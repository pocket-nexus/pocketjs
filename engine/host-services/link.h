/*
 * Pocket Link client (contracts/spec/link.ts): the console's one
 * authenticated TCP connection to a paired companion computer, the guest
 * namespace that rides it and the worker's HTTP stream:
 *
 *   globalThis.link   status/pair/forget/catalog/install/remove/poll
 *   link_http.h       the worker's HTTP resource as a bounded byte-credit
 *                     stream; the worker task exchanges commands and facts
 *                     with this module through its host mailbox
 *
 * The host owns the connection, not a guest: it survives every app switch.
 * link_reset_guest drops what belongs to the guest being torn down (HTTP
 * streams, undelivered events, catalog replies) and keeps the connection and
 * any install already streaming into storage.
 *
 * This never blocks a frame: every socket is non-blocking and link_pump does
 * a bounded amount of work (LINK_RX_BUDGET received bytes, and therefore at
 * most that many bytes written to storage) per call. The host supplies
 * clocks, identity, storage and installs (host_services.h).
 *
 * Capture and offload builds compile the module to inert stubs: link.status()
 * reports an unpaired console and no HTTP stream is available.
 */

#ifndef POCKETJS_LINK_H
#define POCKETJS_LINK_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#if !defined(POCKETJS_CAPTURE) && !defined(POCKETJS_OFFLOAD)
#define POCKETJS_LINK 1
#endif

/* Read identity and paired companions from link_host_directory(). */
void link_init(void);
void link_pump(void);
void link_shutdown(void);
/* Guest switch: drop per-guest state, keep the connection. */
void link_reset_guest(void);

/* `globalThis.link`. Returned strings live until the next call of the same
 * function. */
const char *link_status_json(void);
bool link_pair(const char *uri, size_t length);
bool link_forget(const char *companion);
int32_t link_catalog(void);
int32_t link_install(const char *app_id, size_t length);
bool link_remove(const char *app_id, size_t length);
/* NULL when no event is waiting. */
const char *link_poll(void);

/* The link is up and the companion advertised net.stream; link_http.c
 * checks this before starting a stream. */
bool link_http_available(void);

/* The agent channel (contracts/spec/agent.ts). Ready when the
 * link is up and the companion offered the "agent" feature. The send calls
 * queue whole frames or nothing; false means no room (or no link) now. */
bool link_agent_ready(void);
/* The link is up and the companion offers this feature. */
bool link_feature_ready(const char *name);
bool link_send_ctrl(const char *json, size_t length);
bool link_send_data(uint32_t stream, const uint8_t *bytes, size_t length);
/* A stream id from the console's request numbering. */
uint32_t link_new_stream(void);
/* The companion's clock: epoch ms (UTC) and its zone's offset. False until
 * a companion has linked since boot. */
bool link_clock_now(int64_t *utc_ms, int32_t *offset_min);

/* One line for the development menu, e.g. "LINKED MACBOOK". */
void link_describe(char *out, size_t capacity);

#endif
