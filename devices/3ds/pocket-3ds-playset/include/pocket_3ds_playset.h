/* PICA200 renderer for pocket-playset frames (engine/crates/pocket-playset).
 *
 * The host owns citro3d, the render targets and the frame boundary. Call
 * p3ps_render inside an open frame on a target whose colour and depth were
 * cleared (depth to 0); it draws the sky, the scene's draws in frame order and
 * leaves depth testing on, so whatever the host draws next must set its own
 * depth, cull, blend, attribute and buffer state. */
#ifndef POCKET_3DS_PLAYSET_H
#define POCKET_3DS_PLAYSET_H

#include <citro3d.h>
#include <pocket_playset.h>
#include <stdbool.h>
#include <stddef.h>

typedef struct p3ps_renderer p3ps_renderer;

typedef struct {
  uint32_t draws;
  uint32_t bones;
  uint32_t uploads;
  uint32_t dyn_vertices;
  uint32_t tris;
} p3ps_stats;

/* `shader` is the assembled playset.v.pica. */
p3ps_renderer *p3ps_create(const void *shader, size_t shader_size);
/* Frees every GPU copy. The GPU must be idle. */
void p3ps_destroy(p3ps_renderer *r);
/* Drops the copies of one playset's models and batches (the playset is being
 * destroyed). The GPU must be idle. */
void p3ps_forget(p3ps_renderer *r);
/* Prepares `ps` for `aspect` and draws it into `target` (and `right`, the
 * right eye, when non-null, offset by `iod`). */
bool p3ps_render(p3ps_renderer *r, pps *ps, C3D_RenderTarget *target,
                 C3D_RenderTarget *right, float iod, p3ps_stats *stats);

#endif
