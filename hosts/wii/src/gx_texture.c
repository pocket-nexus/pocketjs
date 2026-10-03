#include "gx_texture.h"

#include "texture_source.h"

#include <malloc.h>
#include <ogc/cache.h>
#include <stdlib.h>
#include <string.h>

extern uint32_t ui_texture_slot_mask(void);

typedef struct {
  int32_t handle;
  uint64_t revision;
  uint32_t width;
  uint32_t height;
  uint32_t psm;
  uint32_t linear;
  size_t image_size;
  uint8_t *image;
  GXTexObj object;
} CacheEntry;

/* ponytail: freed-slot images stay until slot reuse or shutdown; sweep free
 * core slots if retained peak memory becomes material. */
static CacheEntry *cache;
static size_t cache_count;

static bool cache_grow(size_t slot) {
  if (slot < cache_count) return true;

  size_t count = cache_count == 0 ? 4 : cache_count;
  while (count <= slot) {
    if (count > SIZE_MAX / 2) return false;
    count *= 2;
  }
  if (count > SIZE_MAX / sizeof(*cache)) return false;

  CacheEntry *grown = realloc(cache, count * sizeof(*cache));
  if (grown == NULL) return false;
  memset(grown + cache_count, 0, (count - cache_count) * sizeof(*cache));
  for (size_t i = cache_count; i < count; i++) grown[i].handle = -1;
  cache = grown;
  cache_count = count;
  return true;
}

static bool image_size_for(uint32_t width, uint32_t height, size_t *out) {
  if (width == 0 || height == 0) return false;
  size_t tiles_x = ((size_t)width + 3) / 4;
  size_t tiles_y = ((size_t)height + 3) / 4;
  if (tiles_x > SIZE_MAX / tiles_y || tiles_x * tiles_y > SIZE_MAX / 64) {
    return false;
  }
  *out = tiles_x * tiles_y * 64;
  return true;
}

static bool convert_rgba8_tiles(
  const PocketWiiTextureSource *source,
  uint8_t *image
) {
  size_t tiles_x = ((size_t)source->width + 3) / 4;
  size_t tiles_y = ((size_t)source->height + 3) / 4;
  memset(image, 0, tiles_x * tiles_y * 64);

  for (uint32_t y = 0; y < source->height; y++) {
    for (uint32_t x = 0; x < source->width; x++) {
      uint8_t rgba[4];
      if (!pocket_wii_texture_source_rgba(source, x, y, rgba)) return false;

      size_t tile = ((size_t)(y / 4) * tiles_x + x / 4) * 64;
      size_t pixel = ((size_t)(y & 3) * 4 + (x & 3)) * 2;
      image[tile + pixel] = rgba[3];
      image[tile + pixel + 1] = rgba[0];
      image[tile + 32 + pixel] = rgba[1];
      image[tile + 32 + pixel + 1] = rgba[2];
    }
  }
  return true;
}

static void init_texture(CacheEntry *entry, const PocketWiiTextureSource *source) {
  GX_InitTexObj(&entry->object, entry->image, source->width, source->height,
                GX_TF_RGBA8, GX_CLAMP, GX_CLAMP, GX_FALSE);
  u8 filter = source->linear ? GX_LINEAR : GX_NEAR;
  GX_InitTexObjLOD(&entry->object, filter, filter, 0.0f, 0.0f, 0.0f,
                   GX_FALSE, GX_FALSE, GX_ANISO_1);
}

bool pocket_wii_gx_texture_for_handle(
  int32_t handle,
  PocketWiiGXTexture *out
) {
  if (out == NULL) return false;

  PocketWiiTextureSource source;
  if (!pocket_wii_texture_source_for_handle(handle, &source)) return false;

  size_t slot = (uint32_t)handle & ui_texture_slot_mask();
  if (!cache_grow(slot)) return false;

  CacheEntry *entry = &cache[slot];
  if (entry->handle == source.handle && entry->revision == source.revision &&
      entry->width == source.width && entry->height == source.height &&
      entry->psm == source.psm && entry->linear == source.linear) {
    *out = (PocketWiiGXTexture){entry->object, entry->width, entry->height, entry->linear};
    return true;
  }

  size_t image_size;
  if (!image_size_for(source.width, source.height, &image_size) || image_size > UINT32_MAX) {
    return false;
  }

  /* GX may still be reading this slot's image from an earlier submitted draw. */
  if (entry->image != NULL) GX_DrawDone();

  uint8_t *image = entry->image;
  if (image == NULL || entry->image_size != image_size) {
    image = memalign(32, image_size);
    if (image == NULL) return false;
  }
  if (!convert_rgba8_tiles(&source, image)) {
    if (image != entry->image) free(image);
    return false;
  }
  DCFlushRange(image, (u32)image_size);
  GX_InvalidateTexAll();

  uint8_t *old_image = entry->image;
  entry->image = image;
  entry->image_size = image_size;
  entry->handle = source.handle;
  entry->revision = source.revision;
  entry->width = source.width;
  entry->height = source.height;
  entry->psm = source.psm;
  entry->linear = source.linear;
  init_texture(entry, &source);
  if (old_image != image) free(old_image);

  *out = (PocketWiiGXTexture){entry->object, entry->width, entry->height, entry->linear};
  return true;
}

void pocket_wii_gx_texture_cache_clear(void) {
  bool has_images = false;
  for (size_t i = 0; i < cache_count; i++) {
    if (cache[i].image != NULL) {
      has_images = true;
      break;
    }
  }
  if (has_images) GX_DrawDone();
  for (size_t i = 0; i < cache_count; i++) free(cache[i].image);
  free(cache);
  cache = NULL;
  cache_count = 0;
}
