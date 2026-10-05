#include <assert.h>
#include <string.h>
#include <ogc/gx.h>
#include "drawlist.h"
#include "gx_solid.h"
#include "mock/mock_gx.h"

static bool dispatch_solid(const uint32_t *op, size_t length, void *context) {
  return pocket_wii_gx_solid_op(context, op, length);
}

static void expect_vertex(unsigned int index, float x, float y,
                          unsigned int r, unsigned int g,
                          unsigned int b, unsigned int a) {
  assert(mock_gx.vertices[index].x == x);
  assert(mock_gx.vertices[index].y == y);
  assert(mock_gx.vertices[index].r == r);
  assert(mock_gx.vertices[index].g == g);
  assert(mock_gx.vertices[index].b == b);
  assert(mock_gx.vertices[index].a == a);
}

static void expect_scissor(MockScissor actual, uint32_t x, uint32_t y,
                           uint32_t width, uint32_t height) {
  assert(actual.x == x && actual.y == y);
  assert(actual.width == width && actual.height == height);
}

int main(void) {
  static const uint32_t words[] = {
    1, 0x000a000au, 0x003c0050u, 0xff0000ffu,          /* red RECT */
    1, 0x0014001eu, 0x003c0050u, 0xff00ff00u,          /* green RECT */
    7, 0x0014001eu, 0x00140046u, 0x003c001eu,
       0xffff0000u, 0xffff0000u, 0xffff0000u,           /* blue TRI */
    1, 0x0014003cu, 0x0014001eu, 0x80ff0000u,           /* half-alpha blue */
    2, 0x0064000au, 0x00140028u, 0x80402010u, 0xffc0a080u, 0, /* ToTop */
    2, 0x0064000au, 0x00140028u, 0x80402010u, 0xffc0a080u, 1, /* ToBottom */
    2, 0x0064000au, 0x00140028u, 0x80402010u, 0xffc0a080u, 2, /* ToLeft */
    2, 0x0064000au, 0x00140028u, 0x80402010u, 0xffc0a080u, 3, /* ToRight */
  };
  static const float gradient_xy[6][2] = {
    { 45, 80 }, { 65, 80 }, { 65, 90 },
    { 45, 80 }, { 65, 90 }, { 45, 90 },
  };
  static const uint8_t gradient_rgba[4][6][4] = {
    { {128,160,192,255}, {128,160,192,255}, {16,32,64,128},
      {128,160,192,255}, {16,32,64,128}, {16,32,64,128} }, /* ToTop */
    { {16,32,64,128}, {16,32,64,128}, {128,160,192,255},
      {16,32,64,128}, {128,160,192,255}, {128,160,192,255} }, /* ToBottom */
    { {128,160,192,255}, {16,32,64,128}, {16,32,64,128},
      {128,160,192,255}, {16,32,64,128}, {128,160,192,255} }, /* ToLeft */
    { {16,32,64,128}, {128,160,192,255}, {128,160,192,255},
      {16,32,64,128}, {128,160,192,255}, {16,32,64,128} }, /* ToRight */
  };
  PocketWiiGXContext gx;
  GX_SetAlphaCompare(GX_NEVER, 0, GX_AOP_OR, GX_NEVER, 0);
  assert(mock_gx.alpha_compare0 == GX_NEVER &&
         mock_gx.alpha_operation == GX_AOP_OR &&
         mock_gx.alpha_compare1 == GX_NEVER);
  assert(pocket_wii_gx_context_begin(&gx, 40, 30, 240, 136));
  assert(mock_gx.alpha_compare_calls == 2);
  assert(mock_gx.alpha_compare0 == GX_ALWAYS && mock_gx.alpha_reference0 == 0 &&
         mock_gx.alpha_operation == GX_AOP_AND &&
         mock_gx.alpha_compare1 == GX_ALWAYS && mock_gx.alpha_reference1 == 0);
  assert(gx.x == 40 && gx.y == 30 && gx.width == 240 && gx.height == 136);
  assert(gx.scale_x == 0.5f && gx.scale_y == 0.5f);
  assert(mock_gx.x == 40 && mock_gx.y == 30);
  assert(mock_gx.width == 240 && mock_gx.height == 136);
  assert(mock_gx.top == 0 && mock_gx.bottom == 272);
  assert(mock_gx.left == 0 && mock_gx.right == 480);
  assert(mock_gx.blend_type == 1 && mock_gx.source_factor == 4 &&
         mock_gx.destination_factor == 5);

  assert(pocket_wii_drawlist_walk(words, sizeof words / sizeof words[0],
                                  dispatch_solid, &gx) == POCKET_WII_DRAWLIST_OK);
  assert(mock_gx.draw_count == 8);
  assert(mock_gx.scissor_count == 1);
  expect_scissor(mock_gx.scissors[0], 40, 30, 240, 136);
  assert(mock_gx.draws[0] == 0 && mock_gx.draws[1] == 6 &&
         mock_gx.draws[2] == 12 && mock_gx.draws[3] == 15 &&
         mock_gx.draws[4] == 21 && mock_gx.draws[5] == 27 &&
         mock_gx.draws[6] == 33 && mock_gx.draws[7] == 39);
  assert(mock_gx.vertex_count == 45);

  /* Logical RECT/triangle vertices mapped to destination pixel coordinates. */
  expect_vertex(0, 45, 35, 255, 0, 0, 255);
  expect_vertex(1, 85, 35, 255, 0, 0, 255);
  expect_vertex(6, 55, 40, 0, 255, 0, 255);
  expect_vertex(12, 55, 40, 0, 0, 255, 255);
  expect_vertex(13, 75, 40, 0, 0, 255, 255);
  expect_vertex(14, 55, 60, 0, 0, 255, 255);
  expect_vertex(15, 70, 40, 0, 0, 255, 128);

  /* Gradients use the contract's direction endpoints and preserve draw order. */
  for (unsigned int direction = 0; direction < 4; direction += 1) {
    for (unsigned int i = 0; i < 6; i += 1) {
      const uint8_t *rgba = gradient_rgba[direction][i];
      expect_vertex(21 + direction * 6 + i,
                    gradient_xy[i][0], gradient_xy[i][1],
                    rgba[0], rgba[1], rgba[2], rgba[3]);
    }
  }
  for (unsigned int i = 0; i < mock_gx.draw_count; i += 1) {
    expect_scissor(mock_gx.draw_scissors[i], 40, 30, 240, 136);
  }

  uint32_t unsupported[] = { 99 };
  uint32_t invalid_gradient[] = { 2, 0, 1, 0, 0, 4 };
  assert(!pocket_wii_gx_solid_op(&gx, unsupported, 6));
  assert(!pocket_wii_gx_solid_op(&gx, invalid_gradient, 6));
  assert(!pocket_wii_gx_solid_op(&gx, words + 19, 5));
  assert(!pocket_wii_gx_solid_op(&gx, words, 3));
  assert(!pocket_wii_gx_solid_op(NULL, words, 4));

  /* Half-scale destination mapping, nested intersection, and pop restoration. */
  static const uint32_t clips[] = {
    5, 0x00140014u, 0x006400c8u,                     /* outer: 50,40,100,50 */
    1, 0, 0x000a000au, 0xff0000ffu,
    5, 0x003c0064u, 0x006400c8u,                     /* inner: 90,60,60,30 */
    1, 0, 0x000a000au, 0xff0000ffu,
    6,                                                 /* restore outer */
    1, 0, 0x000a000au, 0xff0000ffu,
    5, 0x00f00190u, 0x000a000au,                     /* disjoint: empty */
    1, 0, 0x000a000au, 0xff0000ffu,
    6,                                                 /* restore outer */
    5, 0x00320064u, 0x00320000u,                     /* zero width: empty */
    1, 0, 0x000a000au, 0xff0000ffu,
    6,                                                 /* restore outer */
    6,                                                 /* restore destination */
    1, 0, 0x000a000au, 0xff0000ffu,
    5, 0xfff6ffecu, 0x001e0032u,                     /* negative logical origin */
    1, 0, 0x000a000au, 0xff0000ffu,
    6,
    5, 0x011801f4u, 0x00140032u,                     /* beyond logical surface */
    1, 0, 0x000a000au, 0xff0000ffu,
    6,
  };
  memset(&mock_gx, 0, sizeof mock_gx);
  assert(pocket_wii_gx_context_begin(&gx, 40, 30, 240, 136));
  assert(pocket_wii_drawlist_walk(clips, sizeof clips / sizeof clips[0],
                                  dispatch_solid, &gx) == POCKET_WII_DRAWLIST_OK);
  assert(mock_gx.draw_count == 8);
  assert(mock_gx.scissor_count == 13);
  expect_scissor(mock_gx.draw_scissors[0], 50, 40, 100, 50);
  expect_scissor(mock_gx.draw_scissors[1], 90, 60, 60, 30);
  expect_scissor(mock_gx.draw_scissors[2], 50, 40, 100, 50);
  expect_scissor(mock_gx.draw_scissors[3], 150, 90, 0, 0);
  expect_scissor(mock_gx.draw_scissors[4], 90, 55, 0, 25);
  expect_scissor(mock_gx.draw_scissors[5], 40, 30, 240, 136);
  expect_scissor(mock_gx.draw_scissors[6], 40, 30, 15, 10);
  expect_scissor(mock_gx.draw_scissors[7], 280, 166, 0, 0);
  expect_scissor(mock_gx.scissors[3], 50, 40, 100, 50);
  expect_scissor(mock_gx.scissors[4], 150, 90, 0, 0);
  expect_scissor(mock_gx.scissors[5], 50, 40, 100, 50);
  expect_scissor(mock_gx.scissors[6], 90, 55, 0, 25);
  expect_scissor(mock_gx.scissors[7], 50, 40, 100, 50);
  expect_scissor(mock_gx.scissors[8], 40, 30, 240, 136);
  expect_scissor(mock_gx.scissors[9], 40, 30, 15, 10);
  expect_scissor(mock_gx.scissors[10], 40, 30, 240, 136);
  expect_scissor(mock_gx.scissors[11], 280, 166, 0, 0);
  expect_scissor(mock_gx.scissors[12], 40, 30, 240, 136);

  uint32_t pop[] = { 6 };
  uint32_t push[] = { 5, 0, 0x011001e0u };
  assert(!pocket_wii_gx_solid_op(&gx, pop, 1)); /* malformed underflow */
  for (unsigned int i = 0; i < POCKET_WII_GX_MAX_CLIP_DEPTH; i += 1) {
    assert(pocket_wii_gx_solid_op(&gx, push, 3));
  }
  assert(!pocket_wii_gx_solid_op(&gx, push, 3)); /* bounded stack overflow */
  assert(gx.clip_depth == POCKET_WII_GX_MAX_CLIP_DEPTH);
  assert(!pocket_wii_gx_solid_op(&gx, clips, 2));
  return 0;
}
