/* Staged presentation of pocket_display_esp_lcd. The presenter runs as a
 * thread, FreeRTOS objects are pthread objects and a tick is a millisecond.
 * A queued transfer completes when the next one is submitted or at the
 * terminal barrier, as the panel IO's parameter transfer does; its buffer
 * must hold the submitted bytes until then. */
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "pocket/display_esp_lcd.h"
#include <assert.h>
#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
enum { WIDTH = 8, HEIGHT = 8, STRIDE = WIDTH * 2, TRANSFER_ROWS = 2 };
/* ------------------------------ time ------------------------------------ */
static int64_t clock_us(clockid_t id) {
  struct timespec t;
  clock_gettime(id, &t);
  return (int64_t)t.tv_sec * 1000000 + t.tv_nsec / 1000;
}
int64_t esp_timer_get_time(void) { return clock_us(CLOCK_MONOTONIC); }
TickType_t xTaskGetTickCount(void) {
  return (TickType_t)(esp_timer_get_time() / 1000);
}
static void sleep_us(int64_t us) {
  const int64_t until = esp_timer_get_time() + us;
  for (int64_t left = us; left > 0; left = until - esp_timer_get_time())
    usleep((useconds_t)left);
}
/* ---------------------------- semaphores -------------------------------- */
struct pocket_test_semaphore {
  pthread_mutex_t lock;
  pthread_cond_t cond;
  bool given;
};
SemaphoreHandle_t xSemaphoreCreateBinary(void) {
  SemaphoreHandle_t s = calloc(1, sizeof(*s));
  assert(s);
  pthread_mutex_init(&s->lock, NULL);
  pthread_cond_init(&s->cond, NULL);
  return s;
}
void vSemaphoreDelete(SemaphoreHandle_t s) {
  pthread_cond_destroy(&s->cond);
  pthread_mutex_destroy(&s->lock);
  free(s);
}
BaseType_t xSemaphoreGive(SemaphoreHandle_t s) {
  pthread_mutex_lock(&s->lock);
  s->given = true;
  pthread_cond_signal(&s->cond);
  pthread_mutex_unlock(&s->lock);
  return pdTRUE;
}
BaseType_t xSemaphoreGiveFromISR(SemaphoreHandle_t s, BaseType_t *woken) {
  *woken = pdFALSE;
  return xSemaphoreGive(s);
}
/* The condition variable waits on the realtime clock. */
static struct timespec deadline(TickType_t ticks) {
  const int64_t at = clock_us(CLOCK_REALTIME) + (int64_t)ticks * 1000;
  return (struct timespec){.tv_sec = at / 1000000,
                           .tv_nsec = (at % 1000000) * 1000};
}
BaseType_t xSemaphoreTake(SemaphoreHandle_t s, TickType_t ticks) {
  const struct timespec until = deadline(ticks == portMAX_DELAY ? 0 : ticks);
  pthread_mutex_lock(&s->lock);
  while (!s->given) {
    if (ticks == portMAX_DELAY)
      pthread_cond_wait(&s->cond, &s->lock);
    else if (pthread_cond_timedwait(&s->cond, &s->lock, &until) == ETIMEDOUT)
      break;
  }
  const bool taken = s->given;
  s->given = false;
  pthread_mutex_unlock(&s->lock);
  return taken ? pdTRUE : pdFALSE;
}
/* ------------------------------ queue ----------------------------------- */
struct pocket_test_queue {
  pthread_mutex_t lock;
  pthread_cond_t cond;
  uint32_t items[8];
  size_t count, capacity;
};
QueueHandle_t xQueueCreate(UBaseType_t length, UBaseType_t size) {
  assert(size == sizeof(uint32_t) && length <= 8);
  QueueHandle_t q = calloc(1, sizeof(*q));
  assert(q);
  q->capacity = length;
  pthread_mutex_init(&q->lock, NULL);
  pthread_cond_init(&q->cond, NULL);
  return q;
}
void vQueueDelete(QueueHandle_t q) {
  pthread_cond_destroy(&q->cond);
  pthread_mutex_destroy(&q->lock);
  free(q);
}
/* The driver sends at most one entry per buffer and the stop entry. */
BaseType_t xQueueSend(QueueHandle_t q, const void *item, TickType_t ticks) {
  (void)ticks;
  pthread_mutex_lock(&q->lock);
  assert(q->count < q->capacity);
  memcpy(&q->items[q->count++], item, sizeof(uint32_t));
  pthread_cond_signal(&q->cond);
  pthread_mutex_unlock(&q->lock);
  return pdTRUE;
}
BaseType_t xQueueReceive(QueueHandle_t q, void *item, TickType_t ticks) {
  assert(ticks == portMAX_DELAY);
  pthread_mutex_lock(&q->lock);
  while (!q->count)
    pthread_cond_wait(&q->cond, &q->lock);
  memcpy(item, &q->items[0], sizeof(uint32_t));
  memmove(&q->items[0], &q->items[1], --q->count * sizeof(uint32_t));
  pthread_mutex_unlock(&q->lock);
  return pdTRUE;
}
/* ------------------------------ tasks ----------------------------------- */
static struct {
  void (*entry)(void *);
  void *context;
} task;
static pthread_t task_thread;
static unsigned tasks_started;
static void *run_task(void *argument) {
  (void)argument;
  task.entry(task.context);
  return NULL;
}
BaseType_t xTaskCreatePinnedToCore(void (*entry)(void *), const char *name,
                                   uint32_t stack, void *context,
                                   UBaseType_t priority, TaskHandle_t *out,
                                   BaseType_t core) {
  assert(name && stack && !out && priority == 6 && core == 1);
  task.entry = entry;
  task.context = context;
  tasks_started++;
  return pthread_create(&task_thread, NULL, run_task, NULL) == 0 ? pdPASS
                                                                 : pdFALSE;
}
void vTaskDelete(TaskHandle_t handle) {
  assert(!handle);
  pthread_exit(NULL);
}
UBaseType_t uxTaskPriorityGet(TaskHandle_t handle) {
  assert(!handle);
  return 5;
}
/* ------------------------------ timer ----------------------------------- */
struct pocket_test_timer {
  esp_timer_create_args_t args;
};
esp_err_t esp_timer_create(const esp_timer_create_args_t *args,
                           esp_timer_handle_t *out) {
  *out = calloc(1, sizeof(**out));
  assert(*out);
  (*out)->args = *args;
  return ESP_OK;
}
esp_err_t esp_timer_delete(esp_timer_handle_t timer) {
  free(timer);
  return ESP_OK;
}
/* The presenter starts the timer and then blocks on what its callback gives:
 * sleeping here and calling the callback is the same sequence. */
esp_err_t esp_timer_start_once(esp_timer_handle_t timer, uint64_t us) {
  sleep_us((int64_t)us);
  timer->args.callback(timer->args.arg);
  return ESP_OK;
}
/* ------------------------------ panel ----------------------------------- */
static pthread_mutex_t panel_lock = PTHREAD_MUTEX_INITIALIZER;
static struct {
  int y0, y1;
  const uint8_t *pixels;
  uint8_t bytes[TRANSFER_ROWS * STRIDE];
  int64_t at;
  bool landed;
} sent[64];
static size_t sent_count, barriers;
static bool fail_next;
static esp_lcd_panel_io_color_trans_done_cb_t done_cb;
static void *done_context;
esp_err_t esp_lcd_panel_io_register_event_callbacks(
    esp_lcd_panel_io_handle_t io, const esp_lcd_panel_io_callbacks_t *cbs,
    void *context) {
  assert(io && cbs);
  done_cb = cbs->on_color_trans_done;
  done_context = context;
  return ESP_OK;
}
/* Every queued transfer lands: its buffer still holds the submitted bytes. */
static void land(void) {
  for (size_t i = 0; i < sent_count; i++) {
    if (sent[i].landed)
      continue;
    const size_t size = (size_t)(sent[i].y1 - sent[i].y0) * STRIDE;
    assert(memcmp(sent[i].pixels, sent[i].bytes, size) == 0);
    sent[i].landed = true;
    if (done_cb)
      done_cb((void *)1, NULL, done_context);
  }
}
esp_err_t esp_lcd_panel_draw_bitmap(void *panel, int x0, int y0, int x1, int y1,
                                    const void *pixels) {
  pthread_mutex_lock(&panel_lock);
  assert(panel && sent_count < 64 && x0 == 0 && x1 == WIDTH && y1 > y0 &&
         y1 - y0 <= TRANSFER_ROWS && y1 <= HEIGHT);
  land();
  esp_err_t status = ESP_FAIL;
  if (fail_next) {
    fail_next = false;
  } else {
    typeof(sent[0]) *s = &sent[sent_count++];
    *s = (typeof(*s)){
        .y0 = y0, .y1 = y1, .pixels = pixels, .at = esp_timer_get_time()};
    memcpy(s->bytes, pixels, (size_t)(y1 - y0) * STRIDE);
    status = ESP_OK;
  }
  pthread_mutex_unlock(&panel_lock);
  return status;
}
esp_err_t esp_lcd_panel_io_tx_param(void *io, int cmd, const void *p,
                                    size_t size) {
  assert(io && cmd == -1 && !p && !size);
  pthread_mutex_lock(&panel_lock);
  land();
  barriers++;
  pthread_mutex_unlock(&panel_lock);
  return ESP_OK;
}
/* ----------------------------- refresh ---------------------------------- */
enum { PERIOD_US = 16000 };
static pthread_mutex_t refresh_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t refresh_cond = PTHREAD_COND_INITIALIZER;
static bool refresh_held, refresh_silent;
static int64_t refresh_offset_us, refresh_start_us;
static unsigned refresh_calls;
static bool wait_refresh(void *context, uint32_t timeout_ms,
                         pocket_display_esp_lcd_refresh *out) {
  assert(context == &refresh_calls && timeout_ms == 50);
  pthread_mutex_lock(&refresh_lock);
  while (refresh_held)
    pthread_cond_wait(&refresh_cond, &refresh_lock);
  refresh_calls++;
  const bool silent = refresh_silent;
  refresh_start_us = esp_timer_get_time() + refresh_offset_us;
  *out = (pocket_display_esp_lcd_refresh){.start_us = refresh_start_us,
                                          .period_us = PERIOD_US};
  pthread_mutex_unlock(&refresh_lock);
  return !silent;
}
static void hold_refresh(bool held) {
  pthread_mutex_lock(&refresh_lock);
  refresh_held = held;
  pthread_cond_broadcast(&refresh_cond);
  pthread_mutex_unlock(&refresh_lock);
}
static void *release_later(void *argument) {
  (void)argument;
  sleep_us(50000);
  hold_refresh(false);
  return NULL;
}
/* ------------------------------- test ----------------------------------- */
static const pocket_display_output_v1 *v;
static pocket_rect rows(uint32_t y, uint32_t height) {
  return (pocket_rect){.struct_size = sizeof(pocket_rect),
                       .x = 0,
                       .y = y,
                       .width = WIDTH,
                       .height = height};
}
/* Pixel (x, y) of the frame `seed`, low byte first as the renderer writes. */
static uint8_t low(uint8_t seed, uint32_t x, uint32_t y) {
  return (uint8_t)(seed + y * WIDTH + x);
}
static uint8_t high(uint8_t seed, uint32_t y) { return (uint8_t)(seed ^ y); }
/* Renders the whole frame and flushes `count` regions of it. */
static uint8_t *frame(pocket_display_esp_lcd *d, uint8_t seed,
                      const pocket_rect *regions, size_t count) {
  pocket_rect whole = rows(0, HEIGHT);
  pocket_target target = {.struct_size = sizeof(target)};
  assert(v->acquire(d, &whole, &target) == POCKET_STATUS_OK &&
         target.surface->byte_length == HEIGHT * STRIDE);
  uint8_t *pixels = target.surface->pixels;
  for (uint32_t y = 0; y < HEIGHT; y++)
    for (uint32_t x = 0; x < WIDTH; x++) {
      pixels[y * STRIDE + x * 2] = low(seed, x, y);
      pixels[y * STRIDE + x * 2 + 1] = high(seed, y);
    }
  uint64_t token = 0;
  assert(v->flush(d, regions, count, &token) == POCKET_STATUS_OK && token);
  /* The wait consumes the token before the presenter has sent a row. */
  assert(v->wait(d, token) == POCKET_STATUS_OK);
  assert(v->wait(d, token) == POCKET_STATUS_INVALID);
  return pixels;
}
/* Renders the frame `seed` and flushes its rows [y, y + height). */
static uint8_t *band(pocket_display_esp_lcd *d, uint8_t seed, uint32_t y,
                     uint32_t height) {
  const pocket_rect region = rows(y, height);
  return frame(d, seed, &region, 1);
}
static pocket_display_esp_lcd_stats stats(const pocket_display_esp_lcd *d) {
  pocket_display_esp_lcd_stats s = {.struct_size = sizeof(s)};
  assert(pocket_display_esp_lcd_get_stats(d, &s));
  return s;
}
/* Blocks until the presenter has sent `frames` flushes. */
static void settle(const pocket_display_esp_lcd *d, uint32_t frames) {
  const int64_t until = esp_timer_get_time() + 5000000;
  while (stats(d).frames < frames) {
    assert(esp_timer_get_time() < until);
    sleep_us(500);
  }
}
/* Blocks until the driver has drained the panel IO `count` times. */
static void drained(size_t count) {
  const int64_t until = esp_timer_get_time() + 5000000;
  for (;;) {
    pthread_mutex_lock(&panel_lock);
    const bool reached = barriers >= count;
    pthread_mutex_unlock(&panel_lock);
    if (reached)
      return;
    assert(esp_timer_get_time() < until);
    sleep_us(500);
  }
}
/* Transfer `index` carries rows [y0, y1) of the frame `seed`, bytes
 * exchanged. */
static void expect(size_t index, int y0, int y1, uint8_t seed) {
  pthread_mutex_lock(&panel_lock);
  assert(index < sent_count && sent[index].y0 == y0 && sent[index].y1 == y1);
  for (int y = y0; y < y1; y++)
    for (uint32_t x = 0; x < WIDTH; x++) {
      const uint8_t *pixel = &sent[index].bytes[(y - y0) * STRIDE + x * 2];
      assert(pixel[0] == high(seed, (uint32_t)y) &&
             pixel[1] == low(seed, x, (uint32_t)y));
    }
  pthread_mutex_unlock(&panel_lock);
}
int main(void) {
  v = pocket_display_esp_lcd_vtable();
  pocket_display_esp_lcd_config c = {.struct_size = sizeof(c),
                                     .panel = (void *)1,
                                     .io = (void *)1,
                                     .width = WIDTH,
                                     .height = HEIGHT,
                                     .strip_rows = HEIGHT,
                                     .buffer_count = 2,
                                     .frame_buffer_budget = 2 * HEIGHT * STRIDE,
                                     .byte_swap = true,
                                     .transfer_rows = TRANSFER_ROWS,
                                     .buffer_caps = MALLOC_CAP_SPIRAM,
                                     .wait_refresh = wait_refresh,
                                     .refresh_context = &refresh_calls,
                                     .presenter_core = 1};
  /* A staged render buffer holds the whole frame. */
  c.strip_rows = HEIGHT / 2;
  assert(!pocket_display_esp_lcd_create(&c));
  c.strip_rows = HEIGHT;
  c.transfer_rows = HEIGHT + 1;
  assert(!pocket_display_esp_lcd_create(&c));
  c.transfer_rows = TRANSFER_ROWS;
  c.frame_buffer_budget--;
  assert(!pocket_display_esp_lcd_create(&c) && !tasks_started);
  c.frame_buffer_budget++;
  pocket_display_esp_lcd *d = pocket_display_esp_lcd_create(&c);
  assert(d && tasks_started == 1 && done_cb &&
         pocket_display_esp_lcd_buffer_bytes(d) == 2 * HEIGHT * STRIDE);
  pocket_display_descriptor descriptor = {.struct_size = sizeof(descriptor)};
  assert(v->descriptor(d, &descriptor) == 0 && descriptor.height == HEIGHT &&
         (descriptor.flags & POCKET_DISPLAY_DOUBLE_BUFFERED));
  pocket_buffer_identity first = {.struct_size = sizeof(first)}, next = first;
  assert(v->frame_identity(d, &first) == 0);

  /* The flushed rows go out in ascending order, transfer_rows at a time,
   * with the bytes of each pixel exchanged; unflushed rows stay. Each
   * transfer starts after the scan has passed its rows. */
  const pocket_rect two[2] = {rows(1, 2), rows(5, 3)};
  frame(d, 0x10, two, 2);
  settle(d, 1);
  assert(sent_count == 3 && refresh_calls == 1);
  expect(0, 1, 3, 0x10);
  expect(1, 5, 7, 0x10);
  expect(2, 7, 8, 0x10);
  for (size_t i = 0; i < 3; i++)
    assert(sent[i].at >= refresh_start_us + PERIOD_US / 8 +
                             (int64_t)sent[i].y1 * PERIOD_US / HEIGHT);
  assert(stats(d).unsynced == 0);

  /* Two frames are in flight while the panel reports no refresh: the third
   * acquire waits for the presenter to copy the first. */
  hold_refresh(true);
  const pocket_rect whole = rows(0, HEIGHT);
  uint8_t *a = frame(d, 0x20, &whole, 1);
  uint8_t *b = frame(d, 0x30, &whole, 1);
  assert(a != b && sent_count == 3);
  pthread_t releaser;
  assert(pthread_create(&releaser, NULL, release_later, NULL) == 0);
  const int64_t blocked = esp_timer_get_time();
  uint8_t *again = band(d, 0x40, 6, 2);
  assert(esp_timer_get_time() - blocked >= 40000 && again == a);
  pthread_join(releaser, NULL);
  settle(d, 4);
  assert(sent_count == 3 + 4 + 4 + 1);
  for (int i = 0; i < 4; i++) {
    expect(3 + (size_t)i, i * 2, i * 2 + 2, 0x20);
    expect(7 + (size_t)i, i * 2, i * 2 + 2, 0x30);
  }
  expect(11, 6, 8, 0x40);

  /* Without a refresh report the rows go out at once and are counted. */
  refresh_silent = true;
  band(d, 0x50, 0, 1);
  settle(d, 5);
  expect(12, 0, 1, 0x50);
  assert(stats(d).unsynced == 1);
  refresh_silent = false;

  /* A refresh that started long ago: the next scan has reached the rows.
   * The count before it depends on the load of the test machine. */
  const uint32_t late = stats(d).late;
  refresh_offset_us = -10 * PERIOD_US;
  band(d, 0x60, 2, 2);
  settle(d, 6);
  expect(13, 2, 4, 0x60);
  assert(stats(d).late == late + 1 && stats(d).unsynced == 1);
  refresh_offset_us = 0;

  /* A transfer the panel refuses ends that frame at the terminal barrier
   * and changes the buffer identity; the next frame is presented. */
  assert(v->frame_identity(d, &next) == 0 &&
         next.generation == first.generation && barriers == 0);
  fail_next = true;
  frame(d, 0x70, &whole, 1);
  drained(1);
  assert(sent_count == 14 && barriers == 1 && stats(d).frames == 6);
  assert(v->frame_identity(d, &next) == 0 &&
         next.generation == first.generation + 1);
  assert(v->frame_identity(d, &next) == 0 &&
         next.generation == first.generation + 1);
  band(d, 0x80, 4, 2);
  settle(d, 7);
  expect(14, 4, 6, 0x80);

  /* Invalidation waits for the presenter, then drains the transfers. */
  frame(d, 0x90, &whole, 1);
  pocket_display_esp_lcd_invalidate(d);
  assert(stats(d).frames == 8 && sent_count == 19 && barriers == 2 &&
         sent[18].landed);
  assert(v->frame_identity(d, &next) == 0 &&
         next.generation == first.generation + 2);

  /* Destruction presents what is queued, ends the presenter and drains. */
  hold_refresh(true);
  band(d, 0xa0, 0, 2);
  assert(pthread_create(&releaser, NULL, release_later, NULL) == 0);
  pocket_display_esp_lcd_destroy(d);
  pthread_join(releaser, NULL);
  pthread_join(task_thread, NULL);
  assert(sent_count == 20 && sent[19].landed && barriers == 3 && !done_cb);
  expect(19, 0, 2, 0xa0);
  puts("SPI/I80 adapter staged presentation: row order and byte exchange, "
       "scan pacing, buffer wait, unsynchronised, late and failed frames, "
       "invalidation and destruction tests passed");
  return 0;
}
