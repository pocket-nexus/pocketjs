#ifndef POCKET_WII_DRAWLIST_H
#define POCKET_WII_DRAWLIST_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

enum PocketWiiDrawOp {
  POCKET_WII_DRAW_RECT = 1,
  POCKET_WII_DRAW_GRAD_RECT = 2,
  POCKET_WII_DRAW_GLYPH_RUN = 3,
  POCKET_WII_DRAW_TEX_QUAD = 4,
  POCKET_WII_DRAW_SCISSOR = 5,
  POCKET_WII_DRAW_SCISSOR_POP = 6,
  POCKET_WII_DRAW_TRI = 7,
  POCKET_WII_DRAW_TEX_TRI = 8,
  POCKET_WII_DRAW_TEXT_RUN = 9,
  POCKET_WII_DRAW_SURFACE_QUAD = 10,
};

typedef enum {
  POCKET_WII_DRAWLIST_OK = 0,
  POCKET_WII_DRAWLIST_INVALID_ARGUMENT,
  POCKET_WII_DRAWLIST_TRUNCATED,
  POCKET_WII_DRAWLIST_MALFORMED,
  POCKET_WII_DRAWLIST_UNSUPPORTED_OP,
  POCKET_WII_DRAWLIST_CALLBACK_FAILED,
} PocketWiiDrawListResult;

/* `op` points to the native uint32_t opcode word; `word_count` includes it. */
typedef bool (*PocketWiiDrawOpCallback)(
  const uint32_t *op,
  size_t word_count,
  void *context
);

/* Walk native DrawList words without byte-swapping them. A NULL callback
 * validates the list without dispatching ops. */
PocketWiiDrawListResult pocket_wii_drawlist_walk(
  const uint32_t *words,
  size_t word_count,
  PocketWiiDrawOpCallback callback,
  void *context
);

#endif
