#ifndef POCKETJS_3DS_PUSH_TIMING_H
#define POCKETJS_3DS_PUSH_TIMING_H

/*
 * The time a runtime.push takes on the console, from the transfer's first
 * byte to the `accepted` reply, and the longest stretch the link went
 * without a pump meanwhile. When the push ends, one host `log` line
 * (runtime.logs) sums it up:
 *
 *   push <hash> accepted: <bytes> bytes, transfer <ms> ms, <ms> ms after
 *     received, longest pump gap <ms> ms at t=<ms>; longest steps <step>
 *     <ms> ms, ...
 *
 * and is sent again after the next `ready` when it may have been lost.
 *
 * Built with -DPOCKETJS_PUSH_TRACE, every step is a line of its own as it
 * ends ("push-timing <hash> <step> <ms> ms | t=<ms since the push began>
 * rx=<ms since `received`> gap=<ms since the link's last pump> | <detail>"),
 * and the lines are appended to sdmc:/pocketjs/runtime/push-timing.txt.
 * That trace found the 12.5 s of a new slot's folders (slot_folders.h).
 *
 * Builds without the link (capture, offload) and the build machine's tests
 * compile every call here to nothing.
 */

#include <stddef.h>
#include <stdint.h>

#if defined(__3DS__) && !defined(POCKETJS_CAPTURE) && !defined(POCKETJS_OFFLOAD)
#define POCKETJS_PUSH_TIMING 1
/* The system tick: the start of a step. */
uint64_t push_timing_now(void);
/* A push's stream opened: a new record. */
void push_timing_begin(uint64_t hash, uint32_t bytes);
/* True between push_timing_begin and push_timing_finish. */
int push_timing_active(void);
/* The last byte arrived and `received` is queued. */
void push_timing_received(void);
/* One step ended: its time since `since` (push_timing_now), and a detail. */
void push_timing_step(const char *step, uint64_t since, const char *format, ...) __attribute__((format(printf, 3, 4)));
/* One write of the transfer into the staging file. */
void push_timing_write(uint64_t since, size_t bytes);
/* One pump of the link, from its start to its end (link2_host.c). */
void push_timing_pumped(uint64_t start, uint64_t end);
/* The push ended: accepted, rejected, aborted or timed out. */
void push_timing_finish(const char *outcome);
/* Once a pump: sends the kept lines again when some were lost. */
void push_timing_service(void);
#else
static inline uint64_t push_timing_now(void) { return 0; }
static inline void push_timing_begin(uint64_t hash, uint32_t bytes) { (void)hash; (void)bytes; }
static inline int push_timing_active(void) { return 0; }
static inline void push_timing_received(void) {}
#define push_timing_step(step, since, ...) ((void)(step), (void)(since))
static inline void push_timing_write(uint64_t since, size_t bytes) { (void)since; (void)bytes; }
static inline void push_timing_pumped(uint64_t start, uint64_t end) { (void)start; (void)end; }
static inline void push_timing_finish(const char *outcome) { (void)outcome; }
static inline void push_timing_service(void) {}
#endif

#endif
