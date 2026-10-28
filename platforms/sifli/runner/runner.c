/* The thread that ticks a runtime at the profile rate. Deadlines come from
 * pocket_tick_schedule over a microsecond clock built from the RT-Thread
 * tick, so a tick lands within one OS tick of its deadline. */
#include <rtthread.h>
#include <stdatomic.h>
#include <string.h>

#include "pocket/sifli.h"

struct pocket_sifli_runner {
  pocket_runtime *runtime;
  pocket_tick_schedule *schedule;
  pocket_sifli_runner_config config;
  rt_thread_t thread;
  struct rt_semaphore wake, exited;
  struct rt_mutex stats_lock;
  atomic_bool stopping;
  rt_tick_t last_tick;
  uint64_t ticks;
  pocket_sifli_runner_stats stats;
};

void pocket_sifli_runner_config_defaults(pocket_sifli_runner_config *config) {
  if (config != NULL)
    *config = (pocket_sifli_runner_config){
        .struct_size = sizeof(*config),
        .name = "pocketjs",
        .stack_bytes = 32U * 1024U,
        .priority = RT_THREAD_PRIORITY_MAX / 2U,
        .tick_slice = 10,
        .max_lag_us = 500000,
        .stop_timeout_ms = 5000,
    };
}

/* Microseconds since start; the tick counter is widened across wraps. Only
 * the runner thread reads it. */
static uint64_t now_us(pocket_sifli_runner *runner) {
  const rt_tick_t tick = rt_tick_get();
  runner->ticks += (rt_tick_t)(tick - runner->last_tick);
  runner->last_tick = tick;
  return runner->ticks * 1000000U / RT_TICK_PER_SECOND;
}

static void wait_until(pocket_sifli_runner *runner, uint64_t deadline) {
  while (!atomic_load_explicit(&runner->stopping, memory_order_relaxed)) {
    const uint64_t now = now_us(runner);
    if (now >= deadline)
      return;
    const uint64_t ticks = (deadline - now) * RT_TICK_PER_SECOND / 1000000U;
    if (ticks == 0U)
      rt_thread_yield();
    else
      (void)rt_sem_take(&runner->wake, ticks > RT_TICK_MAX / 2U ? (rt_int32_t)(RT_TICK_MAX / 2U)
                                                               : (rt_int32_t)ticks);
  }
}

static void runner_thread(void *opaque) {
  pocket_sifli_runner *runner = opaque;
  while (!atomic_load_explicit(&runner->stopping, memory_order_relaxed)) {
    uint64_t deadline = 0;
    if (pocket_tick_schedule_deadline(runner->schedule, &deadline) != POCKET_STATUS_OK)
      break;
    wait_until(runner, deadline);
    if (atomic_load_explicit(&runner->stopping, memory_order_relaxed))
      break;
    pocket_tick_timing timing = {.struct_size = sizeof(timing)};
    uint32_t ready = 0;
    if (pocket_tick_schedule_poll(runner->schedule, now_us(runner), &timing, &ready) !=
        POCKET_STATUS_OK)
      break;
    if (!ready)
      continue;
    const uint64_t started = now_us(runner);
    if (runner->config.before_tick != NULL)
      runner->config.before_tick(runner->config.user);
    const int32_t result = pocket_runtime_tick(runner->runtime);
    if (runner->config.after_tick != NULL)
      runner->config.after_tick(result, runner->config.user);
    const uint64_t elapsed = now_us(runner) - started;
    rt_mutex_take(&runner->stats_lock, RT_WAITING_FOREVER);
    runner->stats.frames_skipped +=
        timing.skipped > UINT32_MAX ? UINT32_MAX : (uint32_t)timing.skipped;
    runner->stats.frames++;
    if (result != POCKET_STATUS_OK)
      runner->stats.frame_errors++;
    if (elapsed > runner->stats.max_frame_us)
      runner->stats.max_frame_us = elapsed > UINT32_MAX ? UINT32_MAX : (uint32_t)elapsed;
    rt_mutex_release(&runner->stats_lock);
  }
  /* The runner may be freed once `exited` is released. */
  rt_sem_release(&runner->exited);
}

int32_t pocket_sifli_runner_start(pocket_runtime *runtime, uint32_t tick_hz,
                                  const pocket_sifli_runner_config *config,
                                  pocket_sifli_runner **out) {
  if (runtime == NULL || config == NULL || out == NULL || config->struct_size < sizeof(*config) ||
      config->stack_bytes < 4096U || (uint32_t)config->priority >= RT_THREAD_PRIORITY_MAX ||
      config->tick_slice == 0U || config->max_lag_us == 0U || config->stop_timeout_ms == 0U)
    return POCKET_STATUS_INVALID;
  *out = NULL;
  pocket_sifli_runner *runner = rt_calloc(1, sizeof(*runner));
  if (runner == NULL)
    return POCKET_STATUS_FAILED;
  runner->runtime = runtime;
  runner->config = *config;
  runner->stats.struct_size = sizeof(runner->stats);
  atomic_init(&runner->stopping, false);
  runner->last_tick = rt_tick_get();
  runner->schedule = pocket_tick_schedule_create(tick_hz, 0, config->max_lag_us);
  if (runner->schedule == NULL) {
    rt_free(runner);
    return POCKET_STATUS_INVALID;
  }
  rt_sem_init(&runner->wake, "pjs_wake", 0, RT_IPC_FLAG_FIFO);
  rt_sem_init(&runner->exited, "pjs_exit", 0, RT_IPC_FLAG_FIFO);
  rt_mutex_init(&runner->stats_lock, "pjs_stat", RT_IPC_FLAG_PRIO);
  runner->thread = rt_thread_create(config->name != NULL ? config->name : "pocketjs",
                                    runner_thread, runner, config->stack_bytes,
                                    config->priority, config->tick_slice);
  if (runner->thread == RT_NULL || rt_thread_startup(runner->thread) != RT_EOK) {
    if (runner->thread != RT_NULL)
      rt_thread_delete(runner->thread);
    rt_sem_detach(&runner->wake);
    rt_sem_detach(&runner->exited);
    rt_mutex_detach(&runner->stats_lock);
    pocket_tick_schedule_destroy(runner->schedule);
    rt_free(runner);
    return POCKET_STATUS_FAILED;
  }
  *out = runner;
  return POCKET_STATUS_OK;
}

void pocket_sifli_runner_set_runtime(pocket_sifli_runner *runner, pocket_runtime *runtime) {
  if (runner != NULL && runtime != NULL)
    runner->runtime = runtime;
}

int32_t pocket_sifli_runner_stats_get(pocket_sifli_runner *runner,
                                      pocket_sifli_runner_stats *out) {
  if (runner == NULL || out == NULL || out->struct_size < sizeof(*out))
    return POCKET_STATUS_INVALID;
  const size_t size = out->struct_size;
  rt_mutex_take(&runner->stats_lock, RT_WAITING_FOREVER);
  *out = runner->stats;
  rt_mutex_release(&runner->stats_lock);
  out->struct_size = size;
  return POCKET_STATUS_OK;
}

int32_t pocket_sifli_runner_stop(pocket_sifli_runner *runner) {
  if (runner == NULL)
    return POCKET_STATUS_INVALID;
  atomic_store_explicit(&runner->stopping, true, memory_order_relaxed);
  if (runner->config.interrupt != NULL)
    runner->config.interrupt(runner->config.user);
  rt_sem_release(&runner->wake);
  const rt_int32_t timeout = rt_tick_from_millisecond((rt_int32_t)runner->config.stop_timeout_ms);
  if (rt_sem_take(&runner->exited, timeout) != RT_EOK)
    return POCKET_STATUS_FAILED;
  rt_sem_detach(&runner->wake);
  rt_sem_detach(&runner->exited);
  rt_mutex_detach(&runner->stats_lock);
  pocket_tick_schedule_destroy(runner->schedule);
  rt_free(runner);
  return POCKET_STATUS_OK;
}
