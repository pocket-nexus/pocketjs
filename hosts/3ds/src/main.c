/*
 * PocketJS Nintendo 3DS host: libctru/citro3d boot, then fixed-rate virtual
 * frames while QuickJS runs the guest, the Rust core ticks animations and
 * layout, and the PICA200 backend draws the DrawList.
 *
 * Frame order (docs/DESIGN.md, the shape hosts/psp/src/main.rs drives):
 * hidScanInput -> resolve bottom-screen touch -> globalThis.frame -> drain
 * jobs -> ui_tick (fixed 1/60) -> build both DrawLists -> one C3D frame that
 * draws the top and bottom targets.
 *
 * The app owns a 400x240 primary surface and a simultaneous 320x240 auxiliary
 * surface. Both render targets are ROTATED, and Mtx_OrthoTilt in gfx.c keeps
 * each surface's guest coordinates landscape. Touch belongs only to the
 * auxiliary surface.
 *
 * Building with -DPOCKETJS_CAPTURE turns this into the deterministic e2e
 * binary: input comes from a baked tape instead of the hardware, the listed
 * frames are read back off the render target into sdmc:/fNNNN.raw, and the
 * process parks instead of exiting so the emulator stays alive for the driver
 * to kill.
 */

#include <3ds.h>
#include <citro3d.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include "gfx.h"
#include "input.h"
#include "pocket_core.h"
#include "qjs.h"
#include "offload.h"
#include "media.h"
#include "devserver.h"
#include "devmenu.h"
#include "runtime.h"
#include "soc.h"
#include "svcwire.h"

/* The guest viewport comes from the resolved build plan, never a literal. */
#ifndef POCKETJS_VIEW_W
#error "POCKETJS_VIEW_W must come from the verified ResolvedBuildPlan"
#endif
#ifndef POCKETJS_VIEW_H
#error "POCKETJS_VIEW_H must come from the verified ResolvedBuildPlan"
#endif
#ifndef POCKETJS_RASTER_DENSITY
#error "POCKETJS_RASTER_DENSITY must come from the verified ResolvedBuildPlan"
#endif
#ifndef POCKETJS_AUX_VIEW_W
#error "POCKETJS_AUX_VIEW_W must come from the verified ResolvedBuildPlan"
#endif
#ifndef POCKETJS_AUX_VIEW_H
#error "POCKETJS_AUX_VIEW_H must come from the verified ResolvedBuildPlan"
#endif
#define VIEW_W POCKETJS_VIEW_W
#define VIEW_H POCKETJS_VIEW_H
#define AUX_VIEW_W POCKETJS_AUX_VIEW_W
#define AUX_VIEW_H POCKETJS_AUX_VIEW_H
#define CAPTURE_BYTES ((size_t)VIEW_W * VIEW_H * 4)

/* contracts/spec/spec.ts ANALOG_CENTER. */
#define ANALOG_CENTER 0x8080

/*
 * devkitPro's 3dsx crt0 gives the main thread 32 KiB of stack. QuickJS's
 * interpreter recurses, and so does the Solid render pass it runs, so the
 * default is far too small — a bundle that mounts fine everywhere else
 * corrupts the stack here. libctru reads this symbol at startup.
 */
unsigned int __stacksize__ = 1024 * 1024;

static C3D_RenderTarget *primary_target;
static C3D_RenderTarget *auxiliary_target;

static const u32 DISPLAY_TRANSFER_FLAGS =
  GX_TRANSFER_FLIP_VERT(0) | GX_TRANSFER_OUT_TILED(0) | GX_TRANSFER_RAW_COPY(0) |
  GX_TRANSFER_IN_FORMAT(GX_TRANSFER_FMT_RGBA8) |
  GX_TRANSFER_OUT_FORMAT(GX_TRANSFER_FMT_RGB8) |
  GX_TRANSFER_SCALING(GX_TRANSFER_SCALE_NO);

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
 * the format hosts/psp/src/main.rs reads. The active mask is the last
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
 * transfer uses (DISPLAY_TRANSFER_FLAGS above), so the capture travels the
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
  /* C3D_FrameEnd only queues the frame. The colour buffer is not finished
   * until the GPU is, so wait before transferring it out. */
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

static bool boot_guest(
  PocketRuntimePackage *package,
  char *error,
  size_t error_length
) {
  if (package == NULL || package->guest.javascript_length == 0) {
    snprintf(error, error_length, "guest package has no JavaScript");
    return false;
  }
  ui_init(POCKETJS_RASTER_DENSITY);
  ui_set_viewport((float)VIEW_W, (float)VIEW_H);
  if (ui_create_auxiliary_surface((float)AUX_VIEW_W, (float)AUX_VIEW_H) == 0) {
    snprintf(error, error_length, "auxiliary UI root allocation failed");
    ui_shutdown();
    return false;
  }
  if (package->guest.pak_length > 0) {
    ui_feed_pak(package->guest.pak, package->guest.pak_length);
  }
  if (!qjs_boot(
        (const char *)package->guest.javascript,
        package->guest.javascript_length - 1,
        package->guest.pak,
        package->guest.pak_length
      )) {
    snprintf(error, error_length, "%s", qjs_last_error());
    qjs_shutdown();
    gfx_reset_resources();
    ui_shutdown();
    return false;
  }
  return true;
}

/* Call only after C3D_FrameBegin has retired the previous GPU command list. */
static void teardown_guest(void) {
  qjs_shutdown();
  gfx_reset_resources();
  ui_shutdown();
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
    bool embedded_failed = choice->package == embedded;
    release_choice(choice, embedded);
    if (embedded_failed) return false;
    if (!runtime_failure_lineage_add(failures, rejected)) {
      snprintf(fatal, fatal_length, "recovery failure lineage exhausted");
      return false;
    }
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

static void begin_frame_wait(uint32_t run_frame) {
#ifdef POCKETJS_CAPTURE
  (void)run_frame;
  C3D_FrameBegin(C3D_FRAME_SYNCDRAW);
#else
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
#endif
}

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
  if (choice->package == embedded) fail(message);
  uint64_t rejected = choice->state_hash;
  bool candidate = choice->commit_on_accept;
  if (!runtime_failure_lineage_add(failures, rejected)) {
    fail("recovery failure lineage exhausted");
  }
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
  C3D_FrameEnd(0);
}

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
  C3D_FrameEnd(0);
  *run_frame += 1;
}

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
  C3D_RenderTargetSetOutput(primary_target, GFX_TOP, GFX_LEFT, DISPLAY_TRANSFER_FLAGS);
  C3D_RenderTargetSetOutput(auxiliary_target, GFX_BOTTOM, GFX_LEFT, DISPLAY_TRANSFER_FLAGS);

  if (R_FAILED(romfsInit())) fail("romfsInit failed: the .3dsx has no romfs");
  if (!gfx_init(VIEW_W, VIEW_H)) fail("PICA200 backend failed to initialize");

  char runtime_error[256] = {0};
  PocketRuntimePackage *embedded = runtime_package_load(
    "romfs:/app.pocket",
    runtime_error,
    sizeof runtime_error
  );
  if (embedded == NULL) fail(runtime_error);
  snprintf(embedded->origin, sizeof embedded->origin, "romfs:/app.pocket (recovery)");

  PocketRuntimeState runtime_state = {0};
#if !defined(POCKETJS_CAPTURE) && !defined(POCKETJS_OFFLOAD)
  if (!runtime_storage_init(&runtime_state, runtime_error, sizeof runtime_error)) {
    fail(runtime_error);
  }
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
#endif
  PocketRuntimeFailureLineage failures = {0};
  input_init();
#ifdef POCKETJS_MEDIA
  if (!media_start()) { media_stop(); fail("Media worker allocation failed"); }
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
    int32_t analog = devmenu_blocks_guest ? ANALOG_CENTER : input_analog();
    int32_t right_analog = devmenu_blocks_guest ? ANALOG_CENTER : input_right_analog();
    uint32_t touch = 0;
    size_t touch_count = devmenu_blocks_guest ? 0 : input_touch(&touch);
#endif

    u64 offload_cpu_start = svcGetSystemTick();
    int32_t touch_hit = 0;
    size_t hit_count = ui_touch_hits_auxiliary(
      touch_count > 0 ? &touch : NULL,
      touch_count,
      &touch_hit,
      1
    );
    if (hit_count != touch_count) fail("auxiliary touch hit resolution failed");
    if (!qjs_frame(buttons, analog, &touch, &touch_hit, touch_count, right_analog)) {
#if defined(POCKETJS_CAPTURE) || defined(POCKETJS_OFFLOAD)
      fail(qjs_last_error());
#else
      snprintf(runtime_error, sizeof runtime_error, "%s", qjs_last_error());
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
    /* Animations always advance at the fixed 1/60 timestep; this host
     * presents at the same rate, so it is one tick per frame. */
    ui_tick();
    size_t words = ui_draw();
    size_t auxiliary_words = ui_draw_auxiliary();
    const uint32_t *auxiliary_list = ui_draw_auxiliary_list_ptr();
#ifndef POCKETJS_CAPTURE
    if (devmenu_visible()) {
      auxiliary_list = devmenu_draw_list(&auxiliary_words);
    }
#endif

    u64 offload_ui_ticks = svcGetSystemTick() - offload_cpu_start;
    begin_frame_wait(
#ifdef POCKETJS_CAPTURE
      frame
#else
      run_frame
#endif
    );
#if !defined(POCKETJS_CAPTURE) && !defined(POCKETJS_OFFLOAD)
    /* Reaching the next FrameBegin proves the candidate's first submitted list
     * retired without tripping the GPU watchdog. Only now does it become the
     * active generation on SD. */
    accept_guest(&guest, &runtime_state, &failures, run_frame);
#endif
    offload_cpu_start = svcGetSystemTick();
    gfx_begin_frame();
#ifdef POCKETJS_MEDIA
    media_present();
#endif
    if (!gfx_prepare_surface(0, ui_draw_list_ptr(), words, VIEW_W, VIEW_H) ||
        !gfx_prepare_surface(
          1,
          auxiliary_list,
          auxiliary_words,
          AUX_VIEW_W,
          AUX_VIEW_H
        )) {
#if defined(POCKETJS_CAPTURE) || defined(POCKETJS_OFFLOAD)
      fail("PICA200 surface preparation failed");
#else
      C3D_FrameEnd(0);
      recover_running_guest(
        &guest,
        &runtime_state,
        embedded,
        &failures,
        run_frame + 1,
        "guest-render",
        "PICA200 surface preparation failed"
      );
      run_frame += 2;
      continue;
#endif
    }
    gfx_finish_frame();

    C3D_RenderTargetClear(primary_target, C3D_CLEAR_ALL, 0x000000ff, 0);
    C3D_FrameDrawOn(primary_target);
    /* C3D_FrameDrawOn resets the viewport, so this comes after it. */
    C3D_SetViewport(0, 0, VIEW_H, VIEW_W);
    gfx_draw_surface(0);

    C3D_RenderTargetClear(auxiliary_target, C3D_CLEAR_ALL, 0x000000ff, 0);
    C3D_FrameDrawOn(auxiliary_target);
    C3D_SetViewport(0, 0, AUX_VIEW_H, AUX_VIEW_W);
    gfx_draw_surface(1);
    C3D_FrameEnd(0);
    offload_measure((unsigned)((offload_ui_ticks + svcGetSystemTick() - offload_cpu_start) * 1000000 / SYSCLOCK_ARM11));
#if !defined(POCKETJS_CAPTURE) && !defined(POCKETJS_OFFLOAD)
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
        /* FrameEnd queued both surfaces. Retire them once, then copy both
         * targets before the next command list can overwrite either. */
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
  C3D_FrameEnd(0);
  release_choice(&guest, embedded);
  runtime_package_free(embedded);
#ifndef POCKETJS_CAPTURE
  svcwire_shutdown();
  devserver_shutdown();
  soc_shutdown();
  devmenu_shutdown();
#endif
  gfx_shutdown();
  romfsExit();
  C3D_Fini();
  gfxExit();
  return 0;
}
