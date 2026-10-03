#ifndef POCKET_WII_GX_SOLID_H
#define POCKET_WII_GX_SOLID_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* ponytail: cap nesting at 64; raise if valid guests emit deeper clips. */
#define POCKET_WII_GX_MAX_CLIP_DEPTH 64u

typedef struct {
  uint32_t x;
  uint32_t y;
  uint32_t width;
  uint32_t height;
} PocketWiiGXClip;

typedef struct {
  int32_t x;
  int32_t y;
  uint32_t width;
  uint32_t height;
  float scale_x;
  float scale_y;
  PocketWiiGXClip clip;
  PocketWiiGXClip clip_stack[POCKET_WII_GX_MAX_CLIP_DEPTH];
  uint32_t clip_depth;
} PocketWiiGXContext;

/* Set GX's viewport, projection, vertex-color state, and destination clip. */
bool pocket_wii_gx_context_begin(
  PocketWiiGXContext *context,
  int32_t x,
  int32_t y,
  uint32_t width,
  uint32_t height
);

/* Draw one supported solid op or apply one DrawList scissor op. */
bool pocket_wii_gx_solid_op(
  PocketWiiGXContext *context,
  const uint32_t *op,
  size_t word_count
);

#endif
