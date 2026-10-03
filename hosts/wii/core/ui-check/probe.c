#include <gccore.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "fixture.h"

typedef struct {
  const uint8_t *pixels;
  size_t pixels_len;
  const uint8_t *palette;
  size_t palette_len;
  uint32_t width, height, psm, linear;
  int32_t handle;
  uint64_t revision;
} PocketTexture;

typedef struct {
  const uint8_t *coverage;
  size_t coverage_len;
  uint32_t cell_width, cell_height, coverage_width, coverage_height, glyph_count;
} PocketFontAtlas;

_Static_assert(offsetof(PocketTexture, revision) == 40, "Wii texture ABI offset");
_Static_assert(sizeof(PocketTexture) == 48, "Wii texture ABI size");
_Static_assert(sizeof(PocketFontAtlas) == 28, "Wii font ABI size");

extern void ui_init(uint32_t);
extern void ui_shutdown(void);
extern void ui_set_viewport(float, float);
extern uint32_t ui_feed_pak(const uint8_t *, size_t);
extern int32_t ui_create_node(uint32_t);
extern void ui_insert_before(int32_t, int32_t, int32_t);
extern void ui_set_prop(int32_t, uint32_t, double);
extern void ui_set_image(int32_t, int32_t);
extern void ui_set_text(int32_t, const uint8_t *, size_t);
extern void ui_tick(void);
extern size_t ui_draw(void);
extern const uint32_t *ui_draw_list_ptr(void);
extern size_t ui_draw_list_len(void);
extern size_t ui_pak_texture_count(void);
extern const uint8_t *ui_pak_texture_name(size_t);
extern size_t ui_pak_texture_name_len(size_t);
extern int32_t ui_pak_texture_handle(size_t);
extern size_t ui_pak_sprite_count(void);
extern uint32_t ui_texture_slot_mask(void);
extern int32_t ui_texture_at(uint32_t, PocketTexture *);
extern int32_t ui_font_atlas(uint32_t, PocketFontAtlas *);
extern float ui_measure_text(const uint8_t *, size_t, uint32_t);

static void print_bytes(const uint8_t *bytes, size_t length) {
  for (size_t i = 0; i < length; ++i) printf("%02x", bytes[i]);
}

int main(void) {
  SYS_STDIO_Report(true);
  ui_init(1);
  ui_set_viewport(480.0f, 272.0f);
  uint32_t fed = ui_feed_pak(w13b_pak, sizeof w13b_pak);
  if (fed != 3 || ui_pak_texture_count() != 1 || ui_pak_sprite_count() != 0) return 1;
  if (ui_pak_texture_name_len(0) != 5 || memcmp(ui_pak_texture_name(0), "pixel", 5) != 0) return 2;

  int32_t box = ui_create_node(0);
  int32_t image = ui_create_node(2);
  int32_t label = ui_create_node(1);
  if (!box || !image || !label) return 3;
  ui_insert_before(1, box, 0);
  ui_insert_before(1, image, 0);
  ui_insert_before(1, label, 0);
  ui_set_prop(box, 1, 23.5);
  ui_set_prop(box, 2, 12.25);
  ui_set_prop(box, 64, (double)0xff123456u);
  ui_set_prop(image, 1, 2.0);
  ui_set_prop(image, 2, 2.0);
  ui_set_image(image, ui_pak_texture_handle(0));
  ui_set_prop(label, 1, 12.0);
  ui_set_prop(label, 2, 8.0);
  ui_set_prop(label, 97, 5.0);
  ui_set_prop(label, 96, (double)0xffffffffu);
  ui_set_text(label, (const uint8_t *)"A", 1);
  ui_tick();

  size_t count = ui_draw();
  const uint32_t *words = ui_draw_list_ptr();
  if (!count || !words || ui_draw_list_len() != count) return 4;
  PocketTexture texture = {0};
  PocketFontAtlas font = {0};
  int32_t handle = ui_pak_texture_handle(0);
  if (!ui_texture_at((uint32_t)handle & ui_texture_slot_mask(), &texture)) return 5;
  if (!ui_font_atlas(5, &font) || texture.width != 2 || texture.height != 2 || texture.psm != 3 || texture.pixels_len != 16 || font.glyph_count != 2) return 6;
  static const uint8_t expected_pixels[] = {
    0x12, 0x34, 0x56, 0xff, 0x78, 0x9a, 0xbc, 0xff,
    0xde, 0xf0, 0x12, 0xff, 0x34, 0x56, 0x78, 0xff,
  };
  static const uint32_t expected_draw[] = {
    1, 0, 0x000c0018, 0xff123456,
    4, 0, 0x000c0000, 0x00020002, 0, 0, 0x3f800000, 0x3f800000, 0xffffffff,
  };
  if (texture.handle != 0 || texture.revision != 0 || texture.linear || texture.palette || texture.palette_len
      || memcmp(texture.pixels, expected_pixels, sizeof expected_pixels)) return 7;
  if (font.cell_width != 3 || font.cell_height != 2 || font.coverage_width != 6
      || font.coverage_height != 4 || font.coverage_len != 48) return 8;
  for (size_t i = 0; i < font.coverage_len; ++i) {
    if (font.coverage[i] != (uint8_t)(i * 37 + 11)) return 9;
  }
  if (count != sizeof expected_draw / sizeof expected_draw[0]
      || memcmp(words, expected_draw, sizeof expected_draw)) return 10;
  float measured = ui_measure_text((const uint8_t *)"A", 1, 5);
  uint32_t measured_bits;
  memcpy(&measured_bits, &measured, sizeof measured_bits);
  if (measured_bits != 0x40a00000) return 11;

  printf("W13B PASS fed=%u texture=%ux%u:%u:%llu:%llu:%llu pixels=", fed,
    texture.width, texture.height, texture.psm,
    (unsigned long long)texture.handle, (unsigned long long)texture.revision,
    (unsigned long long)texture.pixels_len);
  print_bytes(texture.pixels, texture.pixels_len);
  printf(" font=%ux%u:%ux%u:%u:%llu coverage=", font.cell_width, font.cell_height,
    font.coverage_width, font.coverage_height, font.glyph_count,
    (unsigned long long)font.coverage_len);
  print_bytes(font.coverage, font.coverage_len);
  printf(" measure=%08x draw=", measured_bits);
  for (size_t i = 0; i < count; ++i) printf("%s%08x", i ? "," : "", (unsigned)words[i]);
  putchar('\n');
  ui_shutdown();
  return 0;
}
