#ifndef POCKET_WII_GX_FONT_H
#define POCKET_WII_GX_FONT_H

#include "gx_solid.h"
#include "drawlist.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
  const uint8_t *coverage;
  size_t coverage_len;
  uint32_t cell_width;
  uint32_t cell_height;
  uint32_t coverage_width;
  uint32_t coverage_height;
  uint32_t glyph_count;
} PocketWiiFontAtlas;

/* Draw one GLYPH_RUN without changing the caller's GX scissor. */
bool pocket_wii_gx_font_op(
  const PocketWiiGXContext *context,
  const uint32_t *op,
  size_t word_count
);

/* Release font texture storage during PocketJS shutdown. */
void pocket_wii_gx_font_cache_clear(void);

#endif
