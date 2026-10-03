#ifndef POCKET_WII_GX_TEXTURED_MOCK_H
#define POCKET_WII_GX_TEXTURED_MOCK_H

#include <stddef.h>
#include "ogc/gx.h"

typedef struct {
  float x, y, u, v;
  u8 r, g, b, a;
} MockGXVertex;

typedef struct {
  size_t first_vertex;
  u16 vertex_count;
  GXTexObj texture;
} MockGXDraw;

typedef struct {
  MockGXVertex vertices[24];
  MockGXDraw draws[8];
  size_t vertex_count;
  size_t draw_count;
  size_t begin_vertex;
  u16 expected_vertices;
  GXTexObj loaded_texture;
  u8 tex0_descriptor;
  u32 texgen_count;
  u8 tev_coordinate;
  u32 tev_map;
  u8 tev_color;
  u8 tev_op;
  unsigned texture_init_count;
  unsigned texture_lod_count;
  unsigned flush_count;
  void *flush_pointer;
  u32 flush_length;
  u32 position_format;
  u32 texcoord_format;
} MockGX;

extern MockGX mock_gx;
void mock_gx_reset_draws(void);

#endif
