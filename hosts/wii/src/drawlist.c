#include "drawlist.h"

static bool fixed_length(uint32_t op, size_t *length) {
  switch (op) {
    case POCKET_WII_DRAW_RECT: *length = 4; return true;
    case POCKET_WII_DRAW_GRAD_RECT: *length = 6; return true;
    case POCKET_WII_DRAW_TEX_QUAD: *length = 9; return true;
    case POCKET_WII_DRAW_SCISSOR: *length = 3; return true;
    case POCKET_WII_DRAW_SCISSOR_POP: *length = 1; return true;
    case POCKET_WII_DRAW_TRI: *length = 7; return true;
    case POCKET_WII_DRAW_TEX_TRI: *length = 12; return true;
    default: return false;
  }
}

PocketWiiDrawListResult pocket_wii_drawlist_walk(
  const uint32_t *words,
  size_t word_count,
  PocketWiiDrawOpCallback callback,
  void *context
) {
  if (words == NULL && word_count != 0) return POCKET_WII_DRAWLIST_INVALID_ARGUMENT;

  for (size_t offset = 0; offset < word_count;) {
    size_t available = word_count - offset;
    const uint32_t *op = words + offset;
    size_t length;

    if (fixed_length(op[0], &length)) {
      if (available < length) return POCKET_WII_DRAWLIST_TRUNCATED;
    } else if (op[0] == POCKET_WII_DRAW_GLYPH_RUN) {
      if (available < 2) return POCKET_WII_DRAWLIST_TRUNCATED;
      uint32_t header = op[1];
      size_t glyph_count = header >> 16;
      if ((header & 0x0000ff00u) != 0) return POCKET_WII_DRAWLIST_MALFORMED;
      if (available < 3) return POCKET_WII_DRAWLIST_TRUNCATED;
      if (glyph_count > (available - 3) / 2) return POCKET_WII_DRAWLIST_TRUNCATED;
      length = 3 + glyph_count * 2;
      for (size_t glyph = 0; glyph < glyph_count; glyph += 1) {
        if ((op[4 + glyph * 2] & 0xffff0000u) != 0) {
          return POCKET_WII_DRAWLIST_MALFORMED;
        }
      }
    } else {
      /* TEXT_RUN and SURFACE_QUAD are outside wii-dev; reject all other codes. */
      return POCKET_WII_DRAWLIST_UNSUPPORTED_OP;
    }

    if (callback != NULL && !callback(op, length, context)) {
      return POCKET_WII_DRAWLIST_CALLBACK_FAILED;
    }
    offset += length;
  }

  return POCKET_WII_DRAWLIST_OK;
}
