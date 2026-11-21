#ifndef POCKET_WORKER_RUNNER_H
#define POCKET_WORKER_RUNNER_H
#include "pocket/worker_quickjs.h"
#ifdef __cplusplus
extern "C" {
#endif
/* One worker domain on its owner task: the resource core, the QuickJS realm,
 * the bootstrap evaluation and the step/wait loop. The platform supplies the
 * task, its lock and notification primitives and a monotonic clock; the
 * runner holds the ordering rules that every platform otherwise repeats. */
typedef struct pocket_worker_runner pocket_worker_runner;
typedef struct {
  uint32_t struct_size;
  /* The core's node table, generation, task-context lock/unlock, wake and
   * clock (pocket_worker_config). The runner calls wake to interrupt wait. */
  pocket_worker_config core;
  /* Realm limits, mount and allocator (pocket_worker_quickjs_config). The
   * runner sets worker; now_micros and context default to the core's. */
  pocket_worker_quickjs_config realm;
  /* The NUL-terminated worker bundle, borrowed until destroy. source_size
   * excludes the terminator. NULL when the bundle is bytecode alone. */
  const char *source;
  size_t source_size;
  void *context;
  /* Block the owner task until the core's wake or the absolute deadline in
   * microseconds; UINT64_MAX means no deadline. A wake that arrived since the
   * previous wait returns immediately: the notification stays pending across
   * the check-to-wait transition. A deadline at or before now returns at
   * once. */
  void (*wait)(void *, uint64_t deadline_micros);
  /* Optional: runs on the owner task after every turn, outside JS. */
  void (*after_turn)(void *);
  /* Bootstrap, then hold turns until pocket_worker_runner_resume. */
  int start_paused;
  /* Optional: the worker bundle as a package bytecode section, evaluated
   * instead of source when its digest is engine_abi, this build's 32-byte
   * engine ABI (contracts/generated/pocket_quickjs_abi.h); another build's
   * bytecode falls back to source. Borrowed until destroy. */
  const uint8_t *bytecode;
  size_t bytecode_size;
  const uint8_t *engine_abi;
} pocket_worker_runner_config;

/* Creates the core and the realm and evaluates the bundle on the calling
 * task, which becomes the owner task. NULL only when the runner itself cannot
 * be allocated; a bootstrap failure returns a runner whose error names the
 * cause and whose failed flag is set, so the owner can report it and destroy
 * the runner. */
pocket_worker_runner *
pocket_worker_runner_create(const pocket_worker_runner_config *);
/* The owner task's loop. Steps the realm while it has work, waits through
 * config->wait until the next deadline or wake while idle, and returns once
 * stop was requested. After a realm fault the loop keeps the core alive
 * until stop is requested, so a UI bridge detaches before destroy. */
void pocket_worker_runner_run(pocket_worker_runner *);
/* Any task after create returned: end the loop, interrupting a turn in
 * progress. Also releases a paused runner. */
void pocket_worker_runner_stop(pocket_worker_runner *);
/* Any task: let a runner created with start_paused execute turns. */
void pocket_worker_runner_resume(pocket_worker_runner *);
int pocket_worker_runner_failed(const pocket_worker_runner *);
/* Empty while the realm runs; the fault or bootstrap message otherwise. */
const char *pocket_worker_runner_error(const pocket_worker_runner *);
/* The resource core, for pocket_worker_ui_attach and native producers. Valid
 * until destroy, including after a fault. */
pocket_worker *pocket_worker_runner_core(pocket_worker_runner *);
/* Owner task, after run returned or after a failed create: shuts the core
 * down, waits through config->wait while native users remain, destroys the
 * realm and frees the runner. */
void pocket_worker_runner_destroy(pocket_worker_runner *);
#ifdef __cplusplus
}
#endif
#endif
