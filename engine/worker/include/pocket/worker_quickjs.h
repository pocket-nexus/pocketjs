#ifndef POCKET_WORKER_QUICKJS_H
#define POCKET_WORKER_QUICKJS_H
#include "pocket/worker.h"
#include "quickjs.h"
#ifdef __cplusplus
extern "C" {
#endif
typedef struct pocket_worker_quickjs pocket_worker_quickjs;
typedef struct {
  uint32_t struct_size;
  pocket_worker *worker;
  size_t heap_limit, stack_limit;
  /* Per-step bounds: Promise jobs executed after the turn callback returns
   * (default 64), facts observed per turn (default 16, at most 64) and their
   * payload bytes (default 8192). The job bound is a count, never a time, so
   * a replay splits a continuation chain at the same place. */
  uint32_t max_jobs, max_facts, max_bytes;
  /* Optional CPU share: at most quota_micros of JS execution per
   * window_micros. Zero quota disables it (the default). A platform sets it
   * when the worker task outranks the UI task on the same core, where the
   * scheduler would not give the UI any time. */
  uint32_t window_micros, quota_micros;
  void *context;
  uint64_t (*now_micros)(void *);
  /* Mount fs/db/console implementations owned by this realm. Never mount ui.
   * Called once on the owner task before evaluating application source. */
  int32_t (*mount)(void *, JSContext *);
  const JSMallocFunctions *allocator;
  void *allocator_context;
} pocket_worker_quickjs_config;
pocket_worker_quickjs *
pocket_worker_quickjs_create(const pocket_worker_quickjs_config *);
int32_t pocket_worker_quickjs_eval(pocket_worker_quickjs *, const char *,
                                   size_t, const char *);
/* Call only on the owning host task. Returns 1 after a turn, 0 when idle or
 * throttled, -1 on domain fault. The caller blocks on wake or next_deadline.
 * Context time is latched for the entire turn; sequence/generation are filled
 * by the adapter. New producer events are observed in a later step. */
int32_t pocket_worker_quickjs_step(pocket_worker_quickjs *,
                                   const pocket_worker_context *);
uint64_t pocket_worker_quickjs_deadline(pocket_worker_quickjs *);
/* Any task while the realm exists: the JS execution in progress, or the next
 * one, ends with a fault. There is no execution time limit; this is how a
 * stop reaches a turn that never returns. */
void pocket_worker_quickjs_interrupt(pocket_worker_quickjs *);
const char *pocket_worker_quickjs_error(const pocket_worker_quickjs *);
JSContext *pocket_worker_quickjs_context(pocket_worker_quickjs *);
/* The caller stops and destroys the resource core before destroying this
 * runtime, after producers relinquish all borrowed data. */
void pocket_worker_quickjs_destroy(pocket_worker_quickjs *);
#ifdef __cplusplus
}
#endif
#endif
