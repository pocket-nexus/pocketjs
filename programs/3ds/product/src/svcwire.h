/*
 * SVC WIRE (PKNT) client transport — the host service channel (spec ops
 * 30..32) over one TCP connection to a companion process on the tethered
 * machine, discovered through its UDP beacon (contracts/spec/spec.ts
 * "SVC WIRE protocol"; platforms/vita/net/src/lib.rs is the reference
 * implementation, threaded — this one is the devserver.c shape instead:
 * non-blocking sockets pumped once per frame by the main thread).
 *
 * The guest contract is the PSP mailbox, unchanged: svcOpen is a
 * non-blocking probe the app retries, svcPoll drains complete JSON lines,
 * svcSend appends one line and is a silent no-op while disconnected.
 */

#ifndef POCKETJS_3DS_SVCWIRE_H
#define POCKETJS_3DS_SVCWIRE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* spec op 30: remember `app`, keep the transport coming up for it, report
 * the live connection state. A different app name tears the connection down
 * and rediscovers (one companion per guest, per the svc reset contract). */
bool svcwire_open(const char *app);

/* Pump discovery, connect, handshake, rx and tx — bounded, non-blocking.
 * Call once per frame from the main loop. */
void svcwire_pump(void);

/* spec op 31: copy queued host->device lines (each newline-terminated) into
 * `out`, whole lines only, up to the svc poll cap. Returns the byte count
 * (0 = idle). */
size_t svcwire_recv_lines(char *out, size_t capacity);

/* spec op 32: queue one device->host ctrl line (no trailing newline).
 * Dropped silently while disconnected or when the outbox is full. */
void svcwire_send_line(const char *line, size_t length);

/* Guest-switch reset: drop every guest-visible queue. The TCP connection
 * survives — the next guest speaking the same app id reuses it. */
void svcwire_reset(void);

void svcwire_shutdown(void);

#endif
