/*
 * Pocket Link 2 on the 3DS (engine/host-services/link2.h, docs/POCKET-LINK.md):
 * the program's one client, its platform (libctru's clock, randomness and
 * sockets) and what the program supplies to it: its identity, the runtime
 * operations, the agent's events and streams, DevTools lines, and the
 * running applet's channel.
 *
 * The runtime operations run on the program's machinery: a pushed package
 * goes into the staging file and through the admission in main.c, a .3dsx
 * through native.c, a screenshot through the GPU-idle transfer in main.c.
 * main.c reports each lifecycle step here.
 *
 * Capture and offload builds have no link: every call here is inert, and the
 * guest namespace reports an unpaired console (link2_guest.h).
 */

#ifndef POCKETJS_3DS_LINK2_HOST_H
#define POCKETJS_3DS_LINK2_HOST_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "link2.h"
#include "runtime.h"

#if !defined(POCKETJS_CAPTURE) && !defined(POCKETJS_OFFLOAD)
#define POCKETJS_LINK 1
#endif

/* After launcher_init: `embedded` is the launcher's package (the home row of
 * runtime.apps). Reads the pairing files and starts searching. */
void link2_host_init(const PocketRuntimePackage *embedded);
/* Once per frame. */
void link2_host_pump(void);
/* Right before the guest's frame: a second pump for what arrived while the
 * loop waited for the display, then the channel's per-frame hand-over. */
void link2_host_before_frame(void);
/* The pumps since the last call: their count, mean and longest, in microseconds. */
void link2_host_pump_cost(uint32_t *count, uint32_t *mean_us, uint32_t *max_us);
void link2_host_shutdown(void);
/* The client, NULL in a build without the link. */
Link2 *link2_host_client(void);

/* A guest is about to boot (its globals may use the channel from its first
 * line), and a guest is torn down or failed to boot: its channel closes,
 * DevTools gets `guest.end`, and what belonged to it is dropped. */
void link2_host_guest_begin(const PocketRuntimePackage *package);
void link2_host_guest_end(void);
/* The running guest's applet channel, or -1 (link2_channel_*); and whether
 * its package declared "link.channel", which decides whether it sees
 * `link.channel` at all. */
int link2_host_channel(void);
bool link2_host_channel_declared(void);

/* The link is up and both sides list the group. */
bool link2_host_in_use(const char *feature);
bool link2_host_clock(int64_t *utc_ms, int32_t *offset_min);
/* The .3dsx this process starts as it exits was armed over the link and the
 * reply has left: the main loop ends. */
bool link2_host_exit_requested(void);

/* The runtime's facts at each lifecycle step, an install's phases, and the
 * host's own log lines. */
void link2_host_set_runtime(
  const PocketRuntimeState *state,
  const PocketRuntimePackage *package,
  const char *phase,
  uint32_t frame
);
void link2_host_report_install(const char *phase, uint64_t hash, const char *message);
bool link2_host_report_log(const char *level, const char *message);
/* A console line of the running guest (ui.__dbgLog): a `log` event with
 * source "guest" while Hub has runtime.logs on, whether a DevTools panel
 * listens or not (docs/POCKET-LINK.md §6.2). */
void link2_host_report_guest_log(const char *level, const char *text, size_t length);
/* The frame the main loop submitted last: runtime.status and log events
 * carry it. */
void link2_host_set_frame(uint32_t frame);

/* A package pushed over the link is whole in POCKET_RUNTIME_UPLOAD: the
 * caller admits it. */
bool link2_host_take_upload(uint64_t *declared_hash);

/* runtime.screenshot: main owns the GPU-idle transfer into the returned
 * linear buffers; the link frees them after the stream. */
bool link2_host_take_screenshot_request(void);
/* The dev menu's X and ui.__dbgShot: the same capture sent unsolicited, as a
 * `runtime.screenshot` event with a stream of its own (§6.2). False without
 * a link that uses `runtime`, or while a capture is on its way. */
bool link2_host_request_screenshot(void);
bool link2_host_screenshot_begin(
  uint32_t frame,
  uint16_t top_width,
  uint16_t top_height,
  uint16_t auxiliary_width,
  uint16_t auxiliary_height,
  uint8_t **top,
  uint8_t **auxiliary
);
void link2_host_screenshot_ready(void);

/* The DevTools stream, for ui.__dbg*. A guest's shim asks `active` once as
 * it installs: from then until that guest ends the program lists `devtools`
 * (§6.1), so a guest without the shim is not offered an eval it cannot run. */
bool link2_host_devtools_active(void);
bool link2_host_devtools_listening(void);
size_t link2_host_devtools_poll(char *out, size_t capacity);
void link2_host_devtools_send(const char *line, size_t length);

/* The agent's events and streams (agent.c). A stream is named in its head
 * event's JSON, so its id is taken first. */
bool link2_host_event(const char *json, size_t length);
uint32_t link2_host_new_stream(void);
bool link2_host_stream_open(uint32_t id, const char *json, size_t length);
size_t link2_host_stream_send(uint32_t id, const uint8_t *bytes, size_t length, bool end);
/* True when the END is queued or the stream is gone. */
bool link2_host_stream_end(uint32_t id);
/* False once the stream ended, Hub reset it or the link dropped. */
bool link2_host_stream_live(uint32_t id);

#endif
