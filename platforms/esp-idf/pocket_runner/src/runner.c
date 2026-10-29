#include "pocket/runner.h"

#include <stdatomic.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

struct pocket_runner {
  pocket_runtime *runtime;
  pocket_tick_schedule *schedule;
  pocket_runner_config_t config;
  SemaphoreHandle_t wake;
  SemaphoreHandle_t exited;
  SemaphoreHandle_t stats_lock;
  atomic_bool stopping;
  pocket_runner_stats_t stats;
};

void pocket_runner_config_defaults(pocket_runner_config_t *config) {
  if (config != NULL) {
    *config = (pocket_runner_config_t){
        .struct_size = sizeof(*config),
        .task_name = "pocketjs",
        .task_stack_bytes = 32U * 1024U,
        .task_priority = 5,
        .task_core = tskNO_AFFINITY,
        .max_lag_us = 500000,
        .stop_timeout_ms = 5000,
    };
  }
}

static void wait_until(pocket_runner_t *runner, int64_t deadline) {
  while (!atomic_load_explicit(&runner->stopping, memory_order_relaxed)) {
    const int64_t remaining = deadline - esp_timer_get_time();
    if (remaining <= 0)
      return;
    if (remaining > 2000) {
      const TickType_t ticks = pdMS_TO_TICKS((uint32_t)(remaining / 1000));
      (void)xSemaphoreTake(runner->wake, ticks > 1 ? ticks - 1 : 1);
    } else {
      taskYIELD();
    }
  }
}

static void runner_task(void *opaque) {
  pocket_runner_t *runner = opaque;

  while (!atomic_load_explicit(&runner->stopping, memory_order_relaxed)) {
    uint64_t deadline = 0;
    if (pocket_tick_schedule_deadline(runner->schedule, &deadline) !=
        POCKET_STATUS_OK)
      break;
    wait_until(runner, (int64_t)deadline);
    if (atomic_load_explicit(&runner->stopping, memory_order_relaxed))
      break;
    pocket_tick_timing timing = {.struct_size = sizeof(timing)};
    uint32_t ready = 0;
    if (pocket_tick_schedule_poll(runner->schedule,
                                  (uint64_t)esp_timer_get_time(), &timing,
                                  &ready) != POCKET_STATUS_OK)
      break;
    if (!ready)
      continue;
    xSemaphoreTake(runner->stats_lock, portMAX_DELAY);
    runner->stats.frames_skipped +=
        timing.skipped > UINT32_MAX ? UINT32_MAX : (uint32_t)timing.skipped;
    xSemaphoreGive(runner->stats_lock);
    const int64_t frame_started = esp_timer_get_time();
    if (runner->config.before_tick)
      runner->config.before_tick(runner->config.user_data);
    const int32_t result = pocket_runtime_tick(runner->runtime);
    if (runner->config.after_tick)
      runner->config.after_tick(result, runner->config.user_data);
    const uint32_t elapsed = (uint32_t)(esp_timer_get_time() - frame_started);
    xSemaphoreTake(runner->stats_lock, portMAX_DELAY);
    runner->stats.frames++;
    if (result != ESP_OK)
      runner->stats.frame_errors++;
    if (elapsed > runner->stats.max_frame_us)
      runner->stats.max_frame_us = elapsed;
    xSemaphoreGive(runner->stats_lock);
  }
  /* The runner may be freed once `exited` is given. */
  const uint32_t stack_caps = runner->config.task_stack_caps;
  xSemaphoreGive(runner->exited);
  if (stack_caps != 0U)
    vTaskDeleteWithCaps(NULL);
  else
    vTaskDelete(NULL);
}

esp_err_t pocket_runner_start(pocket_runtime *runtime,
                              const pocket_runner_config_t *config,
                              pocket_runner_t **out_runner) {
  if (runtime == NULL || config == NULL || out_runner == NULL ||
      config->struct_size < sizeof(*config) ||
      config->task_stack_bytes < 4096U || config->max_lag_us == 0U ||
      config->stop_timeout_ms == 0U) {
    return ESP_ERR_INVALID_ARG;
  }
  *out_runner = NULL;
  /* The booted package's rate presented at the profile cadence. */
  pocket_runtime_timing timing = {.struct_size = sizeof(timing)};
  if (pocket_runtime_get_timing(runtime, &timing) != POCKET_STATUS_OK)
    return ESP_ERR_INVALID_STATE;
  pocket_runner_t *runner = calloc(1, sizeof(*runner));
  if (runner == NULL)
    return ESP_ERR_NO_MEM;
  runner->runtime = runtime;
  runner->config = *config;
  runner->schedule = pocket_tick_schedule_create(
      timing.cadence_hz, (uint64_t)esp_timer_get_time(), config->max_lag_us);
  if (!runner->schedule) {
    free(runner);
    return ESP_ERR_INVALID_ARG;
  }
  atomic_init(&runner->stopping, false);
  runner->stats.struct_size = sizeof(runner->stats);
  runner->wake = xSemaphoreCreateBinary();
  runner->exited = xSemaphoreCreateBinary();
  runner->stats_lock = xSemaphoreCreateMutex();
  if (runner->wake == NULL || runner->exited == NULL ||
      runner->stats_lock == NULL) {
    if (runner->wake != NULL)
      vSemaphoreDelete(runner->wake);
    if (runner->exited != NULL)
      vSemaphoreDelete(runner->exited);
    if (runner->stats_lock != NULL)
      vSemaphoreDelete(runner->stats_lock);
    pocket_tick_schedule_destroy(runner->schedule);
    free(runner);
    return ESP_ERR_NO_MEM;
  }
  const char *name = config->task_name != NULL ? config->task_name : "pocketjs";
  const BaseType_t created =
      config->task_stack_caps != 0U
          ? xTaskCreatePinnedToCoreWithCaps(
                runner_task, name, config->task_stack_bytes, runner,
                config->task_priority, NULL, config->task_core,
                config->task_stack_caps)
          : xTaskCreatePinnedToCore(runner_task, name,
                                    config->task_stack_bytes, runner,
                                    config->task_priority, NULL,
                                    config->task_core);
  if (created != pdPASS) {
    vSemaphoreDelete(runner->wake);
    vSemaphoreDelete(runner->exited);
    vSemaphoreDelete(runner->stats_lock);
    pocket_tick_schedule_destroy(runner->schedule);
    free(runner);
    return ESP_ERR_NO_MEM;
  }
  *out_runner = runner;
  return ESP_OK;
}

esp_err_t pocket_runner_stats(pocket_runner_t *runner,
                              pocket_runner_stats_t *out_stats) {
  if (runner == NULL || out_stats == NULL ||
      out_stats->struct_size < sizeof(*out_stats)) {
    return ESP_ERR_INVALID_ARG;
  }
  const size_t output_size = out_stats->struct_size;
  xSemaphoreTake(runner->stats_lock, portMAX_DELAY);
  *out_stats = runner->stats;
  xSemaphoreGive(runner->stats_lock);
  out_stats->struct_size = output_size;
  return ESP_OK;
}

esp_err_t pocket_runner_stop(pocket_runner_t *runner) {
  if (runner == NULL)
    return ESP_ERR_INVALID_ARG;
  atomic_store_explicit(&runner->stopping, true, memory_order_relaxed);
  if (runner->config.interrupt)
    runner->config.interrupt(runner->config.user_data);
  (void)xSemaphoreGive(runner->wake);
  if (xSemaphoreTake(runner->exited,
                     pdMS_TO_TICKS(runner->config.stop_timeout_ms)) != pdTRUE) {
    return ESP_ERR_TIMEOUT;
  }
  vSemaphoreDelete(runner->wake);
  vSemaphoreDelete(runner->exited);
  vSemaphoreDelete(runner->stats_lock);
  pocket_tick_schedule_destroy(runner->schedule);
  free(runner);
  return ESP_OK;
}
