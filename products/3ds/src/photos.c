/* Photos on the SD card — see photos.h. */

#include "photos.h"

#include <stdio.h>
#include <stdlib.h>

#if !defined(POCKETJS_CAPTURE) && !defined(POCKETJS_OFFLOAD)

#include <3ds.h>
#include <dirent.h>
#include <errno.h>
#include <string.h>
#include <sys/stat.h>

#include "jscan.h"
#include "photos_image.h"
#include "photos_jpeg.h"
#include "pocket_core.h"

/* contracts/spec/camera.ts */
#define PHOTO_KIND_THUMB 0
#define PHOTO_KIND_FULL 1
#define PHOTO_PENDING (-2)
#define PHOTO_MAX_QUEUE 24
/* contracts/spec/spec.ts PSM.PSM_5650: red in the low five bits. */
#define PSM_5650 0u

#define DCIM "sdmc:/DCIM"
/* The folder and file names this module gives its own photos (DCF). */
#define OWN_FOLDER "100POCKT"
#define OWN_PREFIX "PKT_"
#define THUMBS "sdmc:/pocketjs/photos/thumbs"
#define JPEG_QUALITY 90
#define MAX_PHOTO_BYTES (6u * 1024u * 1024u)
#define MAX_LIST 2000
#define NAME_CAPACITY 24
#define THUMB_MAGIC 0x48544b50u /* "PKTH" */
#define WORKER_STACK (64u * 1024u)
#define WORKER_WAIT_NS 100000000LL
#define MAX_HANDLES 256
#define EVENTS_LIMIT 8192u

enum { JOB_SAVE, JOB_LOAD };

typedef struct {
  int type;
  int32_t id;
  char name[NAME_CAPACITY];
  int32_t kind;
  uint16_t *pixels;
  uint32_t width, height;
  uint64_t queued;
} Job;

typedef struct {
  int type;
  int32_t id;
  char name[NAME_CAPACITY];
  int32_t kind;
  uint16_t *pixels; /* LOAD: texture-sized PSM_5650 */
  uint32_t texture_width, texture_height;
  uint32_t ms;
  char error[96];
} PhotoResult;

static LightLock queue_lock;
static bool locks_ready;
static Job jobs[PHOTO_MAX_QUEUE];
static int job_count;
static PhotoResult results[PHOTO_MAX_QUEUE + 4];
static int result_count;
static Thread worker;
static LightEvent worker_wake;
static volatile bool stopping;
static int next_own_number; /* 0 until the own folder was scanned */

static int32_t handles[MAX_HANDLES];
static int handle_count;
static JsonBuffer events = { .limit = EVENTS_LIMIT };
static JsonBuffer events_out;
static JsonBuffer list_out;

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

static void photo_path(char *out, size_t capacity, const char *name) {
  snprintf(out, capacity, "%s/%s", DCIM, name);
}

static void thumb_path(char *out, size_t capacity, const char *name) {
  char flat[NAME_CAPACITY];
  snprintf(flat, sizeof flat, "%s", name);
  flat[8] = '_';
  snprintf(out, capacity, "%s/%s.thm", THUMBS, flat);
}

static long file_size(const char *path) {
  struct stat info;
  return stat(path, &info) == 0 ? (long)info.st_size : -1;
}

// ---------------------------------------------------------------------------
// the thumbnail cache: "PKTH", the photo's byte size, then the square
// ---------------------------------------------------------------------------

static bool read_thumb(const char *name, long source_bytes, uint16_t *texture) {
  char path[96];
  thumb_path(path, sizeof path, name);
  FILE *file = fopen(path, "rb");
  if (file == NULL) return false;
  uint32_t header[2] = { 0, 0 };
  bool ok = fread(header, sizeof header, 1, file) == 1 && header[0] == THUMB_MAGIC && header[1] == (uint32_t)source_bytes;
  for (uint32_t y = 0; ok && y < PHOTO_THUMB_SIZE; y += 1) {
    ok = fread(texture + y * PHOTO_THUMB_TEXTURE, 2, PHOTO_THUMB_SIZE, file) == PHOTO_THUMB_SIZE;
  }
  fclose(file);
  return ok;
}

static void write_thumb(const char *name, long source_bytes, const uint16_t *texture) {
  mkdir("sdmc:/pocketjs", 0777);
  mkdir("sdmc:/pocketjs/photos", 0777);
  mkdir(THUMBS, 0777);
  char path[96];
  thumb_path(path, sizeof path, name);
  FILE *file = fopen(path, "wb");
  if (file == NULL) return;
  uint32_t header[2] = { THUMB_MAGIC, (uint32_t)source_bytes };
  bool ok = fwrite(header, sizeof header, 1, file) == 1;
  for (uint32_t y = 0; ok && y < PHOTO_THUMB_SIZE; y += 1) {
    ok = fwrite(texture + y * PHOTO_THUMB_TEXTURE, 2, PHOTO_THUMB_SIZE, file) == PHOTO_THUMB_SIZE;
  }
  fclose(file);
  if (!ok) remove(path);
}

// ---------------------------------------------------------------------------
// jobs (worker thread)
// ---------------------------------------------------------------------------

static void push_result(const PhotoResult *result) {
  LightLock_Lock(&queue_lock);
  if (result_count < (int)(sizeof results / sizeof results[0])) results[result_count++] = *result;
  else free(result->pixels);
  LightLock_Unlock(&queue_lock);
}

static void fail(PhotoResult *result, const char *message) {
  snprintf(result->error, sizeof result->error, "%s", message);
  free(result->pixels);
  result->pixels = NULL;
}

/* A directory entry's name, upper-cased, when it is `length` characters
 * (8 for a DCF folder, 12 for a DCF file). */
static bool entry_name(const struct dirent *entry, char *out, size_t length) {
  if (strlen(entry->d_name) != length) return false;
  memcpy(out, entry->d_name, length + 1);
  photo_upper(out);
  return true;
}

/* The next own file number: one past the highest PKT_ in the own folder. */
static int own_number(void) {
  if (next_own_number > 0) return next_own_number;
  int highest = 0;
  DIR *dir = opendir(DCIM "/" OWN_FOLDER);
  if (dir != NULL) {
    struct dirent *entry;
    while ((entry = readdir(dir)) != NULL) {
      char name[13];
      if (entry_name(entry, name, 12) && photo_file_name(name) && strncmp(name, OWN_PREFIX, 4) == 0) {
        int number = atoi(name + 4);
        if (number > highest) highest = number;
      }
    }
    closedir(dir);
  }
  next_own_number = highest + 1;
  return next_own_number;
}

static void run_save(Job *job, PhotoResult *result) {
  uint32_t pixels = job->width * job->height;
  uint8_t *rgb = malloc((size_t)pixels * 3u);
  if (rgb == NULL) return fail(result, "no memory to encode the photo");
  photo_rgb565_to_rgb888(job->pixels, rgb, pixels);
  free(job->pixels);
  job->pixels = NULL;

  mkdir(DCIM, 0777);
  mkdir(DCIM "/" OWN_FOLDER, 0777);
  int number = own_number();
  if (number < 1 || number > 9999) {
    free(rgb);
    return fail(result, "the photo folder is full");
  }
  snprintf(result->name, sizeof result->name, OWN_FOLDER "/" OWN_PREFIX "%04d.JPG", number);
  char path[96], temporary[100];
  photo_path(path, sizeof path, result->name);
  snprintf(temporary, sizeof temporary, "%s.TMP", path);
  FILE *file = fopen(temporary, "wb");
  if (file == NULL) {
    free(rgb);
    return fail(result, "the SD card did not take the photo");
  }
  bool written = photo_jpeg_write(file, rgb, job->width, job->height, JPEG_QUALITY);
  bool flushed = fflush(file) == 0 && ferror(file) == 0;
  fclose(file);
  if (!written || !flushed || rename(temporary, path) != 0) {
    remove(temporary);
    free(rgb);
    return fail(result, "the SD card did not take the photo");
  }
  next_own_number = number + 1;
  uint16_t *thumb = photo_thumb(rgb, job->width, job->height);
  free(rgb);
  if (thumb != NULL) {
    write_thumb(result->name, file_size(path), thumb);
    free(thumb);
  }
}

/* Read a photo and decode it to RGB888, at least min_width x min_height
 * (photo_jpeg_read). */
static uint8_t *decode(const char *name, uint32_t min_width, uint32_t min_height, long *source_bytes, uint32_t *width,
  uint32_t *height, char *error, size_t capacity) {
  char path[96];
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
  uint8_t *bytes = malloc((size_t)size);
  FILE *file = bytes == NULL ? NULL : fopen(path, "rb");
  bool read = file != NULL && fread(bytes, 1, (size_t)size, file) == (size_t)size;
  if (file != NULL) fclose(file);
  if (!read) {
    free(bytes);
    snprintf(error, capacity, "%s could not be read", name);
    return NULL;
  }
  uint8_t *rgb = photo_jpeg_read(bytes, (size_t)size, min_width, min_height, width, height);
  free(bytes);
  if (rgb == NULL) snprintf(error, capacity, "%s is not a JPEG this console can read", name);
  return rgb;
}

static void run_load(Job *job, PhotoResult *result) {
  if (job->kind == PHOTO_KIND_THUMB) {
    char path[96];
    photo_path(path, sizeof path, job->name);
    long source_bytes = file_size(path);
    uint16_t *texture = calloc(PHOTO_THUMB_TEXTURE * PHOTO_THUMB_TEXTURE, 2);
    if (texture == NULL) return fail(result, "no memory for the thumbnail");
    if (source_bytes > 0 && read_thumb(job->name, source_bytes, texture)) {
      result->pixels = texture;
      result->texture_width = result->texture_height = PHOTO_THUMB_TEXTURE;
      return;
    }
    free(texture);
  }
  bool thumb = job->kind == PHOTO_KIND_THUMB;
  uint32_t width = 0, height = 0;
  long source_bytes = 0;
  uint8_t *rgb = decode(job->name, thumb ? PHOTO_THUMB_SIZE : PHOTO_SCREEN_WIDTH, thumb ? PHOTO_THUMB_SIZE : PHOTO_SCREEN_HEIGHT,
    &source_bytes, &width, &height, result->error, sizeof result->error);
  if (rgb == NULL) return;
  if (thumb) {
    result->pixels = photo_thumb(rgb, width, height);
    result->texture_width = result->texture_height = PHOTO_THUMB_TEXTURE;
    if (result->pixels != NULL) write_thumb(job->name, source_bytes, result->pixels);
  } else {
    result->pixels = photo_full(rgb, width, height);
    result->texture_width = PHOTO_SCREEN_TEXTURE_WIDTH;
    result->texture_height = PHOTO_SCREEN_TEXTURE_HEIGHT;
  }
  free(rgb);
  if (result->pixels == NULL) fail(result, "no memory for the photo");
}

static void worker_run(void *argument) {
  (void)argument;
  while (!stopping) {
    LightLock_Lock(&queue_lock);
    bool have = job_count > 0;
    Job job;
    if (have) {
      job = jobs[0];
      memmove(jobs, jobs + 1, (size_t)(job_count - 1) * sizeof jobs[0]);
      job_count -= 1;
    }
    LightLock_Unlock(&queue_lock);
    if (!have) {
      LightEvent_WaitTimeout(&worker_wake, WORKER_WAIT_NS);
      continue;
    }
    PhotoResult result;
    memset(&result, 0, sizeof result);
    result.type = job.type;
    result.id = job.id;
    result.kind = job.kind;
    snprintf(result.name, sizeof result.name, "%s", job.name);
    uint64_t started = osGetTime();
    if (job.type == JOB_SAVE) run_save(&job, &result);
    else run_load(&job, &result);
    free(job.pixels);
    result.ms = (uint32_t)(osGetTime() - started);
    push_result(&result);
  }
}

static bool ensure_worker(void) {
  if (!locks_ready) {
    LightLock_Init(&queue_lock);
    LightEvent_Init(&worker_wake, RESET_ONESHOT);
    locks_ready = true;
  }
  if (worker != NULL) return true;
  stopping = false;
  /* Below the main thread: encoding and decoding take what the frame leaves. */
  worker = threadCreate(worker_run, NULL, WORKER_STACK, 0x3f, -2, false);
  return worker != NULL;
}

static bool enqueue(const Job *job) {
  if (!ensure_worker()) return false;
  LightLock_Lock(&queue_lock);
  bool room = job_count < PHOTO_MAX_QUEUE;
  if (room) jobs[job_count++] = *job;
  LightLock_Unlock(&queue_lock);
  if (room) LightEvent_Signal(&worker_wake);
  return room;
}

// ---------------------------------------------------------------------------
// guest-facing (main thread, except photos_save)
// ---------------------------------------------------------------------------

bool photos_save(int32_t id, uint16_t *rgb565, uint32_t width, uint32_t height) {
  Job job;
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
  if (!ensure_worker()) return;
  PhotoResult result;
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
  DIR *dcim = names == NULL ? NULL : opendir(DCIM);
  if (dcim != NULL) {
    struct dirent *folder;
    while (count < MAX_LIST && (folder = readdir(dcim)) != NULL) {
      char folder_upper[9];
      if (!entry_name(folder, folder_upper, 8) || !photo_folder_name(folder_upper)) continue;
      char path[64];
      snprintf(path, sizeof path, "%s/%s", DCIM, folder_upper);
      DIR *dir = opendir(path);
      if (dir == NULL) continue;
      struct dirent *entry;
      while (count < MAX_LIST && (entry = readdir(dir)) != NULL) {
        char file[13];
        if (!entry_name(entry, file, 12) || !photo_file_name(file)) continue;
        char name[NAME_CAPACITY];
        snprintf(name, sizeof name, "%s/%s", folder_upper, file);
        names[count] = strdup(name);
        if (names[count] == NULL) break;
        count += 1;
      }
      closedir(dir);
    }
    closedir(dcim);
  }
  qsort(names, (size_t)count, sizeof *names, compare_names);
  jbuf_reset(&list_out);
  jbuf_text(&list_out, "[");
  for (int i = 0; i < count; i += 1) {
    char full[96];
    photo_path(full, sizeof full, names[i]);
    jbuf_text(&list_out, i ? ",{\"name\":" : "{\"name\":");
    jbuf_cstring(&list_out, names[i]);
    jbuf_text(&list_out, ",\"bytes\":");
    jbuf_i64(&list_out, file_size(full));
    jbuf_text(&list_out, "}");
    free(names[i]);
  }
  jbuf_text(&list_out, "]");
  free(names);
  const char *json = jbuf_cstr(&list_out);
  return json != NULL ? json : "[]";
}

int32_t photos_load(const char *name, int32_t kind) {
  char upper_name[NAME_CAPACITY];
  if (name == NULL || strlen(name) >= sizeof upper_name) return -1;
  snprintf(upper_name, sizeof upper_name, "%s", name);
  photo_upper(upper_name);
  if (!photo_name(upper_name) || (kind != PHOTO_KIND_THUMB && kind != PHOTO_KIND_FULL)) return -1;
  Job job;
  memset(&job, 0, sizeof job);
  job.type = JOB_LOAD;
  job.kind = kind;
  snprintf(job.name, sizeof job.name, "%s", upper_name);
  return enqueue(&job) ? PHOTO_PENDING : -1;
}

void photos_free(int32_t handle) {
  for (int i = 0; i < handle_count; i += 1) {
    if (handles[i] != handle) continue;
    ui_free_texture(handle);
    handles[i] = handles[--handle_count];
    return;
  }
}

bool photos_remove(const char *name) {
  char upper_name[NAME_CAPACITY];
  if (name == NULL || strlen(name) >= sizeof upper_name) return false;
  snprintf(upper_name, sizeof upper_name, "%s", name);
  photo_upper(upper_name);
  if (!photo_name(upper_name)) return false;
  char path[96];
  photo_path(path, sizeof path, upper_name);
  bool removed = remove(path) == 0;
  thumb_path(path, sizeof path, upper_name);
  remove(path);
  return removed;
}

/* A full buffer (EVENTS_LIMIT) drops the event. */
static void append_event(const char *json) {
  size_t mark = events.length;
  if (events.length > 0) jbuf_text(&events, ",");
  jbuf_text(&events, json);
  if (events.failed) {
    events.failed = false;
    events.length = mark;
    if (events.data != NULL) events.data[mark] = '\0';
  }
}

void photos_present(void) {
  if (!locks_ready) return;
  PhotoResult ready[PHOTO_MAX_QUEUE + 4];
  LightLock_Lock(&queue_lock);
  int count = result_count;
  memcpy(ready, results, (size_t)count * sizeof results[0]);
  result_count = 0;
  LightLock_Unlock(&queue_lock);
  for (int i = 0; i < count; i += 1) {
    PhotoResult *result = &ready[i];
    char json[256];
    if (result->error[0] != '\0') {
      if (result->type == JOB_SAVE) {
        snprintf(json, sizeof json, "{\"t\":\"error\",\"job\":%ld,\"message\":\"%s\"}", (long)result->id, result->error);
      } else {
        snprintf(json, sizeof json, "{\"t\":\"error\",\"name\":\"%s\",\"kind\":%ld,\"message\":\"%s\"}", result->name, (long)result->kind, result->error);
      }
    } else if (result->type == JOB_SAVE) {
      snprintf(json, sizeof json, "{\"t\":\"saved\",\"job\":%ld,\"name\":\"%s\",\"ms\":%lu}", (long)result->id, result->name, (unsigned long)result->ms);
    } else {
      int32_t handle = -1;
      if (handle_count < MAX_HANDLES) {
        size_t bytes = (size_t)result->texture_width * result->texture_height * 2u;
        handle = ui_upload_texture((const uint8_t *)result->pixels, bytes, result->texture_width, result->texture_height, PSM_5650);
      }
      free(result->pixels);
      result->pixels = NULL;
      if (handle < 0) {
        snprintf(json, sizeof json, "{\"t\":\"error\",\"name\":\"%s\",\"kind\":%ld,\"message\":\"no texture for the photo\"}", result->name, (long)result->kind);
      } else {
        handles[handle_count++] = handle;
        snprintf(json, sizeof json, "{\"t\":\"loaded\",\"name\":\"%s\",\"kind\":%ld,\"handle\":%ld,\"ms\":%lu}", result->name, (long)result->kind, (long)handle, (unsigned long)result->ms);
      }
    }
    append_event(json);
  }
}

const char *photos_events_json(void) {
  if (events.length == 0) return NULL;
  jbuf_reset(&events_out);
  jbuf_text(&events_out, "[");
  jbuf_raw(&events_out, events.data, events.length);
  jbuf_text(&events_out, "]");
  jbuf_reset(&events);
  return jbuf_cstr(&events_out);
}

void photos_teardown(void) {
  if (worker != NULL) {
    stopping = true;
    LightEvent_Signal(&worker_wake);
    threadJoin(worker, U64_MAX);
    threadFree(worker);
    worker = NULL;
  }
  if (locks_ready) {
    for (int i = 0; i < job_count; i += 1) free(jobs[i].pixels);
    for (int i = 0; i < result_count; i += 1) free(results[i].pixels);
  }
  job_count = 0;
  result_count = 0;
  /* The core drops every texture with the guest. */
  handle_count = 0;
  jbuf_free(&events);
  jbuf_free(&events_out);
  jbuf_free(&list_out);
}

#else /* capture and offload builds: no photos */

bool photos_save(int32_t job, uint16_t *rgb565, uint32_t width, uint32_t height) {
  (void)job;
  (void)width;
  (void)height;
  free(rgb565);
  return false;
}
void photos_fail(int32_t job, const char *message) {
  (void)job;
  (void)message;
}
const char *photos_list_json(void) { return "[]"; }
int32_t photos_load(const char *name, int32_t kind) {
  (void)name;
  (void)kind;
  return -1;
}
void photos_free(int32_t handle) { (void)handle; }
bool photos_remove(const char *name) {
  (void)name;
  return false;
}
const char *photos_events_json(void) { return NULL; }
void photos_present(void) {}
void photos_teardown(void) {}

#endif
