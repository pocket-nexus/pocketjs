#include "pocket/worker_runner.h"
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct pocket_worker_runner {
  pocket_worker_runner_config config;
  pocket_worker *core;
  pocket_worker_quickjs *realm;
  atomic_int stopping, resumed, failed;
  char error[512];
};
static uint64_t now(pocket_worker_runner *r) {
  return r->config.core.now_micros(r->config.core.context);
}
static void wake(pocket_worker_runner *r) {
  if (r->config.core.wake)
    r->config.core.wake(r->config.core.context);
}
static void wait_until(pocket_worker_runner *r, uint64_t deadline) {
  r->config.wait(r->config.context, deadline);
}
static void fail(pocket_worker_runner *r, const char *message) {
  snprintf(r->error, sizeof r->error, "%s", message);
  atomic_store(&r->failed, 1);
}
pocket_worker_runner *
pocket_worker_runner_create(const pocket_worker_runner_config *c) {
  if (!c || c->struct_size < sizeof *c || !c->source || !c->wait ||
      !c->core.now_micros)
    return NULL;
  pocket_worker_runner *r = calloc(1, sizeof *r);
  if (!r)
    return NULL;
  r->config = *c;
  r->config.core.struct_size = sizeof r->config.core;
  atomic_init(&r->stopping, 0);
  atomic_init(&r->resumed, !c->start_paused);
  atomic_init(&r->failed, 0);
  r->core = pocket_worker_create(&r->config.core);
  if (!r->core) {
    fail(r, "worker core allocation failed");
    return r;
  }
  pocket_worker_quickjs_config realm = r->config.realm;
  realm.struct_size = sizeof realm;
  realm.worker = r->core;
  if (!realm.now_micros) {
    realm.now_micros = r->config.core.now_micros;
    if (!realm.context)
      realm.context = r->config.core.context;
  }
  r->realm = pocket_worker_quickjs_create(&realm);
  if (!r->realm) {
    fail(r, "worker realm allocation failed");
    return r;
  }
  if (pocket_worker_quickjs_eval(r->realm, c->source, c->source_size,
                                 "worker.js") != 0)
    fail(r, pocket_worker_quickjs_error(r->realm));
  return r;
}
void pocket_worker_runner_run(pocket_worker_runner *r) {
  if (!r || atomic_load(&r->failed))
    return;
  while (!atomic_load(&r->resumed) && !atomic_load(&r->stopping))
    wait_until(r, UINT64_MAX);
  while (!atomic_load(&r->stopping)) {
    pocket_worker_context context = {.struct_size = sizeof context,
                                     .now_micros = now(r)};
    int32_t result = pocket_worker_quickjs_step(r->realm, &context);
    if (r->config.after_turn)
      r->config.after_turn(r->config.context);
    if (result < 0) {
      fail(r, pocket_worker_quickjs_error(r->realm));
      break;
    }
    if (result > 0)
      continue;
    uint64_t deadline = pocket_worker_quickjs_deadline(r->realm);
    if (deadline != UINT64_MAX && deadline <= now(r))
      continue;
    wait_until(r, deadline);
  }
  /* A faulted realm keeps its core until the owner asks to stop: native
   * producers and the UI bridge still hold it. */
  while (!atomic_load(&r->stopping))
    wait_until(r, UINT64_MAX);
}
void pocket_worker_runner_stop(pocket_worker_runner *r) {
  if (!r)
    return;
  atomic_store(&r->stopping, 1);
  wake(r);
}
void pocket_worker_runner_resume(pocket_worker_runner *r) {
  if (!r)
    return;
  atomic_store(&r->resumed, 1);
  wake(r);
}
int pocket_worker_runner_failed(const pocket_worker_runner *r) {
  return r ? atomic_load(&r->failed) : 1;
}
const char *pocket_worker_runner_error(const pocket_worker_runner *r) {
  return r ? r->error : "missing worker runner";
}
pocket_worker *pocket_worker_runner_core(pocket_worker_runner *r) {
  return r ? r->core : NULL;
}
void pocket_worker_runner_destroy(pocket_worker_runner *r) {
  if (!r)
    return;
  if (r->core) {
    /* Retry at 1 ms while a driver, DMA engine or callback still reaches the
     * core; the platform's wait sleeps or services its mailbox meanwhile. */
    while (pocket_worker_destroy(r->core) == POCKET_WORKER_BUSY)
      wait_until(r, now(r) + 1000);
    r->core = NULL;
  }
  if (r->realm)
    pocket_worker_quickjs_destroy(r->realm);
  free(r);
}
