/*
 * Pocket Link 2 on the 3DS (engine/host-services/link2.h, docs/POCKET-LINK.md):
 * the program's one client, its platform (libctru's clock, randomness and
 * sockets) and what the program supplies to it: its identity, the runtime
 * operations, the agent's events and streams, DevTools lines, and the
 * running applet's channel.
 *
 * The runtime operations share the program's machinery with the development
 * connection (devserver.c), which stays beside the link until it is removed:
 * a pushed package goes into the same staging file and through the same
 * admission in main.c, a .3dsx through native.c, a screenshot through the
 * same GPU-idle transfer. main.c reports each lifecycle step to both.
 *
 * Capture and offload builds have no link: every call here is inert, and the
 * guest namespace reports an unpaired console (link2_guest.h).
 */

#ifndef POCKETJS_3DS_LINK2_HOST_H
#define POCKETJS_3DS_LINK2_HOST_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "dev_protocol.h"
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
void link2_host_shutdown(void);
/* The client, NULL in a build without the link. */
Link2 *link2_host_client(void);

/* A guest is about to boot (its globals may use the channel from its first
 * line), and a guest is torn down or failed to boot: its channel closes,
 * DevTools gets `guest.end`, and what belonged to it is dropped. */
void link2_host_guest_begin(const PocketRuntimePackage *package);
void link2_host_guest_end(void);
/* The running guest's applet channel, or -1 (link2_channel_*). */
int link2_host_channel(void);

/* The link is up and both sides list the group. */
bool link2_host_in_use(const char *feature);
bool link2_host_clock(int64_t *utc_ms, int32_t *offset_min);
/* The .3dsx this process starts as it exits was armed over the link and the
 * reply has left: the main loop ends. */
bool link2_host_exit_requested(void);

/* The runtime's facts, at the call sites of devserver_set_runtime,
 * devserver_report_install and devserver_report_log. */
void link2_host_set_runtime(
  const PocketRuntimeState *state,
  const PocketRuntimePackage *package,
  const char *phase,
  uint32_t frame
);
void link2_host_report_install(const char *phase, uint64_t hash, const char *message);
void link2_host_report_log(const char *level, const char *message);

/* A package pushed over the link is whole in POCKET_RUNTIME_UPLOAD: the
 * caller admits it as it admits the development connection's. */
bool link2_host_take_upload(uint64_t *declared_hash);

/* runtime.screenshot: main owns the GPU-idle transfer into the returned
 * linear buffers, as for the development connection; the link frees them
 * after the stream. */
bool link2_host_take_screenshot_request(void);
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

/* The DevTools stream, for ui.__dbg*. */
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

#endif
