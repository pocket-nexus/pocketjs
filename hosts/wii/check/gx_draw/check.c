#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "pocket_wii.h"
#include "qjs.h"
#include "pocket_core.h"
#include "drawlist.h"
#include "gx_font.h"
#include "texture_source.h"
#include "mock/mock_gx.h"

typedef struct {
  const uint8_t *javascript;
  size_t javascript_length;
  const uint8_t *pak;
  size_t pak_length;
  const uint8_t *plan;
  size_t plan_length;
  uint64_t package_hash;
  uint64_t variant_hash;
} PocketGuestPackage;

static const uint8_t empty_js[] = { 0 };
static const uint8_t package_bytes[] = { 1 };
static const uint8_t pixels[] = { 0x11, 0x22, 0x33, 0xff };
static const uint8_t coverage[] = { 0xff, 0x80, 0x80, 0xff };
static uint32_t draw_words[64];
static size_t draw_word_count;
static unsigned draw_call_count;
static unsigned ui_shutdown_count;
static unsigned qjs_shutdown_count;
static bool qjs_boot_succeeds = true;
static const char *qjs_boot_error = "W21 intentional QuickJS boot failure";

int32_t pocket_package_open(const uint8_t *bytes, size_t length,
  const uint8_t *target, size_t target_length, uint32_t host_abi,
  PocketGuestPackage *out) {
  (void)bytes; (void)length; (void)target; (void)target_length; (void)host_abi;
  *out = (PocketGuestPackage){ .javascript = empty_js, .javascript_length = sizeof empty_js };
  return 0;
}

bool qjs_boot(const char *javascript, size_t length, const uint8_t *pak,
              size_t pak_length) {
  (void)javascript; (void)length; (void)pak; (void)pak_length;
  return qjs_boot_succeeds;
}
bool qjs_frame(uint32_t buttons, uint32_t analog) {
  (void)buttons; (void)analog;
  return true;
}
const char *qjs_last_error(void) { return qjs_boot_succeeds ? "" : qjs_boot_error; }
void qjs_shutdown(void) { qjs_shutdown_count += 1; }

void ui_init(uint32_t raster_density) { (void)raster_density; }
void ui_shutdown(void) { ui_shutdown_count += 1; }
void ui_set_viewport(float width, float height) { (void)width; (void)height; }
uint32_t ui_feed_pak(const uint8_t *ptr, size_t len) { (void)ptr; (void)len; return 0; }
void ui_tick(void) {}
size_t ui_draw(void) { draw_call_count += 1; return draw_word_count; }
const uint32_t *ui_draw_list_ptr(void) { return draw_words; }
size_t ui_draw_list_len(void) { return draw_word_count; }

size_t ui_texture_slot_count(void) { return 4; }
uint32_t ui_texture_slot_mask(void) { return 3; }
int32_t ui_texture_at(uint32_t slot, PocketWiiTextureSource *out) {
  if (slot != 1 || out == NULL) return 0;
  *out = (PocketWiiTextureSource){
    .pixels = pixels, .pixels_len = sizeof pixels,
    .width = 1, .height = 1, .psm = POCKET_WII_PSM_8888,
    .handle = 1, .revision = 1,
  };
  return 1;
}
size_t ui_font_slot_count(void) { return 1; }
int32_t ui_font_atlas(uint32_t slot, PocketWiiFontAtlas *out) {
  if (slot != 0 || out == NULL) return 0;
  *out = (PocketWiiFontAtlas){
    .coverage = coverage, .coverage_len = sizeof coverage,
    .cell_width = 2, .cell_height = 2,
    .coverage_width = 2, .coverage_height = 2, .glyph_count = 1,
  };
  return 1;
}

static uint32_t xy_word(int16_t x, int16_t y) {
  return (uint16_t)x | ((uint32_t)(uint16_t)y << 16);
}

static void put_word(uint32_t value) { draw_words[draw_word_count++] = value; }

static void make_valid_drawlist(void) {
  draw_word_count = 0;
  put_word(POCKET_WII_DRAW_SCISSOR);
  put_word(xy_word(0, 0));
  put_word((80u << 16) | 100u);
  put_word(POCKET_WII_DRAW_RECT);
  put_word(xy_word(10, 10));
  put_word((20u << 16) | 20u);
  put_word(0xff0000ffu);
  put_word(POCKET_WII_DRAW_TEX_QUAD);
  put_word(1);
  put_word(xy_word(5, 5));
  put_word((10u << 16) | 10u);
  put_word(0); put_word(0); put_word(0x3f800000u); put_word(0x3f800000u);
  put_word(0xffffffffu);
  put_word(POCKET_WII_DRAW_TEX_TRI);
  put_word(1);
  put_word(xy_word(10, 10)); put_word(0); put_word(0);
  put_word(xy_word(20, 10)); put_word(0x3f800000u); put_word(0);
  put_word(xy_word(10, 20)); put_word(0); put_word(0x3f800000u);
  put_word(0xffffffffu);
  put_word(POCKET_WII_DRAW_GLYPH_RUN);
  put_word(0x00010000u);
  put_word(0xff112233u);
  put_word(xy_word(30, 30)); put_word(0);
  put_word(POCKET_WII_DRAW_GRAD_RECT);
  put_word(xy_word(50, 10));
  put_word((20u << 16) | 20u);
  put_word(0xff0000ffu); put_word(0xff00ff00u); put_word(3);
  put_word(POCKET_WII_DRAW_SCISSOR_POP);
  put_word(POCKET_WII_DRAW_TRI);
  put_word(xy_word(0, 0)); put_word(xy_word(10, 0)); put_word(xy_word(0, 10));
  put_word(0xffffffffu); put_word(0xffffffffu); put_word(0xffffffffu);
}

static void expect_order(void) {
  static const int expected[] = {
    MOCK_GX_HOST, MOCK_GX_SOLID, MOCK_GX_TEXTURE, MOCK_GX_TEXTURE,
    MOCK_GX_FONT, MOCK_GX_SOLID, MOCK_GX_SOLID, MOCK_GX_HOST,
  };
  assert(mock_gx.draw_count == sizeof expected / sizeof expected[0]);
  for (size_t i = 0; i < sizeof expected / sizeof expected[0]; i += 1) {
    assert(mock_gx.draws[i].kind == expected[i]);
  }
  for (size_t i = 1; i <= 5; i += 1) {
    assert(mock_gx.draws[i].scissor[0] == 40 && mock_gx.draws[i].scissor[1] == 30);
    assert(mock_gx.draws[i].scissor[2] == 50 && mock_gx.draws[i].scissor[3] == 40);
  }
  assert(mock_gx.draws[6].scissor[0] == 40 && mock_gx.draws[6].scissor[1] == 30);
  assert(mock_gx.draws[6].scissor[2] == 240 && mock_gx.draws[6].scissor[3] == 136);
  assert(mock_gx.scissor_count == 3);
}

int main(void) {
  pocket_wii_shutdown();
  pocket_wii_shutdown();
  qjs_boot_succeeds = false;
  assert(pocket_wii_boot(package_bytes, sizeof package_bytes) != 0);
  assert(strcmp(pocket_wii_last_error(), qjs_boot_error) == 0);
  qjs_boot_succeeds = true;
  assert(pocket_wii_boot(package_bytes, sizeof package_bytes) == 0);

  make_valid_drawlist();
  mock_gx_reset();
  mock_gx_host_draw();
  assert(pocket_wii_draw(40, 30, 240, 136) == 0);
  mock_gx_host_draw();
  expect_order();
  assert(draw_call_count == 1);
  assert(mock_gx.texture_init_count == 2 && mock_gx.flush_count == 2);
  assert(pocket_wii_last_error()[0] == '\0');

  static const uint32_t unsupported[] = { POCKET_WII_DRAW_SURFACE_QUAD };
  memcpy(draw_words, unsupported, sizeof unsupported);
  draw_word_count = sizeof unsupported / sizeof unsupported[0];
  mock_gx_reset();
  assert(pocket_wii_draw(0, 0, 0, 1) != 0);
  assert(strstr(pocket_wii_last_error(), "nonzero") != NULL);
  assert(pocket_wii_draw(0, 0, 1, 1) != 0);
  assert(strstr(pocket_wii_last_error(), "unsupported") != NULL);
  assert(mock_gx.draw_count == 0 && mock_gx.scissor_count == 0);

  pocket_wii_shutdown();
  unsigned done_after_clear = mock_gx.draw_done_count;
  assert(done_after_clear >= 2);
  pocket_wii_shutdown();
  assert(mock_gx.draw_done_count == done_after_clear);
  assert(ui_shutdown_count >= 1 && qjs_shutdown_count >= 2);

  assert(pocket_wii_boot(package_bytes, sizeof package_bytes) == 0);
  make_valid_drawlist();
  mock_gx_reset();
  assert(pocket_wii_draw(0, 0, 480, 272) == 0);
  assert(mock_gx.texture_init_count == 2 && mock_gx.flush_count == 2);
  pocket_wii_shutdown();
  puts("W21 PASS ordered public draw dispatch, caller GX draws, clips, errors, cache clear, and reboot");
  return 0;
}
