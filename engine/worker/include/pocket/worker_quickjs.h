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
  uint32_t max_turn_micros, max_jobs, max_facts, max_bytes;
  uint32_t window_micros, quota_micros;
  void *context;
  uint64_t (*now_micros)(void *);
  /* Mount fs/db/console implementations owned by this realm. Never mount ui.
   * Called once on the owner task before evaluating application source. */
  int32_t (*mount)(void *, JSContext *);
  const JSMallocFunctions *allocator;
  void *allocator_context;
  /* Bootstrap parsing/evaluation has a separate limit (default 250000 us). */
  uint32_t max_boot_micros;
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
const char *pocket_worker_quickjs_error(const pocket_worker_quickjs *);
JSContext *pocket_worker_quickjs_context(pocket_worker_quickjs *);
/* The caller stops and destroys the resource core before destroying this
 * runtime, after producers relinquish all borrowed data. */
void pocket_worker_quickjs_destroy(pocket_worker_quickjs *);
#ifdef __cplusplus
}
#endif
#endif
