#include "gx_texture.h"
#include "texture_source.h"

#ifdef POCKET_WII_GX_TEXTURE_MOCK
#include "mock_gx.h"
#endif

#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static uint8_t rgba_pixels[8 * 2 * 4];
static uint8_t t8_pixel[] = {2};
static uint8_t palette[POCKET_WII_TEXTURE_PALETTE_BYTES];
static PocketWiiTextureSource sources[2];

size_t ui_texture_slot_count(void) {
  return 2;
}

uint32_t ui_texture_slot_mask(void) {
  return 0x000fffffu;
}

int32_t ui_texture_at(uint32_t slot, PocketWiiTextureSource *out) {
  if (out == NULL || slot >= 2 || sources[slot].pixels == NULL) return 0;
  *out = sources[slot];
  return 1;
}

#ifdef POCKET_WII_GX_TEXTURE_MOCK
static void expect_rgba8_pixel(const uint8_t *image, unsigned tiles_x,
                               unsigned x, unsigned y, const uint8_t rgba[4]) {
  size_t tile = ((size_t)(y / 4) * tiles_x + x / 4) * 64;
  size_t pixel = ((size_t)(y & 3) * 4 + (x & 3)) * 2;
  image += tile;
  assert(image[pixel] == rgba[3]);
  assert(image[pixel + 1] == rgba[0]);
  assert(image[32 + pixel] == rgba[1]);
  assert(image[32 + pixel + 1] == rgba[2]);
}
#endif

int main(void) {
  for (unsigned i = 0; i < 16; i++) {
    rgba_pixels[i * 4] = (uint8_t)(i + 1);
    rgba_pixels[i * 4 + 1] = (uint8_t)(40 + i);
    rgba_pixels[i * 4 + 2] = (uint8_t)(80 + i);
    rgba_pixels[i * 4 + 3] = (uint8_t)(120 + i);
  }
  palette[2 * 4] = 9;
  palette[2 * 4 + 1] = 19;
  palette[2 * 4 + 2] = 29;
  palette[2 * 4 + 3] = 39;
  sources[0] = (PocketWiiTextureSource){
    .pixels = rgba_pixels, .pixels_len = 4 * 2 * 4,
    .width = 4, .height = 2, .psm = POCKET_WII_PSM_8888,
    .handle = 0, .revision = 1,
  };
  sources[1] = (PocketWiiTextureSource){
    .pixels = t8_pixel, .pixels_len = sizeof t8_pixel,
    .palette = palette, .palette_len = sizeof palette,
    .width = 1, .height = 1, .psm = POCKET_WII_PSM_T8,
    .handle = 1, .revision = 1,
  };

  pocket_wii_gx_texture_cache_clear();
  PocketWiiGXTexture texture;
  assert(pocket_wii_gx_texture_for_handle(0, &texture));
  assert(texture.width == 4 && texture.height == 2 && texture.linear == 0);

#ifdef POCKET_WII_GX_TEXTURE_MOCK
  const uint8_t *image = texture.object.image;
  assert(texture.object.format == GX_TF_RGBA8);
  assert(texture.object.wrap_s == GX_CLAMP && texture.object.wrap_t == GX_CLAMP);
  assert(mock_flush_count == 1 && mock_flush_pointer == texture.object.image);
  assert(mock_flush_length == 64);
  for (unsigned y = 0; y < 4; y++) {
    for (unsigned x = 0; x < 4; x++) {
      size_t pixel = ((size_t)y * 4 + x) * 2;
      if (y < 2) {
        expect_rgba8_pixel(image, 1, x, y, &rgba_pixels[(y * 4 + x) * 4]);
      } else {
        assert(image[pixel] == 0 && image[pixel + 1] == 0);
        assert(image[32 + pixel] == 0 && image[32 + pixel + 1] == 0);
      }
    }
  }
  assert(mock_gx_init_count == 1 && mock_gx_lod_count == 1);
  assert(mock_gx_invalidate_count == 1);
  assert(mock_last_flush_order < mock_last_invalidate_order);
  assert(mock_last_invalidate_order < mock_last_init_order);
  assert(mock_gx_draw_done_count == 0);
  assert(texture.object.min_filter == GX_NEAR && texture.object.mag_filter == GX_NEAR);
#endif

  PocketWiiGXTexture same;
  assert(pocket_wii_gx_texture_for_handle(0, &same));
#ifdef POCKET_WII_GX_TEXTURE_MOCK
  assert(same.object.image == texture.object.image);
  assert(mock_flush_count == 1 && mock_gx_init_count == 1);
  assert(mock_gx_invalidate_count == 1);
#endif

  assert(pocket_wii_gx_texture_for_handle(1, &texture));
  assert(texture.width == 1 && texture.height == 1);
#ifdef POCKET_WII_GX_TEXTURE_MOCK
  image = texture.object.image;
  assert(mock_flush_count == 2 && mock_flush_pointer == texture.object.image);
  assert(mock_flush_length == 64);
  expect_rgba8_pixel(image, 1, 0, 0, &palette[2 * 4]);
  void *texture1_image = texture.object.image;
#endif

  rgba_pixels[0] = 10;
  rgba_pixels[1] = 20;
  rgba_pixels[2] = 30;
  rgba_pixels[3] = 40;
  sources[0].revision++;
  sources[0].linear = 1;
  assert(pocket_wii_gx_texture_for_handle(0, &texture));
  assert(texture.linear == 1);
#ifdef POCKET_WII_GX_TEXTURE_MOCK
  image = texture.object.image;
  const uint8_t updated[] = {10, 20, 30, 40};
  expect_rgba8_pixel(image, 1, 0, 0, updated);
  assert(mock_flush_count == 3 && mock_flush_pointer == texture.object.image);
  assert(mock_gx_init_count == 3 && mock_gx_lod_count == 3);
  assert(mock_gx_invalidate_count == 3);
  assert(texture.object.min_filter == GX_LINEAR && texture.object.mag_filter == GX_LINEAR);
  assert(mock_gx_draw_done_count == 1);
  assert(mock_last_draw_done_order < mock_last_flush_order);
  assert(mock_last_flush_order < mock_last_invalidate_order);
  assert(mock_last_invalidate_order < mock_last_init_order);
#endif

  sources[0].handle = 0x00100000;
  sources[0].revision = 1;
  assert(!pocket_wii_gx_texture_for_handle(0, &texture));
  assert(pocket_wii_gx_texture_for_handle(sources[0].handle, &texture));
#ifdef POCKET_WII_GX_TEXTURE_MOCK
  assert(mock_flush_count == 4 && mock_gx_init_count == 4);
  assert(mock_gx_invalidate_count == 4);
  assert(mock_gx_draw_done_count == 2);
  assert(mock_last_draw_done_order < mock_last_flush_order);
  assert(mock_last_flush_order < mock_last_invalidate_order);
  assert(mock_last_invalidate_order < mock_last_init_order);
#endif

#ifdef POCKET_WII_GX_TEXTURE_MOCK
  void *old_image = texture.object.image;
#endif
  sources[0].width = 8;
  sources[0].pixels_len = sizeof rgba_pixels;
  sources[0].revision++;
  assert(pocket_wii_gx_texture_for_handle(sources[0].handle, &texture));
  assert(texture.width == 8 && texture.height == 2);
#ifdef POCKET_WII_GX_TEXTURE_MOCK
  assert(texture.object.image != old_image);
  assert(mock_flush_count == 5 && mock_flush_length == 128);
  assert(mock_gx_invalidate_count == 5);
  assert(mock_gx_draw_done_count == 3);
  assert(mock_last_draw_done_order < mock_last_flush_order);
  assert(mock_last_flush_order < mock_last_invalidate_order);
  assert(mock_last_invalidate_order < mock_last_init_order);
  assert(mock_free_pointers[mock_free_count - 1] == old_image);
  assert(mock_free_orders[mock_free_count - 1] > mock_last_draw_done_order);
  image = texture.object.image;
  expect_rgba8_pixel(image, 2, 7, 1, &rgba_pixels[(1 * 8 + 7) * 4]);
#endif

  assert(!pocket_wii_gx_texture_for_handle(-1, &texture));
#ifdef POCKET_WII_GX_TEXTURE_MOCK
  unsigned clear_draws = mock_gx_draw_done_count;
  unsigned clear_frees = mock_free_count;
  void *slot0_image = texture.object.image;
  void *slot1_image = texture1_image;
#endif
  pocket_wii_gx_texture_cache_clear();
#ifdef POCKET_WII_GX_TEXTURE_MOCK
  assert(mock_gx_draw_done_count == clear_draws + 1);
  bool freed_slot0 = false;
  bool freed_slot1 = false;
  for (unsigned i = clear_frees; i < mock_free_count; i++) {
    assert(mock_free_orders[i] > mock_last_draw_done_order);
    if (mock_free_pointers[i] == slot0_image) freed_slot0 = true;
    if (mock_free_pointers[i] == slot1_image) freed_slot1 = true;
  }
  assert(freed_slot0 && freed_slot1);
#endif
  assert(pocket_wii_gx_texture_for_handle(sources[0].handle, &texture));
#ifdef POCKET_WII_GX_TEXTURE_MOCK
  assert(mock_flush_count == 6 && mock_gx_init_count == 6);
  assert(mock_gx_invalidate_count == 6);
  clear_draws = mock_gx_draw_done_count;
  clear_frees = mock_free_count;
  slot0_image = texture.object.image;
#endif
  pocket_wii_gx_texture_cache_clear();
#ifdef POCKET_WII_GX_TEXTURE_MOCK
  assert(mock_gx_draw_done_count == clear_draws + 1);
  bool freed_final_image = false;
  for (unsigned i = clear_frees; i < mock_free_count; i++) {
    assert(mock_free_orders[i] > mock_last_draw_done_order);
    if (mock_free_pointers[i] == slot0_image) freed_final_image = true;
  }
  assert(freed_final_image);
#endif
  puts("W19B PASS");
  return 0;
}
