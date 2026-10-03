#ifndef POCKET_WII_TEXTURE_SOURCE_H
#define POCKET_WII_TEXTURE_SOURCE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* contracts/spec/spec.ts PSM values and texture limits. */
enum {
  POCKET_WII_PSM_5650 = 0,
  POCKET_WII_PSM_4444 = 2,
  POCKET_WII_PSM_8888 = 3,
  POCKET_WII_PSM_T8 = 5,
  POCKET_WII_TEXTURE_MAX_DIM = 512,
  POCKET_WII_TEXTURE_PALETTE_BYTES = 1024,
};

/* Mirrors the Wii core's #[repr(C)] PocketTexture. Its pixel and palette
 * pointers borrow the current registry entry; consume or copy them before
 * mutating, drawing, initializing, or shutting down the core UI. */
typedef struct {
  const uint8_t *pixels;
  size_t pixels_len;
  const uint8_t *palette;
  size_t palette_len;
  uint32_t width;
  uint32_t height;
  uint32_t psm;
  uint32_t linear;
  int32_t handle;
  uint64_t revision;
} PocketWiiTextureSource;

/* Resolve a generation-tagged handle through the core texture registry. */
bool pocket_wii_texture_source_for_handle(
  int32_t handle,
  PocketWiiTextureSource *out
);

/* Decode one in-bounds texel into RGBA bytes. */
bool pocket_wii_texture_source_rgba(
  const PocketWiiTextureSource *source,
  uint32_t x,
  uint32_t y,
  uint8_t rgba[4]
);

#endif
