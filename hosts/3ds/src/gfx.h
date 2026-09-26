#ifndef POCKETJS_3DS_GFX_H
#define POCKETJS_3DS_GFX_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/*
 * The PICA200 DrawList backend. gfx_init builds the shader, the attribute
 * layout and the linear-memory vertex arena once. A frame begins once, then
 * every output is prepared into the shared arena before either is drawn.
 *
 * begin/prepare/finish must run after C3D_FrameBegin has retired the previous
 * arena use. gfx_draw_surface runs after C3D_FrameDrawOn/SetViewport for its
 * target and before C3D_FrameEnd.
 */
bool gfx_init(uint32_t logical_width, uint32_t logical_height);
/* Pre-tiled RGB565 storage for a GPU-owned image descriptor. */
bool gfx_stage_image(int32_t handle, const uint8_t *bytes, unsigned width, unsigned height);
void gfx_begin_frame(void);
bool gfx_prepare_surface(
  uint32_t surface,
  const uint32_t *words,
  size_t length,
  uint32_t logical_width,
  uint32_t logical_height
);
void gfx_finish_frame(void);
void gfx_draw_surface(uint32_t surface);
/* Retire every guest-owned image/font texture at a GPU-idle frame boundary.
 * Shader, white texture and vertex arena remain process-owned. */
void gfx_reset_resources(void);
void gfx_shutdown(void);

/* Vertices dropped because the frame overflowed the arena, cumulative. Zero
 * on every frame a real app draws; non-zero means geometry is missing. */
uint32_t gfx_dropped_vertices(void);

/* The batch and vertex counts of the most recently built frame. */
uint32_t gfx_frame_commands(void);
uint32_t gfx_frame_vertices(void);

#endif
