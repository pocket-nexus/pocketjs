#include "gx_font.h"

#include <ogc/cache.h>
#include <ogc/gx.h>

#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

typedef struct {
  float x;
  float y;
  float u;
  float v;
  uint8_t color[4];
} MockVertex;

static uint8_t bitmap[32];
static uint8_t replacement[32];
static PocketWiiFontAtlas atlas;
static bool atlas_live = true;
static MockVertex vertices[64];
static size_t vertex_count;
static size_t begin_vertex_count;
static size_t expected_vertices;
static size_t begin_count;
static bool inside_begin;
static bool descriptors[GX_VA_TEX0 + 1];
static u32 texgen_count;
static u8 tev_op;
static u8 scissor_calls;
static u32 scissor[4] = {70, 50, 12, 10};
static u32 viewport[4] = {40, 30, 240, 136};
static GXTexObj *loaded_texture;
static unsigned texture_init_count;
static unsigned flush_count;
static unsigned invalidate_count;
static unsigned draw_done_count;
static void *flushed_pointer;
static u32 flushed_length;

size_t ui_font_slot_count(void) { return 24; }

int32_t ui_font_atlas(uint32_t slot, PocketWiiFontAtlas *out) {
  if (!atlas_live || slot != 3 || out == NULL) return 0;
  *out = atlas;
  return 1;
}

void GX_InitTexObj(GXTexObj *obj, void *image, u16 width, u16 height,
                   u8 format, u8 wrap_s, u8 wrap_t, u8 mipmap) {
  assert(obj != NULL && image != NULL && format == GX_TF_IA8);
  assert(wrap_s == GX_CLAMP && wrap_t == GX_CLAMP && mipmap == GX_FALSE);
  obj->image = image;
  obj->width = width;
  obj->height = height;
  obj->format = format;
  obj->wrap_s = wrap_s;
  obj->wrap_t = wrap_t;
  obj->mipmap = mipmap;
  texture_init_count += 1;
}

void GX_InitTexObjLOD(GXTexObj *obj, u8 min_filter, u8 mag_filter,
                      f32 min_lod, f32 max_lod, f32 lod_bias,
                      u8 bias_clamp, u8 edge_lod, u8 max_aniso) {
  assert(obj != NULL && min_filter == GX_LINEAR && mag_filter == GX_LINEAR);
  assert(min_lod == 0.0f && max_lod == 0.0f && lod_bias == 0.0f);
  assert(bias_clamp == GX_FALSE && edge_lod == GX_FALSE && max_aniso == GX_ANISO_1);
  obj->min_filter = min_filter;
  obj->mag_filter = mag_filter;
}

void GX_InvalidateTexAll(void) { invalidate_count += 1; }
void GX_DrawDone(void) { draw_done_count += 1; }

void GX_LoadTexObj(GXTexObj *obj, u8 mapid) {
  assert(obj != NULL && mapid == GX_TEXMAP0);
  loaded_texture = obj;
}

void DCFlushRange(void *start, u32 length) {
  assert(start != NULL && ((uintptr_t)start & 31u) == 0);
  flushed_pointer = start;
  flushed_length = length;
  flush_count += 1;
}

void GX_ClearVtxDesc(void) { memset(descriptors, 0, sizeof descriptors); }
void GX_SetVtxDesc(u8 attribute, u8 type) {
  assert(attribute < sizeof descriptors && type == GX_DIRECT);
  descriptors[attribute] = true;
}
void GX_SetVtxAttrFmt(u8 format, u32 attribute, u32 component_type,
                      u32 component_size, u8 fractional_bits) {
  assert(format == GX_VTXFMT0 && fractional_bits == 0);
  if (attribute == GX_VA_POS) assert(component_type == GX_POS_XY && component_size == GX_F32);
  else if (attribute == GX_VA_CLR0) assert(component_type == GX_CLR_RGBA && component_size == GX_RGBA8);
  else if (attribute == GX_VA_TEX0) assert(component_type == GX_TEX_ST && component_size == GX_F32);
  else assert(false);
}
void GX_SetNumChans(u8 count) { assert(count == 1); }
void GX_SetChanCtrl(int32_t channel, u8 enable, u8 ambient_source,
                    u8 material_source, u8 light_mask, u8 diffuse_function,
                    u8 attenuation_function) {
  assert(channel == GX_COLOR0A0 && enable == GX_DISABLE &&
         ambient_source == GX_SRC_VTX && material_source == GX_SRC_VTX &&
         light_mask == GX_LIGHTNULL && diffuse_function == GX_DF_NONE &&
         attenuation_function == GX_AF_NONE);
}
void GX_SetNumTexGens(u32 count) { texgen_count = count; }
void GX_SetTexCoordGen(u16 texcoord, u32 type, u32 source, u32 matrix) {
  assert(texcoord == GX_TEXCOORD0 && type == GX_TG_MTX2x4 &&
         source == GX_TG_TEX0 && matrix == GX_IDENTITY);
}
void GX_SetNumTevStages(u8 count) { assert(count == 1); }
void GX_SetTevOrder(u8 stage, u8 coordinate, u32 map, u8 color) {
  assert(stage == GX_TEVSTAGE0 && color == GX_COLOR0A0);
  if (coordinate == GX_TEXCOORD0) assert(map == GX_TEXMAP0);
  else assert(coordinate == GX_TEXCOORDNULL && map == GX_TEXMAP_NULL);
}
void GX_SetTevOp(u8 stage, u8 mode) {
  assert(stage == GX_TEVSTAGE0);
  tev_op = mode;
}
void GX_SetCullMode(u8 mode) { assert(mode == GX_CULL_NONE); }
void GX_SetZMode(u8 enable, u8 function, u8 update_enable) {
  assert(enable == GX_DISABLE && function == GX_ALWAYS && update_enable == GX_FALSE);
}
void GX_SetBlendMode(u8 type, u8 source_factor, u8 destination_factor, u8 operation) {
  assert(type == GX_BM_BLEND && source_factor == GX_BL_SRCALPHA &&
         destination_factor == GX_BL_INVSRCALPHA && operation == GX_LO_CLEAR);
}
void GX_SetColorUpdate(u8 enable) { assert(enable == GX_TRUE); }
void GX_SetAlphaUpdate(u8 enable) { assert(enable == GX_TRUE); }
void GX_SetScissor(u32 x, u32 y, u32 width, u32 height) {
  scissor[0] = x;
  scissor[1] = y;
  scissor[2] = width;
  scissor[3] = height;
  scissor_calls += 1;
}

void GX_Begin(u8 primitive, u8 format, u16 count) {
  assert(!inside_begin && primitive == GX_TRIANGLES && format == GX_VTXFMT0);
  assert(descriptors[GX_VA_POS] && descriptors[GX_VA_CLR0] && descriptors[GX_VA_TEX0]);
  assert(texgen_count == 1 && tev_op == GX_MODULATE && loaded_texture != NULL);
  assert(vertex_count + count <= sizeof vertices / sizeof vertices[0]);
  expected_vertices = count;
  begin_vertex_count = vertex_count;
  inside_begin = true;
  begin_count += 1;
}

void GX_End(void) {
  assert(inside_begin && vertex_count % 6 == 0);
  inside_begin = false;
  assert(expected_vertices == vertex_count - begin_vertex_count);
}

void GX_Position2f32(f32 x, f32 y) {
  assert(inside_begin && vertex_count < sizeof vertices / sizeof vertices[0]);
  vertices[vertex_count] = (MockVertex){
    .x = viewport[0] + x * viewport[2] / 480.0f,
    .y = viewport[1] + y * viewport[3] / 272.0f,
  };
  vertex_count += 1;
}

void GX_Color4u8(u8 r, u8 g, u8 b, u8 a) {
  assert(vertex_count != 0);
  MockVertex *vertex = &vertices[vertex_count - 1];
  vertex->color[0] = r;
  vertex->color[1] = g;
  vertex->color[2] = b;
  vertex->color[3] = a;
}

void GX_TexCoord2f32(f32 s, f32 t) {
  assert(vertex_count != 0);
  MockVertex *vertex = &vertices[vertex_count - 1];
  vertex->u = s;
  vertex->v = t;
}

static uint32_t xy_word(int16_t x, int16_t y) {
  return (uint16_t)x | ((uint32_t)(uint16_t)y << 16);
}

static void check_vertex(size_t index, float x, float y, float u, float v) {
  const MockVertex *vertex = &vertices[index];
  assert(vertex->x == x && vertex->y == y);
  assert(vertex->u == u && vertex->v == v);
  assert(vertex->color[0] == 0x10 && vertex->color[1] == 0x20 &&
         vertex->color[2] == 0x40 && vertex->color[3] == 0x80);
}

int main(void) {
  for (unsigned i = 0; i < sizeof bitmap; i += 1) {
    bitmap[i] = (uint8_t)(i + 1);
    replacement[i] = (uint8_t)(201 - i);
  }
  atlas = (PocketWiiFontAtlas){
    .coverage = bitmap,
    .coverage_len = sizeof bitmap,
    .cell_width = 2,
    .cell_height = 2,
    .coverage_width = 4,
    .coverage_height = 4,
    .glyph_count = 2,
  };

  PocketWiiGXContext context = {
    .x = 40, .y = 30, .width = 240, .height = 136,
    .scale_x = 0.5f, .scale_y = 0.5f,
  };
  const uint32_t op[] = {
    POCKET_WII_DRAW_GLYPH_RUN,
    0x00020003u,
    0x80402010u,
    xy_word(10, 20), 0,
    xy_word(12, 20), 1,
  };

  pocket_wii_gx_font_cache_clear();
  assert(pocket_wii_gx_font_op(&context, op, sizeof op / sizeof op[0]));
  assert(vertex_count == 12 && begin_count == 1 && texture_init_count == 1);
  assert(loaded_texture != NULL && loaded_texture->format == GX_TF_IA8);
  assert(loaded_texture->width == 8 && loaded_texture->height == 4);
  assert(loaded_texture->min_filter == GX_LINEAR && loaded_texture->mag_filter == GX_LINEAR);
  assert(flush_count == 1 && flushed_pointer == loaded_texture->image && flushed_length == 64);
  assert(invalidate_count == 1 && draw_done_count == 0);

  const uint8_t *image = loaded_texture->image;
  assert(image[0] == 1 && image[1] == 255);
  assert(image[6] == 4 && image[7] == 255);
  assert(image[24] == 13 && image[25] == 255);
  assert(image[32] == 17 && image[33] == 255);
  assert(image[62] == 32 && image[63] == 255);

  check_vertex(0, 45, 40, 0, 0);
  check_vertex(1, 46, 40, 0.5f, 0);
  check_vertex(2, 46, 41, 0.5f, 1);
  check_vertex(3, 45, 40, 0, 0);
  check_vertex(4, 46, 41, 0.5f, 1);
  check_vertex(5, 45, 41, 0, 1);
  check_vertex(6, 46, 40, 0.5f, 0);
  check_vertex(7, 47, 40, 1, 0);
  check_vertex(8, 47, 41, 1, 1);
  check_vertex(9, 46, 40, 0.5f, 0);
  check_vertex(10, 47, 41, 1, 1);
  check_vertex(11, 46, 41, 0.5f, 1);

  /* Simulate a caller-installed DrawList clip and confirm the text op preserves it. */
  assert(scissor[0] == 70 && scissor[1] == 50 && scissor[2] == 12 && scissor[3] == 10);
  assert(scissor_calls == 0);
  assert(texgen_count == 0 && tev_op == GX_PASSCLR);

  assert(pocket_wii_gx_font_op(&context, op, sizeof op / sizeof op[0]));
  assert(texture_init_count == 1 && flush_count == 1 && draw_done_count == 0);

  /* Detect changed atlas bytes even if the allocator reuses the same pointer. */
  bitmap[0] = 77;
  assert(pocket_wii_gx_font_op(&context, op, sizeof op / sizeof op[0]));
  assert(texture_init_count == 2 && flush_count == 2 && invalidate_count == 2);
  assert(draw_done_count == 1 && loaded_texture->image == image);
  assert(((const uint8_t *)loaded_texture->image)[0] == 77);

  /* A different allocation for the same slot also refreshes the GX texture. */
  atlas.coverage = replacement;
  assert(pocket_wii_gx_font_op(&context, op, sizeof op / sizeof op[0]));
  assert(texture_init_count == 3 && flush_count == 3 && invalidate_count == 3);
  assert(draw_done_count == 2 && ((const uint8_t *)loaded_texture->image)[0] == 201);

  uint32_t malformed[] = {POCKET_WII_DRAW_GLYPH_RUN, 0x000200ffu, 0x80402010u};
  assert(!pocket_wii_gx_font_op(&context, malformed, 3));
  uint32_t transparent[] = {POCKET_WII_DRAW_GLYPH_RUN, 0x00000003u, 0x00402010u};
  assert(pocket_wii_gx_font_op(&context, transparent, 3));
  uint32_t bad_gid[] = {POCKET_WII_DRAW_GLYPH_RUN, 0x00010003u, 0x80402010u,
                        xy_word(0, 0), 2};
  size_t old_vertices = vertex_count;
  assert(pocket_wii_gx_font_op(&context, bad_gid, 5));
  assert(vertex_count == old_vertices);

  pocket_wii_gx_font_cache_clear();
  assert(draw_done_count == 3);
  puts("W20 PASS");
  return 0;
}
