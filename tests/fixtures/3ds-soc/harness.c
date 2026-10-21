#include <assert.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sched.h>
#include "3ds.h"
#include "../../../platforms/3ds/soc.h"

static _Atomic int initializations, exits, allocations;
static _Atomic bool entered, release_init;
static bool fail_init, fail_alloc;
static uint64_t now;
uint64_t osGetTime(void) { return now; }
void *memalign(size_t alignment, size_t size) {
  allocations++;
  if (fail_alloc) return NULL;
  return aligned_alloc(alignment, size);
}
Result socInit(uint32_t *buffer, size_t size) {
  assert(buffer && (uintptr_t)buffer % 4096 == 0 && size == 1024 * 1024);
  initializations++;
  atomic_store(&entered, true);
  while (!atomic_load(&release_init)) sched_yield();
  return fail_init ? -1 : 0;
}
void socExit(void) { exits++; }
static void *initialize(void *unused) { (void)unused; assert(soc_ensure(NULL, 0)); return NULL; }
int main(void) {
  pthread_t worker;
  assert(!pthread_create(&worker, NULL, initialize, NULL));
  while (!atomic_load(&entered)) sched_yield();
  /* A simultaneous UI caller returns immediately, without a second init. */
  assert(!soc_ensure(NULL, 0));
  assert(!soc_active());
  assert(initializations == 1 && allocations == 1);
  atomic_store(&release_init, true);
  assert(!pthread_join(worker, NULL));
  assert(soc_active() && soc_ensure(NULL, 0));
  assert(initializations == 1);
  soc_shutdown(); soc_shutdown();
  assert(exits == 1 && !soc_active());

  fail_init = true;
  assert(!soc_ensure(NULL, 0));
  now = 2999;
  assert(!soc_ensure(NULL, 0) && initializations == 2);
  now = 3000; fail_init = false;
  assert(soc_ensure(NULL, 0) && initializations == 3 && allocations == 2);
  soc_shutdown();
  assert(exits == 2);

  /* Shutdown releases the allocation even if SOC never became usable. */
  fail_init = true;
  assert(!soc_ensure(NULL, 0));
  soc_shutdown();
  assert(exits == 2);
  fail_alloc = true;
  assert(!soc_ensure(NULL, 0));
  soc_shutdown();
  fail_alloc = fail_init = false;
  assert(soc_ensure(NULL, 0));
  soc_shutdown();
  puts("SOC concurrent init, cooldown, recovery and shutdown verified");
}
