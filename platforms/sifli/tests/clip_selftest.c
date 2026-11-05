#include "clip_selftest.h"
#include "bf0_hal.h"

/* Compare a hardware-clipped scaled/alpha blit against the same pixels of
 * a full hardware blit. Every pixel outside the clip must retain its fill. */
int pocket_sifli_epic_test_clip(pocket_sifli_epic *epic, uint16_t *full, uint16_t *clipped,
                       uint32_t width, uint32_t height) {
  if (!epic || !full || !clipped || width < 40 || height < 40) return -1;
  const pocket_epic_ops *ops = pocket_sifli_epic_ops(epic);
  pocket_epic_caps caps = {.struct_size = sizeof(caps)};
  if (ops->caps(ops->context, &caps) != POCKET_STATUS_OK) return -1;
  unsigned modes = 0;
  ALIGN(64) static uint32_t texels[64];
  for (unsigned i = 0; i < 64; ++i)
    texels[i] = ((64u + (i * 19u) % 192u) << 24) |
                (((i * 37u) & 255u) << 16) | (((i * 11u) & 255u) << 8) | 149u;
  (void)mpu_dcache_clean(texels, sizeof(texels));
  pocket_epic_texture texture = {.struct_size = sizeof(texture),
      .kind = POCKET_EPIC_TEXTURE_NATIVE, .format = POCKET_EPIC_BGRA8888,
      .width = 8, .height = 8, .pixels = (const uint8_t *)texels,
      .pixel_bytes = sizeof(texels)};
  uint32_t id = 0;
  if (ops->register_texture(ops->context, &texture, &id) != POCKET_STATUS_OK) return -1;
  int result = -1;
  for (unsigned mirror = 0; mirror < 4; ++mirror) {
    if ((mirror & POCKET_EPIC_MIRROR_Y) && !(caps.flags & POCKET_EPIC_BLIT_MIRROR_Y)) continue;
    ++modes;
    for (unsigned target = 1; target <= 2; ++target) {
      pocket_epic_cmd commands[2] = {
          {.op = POCKET_EPIC_OP_FILL, .dst = {0, 0, width, height}, .color = 0xff336699},
          {.op = POCKET_EPIC_OP_BLIT, .flags = POCKET_EPIC_LINEAR | mirror,
           .source = POCKET_EPIC_SOURCE_TEXTURE, .texture = id, .color = 0xbfffffff,
           .src = {0, 0, 8, 8}, .dst = {13, 17, 27, 23}, .clip = {13, 17, 27, 23}},
      };
      if (target == 2) commands[1].clip = (pocket_epic_rect){18, 20, 11, 9};
      if (ops->begin(ops->context, target, width, height) != POCKET_STATUS_OK) goto done;
      if (ops->submit(ops->context, commands, 2) != POCKET_STATUS_OK ||
          ops->end(ops->context) != POCKET_STATUS_OK) goto done;
    }
    mpu_dcache_invalidate(full, width * height * 2u);
    mpu_dcache_invalidate(clipped, width * height * 2u);
    for (uint32_t y = 0; y < height; ++y) {
      for (uint32_t x = 0; x < width; ++x) {
        uint32_t i = y * width + x;
        uint16_t expected = (x >= 18 && x < 29 && y >= 20 && y < 29) ? full[i] : full[0];
        if (clipped[i] != expected) {
          rt_kprintf("[EPIC] FAIL clip mirror=%u xy=%u,%u expected=%x actual=%x\n",
              mirror, x, y, expected, clipped[i]);
          goto done;
        }
      }
    }
  }
  rt_kprintf("[EPIC] PASS scaled alpha blit clips match full render, %u mirror modes\n", modes);
  result = 0;
done:
  (void)ops->end(ops->context);
  ops->release_texture(ops->context, id);
  pocket_sifli_epic_profile_get(epic, NULL, true);
  return result;
}
