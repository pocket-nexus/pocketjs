#include "texture_source.h"

#include <string.h>

#if UINTPTR_MAX == UINT32_MAX
_Static_assert(offsetof(PocketWiiTextureSource, revision) == 40, "Wii PocketTexture revision offset");
_Static_assert(sizeof(PocketWiiTextureSource) == 48, "Wii PocketTexture ABI size");
#endif

extern size_t ui_texture_slot_count(void);
extern uint32_t ui_texture_slot_mask(void);
extern int32_t ui_texture_at(uint32_t slot, PocketWiiTextureSource *out);

static bool texture_source_valid(const PocketWiiTextureSource *source) {
  if (source == NULL || source->pixels == NULL || source->handle < 0 ||
      source->width == 0 || source->height == 0 ||
      source->width > POCKET_WII_TEXTURE_MAX_DIM ||
      source->height > POCKET_WII_TEXTURE_MAX_DIM ||
      (source->width & (source->width - 1)) != 0 ||
      (source->height & (source->height - 1)) != 0 || source->linear > 1) {
    return false;
  }

  size_t bytes_per_pixel;
  switch (source->psm) {
    case POCKET_WII_PSM_5650:
    case POCKET_WII_PSM_4444:
      bytes_per_pixel = 2;
      if (source->palette != NULL || source->palette_len != 0) return false;
      break;
    case POCKET_WII_PSM_8888:
      bytes_per_pixel = 4;
      if (source->palette != NULL || source->palette_len != 0) return false;
      break;
    case POCKET_WII_PSM_T8:
      bytes_per_pixel = 1;
      if (source->palette == NULL || source->palette_len != POCKET_WII_TEXTURE_PALETTE_BYTES) return false;
      break;
    default:
      return false;
  }

  size_t width = source->width;
  size_t height = source->height;
  size_t pixel_count = width * height;
  /* The contract caps both dimensions at 512, so this fits even 32-bit size_t. */
  return source->pixels_len == pixel_count * bytes_per_pixel;
}

bool pocket_wii_texture_source_for_handle(
  int32_t handle,
  PocketWiiTextureSource *out
) {
  if (handle < 0 || out == NULL) return false;

  uint32_t slot = (uint32_t)handle & ui_texture_slot_mask();
  if ((size_t)slot >= ui_texture_slot_count()) return false;

  PocketWiiTextureSource source = {0};
  if (!ui_texture_at(slot, &source) || source.handle != handle || !texture_source_valid(&source)) {
    return false;
  }
  *out = source;
  return true;
}

bool pocket_wii_texture_source_rgba(
  const PocketWiiTextureSource *source,
  uint32_t x,
  uint32_t y,
  uint8_t rgba[4]
) {
  if (rgba == NULL || !texture_source_valid(source) || x >= source->width || y >= source->height) {
    return false;
  }

  size_t index = (size_t)y * source->width + x;
  uint8_t decoded[4];
  switch (source->psm) {
    case POCKET_WII_PSM_5650: {
      uint32_t pixel = (uint32_t)source->pixels[index * 2] |
                       ((uint32_t)source->pixels[index * 2 + 1] << 8);
      uint32_t red = pixel & 0x1fu;
      uint32_t green = (pixel >> 5) & 0x3fu;
      uint32_t blue = (pixel >> 11) & 0x1fu;
      decoded[0] = (uint8_t)((red << 3) | (red >> 2));
      decoded[1] = (uint8_t)((green << 2) | (green >> 4));
      decoded[2] = (uint8_t)((blue << 3) | (blue >> 2));
      decoded[3] = 255;
      break;
    }
    case POCKET_WII_PSM_4444: {
      uint32_t pixel = (uint32_t)source->pixels[index * 2] |
                       ((uint32_t)source->pixels[index * 2 + 1] << 8);
      decoded[0] = (uint8_t)((pixel & 0x0fu) * 17u);
      decoded[1] = (uint8_t)(((pixel >> 4) & 0x0fu) * 17u);
      decoded[2] = (uint8_t)(((pixel >> 8) & 0x0fu) * 17u);
      decoded[3] = (uint8_t)(((pixel >> 12) & 0x0fu) * 17u);
      break;
    }
    case POCKET_WII_PSM_8888:
      memcpy(decoded, source->pixels + index * 4, sizeof decoded);
      break;
    case POCKET_WII_PSM_T8:
      memcpy(decoded, source->palette + (size_t)source->pixels[index] * 4, sizeof decoded);
      break;
    default:
      return false;
  }

  memcpy(rgba, decoded, sizeof decoded);
  return true;
}
