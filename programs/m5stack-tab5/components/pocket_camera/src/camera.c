/*
 * `globalThis.camera` on the ESP32-P4 — see pocketjs/camera.h.
 *
 * Tasks. A capture task streams the sensor through esp_video (V4L2, RGB565
 * from the ISP) and turns each frame upright with the PPA: a centered 4:3
 * crop, scaled by a sixteenth-step factor, rotated and mirrored, into one of
 * three preview buffers in the core's PSM_5650 (red in the low bits). The
 * owner task copies the newest one into the camera texture between turns.
 * At most every CAMERA_SCAN_MS the capture task hands the frame's luma to a
 * decode task that runs quirc. A still is the next frame cropped the same
 * way at 640x480, handed to photos.c for the JPEG encoder.
 */

#include "pocket/camera.h"

#include <errno.h>
#include <fcntl.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>

#include "driver/ppa.h"
#include "esp_cache.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "esp_video_device.h"
#include "esp_video_isp_ioctl.h"
#include "linux/videodev2.h"
#include "photos.h"
#include "pocket/textures.h"
#include "quickjs.h"
#include "quirc/quirc.h"

/* contracts/spec/camera.ts */
#define CAMERA_WIDTH 320u
#define CAMERA_HEIGHT 240u
#define CAMERA_TEXTURE_WIDTH 512u
#define CAMERA_TEXTURE_HEIGHT 256u
#define CAMERA_QR_MAX_BYTES 512u
#define CAMERA_OPEN_INNER 1
#define CAMERA_OPEN_NO_SCAN 2
#define PHOTO_WIDTH 640u
#define PHOTO_HEIGHT 480u
/* contracts/spec/spec.ts: PSM_5650 and IMG_FLAG_LINEAR. */
#define PSM_5650 0u
#define IMG_FLAG_LINEAR 2u

#define CAMERA_FRAME_BYTES (CAMERA_WIDTH * CAMERA_HEIGHT * 2u)
/* Four decode passes a second find a code held in front of the lens. */
#define CAMERA_SCAN_MS 250u
/* The viewfinder shows every second sensor frame (15 of 30 a second): a
 * preview costs PPA and PSRAM time the UI's 33 ms frame needs for its own
 * presents. */
#define CAMERA_PREVIEW_DIVIDER 2u
/* One buffer the PPA writes, the newest complete one, and the one the owner
 * task is reading. */
#define CAMERA_BUFFERS 3
#define VIDEO_BUFFERS 2
#define CAPTURE_STACK (6u * 1024u)
#define DECODE_STACK (12u * 1024u)

static const char *TAG = "pocketjs_camera";

enum { CAPTURE_STARTING, CAPTURE_RUNNING, CAPTURE_FAILED };

static pocketjs_camera_config_t board;
static bool configured;
static bool sensor_started;
static pocket_runtime *runtime;
static bool admitted_qr;
static bool admitted_photo;

static bool open_now;
static int32_t texture_handle = -1;
static int32_t open_flags;
static uint16_t *previews[CAMERA_BUFFERS];
static uint8_t *scan_luma;
static TaskHandle_t capture_task;
static TaskHandle_t decode_task;
static SemaphoreHandle_t capture_exited;
static SemaphoreHandle_t decode_exited;
static _Atomic bool stopping;
static _Atomic int capture_state;
static _Atomic bool scan_wanted;
static _Atomic bool scan_busy;
static _Atomic uint32_t frames;
static _Atomic uint32_t scans;
static _Atomic uint32_t stills;
static _Atomic int32_t still_wanted;
static _Atomic uint32_t decode_ms;
static int64_t last_scan_us;
static char error[160];

/* Buffer hand-off between the capture task and the owner task. */
static SemaphoreHandle_t buffer_lock;
static int latest = -1;
static int reading = -1;

static SemaphoreHandle_t payload_lock;
static char payload[CAMERA_QR_MAX_BYTES + 1];
static size_t payload_length;
static uint32_t payload_sequence;
static uint32_t polled_sequence;
static char poll_out[CAMERA_QR_MAX_BYTES + 1];
static char info_out[448];

void pocketjs_camera_config_defaults(pocketjs_camera_config_t *config) {
  if (config != NULL) {
    *config = (pocketjs_camera_config_t){
        .struct_size = sizeof(*config),
        .storage_root = "/pocket",
        .worker_core = tskNO_AFFINITY,
    };
  }
}

esp_err_t pocketjs_camera_setup(const pocketjs_camera_config_t *config) {
  if (config == NULL || config->struct_size < sizeof(*config) ||
      config->device == NULL || config->storage_root == NULL ||
      config->rotation % 90U != 0 || config->rotation >= 360U)
    return ESP_ERR_INVALID_ARG;
  board = *config;
  configured = true;
  photos_setup(config->storage_root, config->worker_core);
  return ESP_OK;
}

// ---------------------------------------------------------------------------
// the upright crop
// ---------------------------------------------------------------------------

typedef struct {
  uint32_t x, y, w, h;
  float scale;
  ppa_srm_rotation_angle_t angle;
} transform_t;

/* The centered out_w x out_h (4:3) crop of the upright picture, scaled by
 * the smallest sixteenth-step factor that still fits the sensor (the PPA
 * scales in steps of 1/16), as a block of the sensor's picture. */
static bool plan_transform(uint32_t sensor_w, uint32_t sensor_h,
                           uint32_t out_w, uint32_t out_h, transform_t *t) {
  const bool turned = board.rotation == 90U || board.rotation == 270U;
  const uint32_t upright_w = turned ? sensor_h : sensor_w;
  const uint32_t upright_h = turned ? sensor_w : sensor_h;
  for (uint32_t k = 1; k <= 16U; ++k) {
    if ((out_w * 16U) % k != 0 || (out_h * 16U) % k != 0)
      continue;
    const uint32_t crop_w = out_w * 16U / k;
    const uint32_t crop_h = out_h * 16U / k;
    if (crop_w > upright_w || crop_h > upright_h)
      continue;
    t->w = turned ? crop_h : crop_w;
    t->h = turned ? crop_w : crop_h;
    t->x = (sensor_w - t->w) / 2U;
    t->y = (sensor_h - t->h) / 2U;
    t->scale = (float)k / 16.0f;
    /* The PPA turns counter-clockwise. */
    static const ppa_srm_rotation_angle_t counter[4] = {
        PPA_SRM_ROTATION_ANGLE_0, PPA_SRM_ROTATION_ANGLE_270,
        PPA_SRM_ROTATION_ANGLE_180, PPA_SRM_ROTATION_ANGLE_90};
    t->angle = counter[board.rotation / 90U];
    return true;
  }
  return false;
}

static esp_err_t transform(ppa_client_handle_t client, const void *frame,
                           uint32_t sensor_w, uint32_t sensor_h,
                           const transform_t *t, void *out, uint32_t out_w,
                           uint32_t out_h, bool mirror, bool swap) {
  const bool turned = board.rotation == 90U || board.rotation == 270U;
  const ppa_srm_oper_config_t operation = {
      .in = {.buffer = frame, .pic_w = sensor_w, .pic_h = sensor_h,
             .block_w = t->w, .block_h = t->h, .block_offset_x = t->x,
             .block_offset_y = t->y, .srm_cm = PPA_SRM_COLOR_MODE_RGB565},
      .out = {.buffer = out, .buffer_size = out_w * out_h * 2U,
              .pic_w = out_w, .pic_h = out_h,
              .srm_cm = PPA_SRM_COLOR_MODE_RGB565},
      .rotation_angle = t->angle,
      .scale_x = t->scale,
      .scale_y = t->scale,
      /* A mirror across the upright picture's vertical axis: the sensor's
       * other axis when the picture turns a quarter. */
      .mirror_x = mirror && !turned,
      .mirror_y = mirror && turned,
      .rgb_swap = swap,
      .mode = PPA_TRANS_MODE_BLOCKING,
  };
  return ppa_do_scale_rotate_mirror(client, &operation);
}

// ---------------------------------------------------------------------------
// capture task
// ---------------------------------------------------------------------------

/* A buffer neither newest nor being read. */
static int pick_write_buffer(int previous) {
  xSemaphoreTake(buffer_lock, portMAX_DELAY);
  int chosen = -1;
  for (int offset = 1; offset <= CAMERA_BUFFERS; offset += 1) {
    int candidate = (previous + offset) % CAMERA_BUFFERS;
    if (candidate != latest && candidate != reading) {
      chosen = candidate;
      break;
    }
  }
  xSemaphoreGive(buffer_lock);
  return chosen;
}

/* Luma of a PSM_5650 preview for quirc: BT.601 weights on 5/6/5 channels
 * scaled to 8 bits. */
static void fill_luma(const uint16_t *pixels) {
  for (size_t i = 0; i < CAMERA_WIDTH * CAMERA_HEIGHT; i += 1) {
    const uint16_t pixel = pixels[i];
    const uint32_t r = pixel & 0x1fu, g = (pixel >> 5) & 0x3fu, b = pixel >> 11;
    scan_luma[i] =
        (uint8_t)((r * 8u * 77u + g * 4u * 150u + b * 8u * 29u) >> 8);
  }
}

static void take_still(ppa_client_handle_t client, const void *frame,
                       uint32_t sensor_w, uint32_t sensor_h, int32_t job) {
  transform_t t;
  if (!plan_transform(sensor_w, sensor_h, PHOTO_WIDTH, PHOTO_HEIGHT, &t)) {
    photos_fail(job, "the camera picture is smaller than a photo");
    return;
  }
  uint16_t *still = photos_alloc_still(PHOTO_WIDTH, PHOTO_HEIGHT);
  if (still == NULL) {
    photos_fail(job, "no memory for a photo");
    return;
  }
  /* Never mirrored, in the JPEG encoder's RGB565 (red in the high bits). */
  if (transform(client, frame, sensor_w, sensor_h, &t, still, PHOTO_WIDTH,
                PHOTO_HEIGHT, false, false) != ESP_OK) {
    free(still);
    photos_fail(job, "the camera did not deliver a photo");
    return;
  }
  atomic_fetch_add(&stills, 1);
  photos_save(job, still, PHOTO_WIDTH, PHOTO_HEIGHT);
}

static bool start_stream(int fd, uint32_t *width, uint32_t *height,
                         uint8_t **buffers, size_t *lengths) {
  struct v4l2_format format = {.type = V4L2_BUF_TYPE_VIDEO_CAPTURE};
  if (ioctl(fd, VIDIOC_G_FMT, &format) != 0)
    return false;
  if (format.fmt.pix.pixelformat != V4L2_PIX_FMT_RGB565) {
    format.fmt.pix.pixelformat = V4L2_PIX_FMT_RGB565;
    if (ioctl(fd, VIDIOC_S_FMT, &format) != 0)
      return false;
  }
  *width = format.fmt.pix.width;
  *height = format.fmt.pix.height;
  struct v4l2_requestbuffers request = {
      .count = VIDEO_BUFFERS,
      .type = V4L2_BUF_TYPE_VIDEO_CAPTURE,
      .memory = V4L2_MEMORY_MMAP,
  };
  if (ioctl(fd, VIDIOC_REQBUFS, &request) != 0)
    return false;
  for (uint32_t i = 0; i < VIDEO_BUFFERS; ++i) {
    struct v4l2_buffer buffer = {.type = V4L2_BUF_TYPE_VIDEO_CAPTURE,
                                 .memory = V4L2_MEMORY_MMAP,
                                 .index = i};
    if (ioctl(fd, VIDIOC_QUERYBUF, &buffer) != 0)
      return false;
    buffers[i] = mmap(NULL, buffer.length, PROT_READ | PROT_WRITE, MAP_SHARED,
                      fd, buffer.m.offset);
    lengths[i] = buffer.length;
    if (buffers[i] == NULL || ioctl(fd, VIDIOC_QBUF, &buffer) != 0)
      return false;
  }
  int type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
  return ioctl(fd, VIDIOC_STREAMON, &type) == 0;
}

static void capture_run(void *argument) {
  (void)argument;
  ppa_client_handle_t client = NULL;
  const ppa_client_config_t client_config = {
      .oper_type = PPA_OPERATION_SRM,
      .max_pending_trans_num = 1,
  };
  int fd = open(board.device, O_RDONLY);
  uint8_t *buffers[VIDEO_BUFFERS] = {0};
  size_t lengths[VIDEO_BUFFERS] = {0};
  uint32_t width = 0, height = 0;
  transform_t preview;
  if (fd < 0 || ppa_register_client(&client_config, &client) != ESP_OK ||
      !start_stream(fd, &width, &height, buffers, lengths) ||
      !plan_transform(width, height, CAMERA_WIDTH, CAMERA_HEIGHT, &preview)) {
    snprintf(error, sizeof error, "the camera did not start (%s %lux%lu)",
             board.device, (unsigned long)width, (unsigned long)height);
    ESP_LOGE(TAG, "%s: errno %d", error, errno);
    atomic_store(&capture_state, CAPTURE_FAILED);
  } else {
    atomic_store(&capture_state, CAPTURE_RUNNING);
    ESP_LOGI(TAG, "streaming %lux%lu, preview crop %lux%lu at %.4f",
             (unsigned long)width, (unsigned long)height,
             (unsigned long)preview.w, (unsigned long)preview.h,
             (double)preview.scale);
  }
  int writing = 0;
  uint32_t sensor_frames = 0;
  while (atomic_load(&capture_state) == CAPTURE_RUNNING &&
         !atomic_load(&stopping)) {
    struct v4l2_buffer buffer = {.type = V4L2_BUF_TYPE_VIDEO_CAPTURE,
                                 .memory = V4L2_MEMORY_MMAP};
    if (ioctl(fd, VIDIOC_DQBUF, &buffer) != 0) {
      vTaskDelay(pdMS_TO_TICKS(10));
      continue;
    }
    const void *frame = buffers[buffer.index];
    const int32_t job = atomic_exchange(&still_wanted, 0);
    const bool shown = sensor_frames++ % CAMERA_PREVIEW_DIVIDER == 0;
    if ((buffer.flags & V4L2_BUF_FLAG_ERROR) == 0) {
      if (job != 0)
        take_still(client, frame, width, height, job);
      writing = shown ? pick_write_buffer(writing) : -1;
      if (writing >= 0 &&
          transform(client, frame, width, height, &preview, previews[writing],
                    CAMERA_WIDTH, CAMERA_HEIGHT,
                    (open_flags & CAMERA_OPEN_INNER) != 0, true) == ESP_OK) {
        esp_cache_msync(previews[writing], CAMERA_FRAME_BYTES,
                        ESP_CACHE_MSYNC_FLAG_DIR_M2C);
        if (decode_task != NULL && atomic_load(&scan_wanted) &&
            !atomic_load(&scan_busy)) {
          fill_luma(previews[writing]);
          atomic_store(&scan_wanted, false);
          atomic_store(&scan_busy, true);
          xTaskNotifyGive(decode_task);
        }
        xSemaphoreTake(buffer_lock, portMAX_DELAY);
        latest = writing;
        xSemaphoreGive(buffer_lock);
        atomic_fetch_add(&frames, 1);
      }
    } else if (job != 0) {
      atomic_store(&still_wanted, job);
    }
    ioctl(fd, VIDIOC_QBUF, &buffer);
  }
  if (fd >= 0) {
    int type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    ioctl(fd, VIDIOC_STREAMOFF, &type);
    for (uint32_t i = 0; i < VIDEO_BUFFERS; ++i)
      if (buffers[i] != NULL)
        munmap(buffers[i], lengths[i]);
    close(fd);
  }
  if (client != NULL)
    ppa_unregister_client(client);
  xSemaphoreGive(capture_exited);
  vTaskDeleteWithCaps(NULL);
}

// ---------------------------------------------------------------------------
// decode task
// ---------------------------------------------------------------------------

/* quirc's decoded code and payload: 13 KB, in PSRAM with the task. */
typedef struct {
  struct quirc_code code;
  struct quirc_data data;
} qr_result_t;

static void scan(struct quirc *decoder, qr_result_t *qr) {
  int width = 0, height = 0;
  uint8_t *luma = quirc_begin(decoder, &width, &height);
  memcpy(luma, scan_luma, CAMERA_WIDTH * CAMERA_HEIGHT);
  quirc_end(decoder);
  const int count = quirc_count(decoder);
  for (int index = 0; index < count; index += 1) {
    quirc_extract(decoder, index, &qr->code);
    quirc_decode_error_t result = quirc_decode(&qr->code, &qr->data);
    if (result == QUIRC_ERROR_DATA_ECC) {
      quirc_flip(&qr->code);
      result = quirc_decode(&qr->code, &qr->data);
    }
    if (result != QUIRC_SUCCESS || qr->data.payload_len <= 0 ||
        (size_t)qr->data.payload_len > CAMERA_QR_MAX_BYTES)
      continue;
    xSemaphoreTake(payload_lock, portMAX_DELAY);
    memcpy(payload, qr->data.payload, (size_t)qr->data.payload_len);
    payload_length = (size_t)qr->data.payload_len;
    payload[payload_length] = '\0';
    payload_sequence += 1;
    xSemaphoreGive(payload_lock);
  }
}

static void decode_run(void *argument) {
  (void)argument;
  struct quirc *decoder = quirc_new();
  qr_result_t *qr = heap_caps_malloc(sizeof *qr, MALLOC_CAP_SPIRAM);
  if (decoder == NULL || qr == NULL ||
      quirc_resize(decoder, CAMERA_WIDTH, CAMERA_HEIGHT) < 0) {
    /* The preview still runs without decoding. */
    snprintf(error, sizeof error, "QR decoder allocation failed");
  } else {
    while (!atomic_load(&stopping)) {
      ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(100));
      if (atomic_load(&stopping))
        break;
      if (!atomic_load(&scan_busy))
        continue;
      const int64_t started = esp_timer_get_time();
      scan(decoder, qr);
      atomic_store(&decode_ms,
                   (uint32_t)((esp_timer_get_time() - started) / 1000));
      atomic_fetch_add(&scans, 1);
      atomic_store(&scan_busy, false);
    }
  }
  if (decoder != NULL)
    quirc_destroy(decoder);
  free(qr);
  xSemaphoreGive(decode_exited);
  vTaskDeleteWithCaps(NULL);
}

// ---------------------------------------------------------------------------
// open and close
// ---------------------------------------------------------------------------

static void stop_capture(void) {
  if (capture_task != NULL || decode_task != NULL) {
    atomic_store(&stopping, true);
    if (decode_task != NULL)
      xTaskNotifyGive(decode_task);
    if (capture_task != NULL)
      xSemaphoreTake(capture_exited, portMAX_DELAY);
    if (decode_task != NULL)
      xSemaphoreTake(decode_exited, portMAX_DELAY);
    capture_task = NULL;
    decode_task = NULL;
  }
  latest = -1;
  reading = -1;
  atomic_store(&scan_busy, false);
  atomic_store(&scan_wanted, false);
}

static bool allocate_buffers(void) {
  if (buffer_lock == NULL) {
    buffer_lock = xSemaphoreCreateMutex();
    payload_lock = xSemaphoreCreateMutex();
    capture_exited = xSemaphoreCreateBinary();
    decode_exited = xSemaphoreCreateBinary();
  }
  for (int i = 0; i < CAMERA_BUFFERS; i += 1) {
    if (previews[i] == NULL)
      previews[i] = heap_caps_aligned_calloc(128, 1, CAMERA_FRAME_BYTES,
                                             MALLOC_CAP_SPIRAM);
  }
  if (scan_luma == NULL)
    scan_luma = heap_caps_malloc(CAMERA_WIDTH * CAMERA_HEIGHT,
                                 MALLOC_CAP_SPIRAM);
  bool ready = buffer_lock != NULL && payload_lock != NULL &&
               capture_exited != NULL && decode_exited != NULL &&
               scan_luma != NULL;
  for (int i = 0; i < CAMERA_BUFFERS; i += 1)
    ready = ready && previews[i] != NULL;
  return ready;
}

/* The tasks for the camera `open_flags` names. */
/* The ISP keeps the colour matrix the image pipeline last set, and the
 * pipeline's own values run past the hardware's (-4, 4) range: the first
 * stream only logged the rejected reconfigurations, the next start failed
 * on the stored matrix and the preview stayed black. Each start begins
 * from the identity. */
static void reset_color_matrix(void) {
  const int isp = open(ESP_VIDEO_ISP1_DEVICE_NAME, O_RDWR);
  if (isp < 0)
    return;
  esp_video_isp_ccm_t ccm = {.enable = true};
  for (int i = 0; i < ISP_CCM_DIMENSION; i++)
    ccm.matrix[i][i] = 1.0f;
  struct v4l2_ext_control control = {.id = V4L2_CID_USER_ESP_ISP_CCM,
                                     .p_u8 = (uint8_t *)&ccm};
  struct v4l2_ext_controls controls = {
      .ctrl_class = V4L2_CID_USER_CLASS, .count = 1, .controls = &control};
  if (ioctl(isp, VIDIOC_S_EXT_CTRLS, &controls) != 0)
    ESP_LOGW(TAG, "the colour matrix did not reset: errno %d", errno);
  close(isp);
}

static bool start_capture(void) {
  if (!allocate_buffers()) {
    snprintf(error, sizeof error, "camera buffers did not fit in memory");
    return false;
  }
  if (!sensor_started && board.start_sensor != NULL) {
    const esp_err_t started = board.start_sensor(board.context);
    if (started != ESP_OK) {
      snprintf(error, sizeof error, "the camera sensor did not start (%s)",
               esp_err_to_name(started));
      return false;
    }
  }
  sensor_started = true;
  reset_color_matrix();
  latest = -1;
  reading = -1;
  atomic_store(&stopping, false);
  atomic_store(&capture_state, CAPTURE_STARTING);
  atomic_store(&still_wanted, 0);
  atomic_store(&frames, 0);
  atomic_store(&scans, 0);
  payload_sequence = 0;
  polled_sequence = 0;
  last_scan_us = 0;
  if (xTaskCreatePinnedToCoreWithCaps(capture_run, "pocketjs_camera",
                                      CAPTURE_STACK, NULL, 4, &capture_task,
                                      board.worker_core,
                                      MALLOC_CAP_SPIRAM) != pdPASS) {
    capture_task = NULL;
    snprintf(error, sizeof error, "camera task allocation failed");
    return false;
  }
  if ((open_flags & CAMERA_OPEN_NO_SCAN) == 0 &&
      xTaskCreatePinnedToCoreWithCaps(decode_run, "pocketjs_qr", DECODE_STACK,
                                      NULL, 2, &decode_task, board.worker_core,
                                      MALLOC_CAP_SPIRAM) != pdPASS) {
    decode_task = NULL;
    snprintf(error, sizeof error, "QR task allocation failed");
    return false;
  }
  return true;
}

static int32_t camera_open(int32_t flags) {
  if (!configured || runtime == NULL || (!admitted_qr && !admitted_photo))
    return -1;
  /* The mirrored preview and a viewfinder without decoding are
   * camera.photo's. */
  flags = admitted_photo ? flags & (CAMERA_OPEN_INNER | CAMERA_OPEN_NO_SCAN)
                         : 0;
  if (open_now) {
    if (flags == open_flags)
      return texture_handle;
    /* Another mirroring or decoding choice: restart capture behind the same
     * texture, so the guest's handle stays. */
    stop_capture();
    open_flags = flags;
    error[0] = '\0';
    if (start_capture())
      return texture_handle;
    stop_capture();
    return -1;
  }
  error[0] = '\0';
  open_flags = flags;
  /* An IMG entry (framework/compiler/pak.ts): the texture samples linear
   * when a layout scales the preview. */
  const size_t bytes = 8u + CAMERA_TEXTURE_WIDTH * CAMERA_TEXTURE_HEIGHT * 2u;
  uint8_t *entry = heap_caps_calloc(1, bytes, MALLOC_CAP_SPIRAM);
  if (entry != NULL) {
    entry[0] = CAMERA_TEXTURE_WIDTH & 0xffu;
    entry[1] = CAMERA_TEXTURE_WIDTH >> 8;
    entry[2] = CAMERA_TEXTURE_HEIGHT & 0xffu;
    entry[3] = CAMERA_TEXTURE_HEIGHT >> 8;
    entry[4] = PSM_5650;
    entry[5] = IMG_FLAG_LINEAR;
    texture_handle = pocket_texture_upload_entry(runtime, entry, bytes);
    free(entry);
  }
  if (entry == NULL || texture_handle < 0) {
    texture_handle = -1;
    snprintf(error, sizeof error, "camera texture registration failed");
    return -1;
  }
  if (!start_capture()) {
    stop_capture();
    pocket_texture_free(runtime, texture_handle);
    texture_handle = -1;
    return -1;
  }
  open_now = true;
  return texture_handle;
}

static int32_t camera_capture(void) {
  static int32_t next_job = 1;
  if (!admitted_photo || !open_now ||
      atomic_load(&capture_state) != CAPTURE_RUNNING ||
      atomic_load(&still_wanted) != 0)
    return -1;
  int32_t job = next_job++;
  if (next_job <= 0)
    next_job = 1;
  atomic_store(&still_wanted, job);
  return job;
}

static void camera_close(void) {
  if (!open_now)
    return;
  open_now = false;
  stop_capture();
  if (texture_handle >= 0 && runtime != NULL)
    pocket_texture_free(runtime, texture_handle);
  texture_handle = -1;
}

void pocketjs_camera_present(void) {
  photos_present();
  if (!open_now)
    return;
  const int64_t now = esp_timer_get_time();
  if (decode_task != NULL && !atomic_load(&scan_busy) &&
      now - last_scan_us >= CAMERA_SCAN_MS * 1000) {
    last_scan_us = now;
    atomic_store(&scan_wanted, true);
  }
  xSemaphoreTake(buffer_lock, portMAX_DELAY);
  const int frame = latest;
  latest = -1;
  reading = frame;
  xSemaphoreGive(buffer_lock);
  if (frame < 0)
    return;
  /* The PPA wrote the frame behind this core's cache. */
  esp_cache_msync(previews[frame], CAMERA_FRAME_BYTES,
                  ESP_CACHE_MSYNC_FLAG_DIR_M2C);
  pocket_runtime_update_texture(runtime, texture_handle, 0, 0, CAMERA_WIDTH,
                                CAMERA_HEIGHT, (const uint8_t *)previews[frame],
                                CAMERA_FRAME_BYTES);
  xSemaphoreTake(buffer_lock, portMAX_DELAY);
  reading = -1;
  xSemaphoreGive(buffer_lock);
}

void pocketjs_camera_teardown(void) {
  open_now = false;
  stop_capture();
  texture_handle = -1;
  photos_teardown();
  runtime = NULL;
  admitted_qr = false;
  admitted_photo = false;
}

static const char *camera_poll(size_t *length) {
  if (payload_lock == NULL || payload_sequence == polled_sequence)
    return NULL;
  xSemaphoreTake(payload_lock, portMAX_DELAY);
  const bool fresh = payload_sequence != polled_sequence;
  if (fresh) {
    memcpy(poll_out, payload, payload_length + 1);
    *length = payload_length;
    polled_sequence = payload_sequence;
  }
  xSemaphoreGive(payload_lock);
  return fresh ? poll_out : NULL;
}

static const char *camera_info_json(void) {
  char escaped[sizeof error * 2];
  size_t used = 0;
  for (const char *at = error; *at != '\0' && used + 2 < sizeof escaped;
       at += 1) {
    if (*at == '"' || *at == '\\')
      escaped[used++] = '\\';
    escaped[used++] = *at;
  }
  escaped[used] = '\0';
  /* `decodeMs`, `inner`, `stills` (beyond CameraInfo): the last decode
   * pass, the mirrored preview, stills taken. */
  snprintf(info_out, sizeof info_out,
           "{\"open\":%s,\"frames\":%lu,\"scans\":%lu,\"error\":\"%s\","
           "\"decodeMs\":%lu,\"inner\":%s,\"stills\":%lu}",
           open_now ? "true" : "false", (unsigned long)atomic_load(&frames),
           (unsigned long)atomic_load(&scans), escaped,
           (unsigned long)atomic_load(&decode_ms),
           (open_flags & CAMERA_OPEN_INNER) ? "true" : "false",
           (unsigned long)atomic_load(&stills));
  return info_out;
}

// ---------------------------------------------------------------------------
// globalThis.camera
// ---------------------------------------------------------------------------

enum {
  OP_OPEN,
  OP_CLOSE,
  OP_POLL,
  OP_INFO,
  OP_CAPTURE,
  OP_PHOTOS,
  OP_LOAD,
  OP_FREE,
  OP_REMOVE,
  OP_EVENTS,
};

static int32_t int_argument(JSContext *ctx, int argc, JSValueConst *argv,
                            int index) {
  int32_t value = 0;
  if (index < argc)
    JS_ToInt32(ctx, &value, argv[index]);
  return value;
}

static JSValue camera_operation(JSContext *ctx, JSValueConst this_value,
                                int argc, JSValueConst *argv, int magic,
                                void *opaque) {
  (void)this_value;
  (void)opaque;
  switch (magic) {
  case OP_OPEN:
    return JS_NewInt32(ctx, camera_open(argc > 0 && JS_IsNumber(argv[0])
                                            ? int_argument(ctx, argc, argv, 0)
                                            : 0));
  case OP_CLOSE:
    camera_close();
    return JS_UNDEFINED;
  case OP_POLL: {
    size_t length = 0;
    const char *code = camera_poll(&length);
    return code == NULL ? JS_UNDEFINED : JS_NewStringLen(ctx, code, length);
  }
  case OP_INFO:
    return JS_NewString(ctx, camera_info_json());
  case OP_CAPTURE:
    return JS_NewInt32(ctx, camera_capture());
  case OP_PHOTOS:
    return JS_NewString(ctx, photos_list_json());
  case OP_LOAD:
  case OP_REMOVE: {
    const char *name = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    JSValue out = magic == OP_LOAD
                      ? JS_NewInt32(ctx, photos_load(name, int_argument(
                                                               ctx, argc, argv,
                                                               1)))
                      : JS_NewBool(ctx, photos_remove(name));
    if (name != NULL)
      JS_FreeCString(ctx, name);
    return out;
  }
  case OP_FREE:
    photos_free(int_argument(ctx, argc, argv, 0));
    return JS_UNDEFINED;
  case OP_EVENTS: {
    const char *events = photos_events_json();
    return events == NULL ? JS_UNDEFINED : JS_NewString(ctx, events);
  }
  default:
    return JS_UNDEFINED;
  }
}

static void add_operation(JSContext *ctx, JSValue object, const char *name,
                          int arity, int magic) {
  JS_SetPropertyStr(ctx, object, name,
                    JS_NewCClosure(ctx, camera_operation, name, NULL, arity,
                                   magic, NULL));
}

static esp_err_t install(JSContext *ctx, void *user_data) {
  (void)user_data;
  JSValue global = JS_GetGlobalObject(ctx);
  JSValue camera = JS_NewObject(ctx);
  add_operation(ctx, camera, "open", 0, OP_OPEN);
  add_operation(ctx, camera, "close", 0, OP_CLOSE);
  add_operation(ctx, camera, "poll", 0, OP_POLL);
  add_operation(ctx, camera, "info", 0, OP_INFO);
  if (admitted_photo) {
    add_operation(ctx, camera, "capture", 0, OP_CAPTURE);
    add_operation(ctx, camera, "photos", 0, OP_PHOTOS);
    add_operation(ctx, camera, "load", 2, OP_LOAD);
    add_operation(ctx, camera, "free", 1, OP_FREE);
    add_operation(ctx, camera, "remove", 1, OP_REMOVE);
    add_operation(ctx, camera, "events", 0, OP_EVENTS);
  }
  const int set = JS_SetPropertyStr(ctx, global, "camera", camera);
  JS_FreeValue(ctx, global);
  return set < 0 ? ESP_ERR_NO_MEM : ESP_OK;
}

esp_err_t pocketjs_camera_install(JSContext *realm, pocket_runtime *owner,
                                  bool qr, bool photo) {
  if (realm == NULL || owner == NULL || !configured)
    return ESP_ERR_INVALID_ARG;
  if (!qr && !photo)
    return ESP_OK;
  runtime = owner;
  admitted_qr = qr;
  admitted_photo = photo;
  photos_bind(owner);
  return install(realm, NULL);
}
