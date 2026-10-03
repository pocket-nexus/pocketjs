#include "texture_source.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

#ifdef GEKKO
#include <gccore.h>
#define CHECK(expression) do { if (!(expression)) { printf("W19A FAIL line=%d\n", __LINE__); fflush(stdout); return __LINE__; } } while (0)
#else
#define CHECK(expression) assert(expression)
#endif

static const uint8_t pixels_5650[] = { 0x1f, 0x00, 0xe0, 0x07 };
static const uint8_t pixels_4444[] = { 0x21, 0x43 };
static const uint8_t pixels_8888[] = { 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0 };
static const uint8_t pixels_t8[] = { 7, 255 };
static const uint8_t palette_t8[POCKET_WII_TEXTURE_PALETTE_BYTES] = {
  [7 * 4] = 1, [7 * 4 + 1] = 2, [7 * 4 + 2] = 3, [7 * 4 + 3] = 4,
  [255 * 4] = 5, [255 * 4 + 1] = 6, [255 * 4 + 2] = 7, [255 * 4 + 3] = 8,
};
static const uint8_t pixels_short[] = { 1, 2, 3 };

static const PocketWiiTextureSource textures[] = {
  { pixels_5650, sizeof pixels_5650, NULL, 0, 2, 1, POCKET_WII_PSM_5650, 0, 0, UINT64_C(0x1020304050607080) },
  { pixels_4444, sizeof pixels_4444, NULL, 0, 1, 1, POCKET_WII_PSM_4444, 1, 1, 11 },
  { pixels_8888, sizeof pixels_8888, NULL, 0, 2, 1, POCKET_WII_PSM_8888, 0, 2, 12 },
  { pixels_t8, sizeof pixels_t8, palette_t8, sizeof palette_t8, 2, 1, POCKET_WII_PSM_T8, 1, 3, 13 },
  { pixels_short, sizeof pixels_short, NULL, 0, 1, 1, POCKET_WII_PSM_8888, 0, 4, 14 },
  { pixels_8888, sizeof pixels_8888, NULL, 0, 2, 1, 99, 0, 5, 15 },
};

size_t ui_texture_slot_count(void) {
  return sizeof textures / sizeof textures[0];
}

uint32_t ui_texture_slot_mask(void) {
  return UINT32_C(0x000fffff);
}

int32_t ui_texture_at(uint32_t slot, PocketWiiTextureSource *out) {
  if (out == NULL || slot >= ui_texture_slot_count()) return 0;
  *out = textures[slot];
  return 1;
}

static void expect_rgba(const PocketWiiTextureSource *source, uint32_t x, const uint8_t expected[4]) {
  uint8_t actual[4];
  assert(pocket_wii_texture_source_rgba(source, x, 0, actual));
  assert(memcmp(actual, expected, sizeof actual) == 0);
}

int main(void) {
#ifdef GEKKO
  SYS_STDIO_Report(true);
#endif
  PocketWiiTextureSource source;
  static const uint8_t red[] = { 255, 0, 0, 255 };
  static const uint8_t green[] = { 0, 255, 0, 255 };
  static const uint8_t rgba_4444[] = { 17, 34, 51, 68 };
  static const uint8_t rgba_a[] = { 0x12, 0x34, 0x56, 0x78 };
  static const uint8_t rgba_b[] = { 0x9a, 0xbc, 0xde, 0xf0 };
  static const uint8_t rgba_t8_a[] = { 1, 2, 3, 4 };
  static const uint8_t rgba_t8_b[] = { 5, 6, 7, 8 };

  CHECK(pocket_wii_texture_source_for_handle(0, &source));
  CHECK(source.width == 2 && source.height == 1 && source.psm == POCKET_WII_PSM_5650);
  CHECK(source.handle == 0 && source.revision == UINT64_C(0x1020304050607080) && source.linear == 0);
  expect_rgba(&source, 0, red);
  expect_rgba(&source, 1, green);

  CHECK(pocket_wii_texture_source_for_handle(1, &source));
  CHECK(source.psm == POCKET_WII_PSM_4444 && source.linear == 1 && source.revision == 11);
  expect_rgba(&source, 0, rgba_4444);

  CHECK(pocket_wii_texture_source_for_handle(2, &source));
  CHECK(source.psm == POCKET_WII_PSM_8888 && source.linear == 0 && source.revision == 12);
  expect_rgba(&source, 0, rgba_a);
  expect_rgba(&source, 1, rgba_b);

  CHECK(pocket_wii_texture_source_for_handle(3, &source));
  CHECK(source.psm == POCKET_WII_PSM_T8 && source.palette_len == 1024 && source.linear == 1 && source.revision == 13);
  expect_rgba(&source, 0, rgba_t8_a);
  expect_rgba(&source, 1, rgba_t8_b);

  uint8_t unchanged[4] = { 0xa5, 0xa5, 0xa5, 0xa5 };
  CHECK(!pocket_wii_texture_source_rgba(&source, 2, 0, unchanged));
  CHECK(memcmp(unchanged, "\xa5\xa5\xa5\xa5", sizeof unchanged) == 0);
  CHECK(!pocket_wii_texture_source_for_handle(-1, &source));
  CHECK(!pocket_wii_texture_source_for_handle(6, &source));
  CHECK(!pocket_wii_texture_source_for_handle(0x00100000, &source)); /* stale generation */
  CHECK(!pocket_wii_texture_source_for_handle(4, &source)); /* short pixel buffer */
  CHECK(!pocket_wii_texture_source_for_handle(5, &source)); /* unsupported PSM */
  printf("W19A PASS 5650[nearest,r=1020304050607080]=ff0000ff,00ff00ff 4444[linear,r=11]=11223344 8888[nearest,r=12]=12345678,9abcdef0 T8[linear,r=13]=01020304,05060708\n");
  return 0;
}
