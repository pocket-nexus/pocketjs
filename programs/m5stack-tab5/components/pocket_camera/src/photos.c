/* Photos under <storage>/DCIM — see photos.h. */

#include "photos.h"

#include <dirent.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include "driver/jpeg_decode.h"
#include "driver/jpeg_encode.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "photos_image.h"
#include "pocket/textures.h"

/* contracts/spec/camera.ts */
#define PHOTO_KIND_THUMB 0
#define PHOTO_KIND_FULL 1
#define PHOTO_PENDING (-2)
#define PHOTO_MAX_QUEUE 24
/* contracts/spec/spec.ts PSM.PSM_5650: red in the low five bits. */
#define PSM_5650 0u

/* The folder and file names this module gives its own photos (DCF). */
#define OWN_FOLDER "100POCKT"
#define OWN_PREFIX "PKT_"
#define JPEG_QUALITY 90
#define MAX_PHOTO_BYTES (6u * 1024u * 1024u)
/* A 640x480 still at quality 90 encodes to about 80 KB. */
#define JPEG_OUT_BYTES (512u * 1024u)
#define MAX_LIST 2000
#define NAME_CAPACITY 24
/* A storage root, and a path below it: the root, "/photos/thumbs/" and a
 * cached thumbnail's name fit. */
#define STORAGE_CAPACITY 64
#define PATH_CAPACITY 160
#define THUMB_MAGIC 0x48544b50u /* "PKTH" */
#define WORKER_STACK (8u * 1024u)
#define MAX_HANDLES 256
#define EVENTS_LIMIT 8192u

static const char *TAG = "pocketjs_photos";

enum { JOB_SAVE, JOB_LOAD };

typedef struct {
  int type;
  int32_t id;
  char name[NAME_CAPACITY];
  int32_t kind;
  uint16_t *pixels;
  uint32_t width, height;
} job_t;

typedef struct {
  int type;
  int32_t id;
  char name[NAME_CAPACITY];
  int32_t kind;
  uint16_t *pixels; /* LOAD: texture-sized PSM_5650 */
  uint32_t texture_width, texture_height;
  uint32_t ms;
  char error[96];
} result_t;

/* A bounded, growable string for the JSON the guest reads. */
typedef struct {
  char *data;
  size_t length;
  size_t capacity;
  size_t limit;
} text_t;

static char storage[STORAGE_CAPACITY];
static int worker_core;
static pocket_runtime *runtime;
static SemaphoreHandle_t queue_lock;
/* The queues live in PSRAM: internal RAM belongs to drivers and strips. */
#define RESULT_CAPACITY (PHOTO_MAX_QUEUE + 4)
static job_t *jobs;
static int job_count;
static result_t *results;
static result_t *ready;
static int result_count;
static TaskHandle_t worker;
static volatile bool stopping;
static SemaphoreHandle_t worker_exited;
static int next_own_number; /* 0 until the own folder was scanned */
static jpeg_encoder_handle_t encoder;
static jpeg_decoder_handle_t decoder;

static int32_t *handles;
static int handle_count;
static text_t events = {.limit = EVENTS_LIMIT};
static text_t events_out;
static text_t list_out;

// ---------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------

static bool text_append(text_t *text, const char *bytes, size_t length) {
  if (text->limit != 0 && text->length + length > text->limit)
    return false;
  if (text->length + length + 1 > text->capacity) {
    size_t capacity = text->capacity ? text->capacity : 256;
    while (capacity < text->length + length + 1)
      capacity *= 2;
    char *grown = realloc(text->data, capacity);
    if (grown == NULL)
      return false;
    text->data = grown;
    text->capacity = capacity;
  }
  memcpy(text->data + text->length, bytes, length);
  text->length += length;
  text->data[text->length] = '\0';
  return true;
}

static bool text_printf(text_t *text, const char *format, ...) {
  char line[320];
  va_list args;
  va_start(args, format);
  int length = vsnprintf(line, sizeof line, format, args);
  va_end(args);
  return length >= 0 && (size_t)length < sizeof line &&
         text_append(text, line, (size_t)length);
}

static void text_reset(text_t *text) {
  text->length = 0;
  if (text->data != NULL)
    text->data[0] = '\0';
}

static void text_free(text_t *text) {
  free(text->data);
  text->data = NULL;
  text->length = text->capacity = 0;
}

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

static void photo_path(char *out, size_t capacity, const char *name) {
  snprintf(out, capacity, "%s/DCIM/%s", storage, name);
}

static void thumb_path(char *out, size_t capacity, const char *name) {
  char flat[NAME_CAPACITY];
  snprintf(flat, sizeof flat, "%s", name);
  flat[8] = '_';
  snprintf(out, capacity, "%s/photos/thumbs/%s.thm", storage, flat);
}

static long file_size(const char *path) {
  struct stat info;
  return stat(path, &info) == 0 ? (long)info.st_size : -1;
}

static void make_directory(const char *suffix) {
  char path[PATH_CAPACITY];
  snprintf(path, sizeof path, "%s%s", storage, suffix);
  mkdir(path, 0777);
}

// ---------------------------------------------------------------------------
// the thumbnail cache: "PKTH", the photo's byte size, then the square
// ---------------------------------------------------------------------------

static bool read_thumb(const char *name, long source_bytes, uint16_t *texture) {
  char path[PATH_CAPACITY];
  thumb_path(path, sizeof path, name);
  FILE *file = fopen(path, "rb");
  if (file == NULL)
    return false;
  uint32_t header[2] = {0, 0};
  bool ok = fread(header, sizeof header, 1, file) == 1 &&
            header[0] == THUMB_MAGIC && header[1] == (uint32_t)source_bytes;
  for (uint32_t y = 0; ok && y < PHOTO_THUMB_SIZE; y += 1) {
    ok = fread(texture + y * PHOTO_THUMB_TEXTURE, 2, PHOTO_THUMB_SIZE, file) ==
         PHOTO_THUMB_SIZE;
  }
  fclose(file);
  return ok;
}

static void write_thumb(const char *name, long source_bytes,
                        const uint16_t *texture) {
  make_directory("/photos");
  make_directory("/photos/thumbs");
  char path[PATH_CAPACITY];
  thumb_path(path, sizeof path, name);
  FILE *file = fopen(path, "wb");
  if (file == NULL)
    return;
  uint32_t header[2] = {THUMB_MAGIC, (uint32_t)source_bytes};
  bool ok = fwrite(header, sizeof header, 1, file) == 1;
  for (uint32_t y = 0; ok && y < PHOTO_THUMB_SIZE; y += 1) {
    ok = fwrite(texture + y * PHOTO_THUMB_TEXTURE, 2, PHOTO_THUMB_SIZE,
                file) == PHOTO_THUMB_SIZE;
  }
  fclose(file);
  if (!ok)
    remove(path);
}

// ---------------------------------------------------------------------------
// the JPEG codec
// ---------------------------------------------------------------------------

/* The encoder reads its input from any address; the PPA that writes the
 * still needs a PSRAM cache line (128 bytes) for its start and size. */
uint16_t *photos_alloc_still(uint32_t width, uint32_t height) {
  return heap_caps_aligned_alloc(128, (size_t)width * height * 2u,
                                 MALLOC_CAP_SPIRAM);
}

static bool codec_ready(void) {
  if (encoder == NULL) {
    const jpeg_encode_engine_cfg_t config = {.timeout_ms = 2000};
    if (jpeg_new_encoder_engine(&config, &encoder) != ESP_OK)
      return false;
  }
  if (decoder == NULL) {
    const jpeg_decode_engine_cfg_t config = {.timeout_ms = 2000};
    if (jpeg_new_decoder_engine(&config, &decoder) != ESP_OK)
      return false;
  }
  return true;
}

/* Encode `rgb565` (red in the high bits) to `file`. */
static bool jpeg_write(FILE *file, const uint16_t *rgb565, uint32_t width,
                       uint32_t height) {
  const jpeg_encode_memory_alloc_cfg_t memory = {
      .buffer_direction = JPEG_ENC_ALLOC_OUTPUT_BUFFER,
  };
  size_t capacity = 0;
  uint8_t *out = jpeg_alloc_encoder_mem(JPEG_OUT_BYTES, &memory, &capacity);
  if (out == NULL)
    return false;
  const jpeg_encode_cfg_t config = {
      .width = width,
      .height = height,
      .src_type = JPEG_ENCODE_IN_FORMAT_RGB565,
      .sub_sample = JPEG_DOWN_SAMPLING_YUV420,
      .image_quality = JPEG_QUALITY,
  };
  uint32_t size = 0;
  bool ok = jpeg_encoder_process(encoder, &config, (const uint8_t *)rgb565,
                                 width * height * 2u, out, capacity,
                                 &size) == ESP_OK &&
            fwrite(out, 1, size, file) == size;
  free(out);
  return ok;
}

/* Decode a JPEG to packed RGB888 (red first). malloc'd; NULL when it does
 * not decode or is larger than PHOTO_DECODE_MAX_PIXELS. */
static uint8_t *jpeg_read(const uint8_t *jpeg, size_t length, uint32_t *width,
                          uint32_t *height) {
  jpeg_decode_picture_info_t info = {0};
  if (jpeg_decoder_get_info(jpeg, length, &info) != ESP_OK ||
      info.width == 0 || info.height == 0 ||
      (uint64_t)info.width * info.height > PHOTO_DECODE_MAX_PIXELS)
    return NULL;
  /* The codec writes whole 16x16 blocks. */
  const uint32_t stride = (info.width + 15u) & ~15u;
  const uint32_t rows = (info.height + 15u) & ~15u;
  const jpeg_decode_memory_alloc_cfg_t memory = {
      .buffer_direction = JPEG_DEC_ALLOC_OUTPUT_BUFFER,
  };
  size_t capacity = 0;
  uint8_t *out = jpeg_alloc_decoder_mem((size_t)stride * rows * 3u, &memory,
                                        &capacity);
  if (out == NULL)
    return NULL;
  const jpeg_decode_cfg_t config = {
      .output_format = JPEG_DECODE_OUT_FORMAT_RGB888,
      .rgb_order = JPEG_DEC_RGB_ELEMENT_ORDER_RGB,
      .conv_std = JPEG_YUV_RGB_CONV_STD_BT601,
  };
  uint32_t size = 0;
  if (jpeg_decoder_process(decoder, &config, jpeg, length, out, capacity,
                           &size) != ESP_OK) {
    free(out);
    return NULL;
  }
  if (stride != info.width) {
    for (uint32_t y = 1; y < info.height; y += 1)
      memmove(out + (size_t)y * info.width * 3u, out + (size_t)y * stride * 3u,
              (size_t)info.width * 3u);
  }
  *width = info.width;
  *height = info.height;
  return out;
}

// ---------------------------------------------------------------------------
// jobs (worker task)
// ---------------------------------------------------------------------------

static void push_result(const result_t *result) {
  xSemaphoreTake(queue_lock, portMAX_DELAY);
  if (result_count < RESULT_CAPACITY)
    results[result_count++] = *result;
  else
    free(result->pixels);
  xSemaphoreGive(queue_lock);
}

static void fail(result_t *result, const char *message) {
  snprintf(result->error, sizeof result->error, "%s", message);
  free(result->pixels);
  result->pixels = NULL;
}

/* A directory entry's name, upper-cased, when it is `length` characters
 * (8 for a DCF folder, 12 for a DCF file). */
static bool entry_name(const struct dirent *entry, char *out, size_t length) {
  if (strlen(entry->d_name) != length)
    return false;
  memcpy(out, entry->d_name, length + 1);
  photo_upper(out);
  return true;
}

/* The next own file number: one past the highest PKT_ in the own folder. */
static int own_number(void) {
  if (next_own_number > 0)
    return next_own_number;
  int highest = 0;
  char path[PATH_CAPACITY];
  snprintf(path, sizeof path, "%s/DCIM/" OWN_FOLDER, storage);
  DIR *dir = opendir(path);
  if (dir != NULL) {
    struct dirent *entry;
    while ((entry = readdir(dir)) != NULL) {
      char name[13];
      if (entry_name(entry, name, 12) && photo_file_name(name) &&
          strncmp(name, OWN_PREFIX, 4) == 0) {
        int number = atoi(name + 4);
        if (number > highest)
          highest = number;
      }
    }
    closedir(dir);
  }
  next_own_number = highest + 1;
  return next_own_number;
}

static void run_save(job_t *job, result_t *result) {
  make_directory("/DCIM");
  make_directory("/DCIM/" OWN_FOLDER);
  int number = own_number();
  if (number < 1 || number > 9999)
    return fail(result, "the photo folder is full");
  snprintf(result->name, sizeof result->name,
           OWN_FOLDER "/" OWN_PREFIX "%04d.JPG", number);
  char path[PATH_CAPACITY], temporary[PATH_CAPACITY + 4];
  photo_path(path, sizeof path, result->name);
  snprintf(temporary, sizeof temporary, "%s.TMP", path);
  FILE *file = fopen(temporary, "wb");
  if (file == NULL)
    return fail(result, "the storage did not take the photo");
  bool written = jpeg_write(file, job->pixels, job->width, job->height);
  bool flushed = fflush(file) == 0 && ferror(file) == 0;
  fclose(file);
  if (!written || !flushed || rename(temporary, path) != 0) {
    remove(temporary);
    return fail(result, "the storage did not take the photo");
  }
  next_own_number = number + 1;
  size_t pixels = (size_t)job->width * job->height;
  uint8_t *rgb = malloc(pixels * 3u);
  if (rgb == NULL)
    return;
  photo_rgb565_to_rgb888(job->pixels, rgb, pixels);
  uint16_t *thumb = photo_thumb(rgb, job->width, job->height);
  free(rgb);
  if (thumb != NULL) {
    write_thumb(result->name, file_size(path), thumb);
    free(thumb);
  }
}

/* Read a photo and decode it to RGB888. */
static uint8_t *decode(const char *name, long *source_bytes, uint32_t *width,
                       uint32_t *height, char *error, size_t capacity) {
  char path[PATH_CAPACITY];
  photo_path(path, sizeof path, name);
  long size = file_size(path);
  *source_bytes = size;
  if (size <= 0) {
    snprintf(error, capacity, "no photo %s", name);
    return NULL;
  }
  if ((unsigned long)size > MAX_PHOTO_BYTES) {
    snprintf(error, capacity, "%s is too large", name);
    return NULL;
  }
  const jpeg_decode_memory_alloc_cfg_t memory = {
      .buffer_direction = JPEG_DEC_ALLOC_INPUT_BUFFER,
  };
  size_t allocated = 0;
  uint8_t *bytes = jpeg_alloc_decoder_mem((size_t)size, &memory, &allocated);
  FILE *file = bytes == NULL ? NULL : fopen(path, "rb");
  bool read =
      file != NULL && fread(bytes, 1, (size_t)size, file) == (size_t)size;
  if (file != NULL)
    fclose(file);
  if (!read) {
    free(bytes);
    snprintf(error, capacity, "%s could not be read", name);
    return NULL;
  }
  uint8_t *rgb = jpeg_read(bytes, (size_t)size, width, height);
  free(bytes);
  if (rgb == NULL)
    snprintf(error, capacity, "%s is not a JPEG this console can read", name);
  return rgb;
}

static void run_load(job_t *job, result_t *result) {
  bool thumb = job->kind == PHOTO_KIND_THUMB;
  if (thumb) {
    char path[PATH_CAPACITY];
    photo_path(path, sizeof path, job->name);
    long source_bytes = file_size(path);
    uint16_t *texture = calloc(PHOTO_THUMB_TEXTURE * PHOTO_THUMB_TEXTURE, 2);
    if (texture == NULL)
      return fail(result, "no memory for the thumbnail");
    if (source_bytes > 0 && read_thumb(job->name, source_bytes, texture)) {
      result->pixels = texture;
      result->texture_width = result->texture_height = PHOTO_THUMB_TEXTURE;
      return;
    }
    free(texture);
  }
  uint32_t width = 0, height = 0;
  long source_bytes = 0;
  uint8_t *rgb = decode(job->name, &source_bytes, &width, &height,
                        result->error, sizeof result->error);
  if (rgb == NULL)
    return;
  if (thumb) {
    result->pixels = photo_thumb(rgb, width, height);
    result->texture_width = result->texture_height = PHOTO_THUMB_TEXTURE;
    if (result->pixels != NULL)
      write_thumb(job->name, source_bytes, result->pixels);
  } else {
    result->pixels = photo_full(rgb, width, height);
    result->texture_width = PHOTO_SCREEN_TEXTURE_WIDTH;
    result->texture_height = PHOTO_SCREEN_TEXTURE_HEIGHT;
  }
  free(rgb);
  if (result->pixels == NULL)
    fail(result, "no memory for the photo");
}

static void worker_run(void *argument) {
  (void)argument;
  while (!stopping) {
    xSemaphoreTake(queue_lock, portMAX_DELAY);
    bool have = job_count > 0;
    job_t job;
    if (have) {
      job = jobs[0];
      memmove(jobs, jobs + 1, (size_t)(job_count - 1) * sizeof jobs[0]);
      job_count -= 1;
    }
    xSemaphoreGive(queue_lock);
    if (!have) {
      ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(100));
      continue;
    }
    result_t result;
    memset(&result, 0, sizeof result);
    result.type = job.type;
    result.id = job.id;
    result.kind = job.kind;
    snprintf(result.name, sizeof result.name, "%s", job.name);
    const int64_t started = esp_timer_get_time();
    if (!codec_ready())
      fail(&result, "the JPEG codec did not start");
    else if (job.type == JOB_SAVE)
      run_save(&job, &result);
    else
      run_load(&job, &result);
    free(job.pixels);
    result.ms = (uint32_t)((esp_timer_get_time() - started) / 1000);
    push_result(&result);
  }
  xSemaphoreGive(worker_exited);
  vTaskDeleteWithCaps(NULL);
}

static bool ensure_worker(void) {
  if (queue_lock == NULL) {
    jobs = heap_caps_calloc(PHOTO_MAX_QUEUE, sizeof *jobs, MALLOC_CAP_SPIRAM);
    results =
        heap_caps_calloc(RESULT_CAPACITY, sizeof *results, MALLOC_CAP_SPIRAM);
    ready = heap_caps_calloc(RESULT_CAPACITY, sizeof *ready, MALLOC_CAP_SPIRAM);
    handles = heap_caps_calloc(MAX_HANDLES, sizeof *handles, MALLOC_CAP_SPIRAM);
    worker_exited = xSemaphoreCreateBinary();
    if (jobs == NULL || results == NULL || ready == NULL || handles == NULL ||
        worker_exited == NULL)
      return false;
    queue_lock = xSemaphoreCreateMutex();
    if (queue_lock == NULL)
      return false;
  }
  if (worker != NULL)
    return true;
  stopping = false;
  /* Below the UI and render tasks: encoding and decoding take what the
   * frames leave. */
  return xTaskCreatePinnedToCoreWithCaps(worker_run, "pocketjs_photos",
                                         WORKER_STACK, NULL, 2, &worker,
                                         worker_core,
                                         MALLOC_CAP_SPIRAM) == pdPASS;
}

static bool enqueue(const job_t *job) {
  if (!ensure_worker())
    return false;
  xSemaphoreTake(queue_lock, portMAX_DELAY);
  bool room = job_count < PHOTO_MAX_QUEUE;
  if (room)
    jobs[job_count++] = *job;
  xSemaphoreGive(queue_lock);
  if (room)
    xTaskNotifyGive(worker);
  return room;
}

// ---------------------------------------------------------------------------
// guest-facing (owner task, except photos_save and photos_fail)
// ---------------------------------------------------------------------------

void photos_setup(const char *storage_root, int core) {
  snprintf(storage, sizeof storage, "%s", storage_root);
  worker_core = core;
}

void photos_bind(pocket_runtime *owner) { runtime = owner; }

bool photos_save(int32_t id, uint16_t *rgb565, uint32_t width,
                 uint32_t height) {
  job_t job;
  memset(&job, 0, sizeof job);
  job.type = JOB_SAVE;
  job.id = id;
  job.pixels = rgb565;
  job.width = width;
  job.height = height;
  if (!enqueue(&job)) {
    free(rgb565);
    photos_fail(id, "too many photos waiting to be saved");
    return false;
  }
  return true;
}

void photos_fail(int32_t job, const char *message) {
  if (!ensure_worker())
    return;
  result_t result;
  memset(&result, 0, sizeof result);
  result.type = JOB_SAVE;
  result.id = job;
  snprintf(result.error, sizeof result.error, "%s", message);
  push_result(&result);
}

static int compare_names(const void *a, const void *b) {
  /* Newest first: the higher folder, then the higher file number. */
  return -strcmp(*(char *const *)a, *(char *const *)b);
}

const char *photos_list_json(void) {
  char **names = calloc(MAX_LIST, sizeof *names);
  int count = 0;
  char root[STORAGE_CAPACITY + 8];
  snprintf(root, sizeof root, "%s/DCIM", storage);
  DIR *dcim = names == NULL ? NULL : opendir(root);
  if (dcim != NULL) {
    struct dirent *folder;
    while (count < MAX_LIST && (folder = readdir(dcim)) != NULL) {
      char folder_upper[9];
      if (!entry_name(folder, folder_upper, 8) ||
          !photo_folder_name(folder_upper))
        continue;
      char path[PATH_CAPACITY];
      snprintf(path, sizeof path, "%s/DCIM/%s", storage, folder_upper);
      DIR *dir = opendir(path);
      if (dir == NULL)
        continue;
      struct dirent *entry;
      while (count < MAX_LIST && (entry = readdir(dir)) != NULL) {
        char file[13];
        if (!entry_name(entry, file, 12) || !photo_file_name(file))
          continue;
        char name[NAME_CAPACITY];
        snprintf(name, sizeof name, "%s/%s", folder_upper, file);
        names[count] = strdup(name);
        if (names[count] == NULL)
          break;
        count += 1;
      }
      closedir(dir);
    }
    closedir(dcim);
  }
  if (names != NULL)
    qsort(names, (size_t)count, sizeof *names, compare_names);
  text_reset(&list_out);
  text_append(&list_out, "[", 1);
  for (int i = 0; i < count; i += 1) {
    char full[PATH_CAPACITY];
    photo_path(full, sizeof full, names[i]);
    text_printf(&list_out, "%s{\"name\":\"%s\",\"bytes\":%ld}", i ? "," : "",
                names[i], file_size(full));
    free(names[i]);
  }
  text_append(&list_out, "]", 1);
  free(names);
  return list_out.data != NULL ? list_out.data : "[]";
}

int32_t photos_load(const char *name, int32_t kind) {
  char upper_name[NAME_CAPACITY];
  if (name == NULL || strlen(name) >= sizeof upper_name)
    return -1;
  snprintf(upper_name, sizeof upper_name, "%s", name);
  photo_upper(upper_name);
  if (!photo_name(upper_name) ||
      (kind != PHOTO_KIND_THUMB && kind != PHOTO_KIND_FULL))
    return -1;
  job_t job;
  memset(&job, 0, sizeof job);
  job.type = JOB_LOAD;
  job.kind = kind;
  snprintf(job.name, sizeof job.name, "%s", upper_name);
  return enqueue(&job) ? PHOTO_PENDING : -1;
}

void photos_free(int32_t handle) {
  for (int i = 0; i < handle_count; i += 1) {
    if (handles[i] != handle)
      continue;
    pocket_texture_free(runtime, handle);
    handles[i] = handles[--handle_count];
    return;
  }
}

bool photos_remove(const char *name) {
  char upper_name[NAME_CAPACITY];
  if (name == NULL || strlen(name) >= sizeof upper_name)
    return false;
  snprintf(upper_name, sizeof upper_name, "%s", name);
  photo_upper(upper_name);
  if (!photo_name(upper_name))
    return false;
  char path[PATH_CAPACITY];
  photo_path(path, sizeof path, upper_name);
  bool removed = remove(path) == 0;
  thumb_path(path, sizeof path, upper_name);
  remove(path);
  return removed;
}

/* A full buffer (EVENTS_LIMIT) drops the event. */
static void append_event(const char *json) {
  const size_t mark = events.length;
  if ((events.length > 0 && !text_append(&events, ",", 1)) ||
      !text_append(&events, json, strlen(json))) {
    events.length = mark;
    if (events.data != NULL)
      events.data[mark] = '\0';
  }
}

void photos_present(void) {
  if (queue_lock == NULL || runtime == NULL)
    return;
  xSemaphoreTake(queue_lock, portMAX_DELAY);
  int count = result_count;
  memcpy(ready, results, (size_t)count * sizeof results[0]);
  result_count = 0;
  xSemaphoreGive(queue_lock);
  for (int i = 0; i < count; i += 1) {
    result_t *result = &ready[i];
    char json[256];
    if (result->error[0] != '\0') {
      if (result->type == JOB_SAVE) {
        snprintf(json, sizeof json,
                 "{\"t\":\"error\",\"job\":%ld,\"message\":\"%s\"}",
                 (long)result->id, result->error);
      } else {
        snprintf(json, sizeof json,
                 "{\"t\":\"error\",\"name\":\"%s\",\"kind\":%ld,\"message\":"
                 "\"%s\"}",
                 result->name, (long)result->kind, result->error);
      }
    } else if (result->type == JOB_SAVE) {
      snprintf(json, sizeof json,
               "{\"t\":\"saved\",\"job\":%ld,\"name\":\"%s\",\"ms\":%lu}",
               (long)result->id, result->name, (unsigned long)result->ms);
    } else {
      int32_t handle = -1;
      if (handle_count < MAX_HANDLES) {
        size_t bytes =
            (size_t)result->texture_width * result->texture_height * 2u;
        handle = pocket_texture_upload(runtime, result->pixels, bytes, result->texture_width,
            result->texture_height, PSM_5650);
      }
      free(result->pixels);
      result->pixels = NULL;
      if (handle < 0) {
        snprintf(json, sizeof json,
                 "{\"t\":\"error\",\"name\":\"%s\",\"kind\":%ld,\"message\":"
                 "\"no texture for the photo\"}",
                 result->name, (long)result->kind);
      } else {
        handles[handle_count++] = handle;
        snprintf(json, sizeof json,
                 "{\"t\":\"loaded\",\"name\":\"%s\",\"kind\":%ld,\"handle\":%"
                 "ld,\"ms\":%lu}",
                 result->name, (long)result->kind, (long)handle,
                 (unsigned long)result->ms);
      }
    }
    append_event(json);
  }
}

const char *photos_events_json(void) {
  if (events.length == 0)
    return NULL;
  text_reset(&events_out);
  text_append(&events_out, "[", 1);
  text_append(&events_out, events.data, events.length);
  text_append(&events_out, "]", 1);
  text_reset(&events);
  return events_out.data;
}

void photos_teardown(void) {
  if (worker != NULL) {
    stopping = true;
    xTaskNotifyGive(worker);
    xSemaphoreTake(worker_exited, portMAX_DELAY);
    worker = NULL;
  }
  if (queue_lock != NULL) {
    for (int i = 0; i < job_count; i += 1)
      free(jobs[i].pixels);
    for (int i = 0; i < result_count; i += 1)
      free(results[i].pixels);
  }
  job_count = 0;
  result_count = 0;
  /* The core drops every texture with the guest. */
  handle_count = 0;
  runtime = NULL;
  text_free(&events);
  text_free(&events_out);
  text_free(&list_out);
  ESP_LOGD(TAG, "torn down");
}
