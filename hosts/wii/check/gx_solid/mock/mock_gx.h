#ifndef POCKET_WII_GX_SOLID_MOCK_STATE_H
#define POCKET_WII_GX_SOLID_MOCK_STATE_H

#include <stdint.h>

typedef struct {
  float x, y;
  uint8_t r, g, b, a;
} MockVertex;

typedef struct {
  uint32_t x, y, width, height;
} MockScissor;

typedef struct {
  float x, y, width, height;
  float top, bottom, left, right;
  uint8_t blend_type, source_factor, destination_factor;
  uint8_t alpha_compare0, alpha_reference0, alpha_operation;
  uint8_t alpha_compare1, alpha_reference1;
  unsigned int alpha_compare_calls;
  uint8_t primitive;
  unsigned int expected_vertices;
  unsigned int begin_vertex;
  unsigned int vertex_count;
  MockVertex vertices[64];
  unsigned int draw_count;
  unsigned int draws[16];
  MockScissor scissor;
  unsigned int scissor_count;
  MockScissor scissors[128];
  MockScissor draw_scissors[16];
} MockGX;

extern MockGX mock_gx;

#endif
