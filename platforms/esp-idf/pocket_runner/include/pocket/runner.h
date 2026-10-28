#pragma once
#include "esp_err.h"
#include "pocket_runtime.h"
typedef struct pocket_runner pocket_runner_t;
typedef struct {
  size_t struct_size;
  const char *task_name;
  uint32_t task_stack_bytes;
  int task_priority, task_core;
  uint32_t max_lag_us, stop_timeout_ms;
  void (*after_tick)(int32_t status, void *context);
  /* Called from stopping task; must be thread-safe and interrupt the guest. */
  void (*interrupt)(void *context);
  void *user_data;
  /* heap_caps for the task stack (MALLOC_CAP_SPIRAM for a deep guest), or 0
   * for internal RAM. */
  uint32_t task_stack_caps;
  /* Called on the runner task before each tick, with user_data. */
  void (*before_tick)(void *context);
} pocket_runner_config_t;
typedef struct {
  size_t struct_size;
  uint32_t frames, frames_skipped, frame_errors, max_frame_us;
} pocket_runner_stats_t;
void pocket_runner_config_defaults(pocket_runner_config_t *config);
/* Runtime must be booted and remain alive until stop joins the task. */
esp_err_t pocket_runner_start(pocket_runtime *runtime, uint32_t tick_hz,
                              const pocket_runner_config_t *config,
                              pocket_runner_t **out);
esp_err_t pocket_runner_stats(pocket_runner_t *runner,
                              pocket_runner_stats_t *out);
/* Timeout leaves ownership with the caller; call stop again before destruction.
 */
esp_err_t pocket_runner_stop(pocket_runner_t *runner);
