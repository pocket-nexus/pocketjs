#include "pocket/display_esp_lcd.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
static struct {
  const uint8_t *pixels;
  size_t size;
  uint8_t value;
} transfers[8];
static size_t queued, barriers;
static bool fail_next;
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
esp_err_t esp_lcd_panel_io_tx_param(void *io, int cmd, const void *p,
                                    size_t size) {
  assert(io && cmd == -1 && !p && !size);
  for (size_t i = 0; i < queued; i++)
    for (size_t j = 0; j < transfers[i].size; j++)
      assert(transfers[i].pixels[j] == transfers[i].value);
  queued = 0;
  barriers++;
  return ESP_OK;
}
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
  assert(d && pocket_display_esp_lcd_buffer_bytes(d) == 64);
  pocket_display_descriptor desc = {.struct_size = sizeof(desc)};
  assert(v->descriptor(d, &desc) == 0 && desc.refresh_width == 8 &&
         (desc.flags & POCKET_DISPLAY_PIPELINED_ACQUIRE));
  uint64_t a = submit(d, 0, 0x11, 0), b = submit(d, 2, 0x22, 0);
  assert(queued == 2);
  pocket_rect r = region(4);
  pocket_target t = {.struct_size = sizeof(t)};
  assert(v->acquire(d, &r, &t) == POCKET_STATUS_FAILED);
  assert(v->wait(d, b) == 0 && queued == 0 && barriers == 1);
  assert(v->wait(d, a) == 0 && barriers == 1);
  assert(v->wait(d, a) == POCKET_STATUS_INVALID);
  pocket_buffer_identity before = {.struct_size = sizeof(before)},
                         after = before;
  assert(v->frame_identity(d, &before) == 0);
  a = submit(d, 0, 0x33, 0);
  fail_next = true;
  submit(d, 2, 0x44, POCKET_STATUS_FAILED);
  assert(queued == 0);
  assert(v->wait(d, a) == 0);
  assert(v->frame_identity(d, &after) == 0 &&
         after.generation == before.generation + 1);
  /* Renderer failure leaves no submitted DMA; replacement acquire is legal. */
  assert(v->acquire(d, &r, &t) == 0);
  assert(v->acquire(d, &r, &t) == 0);
  submit(d, 4, 0x55, 0);
  pocket_display_esp_lcd_destroy(d);
  assert(!queued);
  puts("SPI/I80 adapter budget, deferred buffers, terminal failure and retry "
       "tests passed");
  return 0;
}
