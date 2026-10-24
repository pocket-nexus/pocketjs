/*
 * `globalThis.media` on ESP-IDF — see pocketjs/media.h.
 *
 * The stream task owns the socket. It reads the companion's PKMV stream
 * (tools/media-stream.ts): PAL8 pictures are applied to a reference picture
 * and expanded into a ring of PSM_5650 frames, IMA ADPCM blocks are decoded
 * into a ring of PCM blocks, and every packet returns one credit. The audio
 * task writes the PCM ring to the board's speaker and keeps the clock: the
 * position is the block being played plus the time since it started. The
 * owner task copies the frame due at that position into the media texture
 * between turns. H.264 needs a decoder this host lacks, so status() reports
 * `h264: false` and the companion sends PAL8.
 *
 * Without a speaker the stream plays muted: audio packets are dropped and
 * the clock is the system timer from the first frame, paused with the
 * stream; a packet more than SILENT_LEAD_MS ahead of it waits.
 */

#include "pocket/media.h"

#include <errno.h>
#include <math.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/inet.h"
#include "lwip/sockets.h"
#include "media_adpcm.h"
#include "media_wire.h"
#include "pocket/textures.h"
#include "quickjs.h"

/* contracts/spec/spec.ts: PSM_5650 and IMG_FLAG_LINEAR. */
#define PSM_5650 0u
#define IMG_FLAG_LINEAR 2u

enum { IDLE, OPENING, BUFFERING, PLAYING, ENDED, FAILED };
enum {
  ERR_NONE,
  ERR_MEMORY,
  ERR_SOCKET,
  ERR_HEADER,
  ERR_PACKET,
  ERR_CODEC,
  ERR_DECODE,
  ERR_REMOTE
};
/* The audio ring lets the stream run 24 blocks (1.1 s) ahead of the
 * speaker; the frame ring covers that lead at 12 fps (1.3 s), or a frame
 * that arrives early is dropped. */
enum { VIDEO_SLOTS = 16, AUDIO_SLOTS = 24, COMMAND_SLOTS = 4 };
/* Muted read-ahead: 9 PAL8 frames at 12 fps. */
enum { SILENT_LEAD_MS = 750 };
/* Audio buffered before playback starts or resumes after an underrun. */
enum { STARTUP_MS = 300 };
/* Time from a block's write to its first sample at the speaker: the I2S
 * DMA queue. */
enum { AUDIO_LATENCY_MS = 40 };
/* The frame buffer: the picture plus the repeated last column and row. */
#define FRAME_PIXELS ((MEDIA_WIDTH + 1) * (MEDIA_HEIGHT + 1))
#define STREAM_STACK (6u * 1024u)
#define AUDIO_STACK (4u * 1024u)
#define IO_TIMEOUT_MS 10000

static const char *TAG = "pocketjs_media";

typedef struct {
  char host[16], token[65];
  unsigned port, generation;
} command_t;
typedef struct {
  uint16_t *pixels;
  unsigned width, height;
  uint32_t pts, generation;
} video_frame_t;
typedef struct {
  int16_t pcm[MEDIA_AUDIO_FRAMES * 2];
  unsigned frames;
  uint32_t pts, generation;
} audio_block_t;

static pocketjs_media_config_t board;
static bool started;
static pocket_runtime *runtime;
static int32_t texture_handle = -1;

static command_t commands[COMMAND_SLOTS];
static _Atomic unsigned command_read, command_write, requested,
    status_generation;
static _Atomic bool requested_open;
static video_frame_t frames[VIDEO_SLOTS];
static _Atomic unsigned frame_read, frame_write;
static audio_block_t *blocks;
static _Atomic unsigned block_read, block_write;
static _Atomic unsigned phase, position, received, decoded, presented,
    dropped, decode_max, underruns, failure;
static _Atomic unsigned volume_percent = 100, buffered_until;
static _Atomic bool paused, startup_ready, draining;
static bool audio_live;
/* The audio clock: the block being played and when its write began. */
static _Atomic uint32_t clock_pts;
static _Atomic int64_t clock_us;
static _Atomic bool clock_running;
/* The muted clock: system microseconds at the stream origin, moved forward
 * by the time spent paused. */
static bool silent_running;
static int64_t silent_started, silent_paused_at;
static uint32_t origin_position, buffer_origin;
static uint8_t *pal8_ref;
static unsigned current_generation;
static TaskHandle_t stream_task;
static TaskHandle_t audio_task;
_Static_assert(ATOMIC_INT_LOCK_FREE == 2, "Media UI handoff must be lock-free");

static uint32_t now_ms(void) {
  return (uint32_t)(esp_timer_get_time() / 1000);
}

static bool current(void) {
  return atomic_load(&requested) == current_generation;
}

static void fail(unsigned error) {
  if (!current())
    return;
  atomic_store(&failure, error);
  atomic_store(&phase, FAILED);
}

/* The playback position now (milliseconds of stream time). */
static uint32_t clock_now(void) {
  if (!audio_live || !atomic_load(&clock_running))
    return atomic_load(&position);
  const int64_t since =
      (esp_timer_get_time() - atomic_load(&clock_us)) / 1000 -
      AUDIO_LATENCY_MS;
  const uint32_t block_ms = MEDIA_AUDIO_FRAMES * 1000 / MEDIA_SAMPLE_RATE;
  const uint32_t ahead =
      since <= 0 ? 0 : (uint32_t)since > block_ms ? block_ms : (uint32_t)since;
  return atomic_load(&clock_pts) + ahead;
}

static void silent_tick(void) {
  if (!silent_running) {
    if (!atomic_load(&decoded))
      return;
    silent_running = true;
    silent_started = esp_timer_get_time();
    silent_paused_at = 0;
    atomic_store(&phase, PLAYING);
    return;
  }
  if (atomic_load(&paused)) {
    if (!silent_paused_at)
      silent_paused_at = esp_timer_get_time();
    return;
  }
  if (silent_paused_at) {
    silent_started += esp_timer_get_time() - silent_paused_at;
    silent_paused_at = 0;
  }
  atomic_store(&position,
               origin_position +
                   (uint32_t)((esp_timer_get_time() - silent_started) / 1000));
}

static bool silent_wait(uint32_t pts) {
  while (current() && pts > atomic_load(&position) + SILENT_LEAD_MS) {
    silent_tick();
    vTaskDelay(pdMS_TO_TICKS(2));
  }
  return current();
}

static bool receive_exact(int fd, void *data, size_t count) {
  uint8_t *p = data;
  uint32_t deadline = now_ms() + IO_TIMEOUT_MS;
  while (count && current()) {
    if (!audio_live)
      silent_tick();
    if (atomic_load(&paused)) {
      deadline = now_ms() + IO_TIMEOUT_MS;
      vTaskDelay(pdMS_TO_TICKS(5));
      continue;
    }
    const int n = recv(fd, p, count, 0);
    if (n > 0) {
      p += n;
      count -= (size_t)n;
      atomic_fetch_add(&received, (unsigned)n);
      deadline = now_ms() + IO_TIMEOUT_MS;
      continue;
    }
    if (n == 0 || (errno != EWOULDBLOCK && errno != EAGAIN) ||
        (int32_t)(now_ms() - deadline) > 0)
      return false;
  }
  return count == 0 && current();
}

static bool put_audio(const uint8_t *data, unsigned size, uint32_t pts) {
  if (!audio_live) {
    atomic_store(&buffered_until,
                 pts + (size > 7 ? size - 7 : 0) * 1000 / MEDIA_SAMPLE_RATE);
    return current();
  }
  while (current()) {
    const unsigned write = atomic_load(&block_write);
    if (write - atomic_load(&block_read) >= AUDIO_SLOTS) {
      vTaskDelay(pdMS_TO_TICKS(2));
      continue;
    }
    audio_block_t *block = &blocks[write % AUDIO_SLOTS];
    const unsigned count = media_decode_audio(data, size, block->pcm);
    if (!count) {
      fail(ERR_PACKET);
      return false;
    }
    block->frames = count;
    block->pts = pts;
    block->generation = current_generation;
    atomic_store(&block_write, write + 1);
    atomic_store(&buffered_until, pts + count * 1000 / MEDIA_SAMPLE_RATE);
    if (!atomic_load(&startup_ready) && atomic_load(&decoded) &&
        atomic_load(&buffered_until) >= buffer_origin + STARTUP_MS)
      atomic_store(&startup_ready, true);
    return true;
  }
  return false;
}

/* The PAL8 palette in the core's PSM_5650: red and blue trade places. */
static void palette_to_5650(MediaPal8 *state, unsigned colors) {
  for (unsigned i = 0; i < colors; ++i) {
    const uint16_t v = state->lut[i];
    state->lut[i] = (uint16_t)((v >> 11) | (v & 0x07e0u) | (v << 11));
  }
}

static bool decode_pal8(MediaPal8 *state, const uint8_t *data, size_t size,
                        uint32_t pts) {
  const int64_t started_us = esp_timer_get_time();
  if (!media_pal8_apply(state, pal8_ref, data, size)) {
    fail(ERR_PACKET);
    return false;
  }
  palette_to_5650(state, media_u16(data + 4));
  /* The reference picture already holds this frame, so a full ring drops
   * its picture instead of waiting: the next frame shown is still exact. */
  const unsigned write = atomic_load(&frame_write);
  if (write - atomic_load(&frame_read) >= VIDEO_SLOTS) {
    atomic_fetch_add(&dropped, 1);
    return current();
  }
  video_frame_t *slot = &frames[write % VIDEO_SLOTS];
  media_pal8_expand(state, pal8_ref, slot->pixels, state->width + 1);
  slot->width = state->width + 1;
  slot->height = state->height + 1 > MEDIA_HEIGHT ? MEDIA_HEIGHT
                                                 : state->height + 1;
  if (slot->width > MEDIA_WIDTH)
    slot->width = MEDIA_WIDTH;
  const unsigned us = (unsigned)(esp_timer_get_time() - started_us);
  if (us > atomic_load(&decode_max))
    atomic_store(&decode_max, us);
  slot->pts = pts;
  slot->generation = current_generation;
  atomic_fetch_add(&decoded, 1);
  atomic_store(&frame_write, write + 1);
  return true;
}

static bool send_credit(int fd) {
  const char credit = 1;
  const uint32_t deadline = now_ms() + IO_TIMEOUT_MS;
  while (current()) {
    if (send(fd, &credit, 1, 0) == 1)
      return true;
    if ((errno != EWOULDBLOCK && errno != EAGAIN) ||
        (int32_t)(now_ms() - deadline) > 0)
      return false;
    vTaskDelay(pdMS_TO_TICKS(1));
  }
  return false;
}

static int open_socket(const command_t *cmd) {
  const int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0)
    return -1;
  struct sockaddr_in address = {.sin_family = AF_INET,
                                .sin_port = htons(cmd->port)};
  const struct timeval timeout = {.tv_sec = 0, .tv_usec = 100 * 1000};
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof timeout);
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof timeout);
  /* A credit is one byte: it leaves when its packet is used, not when the
   * previous credit's acknowledgement arrives. */
  const int nodelay = 1;
  setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &nodelay, sizeof nodelay);
  if (inet_pton(AF_INET, cmd->host, &address.sin_addr) != 1 ||
      connect(fd, (struct sockaddr *)&address, sizeof address) != 0) {
    close(fd);
    return -1;
  }
  size_t sent = 0;
  const uint32_t deadline = now_ms() + IO_TIMEOUT_MS;
  while (current() && sent < 64 && (int32_t)(now_ms() - deadline) <= 0) {
    const int n = send(fd, cmd->token + sent, 64 - sent, 0);
    if (n > 0)
      sent += (size_t)n;
    else if (errno != EWOULDBLOCK && errno != EAGAIN)
      break;
  }
  if (sent != 64) {
    close(fd);
    return -1;
  }
  return fd;
}

/* Wait for the speaker to play every queued block. */
static void drain_audio(void) {
  atomic_store(&startup_ready, true);
  atomic_store(&draining, true);
  while (current() && atomic_load(&block_read) != atomic_load(&block_write))
    vTaskDelay(pdMS_TO_TICKS(5));
  if (current()) {
    atomic_store(&position, atomic_load(&buffered_until));
    atomic_store(&phase, ENDED);
  }
}

static void play(const command_t *cmd) {
  current_generation = cmd->generation;
  atomic_store(&phase, OPENING);
  atomic_store(&failure, ERR_NONE);
  atomic_store(&position, 0);
  atomic_store(&received, 0);
  atomic_store(&decoded, 0);
  atomic_store(&presented, 0);
  atomic_store(&dropped, 0);
  atomic_store(&decode_max, 0);
  atomic_store(&underruns, 0);
  atomic_store(&buffered_until, 0);
  atomic_store(&clock_running, false);
  atomic_store(&startup_ready, false);
  atomic_store(&draining, false);
  atomic_store(&block_read, atomic_load(&block_write));
  atomic_store(&status_generation, current_generation);
  silent_running = false;
  uint8_t *packet = NULL;
  const int fd = open_socket(cmd);
  if (fd < 0) {
    fail(ERR_SOCKET);
    return;
  }
  uint8_t header[32];
  if (!receive_exact(fd, header, 32)) {
    fail(ERR_SOCKET);
    goto done;
  }
  if (!media_header_valid(header)) {
    fail(ERR_HEADER);
    goto done;
  }
  if (media_u16(header + 14) != MEDIA_CODEC_PAL8) {
    fail(ERR_CODEC);
    goto done;
  }
  origin_position = media_u32(header + 24);
  buffer_origin = origin_position;
  atomic_store(&position, origin_position);
  packet = heap_caps_malloc(MEDIA_PACKET_BYTES, MALLOC_CAP_SPIRAM);
  if (packet == NULL) {
    fail(ERR_MEMORY);
    goto done;
  }
  MediaPal8 pal8 = {0};
  memset(pal8_ref, 0, MEDIA_WIDTH * MEDIA_HEIGHT);
  atomic_store(&phase, BUFFERING);
  uint32_t last_video = origin_position, last_audio = origin_position;
  while (current()) {
    if (!receive_exact(fd, header, 16)) {
      fail(ERR_SOCKET);
      break;
    }
    if (!media_packet_valid(header)) {
      fail(ERR_PACKET);
      break;
    }
    const uint32_t size = media_u32(header + 4), pts = media_u32(header + 8);
    if ((header[0] == 1 && (pts < last_video || pts - last_video > 1000)) ||
        (header[0] == 2 && (pts < last_audio || pts - last_audio > 1000))) {
      fail(ERR_PACKET);
      break;
    }
    if (header[0] == 1)
      last_video = pts;
    if (header[0] == 2)
      last_audio = pts;
    if (size && !receive_exact(fd, packet, size)) {
      fail(ERR_SOCKET);
      break;
    }
    if (!audio_live && (header[0] == 1 || header[0] == 2) && !silent_wait(pts))
      break;
    if (header[0] == 1 && !decode_pal8(&pal8, packet, size, pts))
      break;
    if (header[0] == 2 && !put_audio(packet, size, pts))
      break;
    if (!atomic_load(&decoded) && (header[0] == 1 || header[0] == 2) &&
        pts - origin_position > 500) {
      fail(ERR_DECODE);
      break;
    }
    if (header[0] == 4) {
      fail(ERR_REMOTE);
      break;
    }
    if ((header[0] == 1 || header[0] == 2) && !send_credit(fd)) {
      fail(ERR_SOCKET);
      break;
    }
    if (header[0] == 3) {
      if (!atomic_load(&decoded)) {
        fail(ERR_DECODE);
        break;
      }
      if (audio_live) {
        drain_audio();
      } else {
        /* Muted: the stream ends when its last frame has been shown. */
        while (current() &&
               atomic_load(&frame_read) != atomic_load(&frame_write)) {
          silent_tick();
          vTaskDelay(pdMS_TO_TICKS(2));
        }
        if (current())
          atomic_store(&phase, ENDED);
      }
      break;
    }
  }
done:
  close(fd);
  free(packet);
}

static void stream_run(void *unused) {
  (void)unused;
  for (;;) {
    const unsigned read = atomic_load(&command_read);
    if (read == atomic_load(&command_write)) {
      ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(50));
      continue;
    }
    command_t cmd = commands[read % COMMAND_SLOTS];
    atomic_store(&command_read, read + 1);
    if (cmd.generation == atomic_load(&requested))
      play(&cmd);
  }
}

/* The speaker: blocks in stream order while the stream is current and
 * playing; an empty queue after playback began is an underrun. */
static void audio_run(void *unused) {
  (void)unused;
  unsigned last_volume = 101;
  bool started_playing = false;
  for (;;) {
    const unsigned volume = atomic_load(&volume_percent);
    if (volume != last_volume && board.audio_volume != NULL) {
      board.audio_volume(board.context, volume);
      last_volume = volume;
    }
    const unsigned read = atomic_load(&block_read);
    const bool empty = read == atomic_load(&block_write);
    if (atomic_load(&paused) || !atomic_load(&startup_ready) || empty) {
      if (empty && started_playing && !atomic_load(&paused) &&
          !atomic_load(&draining) && atomic_load(&phase) == PLAYING) {
        atomic_fetch_add(&underruns, 1);
        buffer_origin = atomic_load(&buffered_until);
        atomic_store(&position, buffer_origin);
        atomic_store(&startup_ready, false);
        atomic_store(&phase, BUFFERING);
      }
      if (empty || atomic_load(&paused)) {
        started_playing = false;
        atomic_store(&clock_running, false);
      }
      vTaskDelay(pdMS_TO_TICKS(5));
      continue;
    }
    audio_block_t *block = &blocks[read % AUDIO_SLOTS];
    if (block->generation == atomic_load(&requested)) {
      atomic_store(&clock_pts, block->pts);
      atomic_store(&clock_us, esp_timer_get_time());
      atomic_store(&clock_running, true);
      atomic_store(&position, block->pts);
      if (atomic_load(&phase) == BUFFERING)
        atomic_store(&phase, PLAYING);
      started_playing = true;
      board.audio_write(board.context, block->pcm, block->frames);
    }
    atomic_store(&block_read, read + 1);
  }
}

void pocketjs_media_config_defaults(pocketjs_media_config_t *config) {
  if (config != NULL) {
    *config = (pocketjs_media_config_t){
        .struct_size = sizeof(*config),
        .worker_core = tskNO_AFFINITY,
    };
  }
}

esp_err_t pocketjs_media_setup(const pocketjs_media_config_t *config) {
  if (config == NULL || config->struct_size < sizeof(*config))
    return ESP_ERR_INVALID_ARG;
  if (started)
    return ESP_ERR_INVALID_STATE;
  board = *config;
  pal8_ref = heap_caps_malloc(MEDIA_WIDTH * MEDIA_HEIGHT, MALLOC_CAP_SPIRAM);
  blocks = heap_caps_calloc(AUDIO_SLOTS, sizeof *blocks, MALLOC_CAP_SPIRAM);
  if (pal8_ref == NULL || blocks == NULL)
    return ESP_ERR_NO_MEM;
  for (unsigned i = 0; i < VIDEO_SLOTS; ++i) {
    frames[i].pixels = heap_caps_calloc(FRAME_PIXELS, 2, MALLOC_CAP_SPIRAM);
    if (frames[i].pixels == NULL)
      return ESP_ERR_NO_MEM;
  }
  audio_live = board.audio_open != NULL && board.audio_write != NULL &&
               board.audio_open(board.context, MEDIA_SAMPLE_RATE) == ESP_OK;
  if (!audio_live)
    ESP_LOGW(TAG, "no speaker: streams play muted");
  if (xTaskCreatePinnedToCoreWithCaps(stream_run, "pocketjs_media",
                                      STREAM_STACK, NULL, 3, &stream_task,
                                      board.worker_core,
                                      MALLOC_CAP_SPIRAM) != pdPASS)
    return ESP_ERR_NO_MEM;
  if (audio_live &&
      xTaskCreatePinnedToCoreWithCaps(audio_run, "pocketjs_audio", AUDIO_STACK,
                                      NULL, 6, &audio_task, board.worker_core,
                                      MALLOC_CAP_SPIRAM) != pdPASS)
    return ESP_ERR_NO_MEM;
  started = true;
  return ESP_OK;
}

static bool media_open(const char *host, unsigned port, const char *token) {
  if (!started || !host || strlen(host) > 15 || !port || port > 65535 ||
      !token || strlen(token) != 64)
    return false;
  for (unsigned i = 0; i < 64; i++)
    if (!((token[i] >= '0' && token[i] <= '9') ||
          (token[i] >= 'a' && token[i] <= 'f')))
      return false;
  const unsigned write = atomic_load(&command_write);
  if (write - atomic_load(&command_read) >= COMMAND_SLOTS)
    return false;
  command_t *cmd = &commands[write % COMMAND_SLOTS];
  strcpy(cmd->host, host);
  strcpy(cmd->token, token);
  cmd->port = port;
  cmd->generation = atomic_fetch_add(&requested, 1) + 1;
  atomic_store(&paused, false);
  atomic_store(&requested_open, true);
  atomic_store(&command_write, write + 1);
  xTaskNotifyGive(stream_task);
  return true;
}

static void media_close(void) {
  atomic_fetch_add(&requested, 1);
  atomic_store(&requested_open, false);
  atomic_store(&paused, false);
}

static int32_t media_texture(void) {
  if (texture_handle < 0 && runtime != NULL) {
    /* An IMG entry (framework/compiler/pak.ts): linear, since layouts scale
     * the picture. */
    const size_t bytes = 8u + MEDIA_WIDTH * MEDIA_HEIGHT * 2u;
    uint8_t *entry = heap_caps_calloc(1, bytes, MALLOC_CAP_SPIRAM);
    if (entry != NULL) {
      entry[0] = MEDIA_WIDTH & 0xff;
      entry[1] = MEDIA_WIDTH >> 8;
      entry[2] = MEDIA_HEIGHT & 0xff;
      entry[3] = MEDIA_HEIGHT >> 8;
      entry[4] = PSM_5650;
      entry[5] = IMG_FLAG_LINEAR;
      texture_handle = pocket_texture_upload_entry(runtime, entry, bytes);
      free(entry);
    }
  }
  return texture_handle;
}

void pocketjs_media_present(void) {
  if (!started)
    return;
  unsigned read = atomic_load(&frame_read);
  const unsigned write = atomic_load(&frame_write);
  const unsigned generation = atomic_load(&requested);
  const unsigned now = audio_live ? clock_now() : atomic_load(&position);
  video_frame_t *chosen = NULL;
  while (read != write) {
    video_frame_t *slot = &frames[read % VIDEO_SLOTS];
    if (slot->generation == generation && slot->pts > now + 20 &&
        atomic_load(&phase) != ENDED)
      break;
    if (slot->generation == generation) {
      if (chosen)
        atomic_fetch_add(&dropped, 1);
      chosen = slot;
    }
    read++;
  }
  if (chosen && texture_handle >= 0 && runtime != NULL) {
    pocket_runtime_update_texture(runtime, texture_handle, 0, 0, chosen->width,
                                  chosen->height, (const uint8_t *)chosen->pixels,
                                  (size_t)chosen->width * chosen->height * 2u);
    atomic_fetch_add(&presented, 1);
  }
  atomic_store(&frame_read, read);
}

static void media_snapshot(char *out, size_t capacity) {
  static const char *names[] = {"idle",    "opening", "buffering",
                                "playing", "ended",   "error"};
  static const char *errors[] = {"",
                                 "Media allocation failed",
                                 "Media connection lost",
                                 "Unsupported media stream",
                                 "Invalid media packet",
                                 "This console plays PAL8 streams only",
                                 "Video decode failed",
                                 "Companion media failed"};
  unsigned p = atomic_load(&phase), e = atomic_load(&failure),
           now = audio_live ? clock_now() : atomic_load(&position),
           until = atomic_load(&buffered_until);
  if (!atomic_load(&requested_open)) {
    p = IDLE;
    e = 0;
  } else if (atomic_load(&status_generation) != atomic_load(&requested)) {
    p = OPENING;
    e = 0;
    now = until = 0;
  }
  const char *name = p < 6 ? names[p] : "error";
  if (atomic_load(&paused) && (p == PLAYING || p == BUFFERING))
    name = "paused";
  const char *detail =
      e < sizeof errors / sizeof errors[0] ? errors[e] : "Media failed";
  snprintf(out, capacity,
           "{\"phase\":\"%s\",\"positionMs\":%u,\"bufferedMs\":%u,"
           "\"decodedFrames\":%u,\"presentedFrames\":%u,\"droppedFrames\":%u,"
           "\"receivedBytes\":%u,\"decodeMaxUs\":%u,\"audioUnderruns\":%u,"
           "\"hardware\":false,\"h264\":false,\"audio\":%s,\"error\":\"%s\"}",
           name, now, until > now ? until - now : 0, atomic_load(&decoded),
           atomic_load(&presented), atomic_load(&dropped),
           atomic_load(&received), atomic_load(&decode_max),
           atomic_load(&underruns), audio_live ? "true" : "false", detail);
}

void pocketjs_media_teardown(void) {
  media_close();
  texture_handle = -1;
  runtime = NULL;
}

// ---------------------------------------------------------------------------
// globalThis.media
// ---------------------------------------------------------------------------

enum { OP_OPEN, OP_CLOSE, OP_PAUSED, OP_VOLUME, OP_TEXTURE, OP_STATUS };

static JSValue media_operation(JSContext *ctx, JSValueConst this_value,
                               int argc, JSValueConst *argv, int magic,
                               void *opaque) {
  (void)this_value;
  (void)opaque;
  switch (magic) {
  case OP_OPEN: {
    const char *host = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    const char *token = argc > 2 ? JS_ToCString(ctx, argv[2]) : NULL;
    int32_t port = 0;
    if (argc > 1)
      JS_ToInt32(ctx, &port, argv[1]);
    const bool opened =
        host != NULL && token != NULL && port > 0 &&
        media_open(host, (unsigned)port, token);
    if (host != NULL)
      JS_FreeCString(ctx, host);
    if (token != NULL)
      JS_FreeCString(ctx, token);
    return JS_NewBool(ctx, opened);
  }
  case OP_CLOSE:
    media_close();
    return JS_UNDEFINED;
  case OP_PAUSED:
    atomic_store(&paused, argc > 0 && JS_ToBool(ctx, argv[0]));
    return JS_UNDEFINED;
  case OP_VOLUME: {
    double value = 0;
    if (argc > 0)
      JS_ToFloat64(ctx, &value, argv[0]);
    atomic_store(&volume_percent,
                 (unsigned)(!isfinite(value) || value < 0 ? 0
                            : value > 1                   ? 100
                                                          : value * 100));
    return JS_UNDEFINED;
  }
  case OP_TEXTURE:
    return JS_NewInt32(ctx, media_texture());
  case OP_STATUS: {
    char status[640];
    media_snapshot(status, sizeof status);
    return JS_NewString(ctx, status);
  }
  default:
    return JS_UNDEFINED;
  }
}

static void add_operation(JSContext *ctx, JSValue object, const char *name,
                          int arity, int magic) {
  JS_SetPropertyStr(ctx, object, name,
                    JS_NewCClosure(ctx, media_operation, name, NULL, arity,
                                   magic, NULL));
}

static esp_err_t install(JSContext *ctx, void *user_data) {
  (void)user_data;
  JSValue global = JS_GetGlobalObject(ctx);
  JSValue media = JS_NewObject(ctx);
  add_operation(ctx, media, "open", 3, OP_OPEN);
  add_operation(ctx, media, "close", 0, OP_CLOSE);
  add_operation(ctx, media, "paused", 1, OP_PAUSED);
  add_operation(ctx, media, "volume", 1, OP_VOLUME);
  add_operation(ctx, media, "texture", 0, OP_TEXTURE);
  add_operation(ctx, media, "status", 0, OP_STATUS);
  const int set = JS_SetPropertyStr(ctx, global, "media", media);
  JS_FreeValue(ctx, global);
  return set < 0 ? ESP_ERR_NO_MEM : ESP_OK;
}

esp_err_t pocketjs_media_install(JSContext *realm, pocket_runtime *owner) {
  if (realm == NULL || owner == NULL || !started)
    return ESP_ERR_INVALID_ARG;
  runtime = owner;
  texture_handle = -1;
  return install(realm, NULL);
}
