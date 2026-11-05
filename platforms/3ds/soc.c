#include "soc.h"

#include <3ds.h>
#include <malloc.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>

#define SOC_BUFFER_BYTES (1024u * 1024u)
#define SOC_RETRY_COOLDOWN_MS 3000u

enum { SOC_IDLE, SOC_INITIALIZING, SOC_READY };
_Static_assert(ATOMIC_INT_LOCK_FREE == 2, "SOC requires lock-free state access");
static _Atomic int soc_state;
/* Only the initializer accesses these fields. Shutdown runs after all users
 * have stopped, including the joined offload worker. */
static bool soc_failed;
static uint64_t soc_last_failure_ms;
static uint32_t *soc_buffer;

bool soc_ensure(char *error, size_t error_length) {
  int expected = SOC_IDLE;
  if (!atomic_compare_exchange_strong(&soc_state, &expected, SOC_INITIALIZING)) {
    if (expected == SOC_READY) return true;
    if (error != NULL && error_length > 0)
      snprintf(error, error_length, "SOC initialization in progress; retry pending");
    return false;
  }
  uint64_t now = osGetTime();
  if (soc_failed && now - soc_last_failure_ms < SOC_RETRY_COOLDOWN_MS) {
    if (error != NULL && error_length > 0)
      snprintf(error, error_length, "SOC init failed recently; retry pending");
    atomic_store(&soc_state, SOC_IDLE);
    return false;
  }
  if (soc_buffer == NULL) soc_buffer = memalign(0x1000, SOC_BUFFER_BYTES);
  if (soc_buffer == NULL) {
    if (error != NULL && error_length > 0)
      snprintf(error, error_length, "network needs a 1 MiB aligned SOC buffer");
    goto failed;
  }
  Result result = socInit(soc_buffer, SOC_BUFFER_BYTES);
  if (R_FAILED(result)) {
    if (error != NULL && error_length > 0)
      snprintf(error, error_length, "socInit failed (0x%08lx)", (unsigned long)result);
    goto failed;
  }
  atomic_store(&soc_state, SOC_READY);
  return true;
failed:
  soc_failed = true;
  soc_last_failure_ms = now;
  atomic_store(&soc_state, SOC_IDLE);
  return false;
}

bool soc_active(void) {
  return atomic_load(&soc_state) == SOC_READY;
}

void soc_shutdown(void) {
  if (atomic_exchange(&soc_state, SOC_IDLE) == SOC_READY) socExit();
  /* Also release a buffer retained after a failed init. */
  free(soc_buffer);
  soc_buffer = NULL;
  soc_failed = false;
  soc_last_failure_ms = 0;
}
