/* PICA200 texture storage mechanisms shared by PocketJS and Atlas.
 * Caller owns tiled layout, sampling, binding and GPU completion. No function
 * waits for the GPU. Retire all queued/context references before destruction.
 */
#ifndef POCKET_PICA_H
#define POCKET_PICA_H
#include <citro3d.h>
#include <stdbool.h>
#include <stddef.h>
#include <string.h>

/* Only linear-memory 2D textures: CPU upload to VRAM needs a separate transfer
 * mechanism. `levels` includes the base level; each mip must remain >= 8x8.
 * `texture` must be zero initialized and not own an allocation. */
static inline bool pocket_pica_texture_init(C3D_Tex *texture, unsigned width,
    unsigned height, unsigned levels, GPU_TEXCOLOR format, size_t bytes) {
  if (!texture || texture->data || width < 8 || height < 8 || width > 1024 ||
      height > 1024 || (width & (width-1)) || (height & (height-1)) ||
      !levels || levels > 8 || (width >> (levels-1)) < 8 ||
      (height >> (levels-1)) < 8 || !bytes) return false;
  C3D_TexInitParams params = {width, height, levels-1, format, GPU_TEX_2D, false};
  if (!C3D_TexInitWithParams(texture, NULL, params)) {
    memset(texture, 0, sizeof *texture);
    return false;
  }
  if ((size_t)C3D_TexCalcTotalSize(texture->size, texture->maxLevel) != bytes) {
    C3D_TexDelete(texture);
    memset(texture, 0, sizeof *texture);
    return false;
  }
  return true;
}

/* After writing the full tiled payload directly into texture->data. */
static inline bool pocket_pica_texture_publish(C3D_Tex *texture, size_t bytes) {
  if (!texture || !texture->data || !bytes ||
      (size_t)C3D_TexCalcTotalSize(texture->size, texture->maxLevel) != bytes)
    return false;
  C3D_TexFlush(texture); /* flush every mip, not just the base level */
  return true;
}

static inline bool pocket_pica_texture_upload(C3D_Tex *texture,
    const void *tiled, size_t bytes) {
  if (!tiled || !texture || !texture->data || !bytes ||
      (size_t)C3D_TexCalcTotalSize(texture->size, texture->maxLevel) != bytes)
    return false;
  memcpy(texture->data, tiled, bytes);
  return pocket_pica_texture_publish(texture, bytes);
}

/* Caller has unbound and retired GPU references, including citro3d's cached
 * context. Zeroing permits repeated cleanup on partial-load failure. */
static inline void pocket_pica_texture_destroy(C3D_Tex *texture) {
  if (!texture) return;
  if (texture->data) C3D_TexDelete(texture);
  memset(texture, 0, sizeof *texture);
}
#endif
