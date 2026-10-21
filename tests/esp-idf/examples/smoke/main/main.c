#include "pocket_profile.h"
#include "esp_log.h"
#include "pocket/guest_idf.h"
#include "pocket/package_source.h"
#include "pocketjs_package_smoke.h"
#include "sample_io.h"
#include <assert.h>
#include <inttypes.h>
#include <string.h>
#if CONFIG_IDF_TARGET_ESP32P4
#include "pocketjs/esp32p4_ppa_status.h"
#endif
static void require_status(int32_t status) {
  assert(status == POCKET_STATUS_OK);
}
void app_main(void) {
  const pocketjs_package_host_contract_t *host =
      &pocketjs_package_smoke_contract;
  sample_display output;
  require_status(sample_display_init(&output, host->physical_width,
                                     host->physical_height, 16, 2));
  pocket_runtime_config config = {
      .struct_size = sizeof(config),
      .host_abi = pocket_profile.host_abi,
      .tick_hz = pocket_profile.tick_hz,
      .heap_limit = 4 * 1024 * 1024,
      .frame_buffer_budget = output.capacity * output.count,
      .profile_json = pocket_profile.profile_json,
      .profile_json_length = pocket_profile.profile_json_length};
  memcpy(config.profile_hash, pocket_profile.profile_hash, 32);
  pocket_runtime *runtime = pocket_runtime_create(&config);
  assert(runtime);
  const pocket_guest_idf_config guest_config = {4 * 1024 * 1024, 256 * 1024,
                                                true};
  pocket_guest_idf *guest = pocket_guest_idf_create(&guest_config);
  assert(guest);
  require_status(
      pocket_runtime_set_guest(runtime, pocket_guest_idf_vtable(), guest));
  pocket_memory_package package = {pocketjs_package_smoke.data,
                                   pocketjs_package_smoke.size};
  require_status(pocket_runtime_set_package_source(
      runtime, pocket_memory_package_vtable(), &package));
  require_status(
      pocket_runtime_add_input_source(runtime, sample_input_vtable(), NULL));
  uint32_t renderer_id = POCKET_RENDERER_SOFTWARE;
#if CONFIG_IDF_TARGET_ESP32P4
  pocketjs_esp32p4_ppa_t *device = NULL;
  ESP_ERROR_CHECK(pocketjs_esp32p4_ppa_create(&device));
  const pocket_ppa_config ppa_config = {.struct_size = sizeof(ppa_config),
                                        .scale = host->physical_width /
                                                 host->logical_width,
                                        .min_fill_pixels = 1024,
                                        .min_blend_pixels = 256,
                                        .min_srm_pixels = 256,
                                        .mask_budget = output.capacity / 2};
  pocket_render_esp_ppa *renderer = pocket_render_esp_ppa_create(
      &ppa_config, pocketjs_esp32p4_ppa_status_ops(device));
  assert(renderer);
  renderer_id = pocket_runtime_add_renderer(
      runtime, pocket_render_esp_ppa_vtable(), renderer);
  assert(renderer_id != POCKET_RENDERER_INVALID);
#endif
  require_status(pocket_runtime_add_display(runtime, sample_display_vtable(),
                                            &output, renderer_id));
  int32_t boot = pocket_runtime_boot(runtime);
  if (boot)
    ESP_LOGE("pocket_smoke", "boot status=%d: %s", (int)boot,
             pocket_guest_idf_error(guest));
  require_status(boot);
  require_status(pocket_runtime_tick(runtime));
  assert(output.flushes == output.waits);
  ESP_LOGI("pocket_smoke",
           "PASS target=%s hash=%016" PRIx64 " flush=%" PRIu32
           " buffers=%u bytes=%u",
           host->target_id, output.hash, output.flushes, (unsigned)output.count,
           (unsigned)(output.capacity * output.count));
  pocket_runtime_destroy(runtime);
  pocket_guest_idf_destroy(guest);
#if CONFIG_IDF_TARGET_ESP32P4
  pocket_render_esp_ppa_destroy(renderer);
  pocketjs_esp32p4_ppa_destroy(device);
#endif
  sample_display_destroy(&output);
}
