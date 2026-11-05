#include "rotation_selftest.h"
#include "bf0_hal.h"
#include <math.h>
#ifdef quad
#undef quad
#endif

/* Real EPIC rotation with a cropped atlas, opaque color landmarks, alpha,
 * uniform scaling and partial-screen quads. Clipping must preserve every
 * pixel of the full hardware render and leave the rest of the target alone. */
int pocket_sifli_epic_test_rotation(pocket_sifli_epic *epic, uint16_t *full, uint16_t *clipped,
                                  uint32_t width, uint32_t height) {
  if (!epic || !full || !clipped || width < 128 || height < 128) return -1;
  const pocket_epic_ops *ops = pocket_sifli_epic_ops(epic);
  pocket_epic_caps caps = {.struct_size = sizeof(caps)};
  if (ops->caps(ops->context, &caps) != POCKET_STATUS_OK) return -1;
  if (!(caps.flags & POCKET_EPIC_BLIT_ROTATE) || !ops->can_blit_rotate) return -1;
  ALIGN(64) static uint32_t pixels[32 * 32];
  const uint32_t colors[] = {0xffff0000u, 0xff00ff00u, 0xff0000ffu, 0xffffffffu};
  const uint16_t rgb565[] = {0xf800u, 0x07e0u, 0x001fu, 0xffffu};
  for (unsigned y = 0; y < 32; ++y)
    for (unsigned x = 0; x < 32; ++x)
      pixels[y * 32 + x] = (x >= 5 && x < 21 && y >= 7 && y < 23)
          ? colors[(x >= 13) + 2 * (y >= 15)] : 0xff777777u;
  pocket_epic_texture texture = {.struct_size = sizeof(texture),
      .kind = POCKET_EPIC_TEXTURE_NATIVE, .format = POCKET_EPIC_BGRA8888,
      .width = 32, .height = 32, .pixels = (const uint8_t *)pixels, .pixel_bytes = sizeof(pixels)};
  uint32_t id = 0;
  if (ops->register_texture(ops->context, &texture, &id) != POCKET_STATUS_OK) return -1;
  static const int angles[] = {0, 900, 1800, 2700, 370, 1370, 2250, 3590};
  int result = -1;
  unsigned cases = 0;
  uint32_t cycles = 0;
  for (unsigned mode = 0; mode < 4; ++mode) {
    float scale = (mode & 1) ? 2.0f : 1.0f;
    float center = mode == 3 ? 8.0f : 64.0f;
    pocket_epic_rect clip = mode == 3 ? (pocket_epic_rect){0, 0, 13, 11}
                                               : (pocket_epic_rect){58, 55, 15, 17};
    for (unsigned n = 0; n < sizeof(angles) / sizeof(angles[0]); ++n) {
      float radians = angles[n] * (3.14159265358979323846f / 1800.0f);
      float a = cosf(radians) * scale, b = sinf(radians) * scale;
      pocket_epic_cmd draw = {.op = POCKET_EPIC_OP_BLIT_ROTATE,
          .source = POCKET_EPIC_SOURCE_TEXTURE, .texture = id,
          .color = mode == 2 ? 0xbfffffff : 0xffffffff,
          .flags = POCKET_EPIC_LINEAR, .src = {5, 7, 16, 16}};
      for (unsigned i = 0; i < 4; ++i) {
        float x = i >= 2 ? 8.0f : -8.0f;
        float y = i == 1 || i == 2 ? 8.0f : -8.0f;
        draw.quad[i] = (pocket_epic_point){(int32_t)lroundf(center + a * x - b * y),
                                         (int32_t)lroundf(center + b * x + a * y)};
      }
      for (unsigned target = 1; target <= 2; ++target) {
        draw.clip = target == 1 ? (pocket_epic_rect){0, 0, width, height} : clip;
        pocket_epic_cmd fill = {.op = POCKET_EPIC_OP_FILL,
            .dst = {0, 0, width, height}, .color = 0xff336699};
        if (ops->begin(ops->context, target, width, height) != POCKET_STATUS_OK ||
            ops->can_blit_rotate(ops->context, &draw) != POCKET_STATUS_OK ||
            ops->submit(ops->context, &fill, 1) != POCKET_STATUS_OK ||
            ops->fence(ops->context) != POCKET_STATUS_OK) goto done;
        uint32_t start = HAL_DBG_DWT_GetCycles();
        if (ops->submit(ops->context, &draw, 1) != POCKET_STATUS_OK ||
            ops->end(ops->context) != POCKET_STATUS_OK) goto done;
        cycles += HAL_DBG_DWT_GetCycles() - start;
      }
      mpu_dcache_invalidate(full, width * height * 2u);
      mpu_dcache_invalidate(clipped, width * height * 2u);
      for (uint32_t y = 0; y < height; ++y) {
        for (uint32_t x = 0; x < width; ++x) {
          bool inside = x >= clip.x && x < clip.x + clip.w && y >= clip.y && y < clip.y + clip.h;
          uint16_t expected = inside ? full[y * width + x] : full[width * height - 1];
          if (clipped[y * width + x] != expected) {
            rt_kprintf("[EPIC] FAIL rotation clip angle=%d mode=%u xy=%u,%u expected=%x actual=%x\n",
                angles[n], mode, x, y, expected, clipped[y * width + x]);
            goto done;
          }
        }
      }
      if (mode < 2) {
        for (unsigned quadrant = 0; quadrant < 4; ++quadrant) {
          float x = (quadrant & 1) ? 4.0f : -4.0f;
          float y = (quadrant & 2) ? 4.0f : -4.0f;
          unsigned px = (unsigned)lroundf(center + a * x - b * y - 0.5f);
          unsigned py = (unsigned)lroundf(center + b * x + a * y - 0.5f);
          if (full[py * width + px] != rgb565[quadrant]) {
            rt_kprintf("[EPIC] FAIL rotation landmark angle=%d mode=%u quadrant=%u expected=%x actual=%x\n",
                angles[n], mode, quadrant, rgb565[quadrant], full[py * width + px]);
            goto done;
          }
        }
      }
      if (mode == 0 && n < 4) {
        /* At unit scale and cardinal angles, all texel boundaries land
         * exactly on pixel boundaries: check placement and orientation of
         * every pixel against an independent inverse-rotation oracle. */
        for (uint32_t y = 0; y < height; ++y) {
          for (uint32_t x = 0; x < width; ++x) {
            int dx = (int)x - 56, dy = (int)y - 56;
            int u = dx, v = dy;
            if (n == 1) { u = dy; v = 15 - dx; }
            if (n == 2) { u = 15 - dx; v = 15 - dy; }
            if (n == 3) { u = 15 - dy; v = dx; }
            uint16_t expected = u >= 0 && u < 16 && v >= 0 && v < 16
                ? rgb565[(u >= 8) + 2 * (v >= 8)] : full[width * height - 1];
            if (full[y * width + x] != expected) {
              rt_kprintf("[EPIC] FAIL cardinal angle=%d xy=%u,%u expected=%x actual=%x\n",
                  angles[n], x, y, expected, full[y * width + x]);
              goto done;
            }
          }
        }
      }
      ++cases;
    }
  }
  rt_kprintf("[EPIC] PASS rotation atlas/alpha/scale/offscreen clips: %u cases, avg=%uus/draw\n",
      cases, (unsigned)(cycles / (cases * 2u) / (HAL_RCC_GetHCLKFreq(CORE_ID_HCPU) / 1000000u)));
  result = 0;
done:
  (void)ops->end(ops->context);
  ops->release_texture(ops->context, id);
  pocket_sifli_epic_profile_get(epic, NULL, true);
  return result;
}
