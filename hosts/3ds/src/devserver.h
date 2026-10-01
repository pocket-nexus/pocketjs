#ifndef POCKETJS_3DS_DEVSERVER_H
#define POCKETJS_3DS_DEVSERVER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "dev_protocol.h"
#include "runtime.h"

typedef enum {
  DEVSERVER_DISABLED = 0,
  DEVSERVER_READY = 1,
  DEVSERVER_ERROR = -1,
} DevserverInitResult;

typedef struct {
  bool enabled;
  bool discoverable;
  bool connected;
  char ip[16];
  char phase[32];
  uint16_t port;
  uint16_t host_abi;
  uint32_t generation;
  uint64_t running_hash;
  uint64_t device_id;
  uint32_t connects;
  uint32_t auth_failures;
  uint32_t timeouts;
  uint32_t uploads;
  uint32_t screenshots;
} DevserverSnapshot;

/* Starts the paired LAN listener. A missing dev.key is an intentional
 * DISABLED state; malformed key or socket initialization is ERROR. */
DevserverInitResult devserver_init(
  const PocketRuntimeState *state,
  char *error,
  size_t error_length
);
void devserver_shutdown(void);

/* Non-blocking bounded network pump. Call once per application frame. */
void devserver_poll(void);
bool devserver_active(void);
bool devserver_connected(void);
/* Defaults to true. Native hosts can disable guest package admission while
 * retaining control/capture. Disabling also cancels a staged/in-flight upload. */
void devserver_allow_packages(bool allowed);
void devserver_snapshot(DevserverSnapshot *out);

/* Pocket DevTools JSON-line transport exposed through ui.__dbg*. */
size_t devserver_recv_ctrl(char *out, size_t capacity);
void devserver_send_ctrl(const char *line, size_t length);
bool devserver_request_screenshot(void);
const char *devserver_debug_stats(void);

/* Completed binary upload. The caller admits POCKET_RUNTIME_UPLOAD, then
 * reports staged/rejected/accepted at the same lifecycle boundaries used by
 * FTP packages. */
bool devserver_take_upload(uint64_t *declared_hash);
void devserver_report_install(
  const char *phase,
  uint64_t hash,
  const char *message
);
void devserver_report_log(const char *level, const char *message);

/* .3dsx files (src/native.c). An install or a LAUNCH message that asks to
 * start a .3dsx leaves its bare file name here; the caller hands
 * sdmc:/3ds/<name> to hb:ldr and exits its loop. Receipts are
 * {"t":"runtime.native","phase","name","path","message"} control records,
 * name bare and path sdmc:/3ds/<name> (both empty when the name is unknown). */
bool devserver_take_launch(char name[POCKET_RUNTIME_NATIVE_NAME_BYTES + 1]);
void devserver_report_native(const char *phase, const char *name, const char *message);
/* Send what is queued before the process exits, for at most timeout_ms. */
void devserver_flush(uint32_t timeout_ms);

/* Current runtime facts are cached for connect/status/debugStats receipts. */
void devserver_set_runtime(
  const PocketRuntimeState *state,
  const PocketRuntimePackage *package,
  const char *phase,
  uint32_t frame
);
/* One frame's CPU phases in microseconds: guest JS, core tick (animation and
 * physics), DrawList builds, PICA200 preparation and submission, and the
 * interval since the previous frame began. Aggregated per 60-frame window. */
void devserver_set_frame_timing(
  uint32_t js_us,
  uint32_t tick_us,
  uint32_t draw_us,
  uint32_t gpu_us,
  uint32_t frame_us
);

void devserver_set_frame_stats(
  uint32_t frame,
  uint32_t commands,
  uint32_t vertices,
  uint32_t dropped_vertices
);

/* On-demand two-surface screenshot. Main owns the GPU-idle transfer into the
 * returned linear buffers; the server owns and frees them after binary send. */
bool devserver_take_screenshot_request(void);
bool devserver_screenshot_begin(
  uint32_t frame,
  uint16_t top_width,
  uint16_t top_height,
  uint16_t auxiliary_width,
  uint16_t auxiliary_height,
  uint8_t **top,
  uint8_t **auxiliary
);
void devserver_screenshot_ready(void);
void devserver_screenshot_cancel(void);

#endif
