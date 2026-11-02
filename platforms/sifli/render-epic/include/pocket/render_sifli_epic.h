#pragma once
#include <stdbool.h>
#include "pocket_drivers.h"
/* newlib may expose a legacy `quad` macro before this header. */
#ifdef quad
#undef quad
#endif
#ifdef __cplusplus
extern "C" {
#endif
/* Device-specific translation seam between the EPIC renderer and the SiFli
 * executor. The renderer plans every command against pocket_epic_caps and
 * never submits one the capabilities exclude; an executor that rejects a
 * command anyway fails the frame. Rectangles and points are physical pixels
 * of the target bound by begin. Commands run in submission order; fence and
 * end return after every submitted command completed. */

/* pocket_epic_caps.flags */
#define POCKET_EPIC_FILL_OPAQUE (1u << 0)
#define POCKET_EPIC_FILL_ALPHA (1u << 1)
#define POCKET_EPIC_A8_BLEND (1u << 2)
#define POCKET_EPIC_GRADIENT (1u << 3)
/* Axis-aligned blits of registered textures. */
#define POCKET_EPIC_BLIT (1u << 4)
/* Four-point blits of registered textures and solid colors. */
#define POCKET_EPIC_BLIT_QUAD (1u << 5)
/* Blits apply the RGB of the modulate color. */
#define POCKET_EPIC_BLIT_MODULATE (1u << 6)
/* register_texture accepts POCKET_EPIC_TEXTURE_PORTABLE layouts. */
#define POCKET_EPIC_PORTABLE_TEXTURES (1u << 7)
/* Axis-aligned blits honor POCKET_EPIC_MIRROR_Y. */
#define POCKET_EPIC_BLIT_MIRROR_Y (1u << 8)
/* Native rotated/scaled rectangles, subject to can_blit_rotate preflight. */
#define POCKET_EPIC_BLIT_ROTATE (1u << 9)

typedef struct {
  size_t struct_size;
  uint32_t flags;
  /* Largest extent per axis one transaction addresses. */
  uint32_t coordinate_limit;
  /* Bytes of each of the two A8 planes; RGB565 pixels of each of the two
   * fallback tiles. */
  size_t mask_bytes, tile_pixels;
  /* Physical pixels below which an operation stays on the CPU. */
  uint32_t min_fill, min_gradient, min_blend, min_blit;
} pocket_epic_caps;

#define POCKET_EPIC_OP_FILL 1u
#define POCKET_EPIC_OP_FILL_ALPHA 2u
#define POCKET_EPIC_OP_BLEND_A8 3u
#define POCKET_EPIC_OP_GRADIENT 4u
#define POCKET_EPIC_OP_BLIT 5u
#define POCKET_EPIC_OP_BLIT_QUAD 6u
#define POCKET_EPIC_OP_TILE_OUT 7u
#define POCKET_EPIC_OP_TILE_IN 8u
#define POCKET_EPIC_OP_FENCE 9u
#define POCKET_EPIC_OP_BLIT_ROTATE 10u

#define POCKET_EPIC_MIRROR_X (1u << 0)
#define POCKET_EPIC_MIRROR_Y (1u << 1)
#define POCKET_EPIC_LINEAR (1u << 2)

#define POCKET_EPIC_SOURCE_TEXTURE 1u
#define POCKET_EPIC_SOURCE_SOLID 2u

typedef struct {
  uint32_t x, y, w, h;
} pocket_epic_rect;

typedef struct {
  int32_t x, y;
} pocket_epic_point;

/* Colors are ABGR words as the DrawList stores them. FILL and FILL_ALPHA
 * write `color` over dst; BLEND_A8 blends `color` through the A8 window that
 * starts at byte `mask_offset` of plane `mask`, rows `mask_stride` bytes
 * apart, its alpha byte scaling every coverage byte; GRADIENT interpolates
 * `corners` (top left, top right, bottom left, bottom right) over dst. BLIT
 * scales src texels onto dst and writes only inside `clip`; BLIT_QUAD maps
 * the edges of src onto `quad` (top left, bottom left, bottom right, top
 * right) inside `clip`; the alpha byte of `color` scales both, and its RGB
 * multiplies the texels when the capabilities include
 * POCKET_EPIC_BLIT_MODULATE. TILE_OUT copies target pixels of `clip`
 * into tile `tile`, packed; TILE_IN copies the packed tile back over dst.
 * BLIT_ROTATE uses the same fields as BLIT_QUAD, for native textures only.
 * Its quantized rotation/uniform scale must pass can_blit_rotate before
 * submission; it is not a general affine/projective quad capability. */
typedef struct {
  uint32_t op, flags;
  pocket_epic_rect dst, clip, src;
  pocket_epic_point quad[4];
  uint32_t color;
  uint32_t corners[4];
  uint32_t source;  /* POCKET_EPIC_SOURCE_* */
  uint32_t texture; /* registered texture id, or the solid ABGR color */
  uint32_t mask, mask_offset, mask_stride;
  uint32_t tile;
} pocket_epic_cmd;

#define POCKET_EPIC_TEXTURE_NATIVE 0u
#define POCKET_EPIC_TEXTURE_PORTABLE 1u
/* Native formats, EPIC channel order. L8 carries a 1024-byte BGRA palette. */
#define POCKET_EPIC_RGB565 0u
#define POCKET_EPIC_BGRA8888 1u
#define POCKET_EPIC_L8 2u

/* Portable textures keep the PocketJS PSM code in `format`; PSM_T8 carries
 * a 1024-byte RGBA palette. Registration cleans the storage from the CPU
 * cache and reads nothing after it returns; a command that references the
 * id reads the storage when it executes, and the renderer keeps it valid and
 * unchanged until that command completed. */
typedef struct {
  size_t struct_size;
  uint32_t kind, format;
  uint32_t width, height;
  const uint8_t *pixels;
  size_t pixel_bytes;
  const uint8_t *palette;
} pocket_epic_texture;

/* Every callback returns POCKET_STATUS_*. begin waits for earlier work, then
 * binds the framebuffer a display named with its device handle and checks
 * its size. Submitted commands may stay in flight after submit returns;
 * fence, begin and end return after they completed, and end releases the
 * target. mask and tile return CPU-writable SRAM; the renderer
 * fences before rewriting storage a submitted command reads.
 * register_texture returns UNSUPPORTED for a layout or alignment the engines
 * cannot read, and the renderer draws that texture on the CPU. */
typedef struct {
  size_t struct_size;
  void *context;
  int32_t (*caps)(void *, pocket_epic_caps *);
  int32_t (*begin)(void *, uint64_t target, uint32_t width, uint32_t height);
  int32_t (*submit)(void *, const pocket_epic_cmd *, size_t);
  int32_t (*fence)(void *);
  int32_t (*end)(void *);
  uint8_t *(*mask)(void *, uint32_t plane, size_t *length);
  uint16_t *(*tile)(void *, uint32_t tile, size_t *length);
  int32_t (*register_texture)(void *, const pocket_epic_texture *, uint32_t *id);
  void (*release_texture)(void *, uint32_t id);
  /* Read-only preflight for BLIT_ROTATE. OK means this exact command can
   * run; UNSUPPORTED means the renderer must replay it on the CPU. */
  int32_t (*can_blit_rotate)(void *, const pocket_epic_cmd *);
} pocket_epic_ops;

typedef struct {
  size_t struct_size;
  /* Physical pixels per logical pixel, 1 through 4. */
  uint32_t scale;
  /* Optional native texture table baked by tools/build/sifli/epic.ts, 64-byte
   * aligned. The renderer matches its entries to package textures by source
   * digest; the storage outlives the renderer. */
  const uint8_t *native_textures;
  size_t native_texture_bytes;
  /* Textures registered with the executor at once. */
  uint32_t max_textures;
} pocket_epic_config;

typedef struct pocket_render_sifli_epic pocket_render_sifli_epic;
/* Config/ops are copied. The ops context must outlive this renderer. Call
 * destroy only after runtime destruction/unregistration. */
pocket_render_sifli_epic *pocket_render_sifli_epic_create(const pocket_epic_config *,
                                                          const pocket_epic_ops *);
const pocket_renderer_v1 *pocket_render_sifli_epic_vtable(void);
void pocket_render_sifli_epic_destroy(pocket_render_sifli_epic *);
#ifdef __cplusplus
}
#endif
