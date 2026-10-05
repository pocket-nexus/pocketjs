#include "gx_solid.h"

#include <ogc/gu.h>
#include <ogc/gx.h>

#define POCKET_WII_LOGICAL_WIDTH 480.0f
#define POCKET_WII_LOGICAL_HEIGHT 272.0f

static int32_t word_x(uint32_t word) {
  return (int16_t)(word & 0xffffu);
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

static uint32_t scissor_extent(int32_t origin, uint32_t extent) {
  int64_t end = (int64_t)origin + (int64_t)extent;
  int64_t visible = end - (origin < 0 ? 0 : origin);
  if (end <= 0 || visible <= 0) return 0;
  return visible > UINT32_MAX ? UINT32_MAX : (uint32_t)visible;
}

static int64_t logical_to_pixel(
  int32_t origin,
  int64_t logical,
  uint32_t extent,
  uint32_t logical_size,
  bool round_up
) {
  int64_t scaled = logical * extent;
  int64_t pixels = scaled / logical_size;
  int64_t remainder = scaled % logical_size;
  if (round_up ? remainder > 0 : remainder < 0) {
    pixels += round_up ? 1 : -1;
  }
  return (int64_t)origin + pixels;
}

static uint32_t scissor_coordinate(int64_t coordinate) {
  if (coordinate <= 0) return 0;
  return coordinate > UINT32_MAX ? UINT32_MAX : (uint32_t)coordinate;
}

static void intersect_axis(
  uint32_t parent_origin,
  uint32_t parent_extent,
  int64_t *start,
  int64_t *end
) {
  int64_t parent_start = parent_origin;
  int64_t parent_end = parent_start + parent_extent;
  if (*start < parent_start) *start = parent_start;
  if (*end > parent_end) *end = parent_end;
  if (*end < *start) {
    int64_t edge = *start > parent_end ? parent_end : parent_start;
    *start = edge;
    *end = edge;
  }
}

static PocketWiiGXClip intersect_clip(
  PocketWiiGXClip parent,
  int64_t left,
  int64_t top,
  int64_t right,
  int64_t bottom
) {
  intersect_axis(parent.x, parent.width, &left, &right);
  intersect_axis(parent.y, parent.height, &top, &bottom);
  uint32_t x = scissor_coordinate(left);
  uint32_t y = scissor_coordinate(top);
  uint32_t x1 = scissor_coordinate(right);
  uint32_t y1 = scissor_coordinate(bottom);
  return (PocketWiiGXClip){ x, y, x1 - x, y1 - y };
}

static void apply_clip(PocketWiiGXContext *context) {
  GX_SetScissor(context->clip.x, context->clip.y,
                context->clip.width, context->clip.height);
}

static bool push_scissor(PocketWiiGXContext *context, const uint32_t *op) {
  if (context->clip_depth >= POCKET_WII_GX_MAX_CLIP_DEPTH) return false;

  int32_t x = word_x(op[1]);
  int32_t y = word_y(op[1]);
  uint32_t width = word_w(op[2]);
  uint32_t height = word_h(op[2]);
  int64_t left = logical_to_pixel(context->x, x, context->width,
                                  POCKET_WII_LOGICAL_WIDTH, false);
  int64_t top = logical_to_pixel(context->y, y, context->height,
                                 POCKET_WII_LOGICAL_HEIGHT, false);
  int64_t right = width == 0
    ? left
    : logical_to_pixel(context->x, (int64_t)x + width,
                       context->width, POCKET_WII_LOGICAL_WIDTH, true);
  int64_t bottom = height == 0
    ? top
    : logical_to_pixel(context->y, (int64_t)y + height,
                       context->height, POCKET_WII_LOGICAL_HEIGHT, true);

  context->clip_stack[context->clip_depth++] = context->clip;
  context->clip = intersect_clip(context->clip, left, top, right, bottom);
  apply_clip(context);
  return true;
}

static void vertex(float x, float y, uint32_t color) {
  GX_Position2f32(x, y);
  GX_Color4u8(
    (uint8_t)color,
    (uint8_t)(color >> 8),
    (uint8_t)(color >> 16),
    (uint8_t)(color >> 24)
  );
}

bool pocket_wii_gx_context_begin(
  PocketWiiGXContext *context,
  int32_t x,
  int32_t y,
  uint32_t width,
  uint32_t height
) {
  if (context == NULL || width == 0 || height == 0) return false;

  context->x = x;
  context->y = y;
  context->width = width;
  context->height = height;
  context->scale_x = (float)width / POCKET_WII_LOGICAL_WIDTH;
  context->scale_y = (float)height / POCKET_WII_LOGICAL_HEIGHT;
  context->clip = (PocketWiiGXClip){
    x < 0 ? 0 : (uint32_t)x,
    y < 0 ? 0 : (uint32_t)y,
    scissor_extent(x, width),
    scissor_extent(y, height),
  };
  context->clip_depth = 0;

  Mtx identity;
  Mtx44 projection;
  guMtxIdentity(identity);
  guOrtho(projection, 0.0f, POCKET_WII_LOGICAL_HEIGHT, 0.0f,
          POCKET_WII_LOGICAL_WIDTH, 0.0f, 1.0f);
  GX_LoadPosMtxImm(identity, GX_PNMTX0);
  GX_SetCurrentMtx(GX_PNMTX0);
  GX_LoadProjectionMtx(projection, GX_ORTHOGRAPHIC);
  GX_SetViewport((f32)x, (f32)y, (f32)width, (f32)height, 0.0f, 1.0f);
  apply_clip(context);

  GX_ClearVtxDesc();
  GX_SetVtxDesc(GX_VA_POS, GX_DIRECT);
  GX_SetVtxDesc(GX_VA_CLR0, GX_DIRECT);
  GX_SetVtxAttrFmt(GX_VTXFMT0, GX_VA_POS, GX_POS_XY, GX_F32, 0);
  GX_SetVtxAttrFmt(GX_VTXFMT0, GX_VA_CLR0, GX_CLR_RGBA, GX_RGBA8, 0);
  GX_SetNumChans(1);
  GX_SetChanCtrl(GX_COLOR0A0, GX_DISABLE, GX_SRC_VTX, GX_SRC_VTX,
                 GX_LIGHTNULL, GX_DF_NONE, GX_AF_NONE);
  GX_SetNumTexGens(0);
  GX_SetNumTevStages(1);
  GX_SetTevOrder(GX_TEVSTAGE0, GX_TEXCOORDNULL, GX_TEXMAP_NULL, GX_COLOR0A0);
  GX_SetTevOp(GX_TEVSTAGE0, GX_PASSCLR);
  GX_SetCullMode(GX_CULL_NONE);
  GX_SetZMode(GX_DISABLE, GX_ALWAYS, GX_FALSE);
  GX_SetBlendMode(GX_BM_BLEND, GX_BL_SRCALPHA, GX_BL_INVSRCALPHA, GX_LO_CLEAR);
  GX_SetAlphaCompare(GX_ALWAYS, 0, GX_AOP_AND, GX_ALWAYS, 0);
  GX_SetColorUpdate(GX_TRUE);
  GX_SetAlphaUpdate(GX_TRUE);
  return true;
}

static void draw_rect(const uint32_t *op) {
  int32_t x = word_x(op[1]);
  int32_t y = word_y(op[1]);
  uint32_t width = word_w(op[2]);
  uint32_t height = word_h(op[2]);
  uint32_t color = op[3];
  if (width == 0 || height == 0 || (color >> 24) == 0) return;

  float x0 = (float)x;
  float y0 = (float)y;
  float x1 = x0 + (float)width;
  float y1 = y0 + (float)height;
  GX_Begin(GX_TRIANGLES, GX_VTXFMT0, 6);
  vertex(x0, y0, color);
  vertex(x1, y0, color);
  vertex(x1, y1, color);
  vertex(x0, y0, color);
  vertex(x1, y1, color);
  vertex(x0, y1, color);
  GX_End();
}

static bool draw_grad_rect(const uint32_t *op) {
  int32_t x = word_x(op[1]);
  int32_t y = word_y(op[1]);
  uint32_t width = word_w(op[2]);
  uint32_t height = word_h(op[2]);
  uint32_t from = op[3];
  uint32_t to = op[4];
  uint32_t colors[4];

  /* Corners are top-left, top-right, bottom-right, bottom-left. */
  switch (op[5]) {
    case 0: /* ToTop: from at bottom. */
      colors[0] = to; colors[1] = to; colors[2] = from; colors[3] = from;
      break;
    case 1: /* ToBottom: from at top. */
      colors[0] = from; colors[1] = from; colors[2] = to; colors[3] = to;
      break;
    case 2: /* ToLeft: from at right. */
      colors[0] = to; colors[1] = from; colors[2] = from; colors[3] = to;
      break;
    case 3: /* ToRight: from at left. */
      colors[0] = from; colors[1] = to; colors[2] = to; colors[3] = from;
      break;
    default:
      return false;
  }

  if (width == 0 || height == 0 || ((from | to) >> 24) == 0) return true;

  float x0 = (float)x;
  float y0 = (float)y;
  float x1 = x0 + (float)width;
  float y1 = y0 + (float)height;
  GX_Begin(GX_TRIANGLES, GX_VTXFMT0, 6);
  vertex(x0, y0, colors[0]);
  vertex(x1, y0, colors[1]);
  vertex(x1, y1, colors[2]);
  vertex(x0, y0, colors[0]);
  vertex(x1, y1, colors[2]);
  vertex(x0, y1, colors[3]);
  GX_End();
  return true;
}

static void draw_tri(const uint32_t *op) {
  uint32_t color0 = op[4];
  uint32_t color1 = op[5];
  uint32_t color2 = op[6];
  if (((color0 | color1 | color2) & 0xff000000u) == 0) return;

  GX_Begin(GX_TRIANGLES, GX_VTXFMT0, 3);
  vertex((float)word_x(op[1]), (float)word_y(op[1]), color0);
  vertex((float)word_x(op[2]), (float)word_y(op[2]), color1);
  vertex((float)word_x(op[3]), (float)word_y(op[3]), color2);
  GX_End();
}

bool pocket_wii_gx_solid_op(
  PocketWiiGXContext *context,
  const uint32_t *op,
  size_t word_count
) {
  if (context == NULL || context->width == 0 || context->height == 0 || op == NULL) {
    return false;
  }

  switch (op[0]) {
    case 5:
      if (word_count != 3) return false;
      return push_scissor(context, op);
    case 6:
      if (word_count != 1 || context->clip_depth == 0) return false;
      context->clip = context->clip_stack[--context->clip_depth];
      apply_clip(context);
      return true;
    case 1:
      if (word_count != 4) return false;
      draw_rect(op);
      return true;
    case 2:
      if (word_count != 6) return false;
      return draw_grad_rect(op);
    case 7:
      if (word_count != 7) return false;
      draw_tri(op);
      return true;
    default:
      return false;
  }
}
