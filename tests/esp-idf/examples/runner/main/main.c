#include "pocket_profile.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "pocket/guest_idf.h"
#include "pocket/package_source.h"
#include "pocket/runner.h"
#include "pocketjs_package_runner.h"
#include "sample_io.h"
#include <assert.h>
#include <inttypes.h>
#include <string.h>
static void require_status(int32_t status) {
  assert(status == POCKET_STATUS_OK);
}
static void interrupt_guest(void *guest) { pocket_guest_idf_interrupt(guest); }
void app_main(void) {
  const pocketjs_package_host_contract_t *host =
      &pocketjs_package_runner_contract;
  sample_display output;
  require_status(sample_display_init(&output, host->physical_width,
                                     host->physical_height, 16, 2));
  pocket_runtime_config config = {
      .struct_size = sizeof(config),
      .host_abi = pocket_profile.host_abi,
      .tick_hz = pocket_profile.tick_hz,
      .heap_limit = 4 * 1024 * 1024,
      .frame_buffer_budget = output.capacity * output.count,
      .profile = pocket_profile.facts};
  memcpy(config.profile_hash, pocket_profile.profile_hash, 32);
  pocket_runtime *runtime = pocket_runtime_create(&config);
  assert(runtime);
  const pocket_guest_idf_config guest_config = {4 * 1024 * 1024, 256 * 1024,
                                                true};
  pocket_guest_idf *guest = pocket_guest_idf_create(&guest_config);
  assert(guest);
  require_status(
      pocket_runtime_set_guest(runtime, pocket_guest_idf_vtable(), guest));
  pocket_memory_package package = {pocketjs_package_runner.data,
                                   pocketjs_package_runner.size};
  require_status(pocket_runtime_set_package_source(
      runtime, pocket_memory_package_vtable(), &package));
  require_status(
      pocket_runtime_add_input_source(runtime, sample_input_vtable(), NULL));
  uint32_t renderer_id = POCKET_RENDERER_SOFTWARE;

  require_status(pocket_runtime_add_display(runtime, sample_display_vtable(),
                                            &output, renderer_id));
  int32_t boot = pocket_runtime_boot(runtime);
  if (boot)
    ESP_LOGE("pocket_smoke", "boot status=%d: %s", (int)boot,
             pocket_guest_idf_error(guest));
  require_status(boot);
  pocket_runner_config_t runner_config;
  pocket_runner_config_defaults(&runner_config);
  runner_config.interrupt = interrupt_guest;
  runner_config.user_data = guest;
  pocket_runner_t *runner = NULL;
  ESP_ERROR_CHECK(
      pocket_runner_start(runtime, &runner_config, &runner));
  vTaskDelay(pdMS_TO_TICKS(1000));
  pocket_runner_stats_t stats = {.struct_size = sizeof(stats)};
  ESP_ERROR_CHECK(pocket_runner_stats(runner, &stats));
  ESP_ERROR_CHECK(pocket_runner_stop(runner));
  ESP_LOGI("pocket_runner",
           "PASS frames=%" PRIu32 " skipped=%" PRIu32 " errors=%" PRIu32,
           stats.frames, stats.frames_skipped, stats.frame_errors);
  pocket_runtime_destroy(runtime);
  pocket_guest_idf_destroy(guest);

  sample_display_destroy(&output);
}
