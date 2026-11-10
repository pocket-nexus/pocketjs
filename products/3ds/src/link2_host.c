/*
 * Pocket Link 2 on the 3DS: see link2_host.h.
 */

#include "link2_host.h"

#include <stdio.h>
#include <string.h>

#include "devmenu.h"

#ifdef POCKETJS_LINK

#include <3ds.h>
#include <sys/stat.h>
#include <unistd.h>

#include "agent.h"
#include "devstats.h"
#include "hbldr.h"
#include "host_services.h"
#include "jscan.h"
#include "launcher.h"
#include "link2_guest.h"
#include "link_http.h"
#include "native.h"
#include "services_host.h"
#include "sha256.h"
#include "soc.h"

/* What this program serves or uses (§6.1). `runtime.native` is listed
 * whatever started the process: outside the Homebrew Launcher a launch
 * answers the error `launch`. `devtools` is listed while the running guest
 * has the DevTools shim (link2_host_devtools_active), and stands last so the
 * list without it is the same array, one shorter. */
static const char *const FEATURES[] = {
  "apps", "runtime", "runtime.native", "catalog", "install", "net.http", "agent", "channel", "devtools",
};
enum { FEATURE_COUNT = sizeof FEATURES / sizeof FEATURES[0] };
/* The running guest's shim asked for the transport; and what Hub was told. */
static bool shim_present;
static bool devtools_listed;

static Link2 *client;
static char device_name[LINK2_NAME_BYTES];
static char device_model[32];

/* The runtime's facts, as main.c last reported them. */
static PocketRuntimeState runtime_state;
static char runtime_phase[32] = "starting";
static uint32_t runtime_frame;
static uint64_t running_hash;
static char running_title[96];

/* The launcher's own row of runtime.apps. */
static char home_id[LAUNCHER_ID_BYTES];
static char home_output[LAUNCHER_OUTPUT_BYTES];
static char home_version[40];
static char home_hash[17];
static char row_hashes[LINK2_APPS_MAX_ROWS][17];

/* runtime.push: the one staging file. */
static FILE *push_file;
static uint64_t push_hash;
static bool push_ready;   /* whole, and not yet taken by the main loop */
static bool push_pending; /* taken: the admission's report is due */
static uint64_t push_taken_ms;
static uint32_t pushes_taken;
/* An admission reports within a boot and a frame; past this the staging file
 * is free again, so one lost report cannot refuse every later push. */
#define PUSH_REPORT_MS 60000u

/* runtime.native.install */
static uint32_t native_offset;

/* A .3dsx armed with hb:ldr to start as this process exits. */
static bool launch_armed;
static bool exit_requested;

/* runtime.screenshot */
static bool shot_requested;
static bool shot_capturing;
static uint8_t *shot_top;
static uint8_t *shot_auxiliary;
static uint32_t shot_top_bytes;
static uint32_t shot_auxiliary_bytes;
static uint32_t shot_offset;
static uint32_t shot_frame;
static uint16_t shot_size[4];
/* The capture in hand goes out unsolicited (the dev menu, ui.__dbgShot), on
 * the event stream `shot_stream` once it is open. */
static bool shot_unsolicited;
static uint32_t shot_stream;
static uint32_t shots_taken;

/* The guest that runs. */
static int channel = -1;
static bool channel_declared;
static bool guest_running;
static char guest_app[LAUNCHER_ID_BYTES];
static char guest_output[LAUNCHER_OUTPUT_BYTES];
static char guest_hash[17];

// ---------------------------------------------------------------------------
// the platform
// ---------------------------------------------------------------------------

static Link2Platform bsd;

static uint64_t platform_now(void *context) {
  (void)context;
  return services_host_ms();
}

static void platform_random(void *context, uint8_t *out, size_t length) {
  (void)context;
  services_host_random(out, length);
}

/* Sockets exist only while soc:U is up. Turning the radio off closes every
 * socket (wifi.c), so a handle from before reads as gone, and a new one is
 * asked for only once the service is back. */
static int platform_tcp_connect(void *context, const char *address, uint16_t port) {
  return link_host_net_ready() ? bsd.tcp_connect(context, address, port) : -1;
}

static int platform_tcp_connected(void *context, int handle) {
  return soc_active() ? bsd.tcp_connected(context, handle) : -1;
}

static long platform_tcp_send(void *context, int handle, const uint8_t *bytes, size_t length) {
  return soc_active() ? bsd.tcp_send(context, handle, bytes, length) : -1;
}

static long platform_tcp_recv(void *context, int handle, uint8_t *into, size_t capacity) {
  return soc_active() ? bsd.tcp_recv(context, handle, into, capacity) : -1;
}

static void platform_tcp_close(void *context, int handle) {
  if (soc_active()) bsd.tcp_close(context, handle);
}

static int platform_udp_open(void *context, uint16_t port) {
  return link_host_net_ready() ? bsd.udp_open(context, port) : -1;
}

static long platform_udp_recv(void *context, int handle, uint8_t *into, size_t capacity, char address[16]) {
  /* With soc:U down the handle is gone (a later socket may take its number):
   * the client drops it and opens another once the service is back. */
  return soc_active() ? bsd.udp_recv(context, handle, into, capacity, address) : -1;
}

static void platform_udp_close(void *context, int handle) {
  if (soc_active()) bsd.udp_close(context, handle);
}

// ---------------------------------------------------------------------------
// runtime.status, runtime.apps
// ---------------------------------------------------------------------------

static void hex16(uint64_t value, char out[17]) {
  snprintf(out, 17, "%016llx", (unsigned long long)value);
}

static void on_runtime_status(void *context, Link2Json *members) {
  (void)context;
  char address[16] = "";
  char hash[17];
  link_host_address(address, sizeof address);
  link2_json_text(members, "\"phase\":");
  link2_json_cstring(members, runtime_phase);
  link2_json_text(members, ",\"target\":");
  link2_json_cstring(members, POCKETJS_TARGET_ID);
  link2_json_text(members, ",\"hostAbi\":");
  link2_json_u64(members, POCKETJS_HOST_ABI);
  link2_json_text(members, ",\"slot\":");
  link2_json_cstring(members, runtime_slot());
  link2_json_text(members, ",\"address\":");
  link2_json_cstring(members, address);
  link2_json_text(members, ",\"generation\":");
  link2_json_u64(members, runtime_state.generation);
  hex16(runtime_state.active_hash, hash);
  link2_json_text(members, ",\"active\":");
  link2_json_cstring(members, hash);
  hex16(runtime_state.last_good_hash, hash);
  link2_json_text(members, ",\"lastGood\":");
  link2_json_cstring(members, hash);
  hex16(running_hash, hash);
  link2_json_text(members, ",\"running\":");
  link2_json_cstring(members, hash);
  link2_json_text(members, ",\"frame\":");
  link2_json_u64(members, runtime_frame);
  link2_json_text(members, ",\"app\":");
  if (launcher_current_app_id()[0] != '\0') {
    link2_json_text(members, "{\"id\":");
    link2_json_cstring(members, launcher_current_app_id());
    link2_json_text(members, ",\"output\":");
    link2_json_cstring(members, launcher_current_output());
    link2_json_text(members, ",\"title\":");
    link2_json_cstring(members, running_title);
    link2_json_text(members, "}");
  } else {
    link2_json_text(members, "null");
  }
}

static uint32_t on_runtime_generation(void *context) {
  (void)context;
  return runtime_state.generation;
}

static size_t on_runtime_apps(void *context, Link2InstalledApp *rows, size_t capacity) {
  (void)context;
  size_t count = 0;
  if (capacity > 0 && home_id[0] != '\0') {
    rows[count++] = (Link2InstalledApp){
      .id = home_id, .output = home_output, .version = home_version, .hash = home_hash, .home = true,
    };
  }
  LauncherRow row;
  for (size_t index = 0; count < capacity && count < LINK2_APPS_MAX_ROWS && launcher_row(index, &row); index += 1) {
    hex16(row.hash, row_hashes[count]);
    rows[count] = (Link2InstalledApp){
      .id = row.id, .output = row.output, .version = row.version, .hash = row_hashes[count], .home = false,
    };
    count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// runtime.push
// ---------------------------------------------------------------------------

static void push_close(void) {
  if (push_file != NULL) fclose(push_file);
  push_file = NULL;
}

static void push_release(void) {
  push_close();
  push_ready = false;
  push_pending = false;
}

static bool on_push_begin(void *context, uint32_t bytes, const char *hash, Link2Failure *failure) {
  (void)context;
  (void)bytes;
  uint8_t raw[8];
  if (push_ready || push_pending) {
    snprintf(failure->code, sizeof failure->code, "busy");
    snprintf(failure->message, sizeof failure->message, "a pushed package is being admitted");
    return false;
  }
  if (strlen(hash) != 16 || !hex_decode(hash, 16, raw, sizeof raw)) {
    snprintf(failure->code, sizeof failure->code, "malformed");
    snprintf(failure->message, sizeof failure->message, "the hash is not 16 hex digits");
    return false;
  }
  push_hash = 0;
  for (size_t i = 0; i < 8; i += 1) push_hash = (push_hash << 8) | raw[i];
  push_close();
  push_file = fopen(POCKET_RUNTIME_UPLOAD, "wb");
  if (push_file == NULL) {
    snprintf(failure->code, sizeof failure->code, "storage");
    snprintf(failure->message, sizeof failure->message, "the staging file did not open");
    return false;
  }
  return true;
}

static bool on_push_data(void *context, const uint8_t *bytes, size_t length) {
  (void)context;
  return push_file != NULL && fwrite(bytes, 1, length, push_file) == length;
}

/* The file is whole: the main loop admits it at its next frame boundary and
 * reports each step through link2_host_report_install. */
static bool on_push_admit(void *context, Link2Failure *failure) {
  (void)context;
  bool written = push_file != NULL && fflush(push_file) == 0 && fsync(fileno(push_file)) == 0;
  if (push_file != NULL && fclose(push_file) != 0) written = false;
  push_file = NULL;
  if (!written) {
    push_release();
    snprintf(failure->code, sizeof failure->code, "storage");
    snprintf(failure->message, sizeof failure->message, "the staging file did not flush");
    return false;
  }
  push_ready = true;
  return true;
}

static void on_push_abort(void *context) {
  (void)context;
  /* A transfer that stopped part way leaves no staging file; one the main
   * loop has taken is its to remove. */
  bool partial = push_file != NULL || push_ready;
  push_release();
  if (partial) remove(POCKET_RUNTIME_UPLOAD);
}

bool link2_host_take_upload(uint64_t *declared_hash) {
  if (!push_ready) return false;
  push_ready = false;
  push_pending = true;
  push_taken_ms = services_host_ms();
  pushes_taken += 1;
  *declared_hash = push_hash;
  return true;
}

void link2_host_report_install(const char *phase, uint64_t hash, const char *message) {
  if (client == NULL || phase == NULL) return;
  /* A package committed as a slot's active one changes the installed set:
   * the launcher's cached table is read again for the report. */
  if (strcmp(phase, "accepted") == 0) {
    launcher_invalidate();
    link2_apps_changed(client);
  }
  if (!push_pending || hash != push_hash) return;
  if (strcmp(phase, "staged") == 0) {
    link2_push_staged(client, message);
    return;
  }
  if (strcmp(phase, "accepted") == 0) {
    char members[512];
    Link2Json json;
    link2_json_init(&json, members, sizeof members);
    link2_json_text(&json, "\"generation\":");
    link2_json_u64(&json, runtime_state.generation);
    link2_json_text(&json, ",\"message\":");
    link2_json_cstring(&json, message == NULL ? "" : message);
    link2_json_text(&json, ",\"app\":{\"id\":");
    link2_json_cstring(&json, launcher_current_app_id());
    link2_json_text(&json, ",\"output\":");
    link2_json_cstring(&json, launcher_current_output());
    link2_json_text(&json, ",\"title\":");
    link2_json_cstring(&json, running_title);
    link2_json_text(&json, "}");
    link2_push_result(client, !json.failed, members, json.length, NULL);
    push_release();
    return;
  }
  if (strcmp(phase, "receiving") == 0 || strcmp(phase, "received") == 0) return;
  /* rejected, recovered, transfer-error: the admission's own message. */
  Link2Failure failure;
  memset(&failure, 0, sizeof failure);
  snprintf(failure.code, sizeof failure.code, "rejected");
  snprintf(failure.message, sizeof failure.message, "%s", message == NULL ? "" : message);
  /* §6.2: `rejected` says whether the device went back to its last good package. */
  snprintf(failure.members, sizeof failure.members, "\"phase\":\"%s\"", strcmp(phase, "recovered") == 0 ? "recovered" : "rejected");
  link2_push_result(client, false, NULL, 0, &failure);
  push_release();
}

// ---------------------------------------------------------------------------
// runtime.native.install, runtime.launch
// ---------------------------------------------------------------------------

static void fail_with(Link2Failure *failure, const char *code, const char *message) {
  snprintf(failure->code, sizeof failure->code, "%s", code);
  snprintf(failure->message, sizeof failure->message, "%s", message);
}

static bool on_native_begin(void *context, const char *name, uint32_t bytes, uint32_t crc32, bool launch, Link2Failure *failure) {
  (void)context;
  char error[160] = {0};
  if (native_receiving()) {
    fail_with(failure, "busy", "a .3dsx transfer is under way");
    return false;
  }
  PocketRuntimeNativeBegin begin;
  memset(&begin, 0, sizeof begin);
  begin.length = bytes;
  begin.crc32 = crc32;
  begin.flags = launch ? POCKET_RUNTIME_NATIVE_FLAG_LAUNCH : 0;
  snprintf(begin.name, sizeof begin.name, "%s", name);
  if (!native_begin(&begin, error, sizeof error)) {
    fail_with(failure, "storage", error);
    return false;
  }
  native_offset = 0;
  return true;
}

static bool on_native_data(void *context, const uint8_t *bytes, size_t length) {
  (void)context;
  char error[160] = {0};
  if (!native_write(native_offset, bytes, length, error, sizeof error)) return false;
  native_offset += (uint32_t)length;
  return true;
}

/* Arms hb:ldr: the file starts when this process exits. */
static bool arm_launch(const char *path, Link2Failure *failure) {
  char error[160] = {0};
  if (!hbldr_launch_on_exit(path, error, sizeof error)) {
    fail_with(failure, "launch", error);
    return false;
  }
  launch_armed = true;
  return true;
}

static bool on_native_commit(void *context, const char *name, bool launch, char phase[16], char path[128], Link2Failure *failure) {
  (void)context;
  (void)name;
  (void)launch;
  NativeInstall install;
  char error[160] = {0};
  if (!native_commit(&install, error, sizeof error)) {
    fail_with(failure, "rejected", error);
    return false;
  }
  snprintf(path, 128, "%s", install.path);
  snprintf(phase, 16, "%s", install.deferred ? "staged" : "installed");
  if (install.launch) {
    /* A file that replaces the running .3dsx is installed as the process
     * exits, and then starts. */
    if (!arm_launch(install.path, failure)) {
      /* §6.2: the file is on the card and only its start failed. */
      snprintf(failure->members, sizeof failure->members, "\"installed\":true");
      return false;
    }
    snprintf(phase, 16, "launching");
  }
  return true;
}

static void on_native_abort(void *context) {
  (void)context;
  native_abort();
}

static bool on_launch(void *context, const char *native, const char *app, Link2Json *members, bool *launching, Link2Failure *failure) {
  (void)context;
  if (native != NULL) {
    char path[POCKET_NATIVE_PATH_BYTES];
    struct stat info;
    if (!native_path_for(native, path) || stat(path, &info) != 0) {
      fail_with(failure, "not_found", "no such .3dsx under sdmc:/3ds");
      return false;
    }
    if (!arm_launch(path, failure)) return false;
    link2_json_text(members, "\"phase\":\"launching\",\"name\":");
    link2_json_cstring(members, native);
    link2_json_text(members, ",\"path\":");
    link2_json_cstring(members, path);
    *launching = true;
    return true;
  }
  if (!launcher_launch(app)) {
    fail_with(failure, "not_found", "no installed applet has this output");
    return false;
  }
  link2_json_text(members, "\"phase\":\"switching\",\"output\":");
  link2_json_cstring(members, app);
  return true;
}

static void on_restart(void *context) {
  (void)context;
  exit_requested = true;
}

bool link2_host_exit_requested(void) {
  return exit_requested;
}

// ---------------------------------------------------------------------------
// runtime.screenshot
// ---------------------------------------------------------------------------

static void shot_free(void) {
  if (shot_top != NULL) linearFree(shot_top);
  if (shot_auxiliary != NULL) linearFree(shot_auxiliary);
  shot_top = NULL;
  shot_auxiliary = NULL;
  shot_top_bytes = 0;
  shot_auxiliary_bytes = 0;
  shot_offset = 0;
  shot_capturing = false;
  shot_stream = 0;
}

static bool on_screenshot_request(void *context) {
  (void)context;
  if (shot_requested || shot_capturing || shot_top != NULL) return false;
  shot_requested = true;
  shot_unsolicited = false;
  return true;
}

bool link2_host_request_screenshot(void) {
  if (client == NULL || !link2_in_use(client, "runtime")) return false;
  if (shot_requested || shot_capturing || shot_top != NULL) return false;
  shot_requested = true;
  shot_unsolicited = true;
  return true;
}

/* The next bytes of the capture, top surface then bottom: a pointer into the
 * surface that holds byte `shot_offset`, and how many follow in it. */
static const uint8_t *shot_at(uint32_t *left) {
  bool top = shot_offset < shot_top_bytes;
  uint32_t at = top ? shot_offset : shot_offset - shot_top_bytes;
  *left = (top ? shot_top_bytes : shot_auxiliary_bytes) - at;
  return (top ? shot_top : shot_auxiliary) + at;
}

/* An unsolicited capture leaves as its stream's credit and the send buffer
 * allow, a part each pump; Hub's RESET or a dropped link frees it. */
static void shot_pump(void) {
  if (shot_stream == 0) return;
  uint32_t total = shot_top_bytes + shot_auxiliary_bytes;
  while (shot_offset < total) {
    if (!link2_event_stream_live(client, shot_stream)) {
      shot_free();
      return;
    }
    uint32_t left = 0;
    const uint8_t *bytes = shot_at(&left);
    size_t taken = link2_event_stream_send(client, shot_stream, bytes, left, shot_offset + left == total);
    if (taken == 0) return;
    shot_offset += (uint32_t)taken;
  }
  shot_free();
}

static size_t on_screenshot_read(void *context, uint8_t *into, size_t capacity) {
  (void)context;
  uint32_t total = shot_top_bytes + shot_auxiliary_bytes;
  size_t done = 0;
  while (done < capacity && shot_offset < total) {
    uint32_t left = 0;
    const uint8_t *bytes = shot_at(&left);
    size_t take = capacity - done < left ? capacity - done : left;
    memcpy(into + done, bytes, take);
    done += take;
    shot_offset += (uint32_t)take;
  }
  return done;
}

static void on_screenshot_end(void *context) {
  (void)context;
  shot_free();
}

bool link2_host_take_screenshot_request(void) {
  if (!shot_requested) return false;
  shot_requested = false;
  return true;
}

bool link2_host_screenshot_begin(
  uint32_t frame,
  uint16_t top_width,
  uint16_t top_height,
  uint16_t auxiliary_width,
  uint16_t auxiliary_height,
  uint8_t **top,
  uint8_t **auxiliary
) {
  shot_free();
  shot_top_bytes = (uint32_t)top_width * top_height * 3u;
  shot_auxiliary_bytes = (uint32_t)auxiliary_width * auxiliary_height * 3u;
  shot_top = linearAlloc(shot_top_bytes);
  shot_auxiliary = linearAlloc(shot_auxiliary_bytes);
  if (shot_top == NULL || shot_auxiliary == NULL) {
    bool unsolicited = shot_unsolicited;
    shot_free();
    if (client != NULL && !unsolicited) link2_screenshot_failed(client, "storage", "the linear buffers could not be allocated");
    return false;
  }
  shot_frame = frame;
  shot_size[0] = top_width;
  shot_size[1] = top_height;
  shot_size[2] = auxiliary_width;
  shot_size[3] = auxiliary_height;
  shot_capturing = true;
  *top = shot_top;
  *auxiliary = shot_auxiliary;
  return true;
}

void link2_host_screenshot_ready(void) {
  if (!shot_capturing) return;
  shot_capturing = false;
  char members[352];
  Link2Json json;
  link2_json_init(&json, members, sizeof members);
  /* Unsolicited, the members are a whole event; asked for, the client wraps them. */
  if (shot_unsolicited) link2_json_text(&json, "{\"t\":\"runtime.screenshot\",");
  link2_json_text(&json, "\"frame\":");
  link2_json_u64(&json, shot_frame);
  link2_json_text(&json, ",\"format\":\"bgr8-rotated\",\"surfaces\":[{\"name\":\"top\",\"width\":");
  link2_json_u64(&json, shot_size[0]);
  link2_json_text(&json, ",\"height\":");
  link2_json_u64(&json, shot_size[1]);
  link2_json_text(&json, ",\"bytes\":");
  link2_json_u64(&json, shot_top_bytes);
  link2_json_text(&json, "},{\"name\":\"bottom\",\"width\":");
  link2_json_u64(&json, shot_size[2]);
  link2_json_text(&json, ",\"height\":");
  link2_json_u64(&json, shot_size[3]);
  link2_json_text(&json, ",\"bytes\":");
  link2_json_u64(&json, shot_auxiliary_bytes);
  link2_json_text(&json, "}]");
  shot_offset = 0;
  shots_taken += 1;
  if (shot_unsolicited) {
    link2_json_text(&json, "}");
    /* 0 when the link dropped or the event found no room: the capture is dropped. */
    shot_stream = client == NULL || json.failed ? 0 : link2_event_stream(client, members, json.length);
    if (shot_stream == 0) shot_free();
    return;
  }
  /* False when the link dropped meanwhile: nobody reads the capture. */
  if (client == NULL || json.failed ||
      !link2_screenshot_ready(client, members, json.length, shot_frame, shot_top_bytes + shot_auxiliary_bytes)) {
    shot_free();
  }
}

// ---------------------------------------------------------------------------
// the agent's events and streams
// ---------------------------------------------------------------------------

static void on_system_event(void *context, const char *t, const char *json, size_t length) {
  (void)context;
  (void)t;
  agent_link_ctrl(json, length);
}

static uint32_t on_stream_open(void *context, uint32_t id, const char *t, const char *json, size_t length) {
  (void)context;
  return agent_link_stream_open(id, t, json, length);
}

static bool on_stream_data(void *context, uint32_t id, const uint8_t *bytes, size_t length) {
  (void)context;
  return agent_link_data(id, bytes, length);
}

static void on_stream_end(void *context, uint32_t id, bool complete) {
  (void)context;
  agent_link_stream_end(id, complete);
}

static void on_linked(void *context, const char *hub, const char *why) {
  (void)context;
  (void)why;
  agent_link_changed(hub != NULL);
  if (hub == NULL) {
    link_http_disconnected();
    /* hb:ldr is armed: the file starts at exit whether or not the reply left. */
    if (launch_armed) exit_requested = true;
  }
}

bool link2_host_event(const char *json, size_t length) {
  return client != NULL && link2_event(client, json, length);
}

uint32_t link2_host_new_stream(void) {
  return client != NULL ? link2_new_id(client) : 0;
}

bool link2_host_stream_open(uint32_t id, const char *json, size_t length) {
  return client != NULL && link2_event_stream_as(client, id, json, length);
}

size_t link2_host_stream_send(uint32_t id, const uint8_t *bytes, size_t length, bool end) {
  return client != NULL ? link2_event_stream_send(client, id, bytes, length, end) : 0;
}

bool link2_host_stream_end(uint32_t id) {
  return client == NULL || link2_event_stream_end(client, id);
}

bool link2_host_stream_live(uint32_t id) {
  return client != NULL && link2_event_stream_live(client, id);
}

// ---------------------------------------------------------------------------
// DevTools, logs
// ---------------------------------------------------------------------------

/* What Hub is told this program serves: `devtools` only for a guest with the shim. */
static void features_apply(void) {
  if (client == NULL || devtools_listed == shim_present) return;
  devtools_listed = shim_present;
  link2_set_features(client, FEATURES, devtools_listed ? FEATURE_COUNT : FEATURE_COUNT - 1);
}

bool link2_host_devtools_active(void) {
  if (client == NULL) return false;
  shim_present = true;
  features_apply();
  return true;
}

bool link2_host_devtools_listening(void) {
  return client != NULL && link2_devtools_listening(client);
}

size_t link2_host_devtools_poll(char *out, size_t capacity) {
  size_t length = 0;
  const char *line = client != NULL ? link2_devtools_poll(client, &length) : NULL;
  if (line == NULL || length == 0 || length > capacity) return 0;
  memcpy(out, line, length);
  return length;
}

void link2_host_devtools_send(const char *line, size_t length) {
  if (client != NULL) link2_devtools_send(client, line, length);
}

void link2_host_report_log(const char *level, const char *message) {
  if (client == NULL || message == NULL) return;
  link2_log(client, level == NULL ? "info" : level, "host", message, strlen(message), runtime_frame);
}

void link2_host_report_guest_log(const char *level, const char *text, size_t length) {
  if (client == NULL || text == NULL) return;
  /* §6.2 knows debug, info, warn and error: the console's `log` is `info`. */
  if (level == NULL || (strcmp(level, "debug") != 0 && strcmp(level, "warn") != 0 && strcmp(level, "error") != 0)) level = "info";
  link2_log(client, level, "guest", text, length, runtime_frame);
}

void link2_host_set_frame(uint32_t frame) {
  runtime_frame = frame;
}

// ---------------------------------------------------------------------------
// the runtime's facts and the guest's life
// ---------------------------------------------------------------------------

void link2_host_set_runtime(
  const PocketRuntimeState *state,
  const PocketRuntimePackage *package,
  const char *phase,
  uint32_t frame
) {
  if (state != NULL) runtime_state = *state;
  snprintf(runtime_phase, sizeof runtime_phase, "%s", phase == NULL ? "unknown" : phase);
  runtime_frame = frame;
  if (package != NULL) {
    LauncherPackage facts = launcher_package(package);
    running_hash = package->guest.package_hash;
    launcher_package_title(&facts, running_title, sizeof running_title);
    /* The home row of runtime.apps is the home package that runs: a pushed
     * launcher replaces the embedded one's version and hash. */
    char id[LAUNCHER_ID_BYTES];
    launcher_package_app_id(&facts, id, sizeof id);
    if (home_id[0] != '\0' && strcmp(id, home_id) == 0) {
      launcher_package_output(&facts, home_output, sizeof home_output);
      launcher_package_version(&facts, home_version, sizeof home_version);
      hex16(package->guest.package_hash, home_hash);
    }
  }
  if (client != NULL) link2_status_changed(client);
}

void link2_host_guest_begin(const PocketRuntimePackage *package) {
  guest_running = true;
  snprintf(guest_app, sizeof guest_app, "%s", launcher_current_app_id());
  snprintf(guest_output, sizeof guest_output, "%s", launcher_current_output());
  channel = -1;
  channel_declared = package != NULL && (package->guest.features & POCKET_GUEST_FEATURE_CHANNEL) != 0;
  if (package != NULL) hex16(package->guest.package_hash, guest_hash);
  if (client == NULL || !channel_declared) return;
  /* The one place may still be held by the previous guest's close waiting
   * for room: link2_host_before_frame asks again until it is free. */
  channel = link2_channel_open(client, guest_app, guest_hash);
}

void link2_host_guest_end(void) {
  link2_guest_reset();
  link_http_reset();
  if (client != NULL && guest_running) {
    if (channel >= 0) link2_channel_exit(client, channel);
    link2_guest_switch(client, guest_app, guest_output);
  }
  channel = -1;
  channel_declared = false;
  guest_running = false;
  /* The next guest's shim asks again as it installs; a guest without one
   * drops `devtools` at its first frame (link2_host_before_frame), so a
   * switch between two guests with the shim sends no `features` event. */
  shim_present = false;
}

int link2_host_channel(void) {
  return channel;
}

bool link2_host_channel_declared(void) {
  return channel_declared;
}

bool link2_host_in_use(const char *feature) {
  return client != NULL && link2_in_use(client, feature);
}

bool link2_host_clock(int64_t *utc_ms, int32_t *offset_min) {
  return client != NULL && link2_clock(client, utc_ms, offset_min);
}

Link2 *link2_host_client(void) {
  return client;
}

void link2_host_init(const PocketRuntimePackage *embedded) {
  if (client != NULL) return;
  if (embedded != NULL) {
    LauncherPackage home = launcher_package(embedded);
    launcher_package_app_id(&home, home_id, sizeof home_id);
    launcher_package_output(&home, home_output, sizeof home_output);
    launcher_package_version(&home, home_version, sizeof home_version);
    hex16(embedded->guest.package_hash, home_hash);
  }
  link_host_identity(device_name, sizeof device_name, device_model, sizeof device_model);

  Link2Platform platform;
  memset(&platform, 0, sizeof platform);
  memset(&bsd, 0, sizeof bsd);
  link2_bsd_sockets(&bsd);
  platform.now_ms = platform_now;
  platform.random = platform_random;
  platform.tcp_connect = platform_tcp_connect;
  platform.tcp_connected = platform_tcp_connected;
  platform.tcp_send = platform_tcp_send;
  platform.tcp_recv = platform_tcp_recv;
  platform.tcp_close = platform_tcp_close;
  platform.udp_open = platform_udp_open;
  platform.udp_recv = platform_udp_recv;
  platform.udp_close = platform_udp_close;

  Link2Host host;
  memset(&host, 0, sizeof host);
  host.name = device_name;
  host.model = device_model;
  host.target = link_host_target();
  host.host_abi = POCKETJS_HOST_ABI;
  host.directory = link_host_directory();
  /* The whole list at create, so the client allocates the DevTools buffers
   * (link2.h link2_set_features); no guest with the shim runs yet, so the
   * list Hub first sees is without `devtools` (below). */
  host.features = FEATURES;
  host.feature_count = FEATURE_COUNT;
  shim_present = false;
  devtools_listed = false;
  host.max_channels = 1;
  host.linked = on_linked;
  host.runtime_status = on_runtime_status;
  host.runtime_generation = on_runtime_generation;
  host.runtime_apps = on_runtime_apps;
  host.push_begin = on_push_begin;
  host.push_data = on_push_data;
  host.push_admit = on_push_admit;
  host.push_abort = on_push_abort;
  host.native_begin = on_native_begin;
  host.native_data = on_native_data;
  host.native_commit = on_native_commit;
  host.native_abort = on_native_abort;
  host.launch = on_launch;
  host.restart = on_restart;
  host.screenshot_request = on_screenshot_request;
  host.screenshot_read = on_screenshot_read;
  host.screenshot_end = on_screenshot_end;
  host.system_event = on_system_event;
  host.stream_open = on_stream_open;
  host.stream_data = on_stream_data;
  host.stream_end = on_stream_end;
  link2_guest_host(&host);
  link2_http_host(&host);

  mkdir(host.directory, 0777);
  char companions[160];
  snprintf(companions, sizeof companions, "%s/companions", host.directory);
  mkdir(companions, 0777);

  client = link2_create(&platform, &host);
  if (client != NULL) link2_set_features(client, FEATURES, FEATURE_COUNT - 1);
  link2_guest_bind(client);
  link2_http_bind(client);
}

/* What the pumps cost, for a status page: microseconds since the last read. */
static uint32_t pump_count;
static uint64_t pump_ticks;
static uint64_t pump_ticks_max;

static void pump_timed(void) {
  uint64_t started = svcGetSystemTick();
  link2_pump(client);
  link_http_pump();
  uint64_t took = svcGetSystemTick() - started;
  pump_count += 1;
  pump_ticks += took;
  if (took > pump_ticks_max) pump_ticks_max = took;
}

void link2_host_pump(void) {
  if (client == NULL) return;
  pump_timed();
  shot_pump();
  if (push_pending && services_host_ms() - push_taken_ms > PUSH_REPORT_MS) {
    /* The admission never reported: Hub's request ends here, not at its own timeout. */
    Link2Failure failure;
    memset(&failure, 0, sizeof failure);
    fail_with(&failure, "timeout", "the package's admission did not report");
    link2_push_result(client, false, NULL, 0, &failure);
    push_release();
  }
  devstats_set_link(link2_linked(client), link2_stats(client)->links, pushes_taken, shots_taken);
}

/* The dev menu's page: the link and the runtime as this file knows them. */
void devmenu_snapshot(DevmenuSnapshot *out) {
  memset(out, 0, sizeof *out);
  if (client == NULL) return;
  char status[1024];
  Link2Json json;
  link2_json_init(&json, status, sizeof status);
  link2_status_json(client, &json);
  JsonSpan root = { status, json.failed ? 0 : json.length }, paired;
  /* `paired` is an array of objects: one `{` per pairing. */
  out->paired = json_find(root, "paired", &paired) && memchr(paired.start, '{', paired.length) != NULL;
  out->linked = link2_linked(client);
  snprintf(out->device, sizeof out->device, "%s", link2_device_id(client));
  snprintf(out->phase, sizeof out->phase, "%s", runtime_phase);
  u32 address = soc_active() ? (u32)gethostid() : 0;
  snprintf(out->ip, sizeof out->ip, "%u.%u.%u.%u", (unsigned)(address & 0xff), (unsigned)((address >> 8) & 0xff), (unsigned)((address >> 16) & 0xff), (unsigned)(address >> 24));
  out->host_abi = POCKETJS_HOST_ABI;
  out->generation = runtime_state.generation;
  out->running_hash = running_hash;
  out->links = link2_stats(client)->links;
  out->pushes = pushes_taken;
  out->screenshots = shots_taken;
}

/* The second pump of a loop, after the wait for the display and right before
 * the guest's frame: what arrived during the wait reaches the guest in this
 * frame, not the next (a reply 8 ms after its request is taken one frame
 * after it, not two), and the channel's per-frame hand-over starts. */
void link2_host_before_frame(void) {
  if (client == NULL) return;
  pump_timed();
  features_apply();
  /* A guest whose open found the place taken gets its channel once the
   * previous guest's close has left. */
  if (channel < 0 && channel_declared && guest_running) channel = link2_channel_open(client, guest_app, guest_hash);
  if (channel >= 0) link2_channel_frame(client, channel);
}

void link2_host_pump_cost(uint32_t *count, uint32_t *mean_us, uint32_t *max_us) {
  *count = pump_count;
  *mean_us = pump_count == 0 ? 0 : (uint32_t)(pump_ticks / pump_count * 1000000ull / SYSCLOCK_ARM11);
  *max_us = (uint32_t)(pump_ticks_max * 1000000ull / SYSCLOCK_ARM11);
  pump_count = 0;
  pump_ticks = 0;
  pump_ticks_max = 0;
}

void link2_host_shutdown(void) {
  link_http_reset();
  if (client != NULL) {
    link2_stop(client);
    /* One pump moves the CLOSE toward the socket before it is destroyed. */
    link2_pump(client);
  }
  link2_guest_shutdown();
  link2_http_bind(NULL);
  if (client != NULL) link2_destroy(client);
  client = NULL;
  push_close();
  shot_free();
  channel = -1;
}

#else /* capture and offload builds: no link */

void link2_host_init(const PocketRuntimePackage *embedded) { (void)embedded; }
void link2_host_pump(void) {}
void link2_host_before_frame(void) {}
void link2_host_pump_cost(uint32_t *count, uint32_t *mean_us, uint32_t *max_us) {
  *count = 0;
  *mean_us = 0;
  *max_us = 0;
}
void link2_host_shutdown(void) {}
Link2 *link2_host_client(void) { return NULL; }
void link2_host_guest_begin(const PocketRuntimePackage *package) { (void)package; }
void link2_host_guest_end(void) {}
int link2_host_channel(void) { return -1; }
bool link2_host_channel_declared(void) { return false; }
bool link2_host_in_use(const char *feature) {
  (void)feature;
  return false;
}
bool link2_host_clock(int64_t *utc_ms, int32_t *offset_min) {
  (void)utc_ms;
  (void)offset_min;
  return false;
}
bool link2_host_exit_requested(void) { return false; }
void link2_host_set_runtime(const PocketRuntimeState *state, const PocketRuntimePackage *package, const char *phase, uint32_t frame) {
  (void)state;
  (void)package;
  (void)phase;
  (void)frame;
}
void link2_host_report_install(const char *phase, uint64_t hash, const char *message) {
  (void)phase;
  (void)hash;
  (void)message;
}
void link2_host_report_log(const char *level, const char *message) {
  (void)level;
  (void)message;
}
void link2_host_report_guest_log(const char *level, const char *text, size_t length) {
  (void)level;
  (void)text;
  (void)length;
}
void link2_host_set_frame(uint32_t frame) { (void)frame; }
bool link2_host_take_upload(uint64_t *declared_hash) {
  (void)declared_hash;
  return false;
}
bool link2_host_take_screenshot_request(void) { return false; }
bool link2_host_request_screenshot(void) { return false; }
void devmenu_snapshot(DevmenuSnapshot *out) { memset(out, 0, sizeof *out); }
bool link2_host_screenshot_begin(uint32_t frame, uint16_t top_width, uint16_t top_height, uint16_t auxiliary_width, uint16_t auxiliary_height, uint8_t **top, uint8_t **auxiliary) {
  (void)frame;
  (void)top_width;
  (void)top_height;
  (void)auxiliary_width;
  (void)auxiliary_height;
  (void)top;
  (void)auxiliary;
  return false;
}
void link2_host_screenshot_ready(void) {}
bool link2_host_devtools_active(void) { return false; }
bool link2_host_devtools_listening(void) { return false; }
size_t link2_host_devtools_poll(char *out, size_t capacity) {
  (void)out;
  (void)capacity;
  return 0;
}
void link2_host_devtools_send(const char *line, size_t length) {
  (void)line;
  (void)length;
}
bool link2_host_event(const char *json, size_t length) {
  (void)json;
  (void)length;
  return false;
}
uint32_t link2_host_new_stream(void) { return 0; }
bool link2_host_stream_open(uint32_t id, const char *json, size_t length) {
  (void)id;
  (void)json;
  (void)length;
  return false;
}
size_t link2_host_stream_send(uint32_t id, const uint8_t *bytes, size_t length, bool end) {
  (void)id;
  (void)bytes;
  (void)length;
  (void)end;
  return 0;
}
bool link2_host_stream_end(uint32_t id) {
  (void)id;
  return true;
}
bool link2_host_stream_live(uint32_t id) {
  (void)id;
  return false;
}

#endif /* POCKETJS_LINK */
