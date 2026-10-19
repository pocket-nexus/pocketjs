/* `globalThis.camera` — see camera.h. */

#include "camera.h"

#include <stdio.h>

#if !defined(POCKETJS_CAPTURE) && !defined(POCKETJS_OFFLOAD)

#include <3ds.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

#include "pocket_core.h"
#include "quirc/quirc.h"

/* contracts/spec/camera.ts */
#define CAMERA_WIDTH 320u
#define CAMERA_HEIGHT 240u
#define CAMERA_TEXTURE_WIDTH 512u
#define CAMERA_TEXTURE_HEIGHT 256u
#define CAMERA_QR_MAX_BYTES 512u

#define CAMERA_FRAME_BYTES (CAMERA_WIDTH * CAMERA_HEIGHT * 2u)
#define CAMERA_STAGING_BYTES (CAMERA_TEXTURE_WIDTH * CAMERA_TEXTURE_HEIGHT * 2u)
/* A decode pass costs tens of milliseconds on an Old 3DS; four a second
 * finds a code held in front of the lens without starving the guest. */
#define CAMERA_SCAN_MS 250u
#define CAMERA_THREAD_STACK (64u * 1024u)
/* The capture thread wakes this often to notice close(). */
#define CAMERA_WAIT_NS 100000000LL
/* Three frame buffers: one the camera writes, the newest complete one, and
 * the one the main thread is reading. */
#define CAMERA_BUFFERS 3

enum { CAPTURE_STARTING, CAPTURE_RUNNING, CAPTURE_FAILED };

static bool open_now;
static int32_t texture_handle = -1;
static C3D_Tex texture;
static bool texture_live;
static bool texture_retire;
static uint16_t *staging;
static uint16_t *buffers[CAMERA_BUFFERS];
static uint16_t *scan_frame;
static Thread capture_thread;
static Thread decode_thread;
static LightEvent decode_wake;
static _Atomic bool stopping;
static _Atomic int capture_state;
static _Atomic bool scan_busy;
static _Atomic uint32_t frames;
static _Atomic uint32_t scans;
static _Atomic uint32_t restarts;
/* Set once camInit succeeded: camExit is reference-counted and must pair
 * with exactly one successful camInit. */
static _Atomic bool camera_service;
static uint64_t last_scan_ms;
static char error[160];

/* Buffer hand-off between the capture thread and the main thread. */
static LightLock buffer_lock;
static int latest = -1;
static int reading = -1;

static LightLock payload_lock;
static char payload[CAMERA_QR_MAX_BYTES + 1];
static size_t payload_length;
static uint32_t payload_sequence;
static uint32_t polled_sequence;
static char poll_out[CAMERA_QR_MAX_BYTES + 1];
static char info_out[448];

static Result start_camera(u32 *transfer_bytes) {
  Result result = camInit();
  if (R_FAILED(result)) return result;
  atomic_store(&camera_service, true);
  u32 select = SELECT_OUT1;
  if (R_FAILED(result = CAMU_SetSize(select, SIZE_QVGA, CONTEXT_A))) return result;
  if (R_FAILED(result = CAMU_SetOutputFormat(select, OUTPUT_RGB_565, CONTEXT_A))) return result;
  if (R_FAILED(result = CAMU_SetFrameRate(select, FRAME_RATE_30))) return result;
  CAMU_SetNoiseFilter(select, true);
  CAMU_SetAutoExposure(select, true);
  CAMU_SetAutoWhiteBalance(select, true);
  if (R_FAILED(result = CAMU_SetTrimming(PORT_CAM1, false))) return result;
  if (R_FAILED(result = CAMU_GetMaxBytes(transfer_bytes, CAMERA_WIDTH, CAMERA_HEIGHT))) return result;
  if (R_FAILED(result = CAMU_SetTransferBytes(PORT_CAM1, *transfer_bytes, CAMERA_WIDTH, CAMERA_HEIGHT))) {
    return result;
  }
  if (R_FAILED(result = CAMU_Activate(select))) return result;
  CAMU_ClearBuffer(PORT_CAM1);
  return CAMU_StartCapture(PORT_CAM1);
}

/* A buffer neither newest nor being read. */
static int pick_write_buffer(int previous) {
  LightLock_Lock(&buffer_lock);
  int chosen = -1;
  for (int offset = 1; offset <= CAMERA_BUFFERS; offset += 1) {
    int candidate = (previous + offset) % CAMERA_BUFFERS;
    if (candidate != latest && candidate != reading) {
      chosen = candidate;
      break;
    }
  }
  LightLock_Unlock(&buffer_lock);
  return chosen;
}

/*
 * The capture thread: bring the camera up, then keep exactly one receive
 * armed and re-arm it the moment a frame lands, as the libctru camera
 * example does. A frame the port could not deliver raises the buffer-error
 * event, which stops capture until it is started again.
 */
static void capture_run(void *argument) {
  (void)argument;
  u32 transfer_bytes = 0;
  Result result = start_camera(&transfer_bytes);
  Handle events[2] = { 0, 0 };
  if (R_SUCCEEDED(result)) result = CAMU_GetBufferErrorInterruptEvent(&events[1], PORT_CAM1);
  if (R_FAILED(result)) {
    snprintf(error, sizeof error, "the outer camera did not start (0x%08lx)", (unsigned long)result);
    atomic_store(&capture_state, CAPTURE_FAILED);
    return;
  }
  atomic_store(&capture_state, CAPTURE_RUNNING);
  int writing = 0;
  while (!atomic_load(&stopping)) {
    if (events[0] == 0) {
      writing = pick_write_buffer(writing);
      if (writing < 0 ||
          R_FAILED(CAMU_SetReceiving(&events[0], buffers[writing], PORT_CAM1, CAMERA_FRAME_BYTES, (s16)transfer_bytes))) {
        events[0] = 0;
        writing = 0;
        svcSleepThread(CAMERA_WAIT_NS / 10);
        continue;
      }
    }
    s32 index = -1;
    if (R_FAILED(svcWaitSynchronizationN(&index, events, 2, false, CAMERA_WAIT_NS))) continue;
    if (index == 1) {
      /* Capture stopped on a buffer error: drop the receive and restart. */
      svcCloseHandle(events[0]);
      events[0] = 0;
      CAMU_ClearBuffer(PORT_CAM1);
      CAMU_StartCapture(PORT_CAM1);
      atomic_fetch_add(&restarts, 1);
      continue;
    }
    if (index != 0) continue;
    svcCloseHandle(events[0]);
    events[0] = 0;
    LightLock_Lock(&buffer_lock);
    latest = writing;
    LightLock_Unlock(&buffer_lock);
    atomic_fetch_add(&frames, 1);
  }
  if (events[0] != 0) svcCloseHandle(events[0]);
  if (events[1] != 0) svcCloseHandle(events[1]);
  CAMU_StopCapture(PORT_CAM1);
  CAMU_Activate(SELECT_NONE);
}

/* One decode pass over scan_frame. quirc reads 8-bit luma. */
static void scan(struct quirc *decoder) {
  int width = 0, height = 0;
  uint8_t *luma = quirc_begin(decoder, &width, &height);
  for (size_t i = 0; i < CAMERA_WIDTH * CAMERA_HEIGHT; i += 1) {
    uint16_t pixel = scan_frame[i];
    uint32_t r = (pixel >> 11) & 0x1f, g = (pixel >> 5) & 0x3f, b = pixel & 0x1f;
    /* BT.601 weights on 5/6/5 channels scaled to 8 bits. */
    luma[i] = (uint8_t)((r * 8u * 77u + g * 4u * 150u + b * 8u * 29u) >> 8);
  }
  quirc_end(decoder);
  int count = quirc_count(decoder);
  for (int index = 0; index < count; index += 1) {
    static struct quirc_code code;
    static struct quirc_data data;
    quirc_extract(decoder, index, &code);
    quirc_decode_error_t result = quirc_decode(&code, &data);
    if (result == QUIRC_ERROR_DATA_ECC) {
      quirc_flip(&code);
      result = quirc_decode(&code, &data);
    }
    if (result != QUIRC_SUCCESS || data.payload_len <= 0 || (size_t)data.payload_len > CAMERA_QR_MAX_BYTES) continue;
    LightLock_Lock(&payload_lock);
    memcpy(payload, data.payload, (size_t)data.payload_len);
    payload_length = (size_t)data.payload_len;
    payload[payload_length] = '\0';
    payload_sequence += 1;
    LightLock_Unlock(&payload_lock);
  }
}

static void decode_run(void *argument) {
  (void)argument;
  struct quirc *decoder = quirc_new();
  if (decoder == NULL || quirc_resize(decoder, CAMERA_WIDTH, CAMERA_HEIGHT) < 0) {
    /* The preview still runs without decoding. */
    snprintf(error, sizeof error, "QR decoder allocation failed");
    if (decoder != NULL) quirc_destroy(decoder);
    return;
  }
  while (!atomic_load(&stopping)) {
    LightEvent_WaitTimeout(&decode_wake, CAMERA_WAIT_NS);
    if (atomic_load(&stopping)) break;
    if (!atomic_load(&scan_busy)) continue;
    scan(decoder);
    atomic_fetch_add(&scans, 1);
    atomic_store(&scan_busy, false);
  }
  quirc_destroy(decoder);
}

static void join(Thread *thread) {
  if (*thread == NULL) return;
  threadJoin(*thread, U64_MAX);
  threadFree(*thread);
  *thread = NULL;
}

static void stop_threads_and_camera(void) {
  if (capture_thread != NULL || decode_thread != NULL) {
    atomic_store(&stopping, true);
    LightEvent_Signal(&decode_wake);
    join(&capture_thread);
    join(&decode_thread);
  }
  /* Both threads are joined, so the flag is final. */
  if (atomic_load(&camera_service)) {
    camExit();
    atomic_store(&camera_service, false);
  }
  for (int i = 0; i < CAMERA_BUFFERS; i += 1) {
    if (buffers[i] != NULL) linearFree(buffers[i]);
    buffers[i] = NULL;
  }
  free(scan_frame);
  scan_frame = NULL;
  latest = -1;
  reading = -1;
  atomic_store(&scan_busy, false);
}

static void release_texture(void) {
  if (texture_live) C3D_TexDelete(&texture);
  texture_live = false;
  texture_retire = false;
  if (staging != NULL) linearFree(staging);
  staging = NULL;
}

int32_t camera_open(void) {
  if (open_now) return texture_handle;
  /* A close earlier this frame left the texture for the GPU to retire. */
  if (texture_retire) return -1;
  error[0] = '\0';
  bool allocated = (staging = linearAlloc(CAMERA_STAGING_BYTES)) != NULL;
  for (int i = 0; i < CAMERA_BUFFERS; i += 1) {
    buffers[i] = linearAlloc(CAMERA_FRAME_BYTES);
    if (buffers[i] == NULL) allocated = false;
  }
  scan_frame = malloc(CAMERA_FRAME_BYTES);
  if (!allocated || scan_frame == NULL ||
      !C3D_TexInit(&texture, CAMERA_TEXTURE_WIDTH, CAMERA_TEXTURE_HEIGHT, GPU_RGB565)) {
    snprintf(error, sizeof error, "camera buffers did not fit in memory");
    stop_threads_and_camera();
    release_texture();
    return -1;
  }
  texture_live = true;
  memset(texture.data, 0, texture.size);
  GSPGPU_FlushDataCache(texture.data, texture.size);
  memset(staging, 0, CAMERA_STAGING_BYTES);
  C3D_TexSetFilter(&texture, GPU_LINEAR, GPU_LINEAR);
  C3D_TexSetWrap(&texture, GPU_CLAMP_TO_EDGE, GPU_CLAMP_TO_EDGE);

  /* An ordinary core image handle of the texture's size; gfx.c draws the
   * C3D texture above in its place. */
  uint8_t *blank = calloc(CAMERA_STAGING_BYTES, 1);
  texture_handle = blank == NULL ? -1 : ui_upload_texture(
    blank,
    CAMERA_STAGING_BYTES,
    CAMERA_TEXTURE_WIDTH,
    CAMERA_TEXTURE_HEIGHT,
    0
  );
  free(blank);
  if (texture_handle < 0) {
    snprintf(error, sizeof error, "camera texture registration failed");
    stop_threads_and_camera();
    release_texture();
    return -1;
  }

  LightEvent_Init(&decode_wake, RESET_ONESHOT);
  LightLock_Init(&payload_lock);
  LightLock_Init(&buffer_lock);
  latest = -1;
  reading = -1;
  atomic_store(&stopping, false);
  atomic_store(&capture_state, CAPTURE_STARTING);
  atomic_store(&frames, 0);
  atomic_store(&scans, 0);
  atomic_store(&restarts, 0);
  payload_sequence = 0;
  polled_sequence = 0;
  last_scan_ms = 0;
  /* Capture re-arms within microseconds of a frame landing, so it runs just
   * above the main thread; decoding takes whatever time is left over. */
  capture_thread = threadCreate(capture_run, NULL, CAMERA_THREAD_STACK, 0x2f, -2, false);
  decode_thread = threadCreate(decode_run, NULL, CAMERA_THREAD_STACK, 0x3f, -2, false);
  if (capture_thread == NULL || decode_thread == NULL) {
    snprintf(error, sizeof error, "camera thread allocation failed");
    ui_free_texture(texture_handle);
    texture_handle = -1;
    stop_threads_and_camera();
    release_texture();
    return -1;
  }
  open_now = true;
  return texture_handle;
}

void camera_close(void) {
  if (!open_now) return;
  open_now = false;
  stop_threads_and_camera();
  if (texture_handle >= 0) ui_free_texture(texture_handle);
  texture_handle = -1;
  texture_retire = texture_live;
}

void camera_teardown(void) {
  open_now = false;
  stop_threads_and_camera();
  texture_handle = -1;
  release_texture();
}

void camera_present(void) {
  if (texture_retire) {
    release_texture();
    return;
  }
  if (!open_now) return;
  LightLock_Lock(&buffer_lock);
  int frame = latest;
  latest = -1;
  reading = frame;
  LightLock_Unlock(&buffer_lock);
  if (frame < 0) return;
  uint16_t *pixels = buffers[frame];
  GSPGPU_InvalidateDataCache(pixels, CAMERA_FRAME_BYTES);
  for (uint32_t row = 0; row < CAMERA_HEIGHT; row += 1) {
    memcpy(staging + row * CAMERA_TEXTURE_WIDTH, pixels + row * CAMERA_WIDTH, CAMERA_WIDTH * 2u);
  }
  GSPGPU_FlushDataCache(staging, CAMERA_STAGING_BYTES);
  /* Linear rows top-down into the tiled, bottom-up texture: the media.c
   * transfer, at the texture's full 512x256. */
  C3D_SyncDisplayTransfer(
    (u32 *)staging,
    GX_BUFFER_DIM(CAMERA_TEXTURE_WIDTH, CAMERA_TEXTURE_HEIGHT),
    (u32 *)texture.data,
    GX_BUFFER_DIM(CAMERA_TEXTURE_WIDTH, CAMERA_TEXTURE_HEIGHT),
    GX_TRANSFER_FLIP_VERT(1) | GX_TRANSFER_OUT_TILED(1) | GX_TRANSFER_RAW_COPY(0) |
      GX_TRANSFER_IN_FORMAT(GX_TRANSFER_FMT_RGB565) | GX_TRANSFER_OUT_FORMAT(GX_TRANSFER_FMT_RGB565) |
      GX_TRANSFER_SCALING(GX_TRANSFER_SCALE_NO)
  );
  uint64_t now = osGetTime();
  if (!atomic_load(&scan_busy) && now - last_scan_ms >= CAMERA_SCAN_MS) {
    memcpy(scan_frame, pixels, CAMERA_FRAME_BYTES);
    last_scan_ms = now;
    atomic_store(&scan_busy, true);
    LightEvent_Signal(&decode_wake);
  }
  LightLock_Lock(&buffer_lock);
  reading = -1;
  LightLock_Unlock(&buffer_lock);
}

C3D_Tex *camera_texture(int32_t handle) {
  return texture_live && open_now && handle >= 0 && handle == texture_handle ? &texture : NULL;
}

const char *camera_poll(size_t *length) {
  if (payload_sequence == polled_sequence) return NULL;
  LightLock_Lock(&payload_lock);
  bool fresh = payload_sequence != polled_sequence;
  if (fresh) {
    memcpy(poll_out, payload, payload_length + 1);
    *length = payload_length;
    polled_sequence = payload_sequence;
  }
  LightLock_Unlock(&payload_lock);
  return fresh ? poll_out : NULL;
}

const char *camera_info_json(void) {
  char escaped[sizeof error * 2];
  size_t used = 0;
  for (const char *at = error; *at != '\0' && used + 2 < sizeof escaped; at += 1) {
    if (*at == '"' || *at == '\\') escaped[used++] = '\\';
    escaped[used++] = *at;
  }
  escaped[used] = '\0';
  /* `restarts` (beyond CameraInfo): captures restarted after a buffer error. */
  snprintf(
    info_out,
    sizeof info_out,
    "{\"open\":%s,\"frames\":%lu,\"scans\":%lu,\"error\":\"%s\",\"restarts\":%lu}",
    open_now ? "true" : "false",
    (unsigned long)atomic_load(&frames),
    (unsigned long)atomic_load(&scans),
    escaped,
    (unsigned long)atomic_load(&restarts)
  );
  return info_out;
}

#else /* capture and offload builds: no camera */

int32_t camera_open(void) { return -1; }
void camera_close(void) {}
const char *camera_poll(size_t *length) {
  (void)length;
  return NULL;
}
const char *camera_info_json(void) {
  return "{\"open\":false,\"frames\":0,\"scans\":0,\"error\":\"this build has no camera\"}";
}
void camera_present(void) {}
C3D_Tex *camera_texture(int32_t handle) {
  (void)handle;
  return NULL;
}
void camera_teardown(void) {}

#endif
