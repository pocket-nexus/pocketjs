/*
 * PocketJS Nintendo 3DS host: libctru/citro3d boot, then fixed-rate virtual
 * frames through one canonical Runtime with generated QuickJS bindings and
 * independent PICA Renderer and Display drivers.
 *
 * Frame order (docs/DESIGN.md, the shape programs/psp/src/main.rs drives):
 * hidScanInput -> one Runtime tick (contacts, guest, simulation, layout,
 * render and terminal display waits) -> the host's next shared clock boundary.
 *
 * The app owns a 400x240 primary surface and a simultaneous 320x240 auxiliary
 * surface. Both render targets are ROTATED, and Mtx_OrthoTilt in the PICA driver keeps
 * each surface's guest coordinates landscape. Touch belongs only to the
 * auxiliary surface.
 *
 * The embedded guest is also the LAUNCHER (docs/LAUNCHER.md "3DS"): every
 * other runtime slot with a committed active package is an installed app it
 * can switch to (launcher.c). A switch happens at the top of a frame, after
 * the previous one presented: teardown, select the target slot, boot its
 * active package. An installed app's failure is reported to the launcher
 * (appTable().lastError) and never walks the launcher's recovery chain.
 *
 * A requested switch runs under a host-drawn transition (transition.c): the
 * old guest stops and a scrim covers its last frame; a thread of its own
 * draws loading frames with a turning indicator through the teardown, the
 * new guest's bytecode (bytecode.c: cached per slot, else compiled) and its
 * mount; the scrim falls away over the new guest's first frames. QuickJS's interrupt hook reads SELECT inside an installed app's
 * long frame, so the launcher answers without waiting for the frame.
 *
 * Building with -DPOCKETJS_CAPTURE turns this into the deterministic e2e
 * binary: input comes from a baked tape instead of the hardware, the listed
 * frames are read back off the render target into sdmc:/fNNNN.raw, and the
 * process parks instead of exiting so the emulator stays alive for the driver
 * to kill.
 */

#include <3ds.h>
#include <citro3d.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include "gfx.h"
#include "stage.h"
#include "agent.h"
#include "input_policy.h"
#include "pocket_core.h"
#include "qjs.h"
#include "worker.h"
#include "offload.h"
#include "media.h"
#include "devserver.h"
#include "devmenu.h"
#include "hbldr.h"
#include "native.h"
#include "runtime.h"
#include "soc.h"
#include "svcwire.h"
#include "camera.h"
#include "fs.h"
#include "launcher.h"
#include "link.h"
#include "services_host.h"
#include "wifi.h"
#include "transition.h"
#include "bytecode.h"

/* The guest surfaces come from the plan of the package in the .3dsx's RomFS
 * (pocket_package_open reads them), never from a literal or a compile flag:
 * one runtime binary serves every game. surfaces_admit() holds them to the
 * two screens, and every later guest (a push, a recovery) to the surfaces the
 * render targets were created with. */
#define TOP_SCREEN_W 400u
#define TOP_SCREEN_H 240u
#define BOTTOM_SCREEN_W 320u
#define BOTTOM_SCREEN_H 240u
static uint32_t view_width;
static uint32_t view_height;
static uint32_t aux_view_width;
static uint32_t aux_view_height;
static uint32_t raster_density;
#define VIEW_W view_width
#define VIEW_H view_height
#define AUX_VIEW_W aux_view_width
#define AUX_VIEW_H aux_view_height
#define CAPTURE_BYTES ((size_t)VIEW_W * VIEW_H * 4)

/* The auxiliary surface a plan without one gets: the whole bottom screen. */
static uint32_t guest_aux_width(const PocketGuestPackage *guest) {
  return guest->aux_width == 0 ? BOTTOM_SCREEN_W : guest->aux_width;
}
static uint32_t guest_aux_height(const PocketGuestPackage *guest) {
  return guest->aux_height == 0 ? BOTTOM_SCREEN_H : guest->aux_height;
}

/* Whether this binary can run the package: its plan's surfaces fit the
 * screens at density 1 (and, once the first guest has booted, equal the
 * surfaces in use), and it asks for no feature this build left out. */
static bool surfaces_admit(
  const PocketRuntimePackage *package,
  char *error,
  size_t error_length
) {
  const PocketGuestPackage *guest = &package->guest;
  uint32_t aux_width = guest_aux_width(guest);
  uint32_t aux_height = guest_aux_height(guest);
  if (guest->view_width != TOP_SCREEN_W || guest->view_height != TOP_SCREEN_H ||
      aux_width != BOTTOM_SCREEN_W || aux_height != BOTTOM_SCREEN_H ||
      guest->raster_density != 1 ||
      (guest->aux_raster_density != 0 && guest->aux_raster_density != 1)) {
    snprintf(
      error,
      error_length,
      "plan surfaces %lux%lu + %lux%lu at density %lu do not fit the 400x240 + 320x240 screens",
      (unsigned long)guest->view_width,
      (unsigned long)guest->view_height,
      (unsigned long)aux_width,
      (unsigned long)aux_height,
      (unsigned long)guest->raster_density
    );
    return false;
  }
  if (view_width != 0 &&
      (guest->view_width != view_width || guest->view_height != view_height ||
       aux_width != aux_view_width || aux_height != aux_view_height ||
       guest->raster_density != raster_density)) {
    snprintf(error, error_length, "plan surfaces differ from the running guest's");
    return false;
  }
#ifndef POCKETJS_MEDIA
  if ((guest->features & POCKET_GUEST_FEATURE_MEDIA) != 0) {
    snprintf(error, error_length, "plan needs media.playback, which this runtime does not carry");
    return false;
  }
#endif
#ifndef POCKETJS_OFFLOAD
  if ((guest->features & POCKET_GUEST_FEATURE_OFFLOAD) != 0) {
    snprintf(error, error_length, "plan needs io.offload, which this runtime does not carry");
    return false;
  }
#endif
  return true;
}

/* contracts/spec/spec.ts ANALOG_CENTER and BTN.SELECT. */
#define ANALOG_CENTER 0x8080
#define BTN_SELECT 0x0001

/*
 * devkitPro's 3dsx crt0 gives the main thread 32 KiB of stack. QuickJS's
 * interpreter recurses, and so does the Solid render pass it runs, so the
 * default is far too small — a bundle that mounts fine everywhere else
 * corrupts the stack here. libctru reads this symbol at startup.
 */
unsigned int __stacksize__ = 1024 * 1024;

/* libctru's argument vector: argv[0] is this .3dsx under the Homebrew Launcher. */
extern int __system_argc;
extern char **__system_argv;

static C3D_RenderTarget *primary_target;
static C3D_RenderTarget *auxiliary_target;
/* The top screen's right eye: only the agent stage draws in stereo. */
static C3D_RenderTarget *right_target;
static bool stage_ready;
/* Set around qjs_frame, for the interrupt hook (guest_interrupt). */
static bool guest_frame_running;
static u64 guest_frame_started;
#ifndef POCKETJS_CAPTURE
static void loading_end(void);
#endif

/* Read one completed rotated PICA target as tightly packed RGB8. `width` and
 * `height` are the guest landscape dimensions; the returned bytes retain the
 * target's rotated column-major order for host-side decoding. */
static void read_surface_rgb8(
  C3D_RenderTarget *surface_target,
  uint32_t width,
  uint32_t height,
  uint8_t *out
) {
  C3D_SyncDisplayTransfer(
    (u32 *)surface_target->frameBuf.colorBuf,
    GX_BUFFER_DIM(height, width),
    (u32 *)out,
    GX_BUFFER_DIM(height, width),
    GX_TRANSFER_FLIP_VERT(0) | GX_TRANSFER_OUT_TILED(0) | GX_TRANSFER_RAW_COPY(0) |
      GX_TRANSFER_IN_FORMAT(GX_TRANSFER_FMT_RGBA8) |
      GX_TRANSFER_OUT_FORMAT(GX_TRANSFER_FMT_RGB8) |
      GX_TRANSFER_SCALING(GX_TRANSFER_SCALE_NO)
  );
  GSPGPU_InvalidateDataCache(out, (s32)((size_t)width * height * 3));
}

// ---------------------------------------------------------------------------
// capture build (tests/e2e/azahar.ts)
// ---------------------------------------------------------------------------

#ifdef POCKETJS_CAPTURE

#ifndef POCKETJS_CAPTURE_INPUT
#define POCKETJS_CAPTURE_INPUT ""
#endif
#ifndef POCKETJS_CAPTURE_TOUCH
#define POCKETJS_CAPTURE_TOUCH ""
#endif
#ifndef POCKETJS_CAP_START
#define POCKETJS_CAP_START 0
#endif
#ifndef POCKETJS_CAP_N
#define POCKETJS_CAP_N 1
#endif

/* Everything the driver reads lives in one directory, so a run's frames can
 * never be confused with a previous run's (tests/e2e/azahar.ts). */
#define CAPTURE_DIR "sdmc:/pocketjs-captures"

/* The PPF's own RGB8 staging buffer, and the A,B,G,R buffer the file holds. */
#define CAPTURE_RGB_BYTES ((size_t)VIEW_W * VIEW_H * 3)

static u32 *capture_buffer;
static u8 *capture_rgb;
static const char CAPTURE_INPUT[] = POCKETJS_CAPTURE_INPUT;
static const char CAPTURE_TOUCH[] = POCKETJS_CAPTURE_TOUCH;

/* Read one unsigned value, decimal or 0x-prefixed hex, from [start, end). */
static bool parse_uint(const char *text, size_t start, size_t end, uint32_t *out) {
  while (start < end && (text[start] == ' ' || text[start] == '\t')) start += 1;
  if (start >= end) return false;
  bool hex = start + 1 < end && text[start] == '0' &&
             (text[start + 1] == 'x' || text[start + 1] == 'X');
  if (hex) start += 2;
  uint32_t value = 0;
  bool any = false;
  for (; start < end; start += 1) {
    char c = text[start];
    uint32_t digit;
    if (c >= '0' && c <= '9') digit = (uint32_t)(c - '0');
    else if (hex && c >= 'a' && c <= 'f') digit = (uint32_t)(c - 'a' + 10);
    else if (hex && c >= 'A' && c <= 'F') digit = (uint32_t)(c - 'A' + 10);
    else if (c == ' ' || c == '\t') break;
    else return false;
    value = value * (hex ? 16u : 10u) + digit;
    any = true;
  }
  if (!any) return false;
  *out = value;
  return true;
}

static bool capture_wants(uint32_t frame) {
  return frame - (uint32_t)POCKETJS_CAP_START < (uint32_t)POCKETJS_CAP_N;
}

/*
 * Baked scripted input, `frame:mask,frame:mask` with decimal or hex masks —
 * the format programs/psp/src/main.rs reads. The active mask is the last
 * threshold at or before `frame`, so `0:0,20:0x40,24:0` means idle, press
 * DOWN at frame 20, release at 24. Input is baked into the binary at build
 * time and never read from the emulator's filesystem at runtime.
 */
static int32_t scripted_buttons(uint32_t frame) {
  size_t length = sizeof CAPTURE_INPUT - 1;
  size_t index = 0;
  bool found = false;
  uint32_t best_frame = 0;
  uint32_t best_mask = 0;
  while (index < length) {
    while (index < length && (CAPTURE_INPUT[index] == ',' || CAPTURE_INPUT[index] == ';' ||
                              CAPTURE_INPUT[index] == ' ')) {
      index += 1;
    }
    size_t frame_start = index;
    while (index < length && CAPTURE_INPUT[index] != ':' && CAPTURE_INPUT[index] != ',') {
      index += 1;
    }
    if (index >= length || CAPTURE_INPUT[index] != ':') break;
    size_t frame_end = index;
    index += 1;
    size_t mask_start = index;
    while (index < length && CAPTURE_INPUT[index] != ',' && CAPTURE_INPUT[index] != ';') {
      index += 1;
    }
    uint32_t at = 0;
    uint32_t mask = 0;
    if (parse_uint(CAPTURE_INPUT, frame_start, frame_end, &at) &&
        parse_uint(CAPTURE_INPUT, mask_start, index, &mask) && at <= frame &&
        (!found || at >= best_frame)) {
      found = true;
      best_frame = at;
      best_mask = mask;
    }
  }
  return (int32_t)best_mask;
}

/*
 * One resistive-panel contact, `frame:id,x,y@frame:-`, using the same
 * threshold semantics as the button tape. The build tool bounds x/y to the
 * physical 320x240 auxiliary panel before this text reaches C.
 */
static size_t scripted_touch(uint32_t frame, uint32_t *out) {
  size_t length = sizeof CAPTURE_TOUCH - 1;
  size_t index = 0;
  bool found = false;
  bool active = false;
  uint32_t best_frame = 0;
  uint32_t best_contact = 0;
  while (index < length) {
    size_t frame_start = index;
    while (index < length && CAPTURE_TOUCH[index] != ':') index += 1;
    if (index >= length) break;
    size_t frame_end = index++;
    size_t payload_start = index;
    while (index < length && CAPTURE_TOUCH[index] != '@') index += 1;
    size_t payload_end = index;
    if (index < length) index += 1;

    uint32_t at = 0;
    if (!parse_uint(CAPTURE_TOUCH, frame_start, frame_end, &at) || at > frame ||
        (found && at < best_frame)) {
      continue;
    }
    found = true;
    best_frame = at;
    active = payload_end > payload_start && CAPTURE_TOUCH[payload_start] != '-';
    if (!active) continue;

    size_t first_comma = payload_start;
    while (first_comma < payload_end && CAPTURE_TOUCH[first_comma] != ',') first_comma += 1;
    size_t second_comma = first_comma + 1;
    while (second_comma < payload_end && CAPTURE_TOUCH[second_comma] != ',') second_comma += 1;
    uint32_t id = 0;
    uint32_t x = 0;
    uint32_t y = 0;
    if (first_comma >= payload_end || second_comma >= payload_end ||
        !parse_uint(CAPTURE_TOUCH, payload_start, first_comma, &id) ||
        !parse_uint(CAPTURE_TOUCH, first_comma + 1, second_comma, &x) ||
        !parse_uint(CAPTURE_TOUCH, second_comma + 1, payload_end, &y)) {
      active = false;
      continue;
    }
    best_contact = ((id & 0xffu) << 18) | ((y & 0x1ffu) << 9) | (x & 0x1ffu);
  }
  if (!found || !active) return 0;
  *out = best_contact;
  return 1;
}

/*
 * Read the render target back.
 *
 * NOT gfxGetFramebuffer after C3D_FrameEnd: that buffer has already been
 * swapped and reads back black. An explicit display transfer untiles the
 * PICA200 colour buffer into linear CPU-readable memory.
 *
 * **The transfer's output format must be GX_TRANSFER_FMT_RGB8, not RGBA8.**
 * Asking the PPF for a 32-bit linear output out of this 240x400 tiled colour
 * buffer returns rows that are each individually correct and progressively
 * misregistered — every fourth output row slips a further 64 texels — which
 * reads as a shredded screen while the same frame presents perfectly. Azahar's
 * software rasterizer happens to answer the 32-bit request correctly, so the
 * bug only shows under a hardware renderer; measured against a known probe
 * rectangle in the Pocket Voxel host, RGBA8 out matched 74.6% of it and RGB8
 * out matched 100.0%. RGB8 is also the format citro3d's own presentation
 * transfer uses, so the capture travels the
 * path the screen travels. The dropped alpha byte was never read: the decode
 * takes R, G and B only.
 *
 * The bytes stay in the rotated screen orientation — 240 wide by 400 tall,
 * column-major — and each capture word is byte order A, B, G, R. The e2e
 * driver decodes with src[(x * 240 + (239 - y)) * 4] -> dst[y * 400 + x].
 */
static bool capture_write_surface(
  C3D_RenderTarget *surface_target,
  uint32_t width,
  uint32_t height,
  const char *prefix,
  uint32_t frame
) {
  /* Canonical tick has completed native rendering and presentation. Keep the
   * capture cadence at a VBlank boundary before the CPU readback transfer. */
  gspWaitForVBlank();
  read_surface_rgb8(surface_target, width, height, capture_rgb);

  /* Widen B, G, R back into the A, B, G, R word the golden format states, so
   * the on-device format change costs the driver nothing. */
  uint8_t *out = (uint8_t *)capture_buffer;
  for (size_t i = 0; i < (size_t)width * height; i += 1) {
    out[i * 4 + 0] = 0xff;
    out[i * 4 + 1] = capture_rgb[i * 3 + 0];
    out[i * 4 + 2] = capture_rgb[i * 3 + 1];
    out[i * 4 + 3] = capture_rgb[i * 3 + 2];
  }

  /* Named by the process-global frame counter, which is also what indexes the
   * baked input tapes: input at frame N and both surface files are frame N. */
  char path[64];
  snprintf(path, sizeof path, CAPTURE_DIR "/%sf%04lu.raw", prefix, (unsigned long)frame);
  FILE *file = fopen(path, "wb");
  if (file == NULL) return false;
  size_t bytes = (size_t)width * height * 4;
  size_t written = fwrite(capture_buffer, 1, bytes, file);
  return fclose(file) == 0 && written == bytes;
}

/* The sentinel the driver waits for. Written only after every requested frame
 * has been written AND closed, so a partial file can never be compared. */
static void capture_done(void) {
  FILE *file = fopen(CAPTURE_DIR "/done", "wb");
  if (file == NULL) return;
  fputs("ok\n", file);
  fclose(file);
}

#endif /* POCKETJS_CAPTURE */

#if !defined(POCKETJS_CAPTURE) && !defined(POCKETJS_OFFLOAD)
/* A transfer that replaced this .3dsx waits in native-deferred.3dsx until the
 * process no longer reads ROMFS from the file. */
static void finish_native_install(void) {
  romfsExit();
  if (!native_exit_pending()) return;
  char error[192] = {0};
  if (!native_finish_exit(error, sizeof error)) runtime_write_error("native-install", error);
}
#else
static void finish_native_install(void) {
  romfsExit();
}
#endif

/* Report a boot or runtime failure as itself rather than as a timeout, then
 * park. */
static void fail(const char *message) {
  const char *text = message == NULL || message[0] == '\0' ? "unknown failure" : message;
#ifdef POCKETJS_CAPTURE
  mkdir(CAPTURE_DIR, 0777);
  FILE *file = fopen(CAPTURE_DIR "/error.txt", "wb");
#else
  FILE *file = fopen("sdmc:/pocketjs-error.txt", "wb");
#endif
  if (file != NULL) {
    fputs(text, file);
    fputs("\n", file);
    fclose(file);
  }

#ifdef POCKETJS_CAPTURE
  /* Park: Azahar does not stop when the app returns from main, and a still
   * process is what the driver kills. */
  for (;;) gspWaitForVBlank();
#else
  /* On hardware the message has to be readable without pulling the card, and
   * HOME has to keep working: parking in a bare loop costs the user a forced
   * power-off, which is also the one way to lose the file just written. */
  loading_end();
  consoleInit(GFX_BOTTOM, NULL);
  printf("PocketJS %s\nFAILED: %s\nPress HOME to exit.\n", POCKETJS_TARGET_ID, text);
  gfxFlushBuffers();
  gfxSwapBuffers();
  gspWaitForVBlank();
  while (aptMainLoop()) {
    gfxFlushBuffers();
    gfxSwapBuffers();
    gspWaitForVBlank();
  }
  finish_native_install();
  gfxExit();
  exit(1);
#endif
}

// ---------------------------------------------------------------------------
// reusable guest runtime
// ---------------------------------------------------------------------------

typedef struct {
  PocketRuntimePackage *package;
  /* 0 names the ROMFS recovery package; stored packages use their footer hash. */
  uint64_t state_hash;
  bool commit_on_accept;
  uint64_t next_active_hash;
  uint64_t next_last_good_hash;
  uint32_t submitted_frames;
} GuestChoice;

/* The bundle into the guest's runtime. Outside a capture build, from the
 * slot's bytecode when bytecode.c has it for this package, else from the
 * source, keeping the bytecode for the next boot. False leaves `error`. */
static bool run_bundle(PocketRuntimePackage *package, char *error, size_t error_length) {
#ifdef POCKETJS_CAPTURE
  bool booted = qjs_boot(package, NULL, 0, NULL, NULL);
#else
  char path[128];
  bool named = runtime_slot_path(package->guest.slot, "bundle.qbc", path, sizeof path);
  uint64_t hash = package->guest.package_hash;
  size_t length = 0;
  uint8_t *bytecode = named ? bytecode_load(path, hash, &length) : NULL;
  bool booted;
  if (bytecode != NULL) {
    booted = qjs_boot(package, bytecode, length, NULL, NULL);
  } else {
    booted = qjs_boot(package, NULL, 0, &bytecode, &length);
    if (booted && named && bytecode != NULL) bytecode_store(path, hash, bytecode, length);
  }
  free(bytecode);
#endif
  if (!booted) snprintf(error, error_length, "%s", qjs_last_error());
  return booted;
}

static bool boot_guest(
  PocketRuntimePackage *package,
  char *error,
  size_t error_length
) {
  if (package == NULL || package->guest.javascript_length == 0) {
    snprintf(error, error_length, "guest package has no JavaScript");
    return false;
  }
  if (!surfaces_admit(package, error, error_length)) return false;
  /* link.c names the running app in every NET request, and the guest's
   * first code (a module's top level, the first effects) runs inside
   * qjs_boot and may fetch: the launcher learns the app before it starts. */
  LauncherPackage facts = launcher_package(package);
  launcher_set_current(runtime_slot(), &facts);
  /* data.fs: the guest's tree is its own slot's data directory, bound before
   * qjs_boot publishes `globalThis.fs`. A card that cannot hold it leaves
   * the namespace out, as on a host without the capability; so does a
   * capture build, whose goldens must not read an earlier run's files. */
  fs_unbind();
#ifndef POCKETJS_CAPTURE
  if ((package->guest.features & POCKET_GUEST_FEATURE_FS) != 0) {
    char root[128];
    char temp[128];
    if (runtime_slot_path(package->guest.slot, "data", root, sizeof root) &&
        runtime_slot_path(package->guest.slot, "fs-tmp", temp, sizeof temp)) {
      fs_bind(root, temp, fs_plan_quota((const char *)package->guest.plan, package->guest.plan_length));
    }
  }
#endif
  camera_admit(
    (package->guest.features & POCKET_GUEST_FEATURE_CAMERA_QR) != 0,
    (package->guest.features & POCKET_GUEST_FEATURE_CAMERA_PHOTO) != 0
  );
  /* The guest's capability decides who owns the top screen; it must be set
   * before qjs_boot, which publishes `globalThis.agent` only for it. */
  bool agent = stage_ready && (package->guest.features & POCKET_GUEST_FEATURE_AGENT) != 0;
  /* Also sets 3D and the top backlight from the console's display mode. */
  agent_set_enabled(agent);
  if (!run_bundle(package, error, error_length)) {
    qjs_shutdown();
    gfx_reset_resources();
    fs_unbind();
    return false;
  }
  return true;
}

/* Canonical tick has retired all GPU and display work before teardown. */
static void teardown_guest(void) {
  /* Host services keep their process-wide state (the link's connection, an
   * install still streaming) and drop what belonged to this guest. */
  camera_teardown();
  qjs_shutdown();
  link_reset_guest();
  fs_unbind();
  agent_set_enabled(false);
  gfx_reset_resources();
  /* The svc reset contract: the next guest never sees this guest's lines. */
  svcwire_reset();
}

static void release_choice(GuestChoice *choice, PocketRuntimePackage *embedded) {
  if (choice->package != NULL && choice->package != embedded) {
    runtime_package_free(choice->package);
  }
  memset(choice, 0, sizeof *choice);
}

static GuestChoice package_choice(
  PocketRuntimePackage *package,
  uint64_t state_hash,
  const PocketRuntimeState *state
) {
  GuestChoice choice = {
    .package = package,
    .state_hash = state_hash,
    .commit_on_accept = state_hash != state->active_hash,
    .next_active_hash = state_hash,
    .next_last_good_hash = state_hash == state->active_hash ? state->last_good_hash : state->active_hash,
    .submitted_frames = 0,
  };
  return choice;
}

static GuestChoice recovery_choice(
  const PocketRuntimeState *state,
  PocketRuntimePackage *embedded,
  PocketRuntimeFailureLineage *failures
) {
  for (;;) {
    uint64_t hash = runtime_recovery_hash(state, failures);
    if (hash == 0) break;
    char error[256] = {0};
    PocketRuntimePackage *package = runtime_package_load_hash(hash, error, sizeof error);
    if (package != NULL) {
      GuestChoice choice = package_choice(package, hash, state);
      /* A rollback never keeps the rejected artifact as last-good. */
      if (choice.commit_on_accept) choice.next_last_good_hash = 0;
      return choice;
    }
    runtime_write_error("load-recovery", error);
    if (!runtime_failure_lineage_add(failures, hash)) {
      runtime_write_error("load-recovery", "recovery failure lineage exhausted");
      break;
    }
  }
  GuestChoice choice = package_choice(embedded, 0, state);
  if (choice.commit_on_accept) choice.next_last_good_hash = 0;
  return choice;
}

static GuestChoice startup_choice(
  PocketRuntimeState *state,
  PocketRuntimePackage *embedded,
  PocketRuntimeFailureLineage *failures
) {
#ifdef POCKETJS_CAPTURE
  (void)failures;
  return package_choice(embedded, 0, state);
#else
  char error[256] = {0};
  /* Recorded before anything else boots, so a pending package accepted this
   * run is not replaced by the embedded one on the next. */
  bool installed = runtime_note_embedded(embedded->guest.package_hash);
  PocketRuntimePackage *pending = NULL;
  RuntimePendingResult pending_result = runtime_prepare_pending(
    &pending,
    error,
    sizeof error
  );
  if (pending_result == RUNTIME_PENDING_READY) {
    return package_choice(pending, pending->guest.package_hash, state);
  }
  if (pending_result == RUNTIME_PENDING_ERROR) {
    runtime_write_error("prepare-pending", error);
  }
  /* A newly installed .3dsx runs the guest it carries, not an older push. */
  if (installed && state->active_hash != 0) return package_choice(embedded, 0, state);
  if (state->active_hash != 0) {
    PocketRuntimePackage *active = runtime_package_load_hash(
      state->active_hash,
      error,
      sizeof error
    );
    if (active != NULL) return package_choice(active, state->active_hash, state);
    runtime_write_error("load-active", error);
    if (!runtime_failure_lineage_add(failures, state->active_hash)) {
      return package_choice(embedded, 0, state);
    }
    return recovery_choice(state, embedded, failures);
  }
  return package_choice(embedded, 0, state);
#endif
}

static bool boot_with_recovery(
  GuestChoice *choice,
  PocketRuntimeState *state,
  PocketRuntimePackage *embedded,
  PocketRuntimeFailureLineage *failures,
  char *fatal,
  size_t fatal_length
) {
  /* pending + active + last-good + embedded recovery are four distinct
   * artifacts in the longest failure chain. */
  for (uint32_t attempt = 0; attempt < 4; attempt += 1) {
    char error[256] = {0};
    if (boot_guest(choice->package, error, sizeof error)) {
      runtime_write_status(state, choice->package, choice->commit_on_accept ? "candidate" : "booted");
      return true;
    }
    runtime_write_error("boot-guest", error);
    snprintf(fatal, fatal_length, "%s", error);
    uint64_t rejected = choice->state_hash;
    release_choice(choice, embedded);
    if (!runtime_failure_lineage_reject(failures, state, rejected)) return false;
    *choice = recovery_choice(state, embedded, failures);
  }
  snprintf(fatal, fatal_length, "guest recovery attempts exhausted");
  return false;
}

static void accept_guest(
  GuestChoice *choice,
  PocketRuntimeState *state,
  PocketRuntimeFailureLineage *failures,
  uint32_t frame
) {
  if (!choice->commit_on_accept || choice->submitted_frames == 0) return;
  uint64_t accepted_hash = choice->next_active_hash;
  char error[256] = {0};
  if (!runtime_commit(
        state,
        choice->next_active_hash,
        choice->next_last_good_hash,
        error,
        sizeof error
      )) {
    runtime_write_error("accept-guest", error);
    fail(error);
  }
  choice->commit_on_accept = false;
  runtime_failure_lineage_reset(failures);
  runtime_write_status(state, choice->package, "accepted");
  devserver_set_runtime(state, choice->package, "accepted", frame);
  devserver_report_install("accepted", accepted_hash, "first PICA command list retired");
}

#if !defined(POCKETJS_CAPTURE) && !defined(POCKETJS_OFFLOAD)
/* System ticks to microseconds, saturated to 32 bits. */
static uint32_t ticks_to_us(u64 ticks) {
  u64 us = ticks * 1000000 / SYSCLOCK_ARM11;
  return us > UINT32_MAX ? UINT32_MAX : (uint32_t)us;
}
#endif

/* Returns the vblanks waited beyond the first: nonzero when the previous
 * frame's GPU work was still running at the vblank. */
static uint32_t begin_frame_wait(uint32_t run_frame) {
#ifdef POCKETJS_CAPTURE
  (void)run_frame;
  C3D_FrameBegin(C3D_FRAME_SYNCDRAW);
  C3D_FrameEnd(0);
  return 0;
#else
  loading_end();
  /* A bounded wait keeps HOME alive when the prior command list hangs. */
  gspWaitForVBlank();
  uint32_t waited = 0;
  while (!C3D_FrameBegin(C3D_FRAME_NONBLOCK)) {
    gspWaitForVBlank();
    waited += 1;
    if (waited == 180) {
      char verdict[96];
      snprintf(
        verdict,
        sizeof verdict,
        "GPU HUNG executing frame %lu (%lu cmds, %lu verts)",
        (unsigned long)(run_frame == 0 ? 0 : run_frame - 1),
        (unsigned long)gfx_frame_commands(),
        (unsigned long)gfx_frame_vertices()
      );
      fail(verdict);
    }
  }
  C3D_FrameEnd(0);
  return waited;
#endif
}


/* The loading frames come from a thread of their own, from the switch's
 * teardown to the new guest's first frame: the main thread spends that time
 * in teardown, bytecode and the guest's mount, and QuickJS's interrupt
 * handler runs a few times a second at most, too seldom to animate from.
 * The main thread issues no GPU work in that window, and begin_frame_wait
 * and fail() stop the thread before they touch the GPU. One step above the
 * main thread in priority, so a frame is never late behind the guest's code;
 * each costs about a millisecond. */
#ifndef POCKETJS_CAPTURE
#define LOADING_STACK (32 * 1024)
#define LOADING_FRAME_NS 16666667LL
static Thread loading_thread;
static atomic_bool loading_stop;

static void loading_run(void *unused) {
  (void)unused;
  while (!atomic_load(&loading_stop)) {
    /* A GPU still busy with the previous frame skips this one. */
    gfx_present_overlays();
    svcSleepThread(LOADING_FRAME_NS);
  }
}

#ifdef POCKETJS_LINK
static void loading_start(void) {
  if (loading_thread != NULL) return;
  atomic_store(&loading_stop, false);
  s32 priority = 0x30;
  svcGetThreadPriority(&priority, CUR_THREAD_HANDLE);
  loading_thread = threadCreate(loading_run, NULL, LOADING_STACK, priority > 0x18 ? priority - 1 : priority, -2, false);
}
#endif

static void loading_end(void) {
  if (loading_thread == NULL) return;
  atomic_store(&loading_stop, true);
  threadJoin(loading_thread, U64_MAX);
  threadFree(loading_thread);
  loading_thread = NULL;
}
#endif

static void recover_running_guest(
  GuestChoice *choice,
  PocketRuntimeState *state,
  PocketRuntimePackage *embedded,
  PocketRuntimeFailureLineage *failures,
  uint32_t run_frame,
  const char *phase,
  const char *message
) {
  runtime_write_error(phase, message);
  uint64_t rejected = choice->state_hash;
  bool candidate = choice->commit_on_accept;
  if (!runtime_failure_lineage_reject(failures, state, rejected)) fail(message);
  begin_frame_wait(run_frame);
  teardown_guest();
  release_choice(choice, embedded);
  *choice = recovery_choice(state, embedded, failures);
  char fatal[256] = {0};
  if (!boot_with_recovery(choice, state, embedded, failures, fatal, sizeof fatal)) fail(fatal);
  devserver_set_runtime(state, choice->package, "recovered", run_frame);
  devserver_report_install(
    candidate ? "rejected" : "recovered",
    rejected,
    message
  );
}

#ifdef POCKETJS_LINK
static void switch_guest(
  GuestChoice *choice,
  PocketRuntimeState *state,
  PocketRuntimePackage *embedded,
  PocketRuntimeFailureLineage *failures,
  const LauncherTarget *target,
  PocketRuntimePackage *candidate,
  uint64_t report_hash,
  uint32_t *run_frame
);
#endif

/* Swap a fully admitted candidate inside a GPU-idle C3D frame. This is the
 * one path used by the boot-time FTP chord and the in-process TCP transport. */
static void install_candidate(
  GuestChoice *choice,
  PocketRuntimeState *state,
  PocketRuntimePackage *embedded,
  PocketRuntimeFailureLineage *failures,
  PocketRuntimePackage *candidate,
  uint32_t *run_frame,
  char *error,
  size_t error_length
) {
  uint64_t candidate_hash = candidate->guest.package_hash;
#ifdef POCKETJS_LINK
  if (!launcher_home_running()) {
    /* A candidate for the running installed app: its failure goes back to
     * the launcher, never down the launcher's recovery chain. */
    LauncherTarget target;
    memset(&target, 0, sizeof target);
    snprintf(target.slot, sizeof target.slot, "%s", runtime_slot());
    snprintf(target.output, sizeof target.output, "%s", launcher_current_output());
    switch_guest(choice, state, embedded, failures, &target, candidate, candidate_hash, run_frame);
    (void)error;
    (void)error_length;
    return;
  }
#endif
  begin_frame_wait(*run_frame);
  accept_guest(choice, state, failures, *run_frame);
  teardown_guest();
  release_choice(choice, embedded);
  runtime_failure_lineage_reset(failures);
  *choice = package_choice(candidate, candidate_hash, state);
  if (!boot_with_recovery(choice, state, embedded, failures, error, error_length)) fail(error);
  if (choice->state_hash == candidate_hash) {
    if (choice->commit_on_accept) {
      devserver_set_runtime(state, choice->package, "candidate", *run_frame);
      devserver_report_install("staged", candidate_hash, "guest booted; waiting for retired frame");
    } else {
      devserver_set_runtime(state, choice->package, "booted", *run_frame);
      devserver_report_install("accepted", candidate_hash, "package already active; guest restarted");
    }
  } else {
    devserver_set_runtime(state, choice->package, "recovered", *run_frame);
    devserver_report_install("rejected", candidate_hash, error);
  }
  *run_frame += 1;
}

#ifdef POCKETJS_LINK
// ---------------------------------------------------------------------------
// app switching (launcher.c owns the table; this owns the swap)
// ---------------------------------------------------------------------------

/* The SELECT summon edge (docs/LAUNCHER.md). Latched at every boot, as on
 * the PSP host: a SELECT still held from dismissing the launcher must be
 * released before it can summon the launcher again. */
static bool select_latched = true;

/* An installed app's frame that has run this long reads SELECT itself. */
#define LONG_FRAME_TICKS (SYSCLOCK_ARM11 / 20)
#define SELECT_SCAN_TICKS (SYSCLOCK_ARM11 / 60)

/* QuickJS's interrupt hook (qjs_set_interrupt). Inside an installed app's
 * frame that has run past LONG_FRAME_TICKS it scans the buttons, so a SELECT
 * press summons the launcher without waiting for the frame to end: the frame
 * is abandoned along with the app. A scan here moves the press edges
 * hidKeysDown reports (the dev menu chords) to this scan. */
static bool guest_interrupt(void) {
  static u64 last_scan;
  if (!guest_frame_running || launcher_home_running() || launcher_pending() || devmenu_visible()) return false;
  u64 now = svcGetSystemTick();
  if (now - guest_frame_started < LONG_FRAME_TICKS || now - last_scan < SELECT_SCAN_TICKS) return false;
  last_scan = now;
  hidScanInput();
  bool select_now = (input_buttons() & BTN_SELECT) != 0;
  bool summon = select_now && !select_latched;
  select_latched = select_now;
  if (!summon) return false;
  launcher_summon();
  return true;
}

/* One frame of the leaving scrim. The old guest no longer runs; the runtime
 * presents its retained tree again and the driver draws the scrim over it. */
static void present_leaving(uint32_t *run_frame) {
  begin_frame_wait(*run_frame);
  (void)qjs_present();
  *run_frame += 1;
}

/* The launcher's guest when it comes back: its active package, then its own
 * recovery chain, then the embedded package. No embedded-install check: that
 * belongs to a cold boot (startup_choice). */
static GuestChoice home_choice(
  PocketRuntimeState *state,
  PocketRuntimePackage *embedded,
  PocketRuntimeFailureLineage *failures
) {
  /* The embedded bytes are already in memory: no SD read for the same
   * package (a pushed launcher that equals the one in the .3dsx). */
  if (state->active_hash != 0 && state->active_hash == embedded->guest.package_hash) {
    return package_choice(embedded, state->active_hash, state);
  }
  if (state->active_hash != 0) {
    char error[256] = {0};
    PocketRuntimePackage *active = runtime_package_load_hash(state->active_hash, error, sizeof error);
    if (active != NULL) return package_choice(active, state->active_hash, state);
    runtime_write_error("load-active", error);
    if (runtime_failure_lineage_add(failures, state->active_hash)) {
      return recovery_choice(state, embedded, failures);
    }
  }
  return package_choice(embedded, 0, state);
}

static void boot_home(
  GuestChoice *choice,
  PocketRuntimeState *state,
  PocketRuntimePackage *embedded,
  PocketRuntimeFailureLineage *failures
) {
  char error[256] = {0};
  if (!runtime_select_slot(launcher_home_slot()) ||
      !runtime_storage_init(state, error, sizeof error)) {
    fail(error[0] != '\0' ? error : "the launcher's runtime slot is unusable");
  }
  runtime_failure_lineage_reset(failures);
  *choice = home_choice(state, embedded, failures);
  if (!boot_with_recovery(choice, state, embedded, failures, error, sizeof error)) fail(error);
}

/* Boot an installed app from its own slot: `candidate` when one was just
 * admitted, else the slot's active package. False leaves `error`; the
 * package is released and nothing is committed. */
static bool boot_app(
  GuestChoice *choice,
  PocketRuntimeState *state,
  const LauncherTarget *target,
  PocketRuntimePackage *candidate,
  char *error,
  size_t error_length
) {
  if (!runtime_select_slot(target->slot) || !runtime_storage_init(state, error, error_length)) {
    runtime_package_free(candidate);
    return false;
  }
  if (candidate != NULL) {
    *choice = package_choice(candidate, candidate->guest.package_hash, state);
  } else {
    if (state->active_hash == 0) {
      snprintf(error, error_length, "%s has no installed package", target->output);
      return false;
    }
    PocketRuntimePackage *active = runtime_package_load_hash(state->active_hash, error, error_length);
    if (active == NULL) return false;
    *choice = package_choice(active, state->active_hash, state);
  }
  if (!boot_guest(choice->package, error, error_length)) {
    release_choice(choice, NULL);
    return false;
  }
  runtime_write_status(state, choice->package, choice->commit_on_accept ? "candidate" : "booted");
  return true;
}

/* The whole-guest swap: teardown inside a GPU-idle C3D frame, then the boot
 * with the transition's loading frames drawn around it. `report_hash` names
 * a dev-wire package whose verdict this switch decides (0: none). */
static void switch_guest(
  GuestChoice *choice,
  PocketRuntimeState *state,
  PocketRuntimePackage *embedded,
  PocketRuntimeFailureLineage *failures,
  const LauncherTarget *target,
  PocketRuntimePackage *candidate,
  uint64_t report_hash,
  uint32_t *run_frame
) {
  begin_frame_wait(*run_frame);
  accept_guest(choice, state, failures, *run_frame);
  /* The old guest's last frame has retired. From here to the new guest's
   * first frame the loading thread draws the transition, and the teardown
   * releases nothing its frames use. */
  transition_load(osGetTime());
  loading_start();
  teardown_guest();
  release_choice(choice, embedded);
  runtime_failure_lineage_reset(failures);
  if (target->home) {
    runtime_package_free(candidate);
    boot_home(choice, state, embedded, failures);
    if (report_hash != 0) devserver_report_install("accepted", report_hash, "launcher package committed and booted");
  } else {
    char error[256] = {0};
    if (boot_app(choice, state, target, candidate, error, sizeof error)) {
      if (report_hash != 0) {
        if (choice->commit_on_accept) {
          devserver_report_install("staged", report_hash, "app booted in its own slot; waiting for retired frame");
        } else {
          devserver_report_install("accepted", report_hash, "app committed in its own slot and launched");
        }
      }
    } else {
      /* The app's slot is still selected when boot_app got that far. */
      if (strcmp(runtime_slot(), target->slot) == 0) runtime_write_error("boot-guest", error);
      launcher_report_failure(target->output, error);
      if (report_hash != 0) devserver_report_install("rejected", report_hash, error);
      boot_home(choice, state, embedded, failures);
    }
  }
  select_latched = true;
  devserver_set_runtime(state, choice->package, choice->commit_on_accept ? "candidate" : "booted", *run_frame);
  *run_frame += 1;
}

/* An installed app threw from a frame or failed to render: record it in its
 * own slot, show it to the launcher once, and go home. */
static void fail_to_home(
  GuestChoice *choice,
  PocketRuntimeState *state,
  PocketRuntimePackage *embedded,
  PocketRuntimeFailureLineage *failures,
  uint32_t *run_frame,
  const char *phase,
  const char *message
) {
  runtime_write_error(phase, message);
  launcher_report_failure(launcher_current_output(), message);
  bool candidate = choice->commit_on_accept;
  uint64_t rejected = choice->state_hash;
  /* A failing candidate is never accepted on the way out. */
  choice->commit_on_accept = false;
  LauncherTarget home;
  memset(&home, 0, sizeof home);
  snprintf(home.slot, sizeof home.slot, "%s", launcher_home_slot());
  home.home = true;
  switch_guest(choice, state, embedded, failures, &home, NULL, 0, run_frame);
  if (candidate) devserver_report_install("rejected", rejected, message);
}

/* A dev-wire package for an app other than the running one: commit it in
 * the app's own slot and launch it there (`bun run 3ds:dev push --app hn`
 * while the launcher runs). True when it was handled here. */
static bool route_upload(
  GuestChoice *choice,
  PocketRuntimeState *state,
  PocketRuntimePackage *embedded,
  PocketRuntimeFailureLineage *failures,
  uint64_t upload_hash,
  uint32_t *run_frame
) {
  char error[256] = {0};
  PocketRuntimePackage *peek = runtime_package_load(POCKET_RUNTIME_UPLOAD, error, sizeof error);
  if (peek == NULL) return false; /* the ordinary path reports the error */
  char slot[17];
  snprintf(slot, sizeof slot, "%s", peek->guest.slot);
  runtime_package_free(peek);
  if (strcmp(slot, runtime_slot()) == 0) return false;
  PocketRuntimePackage *installed = runtime_slot_install(slot, POCKET_RUNTIME_UPLOAD, upload_hash, state, error, sizeof error);
  if (installed == NULL) {
    runtime_write_error("network-package", error);
    devserver_report_install("rejected", upload_hash, error);
    return true;
  }
  LauncherPackage facts = launcher_package(installed);
  launcher_note_installed(slot, &facts);
  LauncherTarget target;
  memset(&target, 0, sizeof target);
  snprintf(target.slot, sizeof target.slot, "%s", slot);
  target.home = strcmp(slot, launcher_home_slot()) == 0;
  if (!launcher_package_output(&facts, target.output, sizeof target.output)) target.output[0] = '\0';
  if (target.home) {
    runtime_package_free(installed);
    installed = NULL;
  }
  switch_guest(choice, state, embedded, failures, &target, installed, upload_hash, run_frame);
  return true;
}
#endif /* POCKETJS_LINK */

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

int main(void) {
  gfxInitDefault();
  /* No-op on an Old 3DS; on a New 3DS it unlocks the faster clock and the
   * extra cache, which the QuickJS guest feels directly. */
  osSetSpeedupEnable(true);
  C3D_Init(C3D_DEFAULT_CMDBUF_SIZE);
#ifndef POCKETJS_CAPTURE
  /* Debug UI must never make an otherwise admissible guest unbootable. */
  (void)devmenu_init();
#endif

  /* The package in RomFS is the game: it names the surfaces the render
   * targets take and the application's state directory on the SD card. A
   * runtime with no package says so on the bottom screen and waits for HOME. */
  struct stat romfs_package;
  if (R_FAILED(romfsInit()) || stat("romfs:/app.pocket", &romfs_package) != 0) {
    fail("this .3dsx carries no game: romfs:/app.pocket is missing");
  }
  char runtime_error[256] = {0};
  PocketRuntimePackage *embedded = runtime_package_load(
    "romfs:/app.pocket",
    runtime_error,
    sizeof runtime_error
  );
  if (embedded == NULL) fail(runtime_error);
  snprintf(embedded->origin, sizeof embedded->origin, "romfs:/app.pocket (recovery)");
  if (!surfaces_admit(embedded, runtime_error, sizeof runtime_error)) fail(runtime_error);
  view_width = embedded->guest.view_width;
  view_height = embedded->guest.view_height;
  aux_view_width = guest_aux_width(&embedded->guest);
  aux_view_height = guest_aux_height(&embedded->guest);
  raster_density = embedded->guest.raster_density;
  if (!runtime_select_slot(embedded->guest.slot)) fail("package app id gave no runtime slot");

  primary_target = C3D_RenderTargetCreate(
    VIEW_H,
    VIEW_W,
    GPU_RB_RGBA8,
    GPU_RB_DEPTH24_STENCIL8
  );
  auxiliary_target = C3D_RenderTargetCreate(
    AUX_VIEW_H,
    AUX_VIEW_W,
    GPU_RB_RGBA8,
    GPU_RB_DEPTH24_STENCIL8
  );
  if (primary_target == NULL || auxiliary_target == NULL) {
    fail("C3D_RenderTargetCreate failed");
  }

  if (!gfx_init(VIEW_W, VIEW_H)) fail("PICA200 backend failed to initialize");
  /* A missing stage leaves the top screen to the guest, never a failed boot. */
  right_target = C3D_RenderTargetCreate(VIEW_H, VIEW_W, GPU_RB_RGBA8, GPU_RB_DEPTH24_STENCIL8);
  if (right_target != NULL) {
    stage_ready = stage_init();
  }
  if (!gfx_bind_targets(primary_target, auxiliary_target, right_target, VIEW_W, VIEW_H, AUX_VIEW_W, AUX_VIEW_H)) fail("PICA display registration failed");

  PocketRuntimeState runtime_state = {0};
#if !defined(POCKETJS_CAPTURE) && !defined(POCKETJS_OFFLOAD)
  if (!runtime_storage_init(&runtime_state, runtime_error, sizeof runtime_error)) {
    fail(runtime_error);
  }
  native_set_running_path(__system_argc > 0 ? __system_argv[0] : NULL);
  DevserverInitResult devserver_result = devserver_init(
    &runtime_state,
    runtime_error,
    sizeof runtime_error
  );
  if (devserver_result == DEVSERVER_ERROR) {
    /* Pairing/network failure must not make the accepted guest unbootable.
     * Persist it for the next FTP inspection and continue without DevTools.
     * The main loop retries: socInit fails transiently when the app starts
     * while WiFi is still re-associating (e.g. right after ftpd exits). */
    runtime_write_error("devserver-init", runtime_error);
  }
  LauncherPackage home = launcher_package(embedded);
  launcher_init(embedded->guest.slot, &home);
  services_host_bind_runtime(&runtime_state);
  link_init();
  qjs_set_interrupt(guest_interrupt);
#endif
  PocketRuntimeFailureLineage failures = {0};
  input_init();
#ifdef POCKETJS_MEDIA
  if (!media_start(ui_upload_texture)) { media_stop(); fail("Media worker allocation failed"); }
#endif
#ifdef POCKETJS_OFFLOAD
  GuestChoice guest = package_choice(embedded, 0, &runtime_state);
  guest.commit_on_accept = false;
  offload_start();
  if (!boot_guest(embedded, runtime_error, sizeof runtime_error)) fail(runtime_error);
#else
  GuestChoice guest = startup_choice(&runtime_state, embedded, &failures);
  if (!boot_with_recovery(
        &guest,
        &runtime_state,
        embedded,
        &failures,
        runtime_error,
        sizeof runtime_error
      )) {
    fail(runtime_error);
  }
#ifndef POCKETJS_CAPTURE
  devserver_set_runtime(
    &runtime_state,
    guest.package,
    guest.commit_on_accept ? "candidate" : "booted",
    0
  );
#endif
#endif /* ordinary recovery boot */

#ifdef POCKETJS_CAPTURE
  mkdir(CAPTURE_DIR, 0777);
  capture_buffer = linearAlloc(CAPTURE_BYTES);
  capture_rgb = linearAlloc(CAPTURE_RGB_BYTES);
  if (capture_buffer == NULL || capture_rgb == NULL) fail("capture buffer allocation failed");
  uint32_t frame = 0;
#endif
#ifndef POCKETJS_CAPTURE
  uint32_t run_frame = 0;
#endif

  while (aptMainLoop()) {
    u64 phase_loop __attribute__((unused)) = svcGetSystemTick();
    hidScanInput();
#ifdef POCKETJS_CAPTURE
    /* The tapes have no analog track: pin the stick to centre so scripted
     * runs stay deterministic. */
    int32_t buttons = scripted_buttons(frame);
    int32_t analog = ANALOG_CENTER;
    int32_t right_analog = ANALOG_CENTER;
    uint32_t touch = 0;
    size_t touch_count = scripted_touch(frame, &touch);
#elif defined(POCKETJS_OFFLOAD)
    if (input_offload_exit_requested()) break;
    int32_t buttons = input_buttons();
    int32_t analog = input_analog();
    int32_t right_analog = input_right_analog();
    uint32_t touch = 0;
    size_t touch_count = input_touch(&touch);
#else
    if (input_exit_requested()) break;
    if (devserver_result == DEVSERVER_ERROR && run_frame % 300 == 299) {
      /* One retry every ~5 s until the transient boot-time failure clears. */
      devserver_result = devserver_init(&runtime_state, runtime_error, sizeof runtime_error);
      if (devserver_result == DEVSERVER_READY) {
        devserver_set_runtime(
          &runtime_state,
          guest.package,
          guest.commit_on_accept ? "candidate" : "booted",
          run_frame
        );
      }
    }
    devserver_poll();
    svcwire_pump();
    pocket_3ds_worker_service();
    link_pump();
    pocket_3ds_worker_service();
    wifi_pump();
    {
      /* An installed or named .3dsx starts when this process exits: the same
       * hand-off the Homebrew Launcher makes, so the loop ends here. */
      char launch_name[POCKET_RUNTIME_NATIVE_NAME_BYTES + 1];
      char launch_path[POCKET_NATIVE_PATH_BYTES];
      if (devserver_take_launch(launch_name) && native_path_for(launch_name, launch_path)) {
        if (hbldr_launch_on_exit(launch_path, runtime_error, sizeof runtime_error)) {
          devserver_report_native("launching", launch_name, "exiting to start it");
          devserver_flush(1000);
          break;
        }
        devserver_report_native("launch-error", launch_name, runtime_error);
      }
    }
    if (launcher_pending()) {
      /* A switch starts once the leaving scrim covers the old guest. */
      u64 now = osGetTime();
      transition_leave(now);
      if (!transition_covered(now)) {
        present_leaving(&run_frame);
        continue;
      }
      LauncherTarget target;
      launcher_take_request(&target);
      switch_guest(&guest, &runtime_state, embedded, &failures, &target, NULL, 0, &run_frame);
      continue;
    }
    if (input_devmenu_toggle_requested()) devmenu_toggle();
    if (devmenu_visible() && input_devmenu_close_requested()) devmenu_hide();
    if (devmenu_visible() && input_devmenu_screenshot_requested()) {
      devmenu_set_notice(
        devserver_request_screenshot() ? "SHOT QUEUED" : "NO DEV CLIENT"
      );
    }
    bool devmenu_blocks_guest = input_devmenu_blocks_guest(devmenu_visible());
    uint64_t upload_hash = 0;
    if (devserver_take_upload(&upload_hash)) {
      if (route_upload(&guest, &runtime_state, embedded, &failures, upload_hash, &run_frame)) continue;
      PocketRuntimePackage *uploaded = NULL;
      RuntimePendingResult result = runtime_prepare_file(
        POCKET_RUNTIME_UPLOAD,
        upload_hash,
        &uploaded,
        runtime_error,
        sizeof runtime_error
      );
      if (result != RUNTIME_PENDING_READY) {
        if (result == RUNTIME_PENDING_NONE) {
          snprintf(
            runtime_error,
            sizeof runtime_error,
            "%s disappeared before package admission",
            POCKET_RUNTIME_UPLOAD
          );
        }
        runtime_write_error("network-package", runtime_error);
        devserver_report_install("rejected", upload_hash, runtime_error);
      } else {
        install_candidate(
          &guest,
          &runtime_state,
          embedded,
          &failures,
          uploaded,
          &run_frame,
          runtime_error,
          sizeof runtime_error
        );
        continue;
      }
    }
    if (!devmenu_blocks_guest && input_reload_requested()) {
      PocketRuntimePackage *pending = NULL;
      RuntimePendingResult result = runtime_prepare_pending(
        &pending,
        runtime_error,
        sizeof runtime_error
      );
      if (result == RUNTIME_PENDING_ERROR) {
        runtime_write_error("manual-reload", runtime_error);
      } else if (result == RUNTIME_PENDING_READY) {
        install_candidate(
          &guest,
          &runtime_state,
          embedded,
          &failures,
          pending,
          &run_frame,
          runtime_error,
          sizeof runtime_error
        );
        continue;
      }
    }
    int32_t buttons = devmenu_blocks_guest ? 0 : input_buttons();
    if (!launcher_home_running()) {
      /* SELECT belongs to the system while an installed app runs: its press
       * edge summons the launcher and the app never sees the bit. */
      bool select_now = (buttons & BTN_SELECT) != 0;
      if (select_now && !select_latched) launcher_summon();
      select_latched = select_now;
      buttons &= ~BTN_SELECT;
    }
    int32_t analog = devmenu_blocks_guest ? ANALOG_CENTER : input_analog();
    int32_t right_analog = devmenu_blocks_guest ? ANALOG_CENTER : input_right_analog();
    uint32_t touch = 0;
    size_t touch_count = devmenu_blocks_guest ? 0 : input_touch(&touch);
#endif
    if (agent_enabled()) {
      if (buttons != 0 || touch_count > 0) stage_note_activity();
      buttons = agent_filter_buttons(buttons);
      agent_pump();
      stage_tick();
    }

    u64 phase_wait __attribute__((unused)) = svcGetSystemTick();
    uint32_t gpu_late __attribute__((unused)) = begin_frame_wait(
#ifdef POCKETJS_CAPTURE
      frame
#else
      run_frame
#endif
    );
    u64 phase_wait_end __attribute__((unused)) = svcGetSystemTick();
#ifdef POCKETJS_MEDIA
    media_present();
#endif
    camera_present();
    if (agent_enabled()) {
      stage_capture_mirror(auxiliary_target);
      agent_capture(auxiliary_target);
    }
#ifndef POCKETJS_CAPTURE
    if (devmenu_visible()) {
      char link_line[48];
      link_describe(link_line, sizeof link_line);
      devmenu_set_link_line(link_line);
    }
#endif
    /* The new guest's first frame still draws under the loading overlay;
     * the ones after it under the arriving fade. The canonical tick draws
     * the overlay the driver asks gfx.c for, so the fade advances first. */
    u64 transition_now = osGetTime();
    TransitionPhase transition = transition_phase();
    if (transition == TRANSITION_ARRIVING) transition_advance(transition_now);
    u64 offload_cpu_start = svcGetSystemTick();
    u64 phase_js __attribute__((unused)) = offload_cpu_start;
    guest_frame_started = svcGetSystemTick();
    guest_frame_running = true;
    bool frame_ran = qjs_frame(buttons, analog, &touch, touch_count, right_analog);
    guest_frame_running = false;
    if (!frame_ran) {
#if defined(POCKETJS_CAPTURE) || defined(POCKETJS_OFFLOAD)
      fail(qjs_last_error());
#else
      /* SELECT ended a long frame (guest_interrupt): the switch starts at the
       * top of the next one. */
      if (qjs_interrupted() && launcher_pending()) continue;
      snprintf(runtime_error, sizeof runtime_error, "%s", qjs_last_error());
      if (!launcher_home_running()) {
        fail_to_home(&guest, &runtime_state, embedded, &failures, &run_frame, "guest-frame", runtime_error);
        continue;
      }
      recover_running_guest(
        &guest,
        &runtime_state,
        embedded,
        &failures,
        run_frame,
        "guest-frame",
        runtime_error
      );
      run_frame += 1;
      continue;
#endif
    }
    /* Canonical tick owns input, guest, fixed simulation, layout and both
     * terminal display submissions. The host owns the shared clock boundary. */
    u64 phase_tick __attribute__((unused)) = svcGetSystemTick();
    offload_measure((unsigned)((phase_tick - offload_cpu_start) * 1000000 / SYSCLOCK_ARM11));
#if !defined(POCKETJS_CAPTURE) && !defined(POCKETJS_OFFLOAD)
    accept_guest(&guest, &runtime_state, &failures, run_frame);
#endif
    if (transition == TRANSITION_LOADING) transition_arrive(transition_now);
#if !defined(POCKETJS_CAPTURE) && !defined(POCKETJS_OFFLOAD)
    {
      /* A frame interval is measured only between consecutive presented
       * frames: a recovery or a reload advances run_frame by more than one,
       * and the frame after it starts a fresh interval. */
      static u64 previous_js;
      static uint32_t previous_frame = UINT32_MAX;
      if (previous_frame != UINT32_MAX && run_frame == previous_frame + 1) {
        devserver_set_frame_timing(
          ticks_to_us(phase_tick - phase_js),
          0, /* Internal tick/layout/render phases belong to the runtime. */
          0,
          0,
          ticks_to_us(phase_js - previous_js),
          ticks_to_us((phase_wait - phase_loop) + (phase_js - phase_wait_end)),
          ticks_to_us(phase_wait_end - phase_wait),
          0,
          gpu_late > 0
        );
      }
      previous_js = phase_js;
      previous_frame = run_frame;
    }
    guest.submitted_frames += 1;
    devserver_set_frame_stats(
      run_frame,
      gfx_frame_commands(),
      gfx_frame_vertices(),
      gfx_dropped_vertices()
    );
    if (devserver_take_screenshot_request()) {
      uint8_t *top_rgb = NULL;
      uint8_t *auxiliary_rgb = NULL;
      if (devserver_screenshot_begin(
            run_frame,
            VIEW_W,
            VIEW_H,
            AUX_VIEW_W,
            AUX_VIEW_H,
            &top_rgb,
            &auxiliary_rgb
          )) {
        /* Canonical tick has retired both surfaces. Copy both targets before
         * the next tick can overwrite either. */
        gspWaitForVBlank();
        read_surface_rgb8(primary_target, VIEW_W, VIEW_H, top_rgb);
        read_surface_rgb8(
          auxiliary_target,
          AUX_VIEW_W,
          AUX_VIEW_H,
          auxiliary_rgb
        );
        devserver_screenshot_ready();
      } else {
        devserver_report_log("error", "screenshot: linear buffer allocation failed");
      }
    }
    run_frame += 1;
#endif
#if defined(POCKETJS_OFFLOAD) && !defined(POCKETJS_CAPTURE)
    run_frame += 1;
#endif

#ifdef POCKETJS_CAPTURE
    if (capture_wants(frame)) {
      /* A frame that overflowed the vertex arena is missing geometry, which
       * must never become a golden. */
      if (gfx_dropped_vertices() > 0) fail("vertex arena overflowed during capture");
      if (!capture_write_surface(primary_target, VIEW_W, VIEW_H, "", frame) ||
          !capture_write_surface(
            auxiliary_target,
            AUX_VIEW_W,
            AUX_VIEW_H,
            "aux-",
            frame
          )) {
        fail("capture write failed");
      }
      if (frame + 1 >= (uint32_t)POCKETJS_CAP_START + POCKETJS_CAP_N) {
        capture_done();
        /* Park: Azahar does not stop when the app returns from main, and a
         * still process is what the driver kills. */
        for (;;) gspWaitForVBlank();
      }
    }
    frame += 1;
#endif
  }

  begin_frame_wait(
#ifdef POCKETJS_CAPTURE
    frame
#else
    run_frame
#endif
  );
  offload_stop();
#ifdef POCKETJS_MEDIA
  media_stop();
#endif
  input_shutdown();
  teardown_guest();
  agent_shutdown();
  stage_shutdown();
  release_choice(&guest, embedded);
  runtime_package_free(embedded);
#ifndef POCKETJS_CAPTURE
  link_shutdown();
  wifi_shutdown();
  svcwire_shutdown();
  devserver_shutdown();
  soc_shutdown();
  devmenu_shutdown();
#endif
  gfx_shutdown();
  finish_native_install();
  C3D_Fini();
  gfxExit();
  return 0;
}
