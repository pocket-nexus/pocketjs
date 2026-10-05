#include "mock/mock_gx.h"

#include <assert.h>
#include <stdint.h>
#include <string.h>

MockGX mock_gx;
static MockGXVertex pending;

void mock_gx_reset_draws(void) {
  mock_gx.draw_count = 0;
  mock_gx.vertex_count = 0;
  mock_gx.begin_vertex = 0;
  mock_gx.expected_vertices = 0;
  memset(mock_gx.draws, 0, sizeof mock_gx.draws);
  memset(mock_gx.vertices, 0, sizeof mock_gx.vertices);
}

void GX_InitTexObj(GXTexObj *obj, void *image, u16 width, u16 height,
                   u8 format, u8 wrap_s, u8 wrap_t, u8 mipmap) {
  assert(obj != NULL && image != NULL);
  assert(format == GX_TF_RGBA8 && wrap_s == GX_CLAMP && wrap_t == GX_CLAMP);
  assert(mipmap == GX_FALSE);
  *obj = (GXTexObj){.image = image, .width = width, .height = height,
                    .format = format, .wrap_s = wrap_s, .wrap_t = wrap_t,
                    .mipmap = mipmap};
  mock_gx.texture_init_count++;
}

void GX_InitTexObjLOD(GXTexObj *obj, u8 min_filter, u8 mag_filter,
                      f32 min_lod, f32 max_lod, f32 lod_bias,
                      u8 bias_clamp, u8 edge_lod, u8 max_aniso) {
  assert(obj != NULL && min_lod == 0.0f && max_lod == 0.0f);
  assert(lod_bias == 0.0f && bias_clamp == GX_FALSE && edge_lod == GX_FALSE);
  assert(max_aniso == GX_ANISO_1);
  obj->min_filter = min_filter;
  obj->mag_filter = mag_filter;
  mock_gx.texture_lod_count++;
}

void DCFlushRange(void *start, u32 length) {
  assert(start != NULL && ((uintptr_t)start & 31u) == 0);
  mock_gx.flush_count++;
  mock_gx.flush_pointer = start;
  mock_gx.flush_length = length;
}

void GX_SetVtxDesc(u8 attribute, u8 type) {
  assert(attribute == GX_VA_TEX0 && (type == GX_DIRECT || type == GX_NONE));
  mock_gx.tex0_descriptor = type;
}

void GX_SetVtxAttrFmt(u8 format, u32 attribute, u32 component_type,
                      u32 component_size, u8 fractional_bits) {
  assert(format == GX_VTXFMT0 && attribute == GX_VA_TEX0);
  assert(component_type == GX_TEX_ST && component_size == GX_F32);
  assert(fractional_bits == 0);
  mock_gx.texcoord_format++;
}

void GX_SetNumTexGens(u32 count) {
  assert(count <= 1);
  mock_gx.texgen_count = count;
}

void GX_SetTexCoordGen(u16 texcoord, u32 type, u32 source, u32 matrix) {
  assert(texcoord == GX_TEXCOORD0 && type == GX_TG_MTX2x4);
  assert(source == GX_TG_TEX0 && matrix == GX_IDENTITY);
}

void GX_SetTevOrder(u8 stage, u8 coordinate, u32 map, u8 color) {
  assert(stage == GX_TEVSTAGE0);
  mock_gx.tev_coordinate = coordinate;
  mock_gx.tev_map = map;
  mock_gx.tev_color = color;
}

void GX_SetTevOp(u8 stage, u8 mode) {
  assert(stage == GX_TEVSTAGE0 && (mode == GX_MODULATE || mode == GX_PASSCLR));
  mock_gx.tev_op = mode;
}

void GX_LoadTexObj(GXTexObj *obj, u8 map) {
  assert(obj != NULL && obj->image != NULL && map == GX_TEXMAP0);
  mock_gx.loaded_texture = *obj;
}

void GX_Begin(u8 primitive, u8 format, u16 vertex_count) {
  assert(primitive == GX_TRIANGLES && format == GX_VTXFMT0);
  assert(mock_gx.tex0_descriptor == GX_DIRECT && mock_gx.texgen_count == 1);
  assert(mock_gx.tev_coordinate == GX_TEXCOORD0 && mock_gx.tev_map == GX_TEXMAP0);
  assert(mock_gx.tev_op == GX_MODULATE && mock_gx.loaded_texture.image != NULL);
  assert(mock_gx.draw_count < sizeof mock_gx.draws / sizeof mock_gx.draws[0]);
  assert(mock_gx.vertex_count + vertex_count <=
         sizeof mock_gx.vertices / sizeof mock_gx.vertices[0]);
  MockGXDraw *draw = &mock_gx.draws[mock_gx.draw_count++];
  draw->first_vertex = mock_gx.vertex_count;
  draw->vertex_count = vertex_count;
  draw->texture = mock_gx.loaded_texture;
  mock_gx.begin_vertex = mock_gx.vertex_count;
  mock_gx.expected_vertices = vertex_count;
  pending = (MockGXVertex){0};
}

void GX_End(void) {
  assert(mock_gx.vertex_count - mock_gx.begin_vertex == mock_gx.expected_vertices);
}

void GX_Position2f32(f32 x, f32 y) {
  pending.x = x;
  pending.y = y;
}

void GX_Color4u8(u8 r, u8 g, u8 b, u8 a) {
  pending.r = r;
  pending.g = g;
  pending.b = b;
  pending.a = a;
}

void GX_TexCoord2f32(f32 s, f32 t) {
  assert(mock_gx.vertex_count < sizeof mock_gx.vertices / sizeof mock_gx.vertices[0]);
  pending.u = s;
  pending.v = t;
  mock_gx.vertices[mock_gx.vertex_count++] = pending;
}
