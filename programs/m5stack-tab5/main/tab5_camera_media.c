#include "tab5_camera_media.h"

#if TAB5_LAUNCHER
#include <stdbool.h>
#include <stdio.h>

#include "bsp/m5stack_tab5.h"
#include "esp_codec_dev.h"
#include "esp_log.h"
#include "esp_video_device.h"
#include "pocket/camera.h"
#include "pocket/media.h"
#include "pocket/package_facts.h"

static const char *TAG = "tab5_camera_media";

/* The sensor's picture is upright with the Tab5 held as the landscape
 * firmware draws: the panel's left edge on top. */
#define TAB5_CAMERA_ROTATION 0U
/* The ES8388's volume at the guest's full volume. */
#define TAB5_VOLUME_MAX 80U
/* The second core: the first runs the guest. */
#define TAB5_WORKER_CORE 1

static bool camera_ready;
static bool media_ready;
static esp_codec_dev_handle_t speaker;

static esp_err_t start_sensor(void *context) {
  (void)context;
  return bsp_camera_start(NULL);
}

static esp_err_t audio_open(void *context, uint32_t rate) {
  (void)context;
  speaker = bsp_audio_codec_speaker_init();
  if (speaker == NULL)
    return ESP_FAIL;
  esp_codec_dev_sample_info_t format = {
      .bits_per_sample = 16,
      .channel = 2,
      .sample_rate = rate,
  };
  if (esp_codec_dev_open(speaker, &format) != ESP_CODEC_DEV_OK)
    return ESP_FAIL;
  esp_codec_dev_set_out_vol(speaker, TAB5_VOLUME_MAX);
  return ESP_OK;
}

static esp_err_t audio_write(void *context, const int16_t *pcm,
                             size_t frames) {
  (void)context;
  return esp_codec_dev_write(speaker, (void *)pcm, (int)(frames * 4U)) ==
                 ESP_CODEC_DEV_OK
             ? ESP_OK
             : ESP_FAIL;
}

static void audio_volume(void *context, uint32_t percent) {
  (void)context;
  esp_codec_dev_set_out_vol(speaker, (int)(percent * TAB5_VOLUME_MAX / 100U));
}

void tab5_camera_media_install(JSContext *realm, pocket_runtime *runtime,
                               uint32_t features) {
  const bool qr = (features & POCKET_IDF_FEATURE_CAMERA_QR) != 0U;
  const bool photo = (features & POCKET_IDF_FEATURE_CAMERA_PHOTO) != 0U;
  if ((qr || photo) && !camera_ready) {
    pocketjs_camera_config_t config;
    pocketjs_camera_config_defaults(&config);
    config.device = ESP_VIDEO_MIPI_CSI_DEVICE_NAME;
    config.start_sensor = start_sensor;
    config.rotation = TAB5_CAMERA_ROTATION;
    config.storage_root = "/pocket";
    config.worker_core = TAB5_WORKER_CORE;
    camera_ready = pocketjs_camera_setup(&config) == ESP_OK;
  }
  if (camera_ready)
    ESP_ERROR_CHECK(pocketjs_camera_install(realm, runtime, qr, photo));
  if ((features & POCKET_IDF_FEATURE_MEDIA) != 0U) {
    if (!media_ready) {
      pocketjs_media_config_t config;
      pocketjs_media_config_defaults(&config);
      config.audio_open = audio_open;
      config.audio_write = audio_write;
      config.audio_volume = audio_volume;
      config.worker_core = TAB5_WORKER_CORE;
      media_ready = pocketjs_media_setup(&config) == ESP_OK;
      if (!media_ready)
        ESP_LOGE(TAG, "media did not start");
    }
    if (media_ready)
      ESP_ERROR_CHECK(pocketjs_media_install(realm, runtime));
  }
}

void tab5_camera_media_present(void) {
  if (camera_ready)
    pocketjs_camera_present();
  if (media_ready)
    pocketjs_media_present();
}

void tab5_camera_media_teardown(void) {
  if (camera_ready)
    pocketjs_camera_teardown();
  if (media_ready)
    pocketjs_media_teardown();
}
#endif
