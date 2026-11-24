#include "esp_attr.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "pocket/display_esp_lcd.h"
#include <limits.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
/* One strip transfer takes milliseconds at any usable SPI/I80 clock. A wait
 * past this bound fails and keeps the buffer reserved. */
#define WAIT_TIMEOUT_MS 1000
/* Staged presentation: a panel refreshes every 8 to 33 ms; without a report
 * for this long the presenter sends the frame unsynchronised. */
#define REFRESH_TIMEOUT_MS 50
#define PRESENTER_STACK_BYTES 4096
/* A window of a staged flush: the columns [x, x + width) of the rows
 * [y, y + height). The presenter advances y past the rows it has sent. */
typedef struct {
  uint32_t x, y, width, height;
} span;
typedef struct {
  uint8_t *pixels;
  bool pending, timed_out;
  uint64_t token;
  uint32_t target;
  pocket_rect region;
  pocket_surface surface;
  /* Staged presentation: the flushed windows, the flush time, and whether the
   * presenter has copied them out of `pixels`. */
  span *spans;
  uint32_t span_count;
  int64_t flushed_us;
  atomic_bool presented;
} buffer;
/* A DMA buffer of the presenter and the completion count at which its last
 * transfer has landed. */
typedef struct {
  uint8_t *pixels;
  uint32_t target;
} transfer;
struct pocket_display_esp_lcd {
  pocket_display_esp_lcd_config config;
  size_t capacity;
  uint32_t active;
  uint64_t next, generation;
  uint32_t submitted;
  volatile uint32_t completed;
  SemaphoreHandle_t done;
  buffer buffers[2];
  /* Staged presentation. */
  bool staged;
  transfer transfers[2];
  uint32_t turn;
  QueueHandle_t queue;
  SemaphoreHandle_t presented, tick;
  esp_timer_handle_t timer;
  /* Written by the presenter, read by the task that drives the display. */
  atomic_bool presenting, lost;
  atomic_uint_least32_t frames, unsynced, late, present_us_max;
};
/* The panel IO's transfer ISR delivers one on_color_trans_done per completed
 * esp_lcd_panel_draw_bitmap, for SPI and I80 alike. */
static bool IRAM_ATTR transfer_done(esp_lcd_panel_io_handle_t io,
                                    esp_lcd_panel_io_event_data_t *data,
                                    void *context) {
  (void)io;
  (void)data;
  pocket_display_esp_lcd *d = context;
  d->completed++;
  BaseType_t woken = pdFALSE;
  xSemaphoreGiveFromISR(d->done, &woken);
  return woken == pdTRUE;
}
static bool landed(const pocket_display_esp_lcd *d, const buffer *b) {
  return (int32_t)(d->completed - b->target) >= 0;
}
/* A flushed buffer, or one whose wait timed out before its transfer landed,
 * may still be read by DMA. A staged buffer is read until the presenter has
 * copied its rows. */
static bool reserved(const pocket_display_esp_lcd *d, const buffer *b) {
  if (d->staged)
    return !atomic_load(&b->presented);
  return b->pending || (b->timed_out && !landed(d, b));
}
/* IDF's parameter transaction waits for all queued color transfers before
 * returning. A no-command/no-parameter transaction is the terminal barrier
 * for invalidation, destruction and submission errors; every completion
 * callback has run when it returns. Failure to establish it is fatal:
 * returning would release live DMA storage. */
static void terminal(pocket_display_esp_lcd *d) {
  ESP_ERROR_CHECK(esp_lcd_panel_io_tx_param(d->config.io, -1, NULL, 0));
  d->completed = d->submitted;
}
/* Pixel storage read and written as 32-bit words. ESP-IDF compiles with
 * -fno-builtin-memcpy, so a 4-byte memcpy would be a call per word. */
typedef uint32_t __attribute__((may_alias)) pixel_word;
/* Copy RGB565 pixels with the two bytes of each pixel exchanged. */
static void copy_swapped(uint8_t *to, const uint8_t *from, size_t bytes) {
  if ((((uintptr_t)to | (uintptr_t)from) & 3U) == 0) {
    pixel_word *out = __builtin_assume_aligned(to, 4);
    const pixel_word *in = __builtin_assume_aligned(from, 4);
    for (; bytes >= 4; in++, out++, bytes -= 4) {
      const uint32_t value = *in;
      *out = ((value & 0x00ff00ffU) << 8) | ((value >> 8) & 0x00ff00ffU);
    }
    to = (uint8_t *)out;
    from = (const uint8_t *)in;
  }
  for (; bytes >= 2; to += 2, from += 2, bytes -= 2) {
    to[0] = from[1];
    to[1] = from[0];
  }
}
/* Blocks the presenter until the transfer counted `target` has landed. */
static bool await(pocket_display_esp_lcd *d, uint32_t target) {
  const TickType_t deadline =
      xTaskGetTickCount() + pdMS_TO_TICKS(WAIT_TIMEOUT_MS);
  while ((int32_t)(d->completed - target) < 0) {
    const TickType_t remaining = deadline - xTaskGetTickCount();
    if ((int32_t)remaining <= 0)
      return false;
    (void)xSemaphoreTake(d->done, remaining);
  }
  return true;
}
static void wake(void *context) {
  pocket_display_esp_lcd *d = context;
  xSemaphoreGive(d->tick);
}
/* Blocks the presenter until the esp_timer clock reaches `time_us`: on the
 * one-shot timer, then for the rest, which is below the timer's resolution,
 * in a loop. */
static void sleep_until(pocket_display_esp_lcd *d, int64_t time_us) {
  const int64_t remaining = time_us - esp_timer_get_time();
  if (remaining >= 100) {
    (void)xSemaphoreTake(d->tick, 0);
    if (esp_timer_start_once(d->timer, (uint64_t)remaining - 50) == ESP_OK)
      (void)xSemaphoreTake(d->tick, pdMS_TO_TICKS(remaining / 1000 + 20));
    else
      (void)xSemaphoreTake(d->tick, pdMS_TO_TICKS(remaining / 1000));
  }
  while (esp_timer_get_time() < time_us) {
  }
}
/* Copy `rows` rows of `row_bytes` bytes, `stride` bytes apart in `from`, into
 * consecutive rows of `to`. */
static void copy_rows(const pocket_display_esp_lcd *d, uint8_t *to,
                      const uint8_t *from, uint32_t rows, size_t row_bytes,
                      size_t stride) {
  if (row_bytes == stride) {
    row_bytes *= rows;
    rows = 1;
  }
  for (; rows; rows--, to += row_bytes, from += stride) {
    if (d->config.byte_swap)
      copy_swapped(to, from, row_bytes);
    else
      memcpy(to, from, row_bytes);
  }
}
/* Send the flushed windows of a staged buffer through the transfer buffers,
 * transfer_rows rows of one window at a time. The next transfer is of the
 * window whose first unsent row is the highest on the panel, so the rows of
 * windows that stand side by side go out in ascending order as well.
 *
 * With a refresh report the rows follow the panel's scan. `start_us` is the
 * end of a scan; the next scan begins after the blanking interval, taken as
 * at most an eighth of the period (`guard`), and reads row r no earlier than
 * start_us + r * period / height. A transfer of rows [row, row + rows) starts
 * after start_us + guard + (row + rows) * period / height: the scan has
 * passed them, so it shows the previous frame in every row. The scan after
 * it reads `row` no earlier than start_us + period + row * (period - guard) /
 * height; a transfer that starts within `guard` of that instant is counted
 * as late. */
static bool present(pocket_display_esp_lcd *d, buffer *b) {
  const pocket_display_esp_lcd_config *c = &d->config;
  const size_t stride = (size_t)c->width * 2;
  pocket_display_esp_lcd_refresh refresh = {0};
  const bool synced =
      c->wait_refresh &&
      c->wait_refresh(c->refresh_context, REFRESH_TIMEOUT_MS, &refresh) &&
      refresh.period_us;
  const int64_t guard = refresh.period_us / 8;
  bool late = false;
  /* The windows are in row order: those before `first` are sent, those from
   * `head` on have no row sent. */
  for (uint32_t first = 0, head = 0;;) {
    while (first < b->span_count && !b->spans[first].height)
      first++;
    if (head < first)
      head = first;
    if (first == b->span_count)
      break;
    /* `head` when no started window has an unsent row at or above it. */
    uint32_t pick = head;
    for (uint32_t i = head; i-- > first;)
      if (b->spans[i].height &&
          (pick == b->span_count || b->spans[i].y <= b->spans[pick].y))
        pick = i;
    if (pick == head)
      head++;
    span *s = &b->spans[pick];
    const uint32_t row = s->y;
    const uint32_t rows =
        s->height < c->transfer_rows ? s->height : c->transfer_rows;
    transfer *t = &d->transfers[d->turn];
    d->turn ^= 1U;
    /* This storage is free once its previous transfer has landed. */
    if (!await(d, t->target))
      return false;
    copy_rows(d, t->pixels,
              b->pixels + (size_t)(row - b->region.y) * stride +
                  (size_t)s->x * 2,
              rows, (size_t)s->width * 2, stride);
    if (synced) {
      sleep_until(d, refresh.start_us + guard +
                         (int64_t)(row + rows) * refresh.period_us / c->height);
      const int64_t next = refresh.start_us + refresh.period_us +
                           (int64_t)row * (refresh.period_us - guard) / c->height;
      late |= esp_timer_get_time() + guard > next;
    }
    if (esp_lcd_panel_draw_bitmap(c->panel, (int)s->x, (int)row,
                                  (int)(s->x + s->width), (int)(row + rows),
                                  t->pixels) != ESP_OK)
      return false;
    t->target = ++d->submitted;
    s->y += rows;
    s->height -= rows;
  }
  const uint32_t took = (uint32_t)(esp_timer_get_time() - b->flushed_us);
  if (took > atomic_load(&d->present_us_max))
    atomic_store(&d->present_us_max, took);
  if (!synced)
    atomic_fetch_add(&d->unsynced, 1);
  if (late)
    atomic_fetch_add(&d->late, 1);
  atomic_fetch_add(&d->frames, 1);
  return true;
}
/* Presents the queued buffers in flush order. An index past the buffers
 * ends the task. */
static void presenter(void *context) {
  pocket_display_esp_lcd *d = context;
  for (;;) {
    uint32_t index;
    if (xQueueReceive(d->queue, &index, portMAX_DELAY) != pdTRUE)
      continue;
    if (index >= d->config.buffer_count)
      break;
    buffer *b = &d->buffers[index];
    if (!present(d, b)) {
      /* The panel holds a part of this frame: stop the transfers and report
       * a new buffer identity, so the runtime repaints the panel. */
      terminal(d);
      atomic_store(&d->lost, true);
    }
    atomic_store(&b->presented, true);
    xSemaphoreGive(d->presented);
  }
  /* The last access to the display: destroy frees it after this store. */
  atomic_store(&d->presenting, false);
  vTaskDelete(NULL);
}
/* Blocks until the presenter has copied every flushed buffer. */
static void idle(pocket_display_esp_lcd *d) {
  for (uint32_t i = 0; i < d->config.buffer_count; i++)
    while (!atomic_load(&d->buffers[i].presented))
      (void)xSemaphoreTake(d->presented, pdMS_TO_TICKS(10));
}
pocket_display_esp_lcd *
pocket_display_esp_lcd_create(const pocket_display_esp_lcd_config *c) {
  if (!c || c->struct_size < sizeof(*c) || !c->panel || !c->io || !c->width ||
      !c->height || c->width > INT_MAX || c->height > INT_MAX ||
      !c->strip_rows || c->strip_rows > c->height || !c->buffer_count ||
      c->buffer_count > 2 ||
      c->width > SIZE_MAX / 2 / c->strip_rows / c->buffer_count)
    return NULL;
  const bool staged = c->transfer_rows != 0;
  if (staged && (c->strip_rows != c->height || c->transfer_rows > c->height))
    return NULL;
  if (c->column_alignment && (!staged || c->width % c->column_alignment))
    return NULL;
  size_t capacity = (size_t)c->width * c->strip_rows * 2;
  if (capacity * c->buffer_count > c->frame_buffer_budget)
    return NULL;
  pocket_display_esp_lcd *d = calloc(1, sizeof(*d));
  if (!d)
    return NULL;
  d->config = *c;
  d->capacity = capacity;
  d->active = UINT32_MAX;
  d->generation = 1;
  d->staged = staged;
  d->done = xSemaphoreCreateBinary();
  if (!d->done) {
    free(d);
    return NULL;
  }
  const esp_lcd_panel_io_callbacks_t callbacks = {.on_color_trans_done =
                                                      transfer_done};
  if (esp_lcd_panel_io_register_event_callbacks(c->io, &callbacks, d) !=
      ESP_OK) {
    vSemaphoreDelete(d->done);
    free(d);
    return NULL;
  }
  const uint32_t caps = !staged          ? MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA
                        : c->buffer_caps ? c->buffer_caps
                                         : MALLOC_CAP_DEFAULT;
  for (uint32_t i = 0; i < c->buffer_count; i++) {
    buffer *b = &d->buffers[i];
    atomic_init(&b->presented, true);
    b->pixels = heap_caps_aligned_alloc(128, capacity, caps);
    if (staged)
      b->spans = calloc(c->strip_rows, sizeof(*b->spans));
    if (!b->pixels || (staged && !b->spans)) {
      pocket_display_esp_lcd_destroy(d);
      return NULL;
    }
    memset(b->pixels, 0, capacity);
  }
  if (!staged)
    return d;
  const size_t transfer_bytes = (size_t)c->width * c->transfer_rows * 2;
  for (uint32_t i = 0; i < 2; i++) {
    d->transfers[i].pixels = heap_caps_aligned_alloc(
        128, transfer_bytes, MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA);
    if (!d->transfers[i].pixels) {
      pocket_display_esp_lcd_destroy(d);
      return NULL;
    }
  }
  d->queue = xQueueCreate(c->buffer_count + 1, sizeof(uint32_t));
  d->presented = xSemaphoreCreateBinary();
  d->tick = xSemaphoreCreateBinary();
  const esp_timer_create_args_t timer = {
      .callback = wake, .arg = d, .name = "pocket_lcd"};
  UBaseType_t priority = c->presenter_priority ? c->presenter_priority
                                               : uxTaskPriorityGet(NULL) + 1;
  if (priority >= configMAX_PRIORITIES)
    priority = configMAX_PRIORITIES - 1;
  if (!d->queue || !d->presented || !d->tick ||
      esp_timer_create(&timer, &d->timer) != ESP_OK) {
    pocket_display_esp_lcd_destroy(d);
    return NULL;
  }
  atomic_store(&d->presenting, true);
  if (xTaskCreatePinnedToCore(
          presenter, "pocket_lcd", PRESENTER_STACK_BYTES, d, priority, NULL,
          c->presenter_core < 0 ? tskNO_AFFINITY
                                : (BaseType_t)c->presenter_core) != pdPASS) {
    atomic_store(&d->presenting, false);
    pocket_display_esp_lcd_destroy(d);
    return NULL;
  }
  return d;
}
size_t pocket_display_esp_lcd_buffer_bytes(const pocket_display_esp_lcd *d) {
  return d ? d->capacity * d->config.buffer_count : 0;
}
bool pocket_display_esp_lcd_get_stats(const pocket_display_esp_lcd *d,
                                      pocket_display_esp_lcd_stats *out) {
  if (!d || !d->staged || !out || out->struct_size < sizeof(*out))
    return false;
  *out = (pocket_display_esp_lcd_stats){.struct_size = sizeof(*out),
                                        .frames = atomic_load(&d->frames),
                                        .unsynced = atomic_load(&d->unsynced),
                                        .late = atomic_load(&d->late),
                                        .present_us_max =
                                            atomic_load(&d->present_us_max)};
  return true;
}
void pocket_display_esp_lcd_invalidate(pocket_display_esp_lcd *d) {
  if (d) {
    if (d->staged)
      idle(d);
    terminal(d);
    if (d->generation == UINT64_MAX)
      abort();
    d->generation++;
  }
}
void pocket_display_esp_lcd_destroy(pocket_display_esp_lcd *d) {
  if (!d)
    return;
  if (atomic_load(&d->presenting)) {
    /* The presenter finishes the queued buffers, then ends. */
    const uint32_t stop = UINT32_MAX;
    idle(d);
    (void)xQueueSend(d->queue, &stop, portMAX_DELAY);
    while (atomic_load(&d->presenting))
      (void)xSemaphoreTake(d->presented, pdMS_TO_TICKS(1));
  }
  bool drain = d->staged && d->completed != d->submitted;
  for (uint32_t i = 0; !d->staged && i < d->config.buffer_count; i++)
    drain |= reserved(d, &d->buffers[i]);
  if (drain)
    terminal(d);
  const esp_lcd_panel_io_callbacks_t none = {.on_color_trans_done = NULL};
  (void)esp_lcd_panel_io_register_event_callbacks(d->config.io, &none, NULL);
  vSemaphoreDelete(d->done);
  if (d->timer)
    (void)esp_timer_delete(d->timer);
  if (d->queue)
    vQueueDelete(d->queue);
  if (d->presented)
    vSemaphoreDelete(d->presented);
  if (d->tick)
    vSemaphoreDelete(d->tick);
  for (uint32_t i = 0; i < 2; i++)
    heap_caps_free(d->transfers[i].pixels);
  for (uint32_t i = 0; i < d->config.buffer_count; i++) {
    heap_caps_free(d->buffers[i].pixels);
    free(d->buffers[i].spans);
  }
  free(d);
}
static int32_t descriptor(void *context, pocket_display_descriptor *out) {
  pocket_display_esp_lcd *d = context;
  if (!d || !out || out->struct_size < sizeof(*out))
    return POCKET_STATUS_INVALID;
  /* Without column windows a flushed window spans the width. */
  const uint32_t columns =
      d->config.column_alignment ? d->config.column_alignment : d->config.width;
  *out = (pocket_display_descriptor){
      .struct_size = sizeof(*out),
      .role = POCKET_DISPLAY_ROLE_PRIMARY,
      .width = d->config.width,
      .height = d->config.height,
      .pixel_format = POCKET_PIXEL_FORMAT_RGB565,
      .stride_bytes = (size_t)d->config.width * 2,
      .target_kind = POCKET_TARGET_CPU_VISIBLE,
      .flags =
          POCKET_DISPLAY_FRAME_STORAGE | POCKET_DISPLAY_PARTIAL_REFRESH |
          (d->config.buffer_count == 2 ? POCKET_DISPLAY_DOUBLE_BUFFERED |
                                             POCKET_DISPLAY_PIPELINED_ACQUIRE
                                       : 0),
      .refresh_width = columns,
      .refresh_height = 1,
      .window_x_alignment = columns,
      .window_y_alignment = 1};
  return POCKET_STATUS_OK;
}
static int32_t acquire(void *context, const pocket_rect *region,
                       pocket_target *out) {
  pocket_display_esp_lcd *d = context;
  if (!d || !region || region->struct_size < sizeof(*region) || !out ||
      out->struct_size < sizeof(*out) || region->x ||
      region->width != d->config.width || !region->height ||
      region->height > d->config.strip_rows ||
      region->height > d->config.height ||
      region->y > d->config.height - region->height)
    return POCKET_STATUS_INVALID;
  /* A staged buffer is free once the presenter has copied its rows: wait for
   * one, as the direct path waits for a transfer. */
  const TickType_t deadline =
      xTaskGetTickCount() + pdMS_TO_TICKS(WAIT_TIMEOUT_MS);
  for (bool busy = d->staged; busy;) {
    for (uint32_t i = 0; i < d->config.buffer_count; i++)
      busy &= reserved(d, &d->buffers[i]);
    if (!busy)
      break;
    const TickType_t remaining = deadline - xTaskGetTickCount();
    if ((int32_t)remaining <= 0)
      return POCKET_STATUS_FAILED;
    (void)xSemaphoreTake(d->presented, remaining);
  }
  /* An unflushed acquire has no DMA reader and can be replaced after a failed
   * render. */
  for (uint32_t i = 0; i < d->config.buffer_count; i++) {
    buffer *b = &d->buffers[i];
    if (reserved(d, b))
      continue;
    b->timed_out = false;
    d->active = i;
    b->region = *region;
    b->surface = (pocket_surface){.struct_size = sizeof(b->surface),
                                  .pixels = b->pixels,
                                  .byte_length = (size_t)d->config.width *
                                                 region->height * 2,
                                  .region = &b->region,
                                  .stride_bytes = (size_t)d->config.width * 2,
                                  .pixel_format = POCKET_PIXEL_FORMAT_RGB565};
    *out = (pocket_target){.struct_size = sizeof(*out),
                           .kind = POCKET_TARGET_CPU_VISIBLE,
                           .region = &b->region,
                           .pixel_format = POCKET_PIXEL_FORMAT_RGB565,
                           .surface = &b->surface};
    return POCKET_STATUS_OK;
  }
  return POCKET_STATUS_FAILED;
}
/* Exchange the two bytes of every RGB565 pixel, two pixels at a time. A
 * strip buffer is 128-byte aligned and a row holds an even number of bytes,
 * so `pixels` is 2-byte aligned. */
static void swap_pixel_bytes(uint8_t *pixels, size_t bytes) {
  if (bytes < 2)
    return;
  if ((uintptr_t)pixels & 2U) {
    uint8_t a = pixels[0];
    pixels[0] = pixels[1];
    pixels[1] = a;
    pixels += 2;
    bytes -= 2;
  }
  pixel_word *words = __builtin_assume_aligned(pixels, 4);
  for (; bytes >= 4; words++, bytes -= 4) {
    const uint32_t value = *words;
    *words = ((value & 0x00ff00ffU) << 8) | ((value >> 8) & 0x00ff00ffU);
  }
  if (bytes >= 2) {
    uint8_t *tail = (uint8_t *)words;
    uint8_t a = tail[0];
    tail[0] = tail[1];
    tail[1] = a;
  }
}
static int32_t flush(void *context, const pocket_rect *regions, size_t count,
                     uint64_t *token) {
  pocket_display_esp_lcd *d = context;
  if (!d || !regions || !count || !token ||
      d->active >= d->config.buffer_count || d->next == UINT64_MAX)
    return POCKET_STATUS_INVALID;
  buffer *b = &d->buffers[d->active];
  const uint32_t columns = d->config.column_alignment;
  /* A buffer holds strip_rows windows. Full-width regions are disjoint rows
   * of the buffer, so no more of them exist. */
  if (columns && count > d->config.strip_rows)
    return POCKET_STATUS_INVALID;
  const pocket_rect *r = regions;
  /* The row no later region starts above: the end of the last full-width
   * region, the first row of the last column window. */
  uint32_t floor = b->region.y;
  for (size_t i = 0; i < count; i++) {
    if (r->struct_size < sizeof(*r) || r->struct_size % _Alignof(pocket_rect) ||
        !r->height || r->y < floor || r->height > b->region.height ||
        r->y - b->region.y > b->region.height - r->height)
      return POCKET_STATUS_INVALID;
    if (columns) {
      if (!r->width || r->width > d->config.width ||
          r->x > d->config.width - r->width || r->x % columns ||
          r->width % columns)
        return POCKET_STATUS_INVALID;
      floor = r->y;
    } else {
      if (r->x || r->width != d->config.width)
        return POCKET_STATUS_INVALID;
      floor = r->y + r->height;
    }
    r = (const pocket_rect *)((const uint8_t *)r + r->struct_size);
  }
  r = regions;
  if (d->staged) {
    for (size_t i = 0; i < count; i++) {
      b->spans[i] = (span){
          .x = r->x, .y = r->y, .width = r->width, .height = r->height};
      r = (const pocket_rect *)((const uint8_t *)r + r->struct_size);
    }
    b->span_count = (uint32_t)count;
    b->flushed_us = esp_timer_get_time();
    atomic_store(&b->presented, false);
    b->pending = true;
    *token = b->token = ++d->next;
    const uint32_t index = d->active;
    d->active = UINT32_MAX;
    /* The queue holds one entry per buffer and the stop entry. */
    (void)xQueueSend(d->queue, &index, portMAX_DELAY);
    return POCKET_STATUS_OK;
  }
  for (size_t i = 0; i < count; i++) {
    uint8_t *pixels =
        b->pixels + (size_t)(r->y - b->region.y) * d->config.width * 2;
    /* The rows of the regions are the rows this frame rendered; the regions
     * are disjoint (validated above), so each row is exchanged once. */
    if (d->config.byte_swap)
      swap_pixel_bytes(pixels, (size_t)r->height * d->config.width * 2);
    if (esp_lcd_panel_draw_bitmap(d->config.panel, 0, (int)r->y, (int)r->width,
                                  (int)(r->y + r->height), pixels) != ESP_OK) {
      terminal(d);
      d->active = UINT32_MAX;
      if (d->generation == UINT64_MAX)
        abort();
      d->generation++;
      return POCKET_STATUS_FAILED;
    }
    d->submitted++;
    r = (const pocket_rect *)((const uint8_t *)r + r->struct_size);
  }
  b->pending = true;
  b->target = d->submitted;
  *token = b->token = ++d->next;
  d->active = UINT32_MAX;
  return POCKET_STATUS_OK;
}
/* Blocks until the completion count reaches this buffer's last transfer; a
 * later buffer's transfers keep streaming. A staged buffer is not handed out
 * again before the presenter has copied it (acquire waits), so its wait
 * returns at once and the caller renders the next frame meanwhile. */
static int32_t wait_display(void *context, uint64_t token) {
  pocket_display_esp_lcd *d = context;
  if (!d)
    return POCKET_STATUS_INVALID;
  for (uint32_t i = 0; i < d->config.buffer_count; i++) {
    buffer *b = &d->buffers[i];
    if (!b->pending || b->token != token)
      continue;
    b->pending = false;
    if (d->staged)
      return POCKET_STATUS_OK;
    const TickType_t deadline =
        xTaskGetTickCount() + pdMS_TO_TICKS(WAIT_TIMEOUT_MS);
    while (!landed(d, b)) {
      const TickType_t remaining = deadline - xTaskGetTickCount();
      if ((int32_t)remaining <= 0) {
        b->timed_out = true;
        return POCKET_STATUS_FAILED;
      }
      (void)xSemaphoreTake(d->done, remaining);
    }
    return POCKET_STATUS_OK;
  }
  return POCKET_STATUS_INVALID;
}
static int32_t identity(void *context, pocket_buffer_identity *out) {
  pocket_display_esp_lcd *d = context;
  if (!d || !out || out->struct_size < sizeof(*out))
    return POCKET_STATUS_INVALID;
  /* A staged frame the presenter could not send left the panel undefined. */
  if (atomic_exchange(&d->lost, false)) {
    if (d->generation == UINT64_MAX)
      abort();
    d->generation++;
  }
  *out = (pocket_buffer_identity){
      .struct_size = sizeof(*out), .buffer = 1, .generation = d->generation};
  return POCKET_STATUS_OK;
}
static const pocket_display_output_v1 DISPLAY = {.struct_size = sizeof(DISPLAY),
                                                 .descriptor = descriptor,
                                                 .acquire = acquire,
                                                 .flush = flush,
                                                 .wait = wait_display,
                                                 .frame_identity = identity};
const pocket_display_output_v1 *pocket_display_esp_lcd_vtable(void) {
  return &DISPLAY;
}
