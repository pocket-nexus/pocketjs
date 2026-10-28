/*
 * Pocket Link client (contracts/spec/link.ts): the console's one
 * authenticated TCP connection to a paired companion computer, and the two
 * guest namespaces that ride it:
 *
 *   globalThis.link   status/pair/forget/catalog/install/remove/poll
 *   globalThis.net    the NET module (contracts/spec/net.ts) whose HTTP
 *                     transport is the companion: start/take/cancel/poll/
 *                     lastError
 *
 * Worker HTTP uses link_http.h and a bounded byte-credit window. The worker
 * task exchanges commands and facts with this module through its host mailbox.
 *
 * The host owns the connection, not a guest: it survives every app switch.
 * link_reset_guest drops what belongs to the guest being torn down (net
 * handles, undelivered events, catalog replies) and keeps the connection and
 * any install already streaming into storage.
 *
 * This never blocks a frame: every socket is non-blocking and link_pump does
 * a bounded amount of work (LINK_RX_BUDGET received bytes, and therefore at
 * most that many bytes written to storage) per call. The host supplies
 * clocks, identity, storage and installs (host_services.h).
 *
 * Capture and offload builds compile the module to inert stubs: link.status()
 * reports an unpaired console, net.start() refuses with `unavailable`.
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

/* `globalThis.net` over the link. */
int32_t link_net_start(const char *meta, size_t meta_length, const uint8_t *body, size_t body_length);
/* Bytes copied, or -1 (unknown handle, not done, or wrong size). */
int32_t link_net_take(int32_t handle, uint8_t *into, size_t length);
void link_net_cancel(int32_t handle);
const char *link_net_poll(void);
const char *link_net_last_error(void);

/* The link is up and the companion advertised net.stream; link_http.c
 * checks this before starting a stream. */
bool link_http_available(void);

/* The agent channel (contracts/spec/agent.ts). Ready when the
 * link is up and the companion offered the "agent" feature. The send calls
 * queue whole frames or nothing; false means no room (or no link) now. */
bool link_agent_ready(void);
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
