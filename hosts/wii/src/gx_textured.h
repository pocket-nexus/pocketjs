#ifndef POCKET_WII_GX_TEXTURED_H
#define POCKET_WII_GX_TEXTURED_H

#include "gx_solid.h"

/*
 * Draw one TEX_QUAD or TEX_TRI op in the current caller-owned GX frame,
 * using the logical projection and viewport set by
 * pocket_wii_gx_context_begin.
 * Temporarily binds TEXMAP0 and modulates texture by vertex color, then
 * restores the solid pass's TEX0 descriptor and TEV state. The caller still
 * owns viewport, scissor, blend, and the rest of GX state.
 */
bool pocket_wii_gx_textured_op(
  PocketWiiGXContext *context,
  const uint32_t *op,
  size_t word_count
);

#endif
