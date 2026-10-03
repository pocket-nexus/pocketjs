#ifndef POCKET_WII_GX_TEXTURE_H
#define POCKET_WII_GX_TEXTURE_H

#include <stdbool.h>
#include <stdint.h>

#include <ogc/gx.h>

typedef struct {
  GXTexObj object;
  uint32_t width;
  uint32_t height;
  uint32_t linear;
} PocketWiiGXTexture;

/* Resolve, upload, and return the current GX object for a live texture handle. */
bool pocket_wii_gx_texture_for_handle(
  int32_t handle,
  PocketWiiGXTexture *out
);

/* Release the texture cache during PocketJS shutdown. */
void pocket_wii_gx_texture_cache_clear(void);

#endif
