#include "gx_textured.h"
#include "gx_texture.h"
#include "texture_source.h"
#include "drawlist.h"
#include "mock/mock_gx.h"

#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static uint8_t opaque_5650[] = {0xff, 0x07, 0x1f, 0xf8, 0x00, 0x00, 0xe0, 0x07};
static uint8_t alpha_4444[] = {0x00, 0xf0, 0xff, 0x0f, 0x88, 0x88, 0x00, 0x00};
static uint8_t indexed_t8[] = {2};
static uint8_t palette[POCKET_WII_TEXTURE_PALETTE_BYTES];
static PocketWiiTextureSource sources[3];

size_t ui_texture_slot_count(void) { return 3; }
uint32_t ui_texture_slot_mask(void) { return 0x000fffffu; }
int32_t ui_texture_at(uint32_t slot, PocketWiiTextureSource *out) {
  if (slot >= 3 || out == NULL || sources[slot].pixels == NULL) return 0;
  *out = sources[slot];
  return 1;
}

static uint32_t float_word(float value) {
  uint32_t word;
  memcpy(&word, &value, sizeof word);
  return word;
}

static uint32_t xy_word(int16_t x, int16_t y) {
  return (uint16_t)x | ((uint32_t)(uint16_t)y << 16);
}

static uint32_t wh_word(uint16_t width, uint16_t height) {
  return width | ((uint32_t)height << 16);
}

static void expect_vertex(size_t index, float x, float y, float u, float v,
                          uint32_t color) {
  const MockGXVertex *actual = &mock_gx.vertices[index];
  assert(actual->x == x && actual->y == y && actual->u == u && actual->v == v);
  assert(actual->r == (uint8_t)color && actual->g == (uint8_t)(color >> 8));
  assert(actual->b == (uint8_t)(color >> 16) && actual->a == (uint8_t)(color >> 24));
}

static void expect_cache_state(void) {
  assert(mock_gx.tex0_descriptor == GX_NONE);
  assert(mock_gx.texgen_count == 0);
  assert(mock_gx.tev_coordinate == GX_TEXCOORDNULL);
  assert(mock_gx.tev_map == GX_TEXMAP_NULL && mock_gx.tev_color == GX_COLOR0A0);
  assert(mock_gx.tev_op == GX_PASSCLR);
}

int main(void) {
  palette[2 * 4 + 0] = 180;
  palette[2 * 4 + 1] = 90;
  palette[2 * 4 + 2] = 45;
  palette[2 * 4 + 3] = 128;
  sources[0] = (PocketWiiTextureSource){
    .pixels = opaque_5650, .pixels_len = sizeof opaque_5650,
    .width = 2, .height = 2, .psm = POCKET_WII_PSM_5650,
    .handle = 0, .revision = 1,
  };
  sources[1] = (PocketWiiTextureSource){
    .pixels = alpha_4444, .pixels_len = sizeof alpha_4444,
    .width = 2, .height = 2, .psm = POCKET_WII_PSM_4444, .linear = 1,
    .handle = 1, .revision = 2,
  };
  sources[2] = (PocketWiiTextureSource){
    .pixels = indexed_t8, .pixels_len = sizeof indexed_t8,
    .palette = palette, .palette_len = sizeof palette,
    .width = 1, .height = 1, .psm = POCKET_WII_PSM_T8,
    .handle = 2, .revision = 3,
  };
  pocket_wii_gx_texture_cache_clear();

  PocketWiiGXContext context = {
    .x = 40, .y = 30, .width = 240, .height = 136,
    .scale_x = 0.5f, .scale_y = 0.5f,
  };
  uint32_t bad_op[] = {POCKET_WII_DRAW_RECT};
  uint32_t short_quad[] = {POCKET_WII_DRAW_TEX_QUAD};
  assert(!pocket_wii_gx_textured_op(&context, bad_op, 1));
  assert(!pocket_wii_gx_textured_op(&context, short_quad, 0));
  assert(!pocket_wii_gx_textured_op(&context, short_quad, 8));
  assert(!pocket_wii_gx_textured_op(&context, NULL, 0));

  uint32_t opaque_quad[] = {
    POCKET_WII_DRAW_TEX_QUAD, 0, xy_word(-3, 5), wh_word(20, 12),
    float_word(0.125f), float_word(0.25f), float_word(0.875f), float_word(0.75f),
    0xffd0c0b0,
  };
  assert(pocket_wii_gx_textured_op(&context, opaque_quad, 9));
  assert(mock_gx.draw_count == 1 && mock_gx.vertex_count == 6);
  expect_vertex(0, -3, 5, 0.125f, 0.25f, 0xffd0c0b0);
  expect_vertex(1, 17, 5, 0.875f, 0.25f, 0xffd0c0b0);
  expect_vertex(2, 17, 17, 0.875f, 0.75f, 0xffd0c0b0);
  expect_vertex(3, -3, 5, 0.125f, 0.25f, 0xffd0c0b0);
  expect_vertex(4, 17, 17, 0.875f, 0.75f, 0xffd0c0b0);
  expect_vertex(5, -3, 17, 0.125f, 0.75f, 0xffd0c0b0);
  assert(mock_gx.draws[0].texture.min_filter == GX_NEAR);
  assert(mock_gx.draws[0].texture.mag_filter == GX_NEAR);
  expect_cache_state();

  uint32_t alpha_quad[] = {
    POCKET_WII_DRAW_TEX_QUAD, 1, xy_word(10, 20), wh_word(8, 6),
    float_word(0), float_word(0), float_word(1), float_word(1), 0x80d0b080,
  };
  assert(pocket_wii_gx_textured_op(&context, alpha_quad, 9));
  assert(mock_gx.draw_count == 2 && mock_gx.vertex_count == 12);
  expect_vertex(6, 10, 20, 0, 0, 0x80d0b080);
  expect_vertex(7, 18, 20, 1, 0, 0x80d0b080);
  expect_vertex(8, 18, 26, 1, 1, 0x80d0b080);
  expect_vertex(9, 10, 20, 0, 0, 0x80d0b080);
  expect_vertex(10, 18, 26, 1, 1, 0x80d0b080);
  expect_vertex(11, 10, 26, 0, 1, 0x80d0b080);
  assert(mock_gx.draws[1].texture.min_filter == GX_LINEAR);
  assert(mock_gx.draws[1].texture.mag_filter == GX_LINEAR);
  expect_cache_state();

  uint32_t palette_quad[] = {
    POCKET_WII_DRAW_TEX_QUAD, 2, xy_word(0, 0), wh_word(1, 1),
    float_word(0), float_word(0), float_word(1), float_word(1), 0xffffffff,
  };
  assert(pocket_wii_gx_textured_op(&context, palette_quad, 9));
  assert(mock_gx.draw_count == 3 && mock_gx.vertex_count == 18);
  expect_vertex(12, 0, 0, 0, 0, 0xffffffff);
  expect_vertex(13, 1, 0, 1, 0, 0xffffffff);
  expect_vertex(14, 1, 1, 1, 1, 0xffffffff);
  expect_vertex(15, 0, 0, 0, 0, 0xffffffff);
  expect_vertex(16, 1, 1, 1, 1, 0xffffffff);
  expect_vertex(17, 0, 1, 0, 1, 0xffffffff);
  assert(mock_gx.draws[2].texture.min_filter == GX_NEAR);
  assert(mock_gx.draws[2].texture.mag_filter == GX_NEAR);
  expect_cache_state();

  uint32_t transformed_tri[] = {
    POCKET_WII_DRAW_TEX_TRI, 1,
    xy_word(10, 12), float_word(0.75f), float_word(0.125f),
    xy_word(20, 13), float_word(0.75f), float_word(0.875f),
    xy_word(14, 25), float_word(0.125f), float_word(0.125f),
    0x80ffffff,
  };
  assert(pocket_wii_gx_textured_op(&context, transformed_tri, 12));
  assert(mock_gx.draw_count == 4 && mock_gx.vertex_count == 21);
  expect_vertex(18, 10, 12, 0.75f, 0.125f, 0x80ffffff);
  expect_vertex(19, 20, 13, 0.75f, 0.875f, 0x80ffffff);
  expect_vertex(20, 14, 25, 0.125f, 0.125f, 0x80ffffff);
  assert(mock_gx.draws[3].texture.min_filter == GX_LINEAR);
  assert(mock_gx.draws[3].texture.mag_filter == GX_LINEAR);
  expect_cache_state();

  PocketWiiGXTexture cached[3];
  for (int32_t handle = 0; handle < 3; handle++) {
    assert(pocket_wii_gx_texture_for_handle(handle, &cached[handle]));
    assert(mock_gx.draws[handle].texture.image == cached[handle].object.image);
    assert(mock_gx.draws[handle].texture.format == GX_TF_RGBA8);
    assert(mock_gx.draws[handle].texture.width == cached[handle].width);
    assert(mock_gx.draws[handle].texture.height == cached[handle].height);
  }
  assert(mock_gx.draws[3].texture.image == cached[1].object.image);
  assert(mock_gx.flush_count == 3 && mock_gx.texture_init_count == 3);
  assert(mock_gx.texture_lod_count == 3 && mock_gx.texcoord_format == 4);

  uint32_t transparent_quad[] = {
    POCKET_WII_DRAW_TEX_QUAD, 99, xy_word(0, 0), wh_word(1, 1),
    float_word(0), float_word(0), float_word(1), float_word(1), 0x00ffffff,
  };
  assert(pocket_wii_gx_textured_op(&context, transparent_quad, 9));
  assert(mock_gx.draw_count == 4 && mock_gx.flush_count == 3);

  uint32_t bad_handle[] = {
    POCKET_WII_DRAW_TEX_QUAD, 99, xy_word(0, 0), wh_word(1, 1),
    float_word(0), float_word(0), float_word(1), float_word(1), 0xffffffff,
  };
  assert(!pocket_wii_gx_textured_op(&context, bad_handle, 9));
  assert(mock_gx.draw_count == 4);

  pocket_wii_gx_texture_cache_clear();
  puts("W19C PASS: opaque, alpha, T8, transformed UVs, filters, tint, and draw order");
  return 0;
}
