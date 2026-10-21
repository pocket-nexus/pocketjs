/*
 * SVC WIRE (PKNT) client transport for the legacy Apple hosts — the host
 * service channel (spec ops 30..32) over one TCP connection to a companion
 * process on the LAN, discovered through its UDP beacon (contracts/spec/
 * spec.ts "SVC WIRE protocol"; platforms/vita/net/src/lib.rs is the threaded
 * reference, programs/3ds/product/src/svcwire.c the frame-pumped one this file follows:
 * non-blocking BSD sockets, a bounded amount of work per frame, no threads).
 *
 * The guest contract is the PSP mailbox, unchanged: svcOpen is a
 * non-blocking probe the app retries, svcPoll drains complete JSON lines,
 * svcSend appends one line and is a silent no-op while disconnected.
 *
 * Compiled in only when POCKET_SVC_WIRE is defined (tools/ipodtouch4.ts does
 * that for apps whose companion lives on the network); every other legacy
 * Apple build keeps its op table byte-identical.
 */

#ifndef POCKETJS_IPHONE2G_SVCWIRE_H
#define POCKETJS_IPHONE2G_SVCWIRE_H

#include <stddef.h>
#include <stdint.h>

/* spec op 30: remember `app`, keep the transport coming up for it, report
 * the live connection state. A different app name tears the connection down
 * and rediscovers (one companion per guest). */
int svcwire_open(const char *app);

/* Pump discovery, connect, handshake, rx and tx — bounded, non-blocking.
 * Called once per guest frame by pocket_runtime.c. */
void svcwire_pump(void);

/* spec op 31: copy queued host->device lines (each newline-terminated) into
 * `out`, whole lines only, up to the svc poll cap. Returns the byte count
 * (0 = idle). */
size_t svcwire_recv_lines(char *out, size_t capacity);

/* spec op 32: queue one device->host ctrl line (no trailing newline).
 * Dropped silently while disconnected or when the outbox is full. */
void svcwire_send_line(const char *line, size_t length);

/* Connection state for the acceptance record: "idle", "discover",
 * "connecting", "hello", "up" or "backoff". */
const char *svcwire_state_name(void);

void svcwire_shutdown(void);

#endif
