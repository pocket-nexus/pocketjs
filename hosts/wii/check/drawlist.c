/*
 * From the repository root, run:
 * cc -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined \
 *   -fno-omit-frame-pointer -Ihosts/wii/src hosts/wii/src/drawlist.c \
 *   hosts/wii/check/drawlist.c -o /tmp/wii-drawlist-check && \
 *   ASAN_OPTIONS=detect_leaks=0 /tmp/wii-drawlist-check
 */
#include "drawlist.h"

#include <assert.h>
#include <stdlib.h>

typedef struct {
  size_t index;
  const uint32_t *ops;
  const size_t *lengths;
} Expected;

static bool check_op(const uint32_t *op, size_t word_count, void *context) {
  Expected *expected = context;
  assert(op[0] == expected->ops[expected->index]);
  assert(word_count == expected->lengths[expected->index]);
  expected->index += 1;
  return true;
}

static bool stop_at_first_op(const uint32_t *op, size_t word_count, void *context) {
  (void)op;
  (void)word_count;
  (void)context;
  return false;
}

int main(void) {
  static const uint32_t words[] = {
    1, 0x00020001u, 0x00040003u, 0xaabbccddu,                         /* RECT */
    7, 0, 1, 2, 3, 4, 5,                                             /* TRI */
    2, 0, 0, 0x11223344u, 0x55667788u, 3,                            /* GRAD_RECT */
    5, 0, 0,                                                         /* SCISSOR */
    6,                                                               /* SCISSOR_POP */
    4, 9, 0, 0, 0, 0, 0x3f800000u, 0x3f800000u, 0xffffffffu,        /* TEX_QUAD */
    8, 9, 0, 0, 0, 0, 0, 0, 0, 0x3f800000u, 0x3f800000u, 0xffffffffu, /* TEX_TRI */
    3, 0x00020001u, 0xff000000u, 0x00020001u, 0x0000002au,
       0x00040003u, 0x0000002bu,                                     /* GLYPH_RUN */
  };
  static const uint32_t expected_ops[] = { 1, 7, 2, 5, 6, 4, 8, 3 };
  static const size_t expected_lengths[] = { 4, 7, 6, 3, 1, 9, 12, 7 };
  Expected expected = { 0, expected_ops, expected_lengths };

  assert(pocket_wii_drawlist_walk(words, sizeof words / sizeof words[0], check_op, &expected) == POCKET_WII_DRAWLIST_OK);
  assert(expected.index == sizeof expected_ops / sizeof expected_ops[0]);
  assert(pocket_wii_drawlist_walk(NULL, 0, NULL, NULL) == POCKET_WII_DRAWLIST_OK);
  assert(pocket_wii_drawlist_walk(NULL, 1, NULL, NULL) == POCKET_WII_DRAWLIST_INVALID_ARGUMENT);
  assert(pocket_wii_drawlist_walk(words, sizeof words / sizeof words[0], stop_at_first_op, NULL) == POCKET_WII_DRAWLIST_CALLBACK_FAILED);

  static const uint32_t fixed_ops[] = { 1, 2, 4, 5, 7, 8 };
  static const size_t fixed_lengths[] = { 4, 6, 9, 3, 7, 12 };
  for (size_t i = 0; i < sizeof fixed_ops / sizeof fixed_ops[0]; i += 1) {
    size_t short_length = fixed_lengths[i] - 1;
    uint32_t *short_op = calloc(short_length, sizeof *short_op);
    assert(short_op != NULL);
    short_op[0] = fixed_ops[i];
    assert(pocket_wii_drawlist_walk(short_op, short_length, NULL, NULL) == POCKET_WII_DRAWLIST_TRUNCATED);
    free(short_op);
  }

  uint32_t *short_glyph = malloc(sizeof *short_glyph);
  assert(short_glyph != NULL);
  short_glyph[0] = 3;
  assert(pocket_wii_drawlist_walk(short_glyph, 1, NULL, NULL) == POCKET_WII_DRAWLIST_TRUNCATED);
  free(short_glyph);

  uint32_t *glyph_prefix = malloc(2 * sizeof *glyph_prefix);
  assert(glyph_prefix != NULL);
  glyph_prefix[0] = 3;
  glyph_prefix[1] = 1u << 16;
  assert(pocket_wii_drawlist_walk(glyph_prefix, 2, NULL, NULL) == POCKET_WII_DRAWLIST_TRUNCATED);
  free(glyph_prefix);

  uint32_t glyph_count_overflow[] = { 3, 0xffff0000u, 0 };
  assert(pocket_wii_drawlist_walk(glyph_count_overflow, 3, NULL, NULL) == POCKET_WII_DRAWLIST_TRUNCATED);
  uint32_t glyph_reserved_header[] = { 3, 0x00000100u, 0 };
  assert(pocket_wii_drawlist_walk(glyph_reserved_header, 3, NULL, NULL) == POCKET_WII_DRAWLIST_MALFORMED);
  uint32_t glyph_reserved_id[] = { 3, 1u << 16, 0, 0, 0x00010001u };
  assert(pocket_wii_drawlist_walk(glyph_reserved_id, 5, NULL, NULL) == POCKET_WII_DRAWLIST_MALFORMED);

  uint32_t unsupported[] = { 0xffffffffu };
  assert(pocket_wii_drawlist_walk(unsupported, 1, NULL, NULL) == POCKET_WII_DRAWLIST_UNSUPPORTED_OP);
  uint32_t text_run[] = { 9 };
  assert(pocket_wii_drawlist_walk(text_run, 1, NULL, NULL) == POCKET_WII_DRAWLIST_UNSUPPORTED_OP);
  uint32_t surface_quad[] = { 10 };
  assert(pocket_wii_drawlist_walk(surface_quad, 1, NULL, NULL) == POCKET_WII_DRAWLIST_UNSUPPORTED_OP);
  return 0;
}
