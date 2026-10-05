#ifndef POCKET_WII_GX_DRAW_MOCK_STATE_H
#define POCKET_WII_GX_DRAW_MOCK_STATE_H

#include <stdbool.h>
#include <stddef.h>
#include <ogc/gx.h>

enum {
  MOCK_GX_HOST = 0,
  MOCK_GX_SOLID,
  MOCK_GX_TEXTURE,
  MOCK_GX_FONT,
};

typedef struct {
  int kind;
  u16 vertex_count;
  u32 scissor[4];
} MockGXDraw;

typedef struct {
  MockGXDraw draws[32];
  size_t draw_count;
  u16 expected_vertices;
  size_t vertices_in_draw;
  u8 tev_op;
  GXTexObj texture;
  u32 scissor[4];
  size_t scissor_count;
  unsigned texture_init_count;
  unsigned draw_done_count;
  unsigned invalidate_count;
  unsigned flush_count;
  bool host_next_draw;
} MockGX;

extern MockGX mock_gx;
void mock_gx_reset(void);
void mock_gx_host_draw(void);

#endif
