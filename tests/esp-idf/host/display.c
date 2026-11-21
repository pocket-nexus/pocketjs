#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "pocket/display_esp_lcd.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static struct {
  const uint8_t *pixels;
  size_t size;
  uint8_t value;
} transfers[8];
static size_t queued, barriers;
static bool fail_next, stalled;
static TickType_t ticks;
static esp_lcd_panel_io_color_trans_done_cb_t done_cb;
static void *done_context;
struct pocket_test_semaphore {
  bool given;
};
esp_err_t esp_lcd_panel_io_register_event_callbacks(
    esp_lcd_panel_io_handle_t io, const esp_lcd_panel_io_callbacks_t *cbs,
    void *context) {
  assert(io && cbs);
  done_cb = cbs->on_color_trans_done;
  done_context = context;
  return ESP_OK;
}
esp_err_t esp_lcd_panel_draw_bitmap(void *panel, int x0, int y0, int x1, int y1,
                                    const void *pixels) {
  assert(panel && queued < 8 && x0 == 0 && x1 == 8 && y1 > y0);
  transfers[queued++] = (typeof(transfers[0])){
      pixels, (size_t)(x1 - x0) * (y1 - y0) * 2, ((const uint8_t *)pixels)[0]};
  if (fail_next) {
    fail_next = false;
    return ESP_FAIL;
  }
  return ESP_OK;
}
/* The oldest transfer finishes: its buffer stayed untouched while in flight
 * and the IO's completion callback runs as the ISR would. */
static void complete(void) {
  assert(queued);
  for (size_t j = 0; j < transfers[0].size; j++)
    assert(transfers[0].pixels[j] == transfers[0].value);
  memmove(&transfers[0], &transfers[1], --queued * sizeof(transfers[0]));
  if (done_cb)
    done_cb((void *)1, NULL, done_context);
}
esp_err_t esp_lcd_panel_io_tx_param(void *io, int cmd, const void *p,
                                    size_t size) {
  assert(io && cmd == -1 && !p && !size);
  while (queued)
    complete();
  barriers++;
  return ESP_OK;
}
SemaphoreHandle_t xSemaphoreCreateBinary(void) {
  return calloc(1, sizeof(struct pocket_test_semaphore));
}
void vSemaphoreDelete(SemaphoreHandle_t s) { free(s); }
BaseType_t xSemaphoreGiveFromISR(SemaphoreHandle_t s, BaseType_t *woken) {
  s->given = true;
  *woken = pdTRUE;
  return pdTRUE;
}
/* Blocking lets the next transfer finish unless the bus is stalled, in which
 * case the clock runs out the full timeout. */
BaseType_t xSemaphoreTake(SemaphoreHandle_t s, TickType_t timeout) {
  if (!s->given && queued && !stalled)
    complete();
  if (!s->given) {
    ticks += timeout;
    return pdFALSE;
  }
  s->given = false;
  return pdTRUE;
}
TickType_t xTaskGetTickCount(void) { return ticks; }
static pocket_rect region(uint32_t y) {
  return (pocket_rect){.struct_size = sizeof(pocket_rect),
                       .x = 0,
                       .y = y,
                       .width = 8,
                       .height = 2};
}
static uint64_t submit(pocket_display_esp_lcd *d, uint32_t y, uint8_t value,
                       int32_t expected) {
  const pocket_display_output_v1 *v = pocket_display_esp_lcd_vtable();
  pocket_rect r = region(y);
  pocket_target t = {.struct_size = sizeof(t)};
  assert(v->acquire(d, &r, &t) == 0);
  memset(t.surface->pixels, value, t.surface->byte_length);
  uint64_t token = 0;
  assert(v->flush(d, &r, 1, &token) == expected);
  return token;
}
int main(void) {
  const pocket_display_output_v1 *v = pocket_display_esp_lcd_vtable();
  pocket_display_esp_lcd_config c = {.struct_size = sizeof(c),
                                     .panel = (void *)1,
                                     .io = (void *)1,
                                     .width = 8,
                                     .height = 8,
                                     .strip_rows = 2,
                                     .buffer_count = 2,
                                     .frame_buffer_budget = 63};
  assert(!pocket_display_esp_lcd_create(&c));
  c.frame_buffer_budget = 64;
  pocket_display_esp_lcd *d = pocket_display_esp_lcd_create(&c);
  assert(d && pocket_display_esp_lcd_buffer_bytes(d) == 64 && done_cb);
  pocket_display_descriptor desc = {.struct_size = sizeof(desc)};
  assert(v->descriptor(d, &desc) == 0 && desc.refresh_width == 8 &&
         (desc.flags & POCKET_DISPLAY_PIPELINED_ACQUIRE));
  uint64_t a = submit(d, 0, 0x11, 0), b = submit(d, 2, 0x22, 0);
  assert(queued == 2);
  pocket_rect r = region(4);
  pocket_target t = {.struct_size = sizeof(t)};
  assert(v->acquire(d, &r, &t) == POCKET_STATUS_FAILED);
  /* Waiting on the first token completes only its transfer and frees only
   * its buffer; the second transfer keeps streaming without a barrier. */
  assert(v->wait(d, a) == 0 && queued == 1 && barriers == 0);
  assert(v->acquire(d, &r, &t) == 0 && queued == 1);
  memset(t.surface->pixels, 0x33, t.surface->byte_length);
  uint64_t e = 0;
  assert(v->flush(d, &r, 1, &e) == 0 && queued == 2);
  /* A later token completes everything queued before it. */
  assert(v->wait(d, e) == 0 && queued == 0 && barriers == 0);
  assert(v->wait(d, b) == 0);
  assert(v->wait(d, a) == POCKET_STATUS_INVALID);
  pocket_buffer_identity before = {.struct_size = sizeof(before)},
                         after = before;
  assert(v->frame_identity(d, &before) == 0);
  a = submit(d, 0, 0x44, 0);
  fail_next = true;
  submit(d, 2, 0x55, POCKET_STATUS_FAILED);
  assert(queued == 0 && barriers == 1);
  assert(v->wait(d, a) == 0);
  assert(v->frame_identity(d, &after) == 0 &&
         after.generation == before.generation + 1);
  /* Renderer failure leaves no submitted DMA; replacement acquire is legal. */
  assert(v->acquire(d, &r, &t) == 0);
  assert(v->acquire(d, &r, &t) == 0);
  /* A transfer that never completes bounds the wait, consumes the token and
   * keeps its buffer reserved until the transfer lands. */
  stalled = true;
  a = submit(d, 4, 0x66, 0);
  assert(v->wait(d, a) == POCKET_STATUS_FAILED && queued == 1 && ticks >= 1000);
  assert(v->wait(d, a) == POCKET_STATUS_INVALID);
  b = submit(d, 6, 0x77, 0);
  assert(v->acquire(d, &r, &t) == POCKET_STATUS_FAILED);
  stalled = false;
  assert(v->wait(d, b) == 0 && queued == 0);
  assert(v->acquire(d, &r, &t) == 0);
  pocket_display_esp_lcd_destroy(d);
  assert(!queued && !done_cb);
  puts("SPI/I80 adapter budget, per-buffer waits, terminal failure, bounded "
       "timeout and retry tests passed");
  return 0;
}
