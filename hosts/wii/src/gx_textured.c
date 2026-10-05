#include "gx_textured.h"

#include "drawlist.h"
#include "gx_texture.h"

#include <ogc/gx.h>

#include <string.h>

_Static_assert(sizeof(float) == sizeof(uint32_t), "DrawList UVs are binary32");

static int32_t word_x(uint32_t word) {
  return (int16_t)word;
}

static int32_t word_y(uint32_t word) {
  return (int16_t)(word >> 16);
}

static uint32_t word_w(uint32_t word) {
  return word & 0xffffu;
}

static uint32_t word_h(uint32_t word) {
  return word >> 16;
}

static float word_float(uint32_t word) {
  float value;
  memcpy(&value, &word, sizeof value);
  return value;
}

static void vertex(float x, float y, float u, float v, uint32_t color) {
  GX_Position2f32(x, y);
  GX_Color4u8(
    (uint8_t)color,
    (uint8_t)(color >> 8),
    (uint8_t)(color >> 16),
    (uint8_t)(color >> 24)
  );
  GX_TexCoord2f32(u, v);
}

static void texture_state(PocketWiiGXTexture *texture) {
  GX_SetVtxDesc(GX_VA_TEX0, GX_DIRECT);
  GX_SetVtxAttrFmt(GX_VTXFMT0, GX_VA_TEX0, GX_TEX_ST, GX_F32, 0);
  GX_SetNumTexGens(1);
  GX_SetTexCoordGen(GX_TEXCOORD0, GX_TG_MTX2x4, GX_TG_TEX0, GX_IDENTITY);
  GX_SetTevOrder(GX_TEVSTAGE0, GX_TEXCOORD0, GX_TEXMAP0, GX_COLOR0A0);
  GX_SetTevOp(GX_TEVSTAGE0, GX_MODULATE);
  GX_LoadTexObj(&texture->object, GX_TEXMAP0);
}

static void solid_state(void) {
  GX_SetNumTexGens(0);
  GX_SetVtxDesc(GX_VA_TEX0, GX_NONE);
  GX_SetTevOrder(GX_TEVSTAGE0, GX_TEXCOORDNULL, GX_TEXMAP_NULL, GX_COLOR0A0);
  GX_SetTevOp(GX_TEVSTAGE0, GX_PASSCLR);
}

static void draw_quad(const uint32_t *op) {
  float x0 = (float)word_x(op[2]);
  float y0 = (float)word_y(op[2]);
  float x1 = x0 + (float)word_w(op[3]);
  float y1 = y0 + (float)word_h(op[3]);
  float u0 = word_float(op[4]);
  float v0 = word_float(op[5]);
  float u1 = word_float(op[6]);
  float v1 = word_float(op[7]);
  uint32_t color = op[8];

  GX_Begin(GX_TRIANGLES, GX_VTXFMT0, 6);
  vertex(x0, y0, u0, v0, color);
  vertex(x1, y0, u1, v0, color);
  vertex(x1, y1, u1, v1, color);
  vertex(x0, y0, u0, v0, color);
  vertex(x1, y1, u1, v1, color);
  vertex(x0, y1, u0, v1, color);
  GX_End();
}

static void draw_tri(const uint32_t *op) {
  uint32_t color = op[11];
  GX_Begin(GX_TRIANGLES, GX_VTXFMT0, 3);
  for (size_t corner = 0; corner < 3; corner++) {
    size_t offset = 2 + corner * 3;
    vertex((float)word_x(op[offset]), (float)word_y(op[offset]),
           word_float(op[offset + 1]), word_float(op[offset + 2]), color);
  }
  GX_End();
}

bool pocket_wii_gx_textured_op(
  PocketWiiGXContext *context,
  const uint32_t *op,
  size_t word_count
) {
  if (context == NULL || context->width == 0 || context->height == 0 || op == NULL) {
    return false;
  }
  if (word_count == 0) return false;

  uint32_t color;
  switch (op[0]) {
    case POCKET_WII_DRAW_TEX_QUAD:
      if (word_count != 9) return false;
      if (word_w(op[3]) == 0 || word_h(op[3]) == 0) return true;
      color = op[8];
      break;
    case POCKET_WII_DRAW_TEX_TRI:
      if (word_count != 12) return false;
      color = op[11];
      break;
    default:
      return false;
  }
  if ((color >> 24) == 0) return true;

  PocketWiiGXTexture texture;
  if (!pocket_wii_gx_texture_for_handle((int32_t)op[1], &texture)) return false;

  texture_state(&texture);
  if (op[0] == POCKET_WII_DRAW_TEX_QUAD) draw_quad(op);
  else draw_tri(op);
  solid_state();
  return true;
}
