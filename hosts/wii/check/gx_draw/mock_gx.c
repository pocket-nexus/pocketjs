#include "mock/mock_gx.h"

#include <assert.h>
#include <malloc.h>
#include <string.h>
#include <ogc/cache.h>
#include <ogc/gu.h>

MockGX mock_gx;
static bool alpha_compare_accepts_all;

void mock_gx_reset(void) {
  memset(&mock_gx, 0, sizeof mock_gx);
  alpha_compare_accepts_all = false;
}

void guMtxIdentity(Mtx matrix) {
  memset(matrix, 0, sizeof(Mtx));
  for (unsigned i = 0; i < 3; i += 1) matrix[i][i] = 1.0f;
}

void guOrtho(Mtx44 matrix, f32 top, f32 bottom, f32 left, f32 right,
             f32 near_z, f32 far_z) {
  memset(matrix, 0, sizeof(Mtx44));
  (void)top; (void)bottom; (void)left; (void)right; (void)near_z; (void)far_z;
}

void GX_LoadPosMtxImm(Mtx matrix, u32 index) { (void)matrix; (void)index; }
void GX_SetCurrentMtx(u32 index) { (void)index; }
void GX_LoadProjectionMtx(Mtx44 matrix, u8 type) { (void)matrix; (void)type; }
void GX_SetViewport(f32 x, f32 y, f32 width, f32 height, f32 near_z, f32 far_z) {
  (void)x; (void)y; (void)width; (void)height; (void)near_z; (void)far_z;
}
void GX_SetScissor(u32 x, u32 y, u32 width, u32 height) {
  mock_gx.scissor[0] = x;
  mock_gx.scissor[1] = y;
  mock_gx.scissor[2] = width;
  mock_gx.scissor[3] = height;
  mock_gx.scissor_count += 1;
}
void GX_ClearVtxDesc(void) {}
void GX_SetVtxDesc(u8 attribute, u8 type) { (void)attribute; (void)type; }
void GX_SetVtxAttrFmt(u8 format, u32 attribute, u32 component_type,
                      u32 component_size, u8 fractional_bits) {
  (void)format; (void)attribute; (void)component_type;
  (void)component_size; (void)fractional_bits;
}
void GX_SetNumChans(u8 count) { (void)count; }
void GX_SetChanCtrl(int32_t channel, u8 enable, u8 ambient_source,
                    u8 material_source, u8 light_mask, u8 diffuse_function,
                    u8 attenuation_function) {
  (void)channel; (void)enable; (void)ambient_source; (void)material_source;
  (void)light_mask; (void)diffuse_function; (void)attenuation_function;
}
void GX_SetNumTexGens(u32 count) { (void)count; }
void GX_SetTexCoordGen(u16 texcoord, u32 type, u32 source, u32 matrix) {
  (void)texcoord; (void)type; (void)source; (void)matrix;
}
void GX_SetNumTevStages(u8 count) { (void)count; }
void GX_SetTevOrder(u8 stage, u8 coordinate, u32 map, u8 color) {
  (void)stage; (void)coordinate; (void)map; (void)color;
}
void GX_SetTevOp(u8 stage, u8 mode) { (void)stage; mock_gx.tev_op = mode; }
void GX_SetCullMode(u8 mode) { (void)mode; }
void GX_SetZMode(u8 enable, u8 function, u8 update_enable) {
  (void)enable; (void)function; (void)update_enable;
}
void GX_SetBlendMode(u8 type, u8 source_factor, u8 destination_factor, u8 operation) {
  (void)type; (void)source_factor; (void)destination_factor; (void)operation;
}
void GX_SetAlphaCompare(u8 compare0, u8 ref0, u8 operation,
                        u8 compare1, u8 ref1) {
  assert(compare0 == GX_ALWAYS && ref0 == 0 && operation == GX_AOP_AND &&
         compare1 == GX_ALWAYS && ref1 == 0);
  alpha_compare_accepts_all = true;
}
void GX_SetColorUpdate(u8 enable) { (void)enable; }
void GX_SetAlphaUpdate(u8 enable) { (void)enable; }

void GX_Begin(u8 primitive, u8 format, u16 vertex_count) {
  assert(primitive == GX_TRIANGLES && format == GX_VTXFMT0);
  if (!mock_gx.host_next_draw) assert(alpha_compare_accepts_all);
  assert(mock_gx.draw_count < sizeof mock_gx.draws / sizeof mock_gx.draws[0]);
  MockGXDraw *draw = &mock_gx.draws[mock_gx.draw_count++];
  draw->kind = mock_gx.host_next_draw ? MOCK_GX_HOST :
    mock_gx.tev_op != GX_MODULATE ? MOCK_GX_SOLID :
    mock_gx.texture.format == GX_TF_IA8 ? MOCK_GX_FONT : MOCK_GX_TEXTURE;
  draw->vertex_count = vertex_count;
  memcpy(draw->scissor, mock_gx.scissor, sizeof draw->scissor);
  mock_gx.host_next_draw = false;
  mock_gx.expected_vertices = vertex_count;
  mock_gx.vertices_in_draw = 0;
}
void GX_End(void) {
  assert(mock_gx.vertices_in_draw == mock_gx.expected_vertices);
}
void GX_Position2f32(f32 x, f32 y) {
  (void)x; (void)y;
  assert(mock_gx.draw_count != 0);
  mock_gx.vertices_in_draw += 1;
}
void GX_Color4u8(u8 r, u8 g, u8 b, u8 a) { (void)r; (void)g; (void)b; (void)a; }
void GX_TexCoord2f32(f32 s, f32 t) { (void)s; (void)t; }

void GX_InitTexObj(GXTexObj *obj, void *image, u16 width, u16 height,
                   u8 format, u8 wrap_s, u8 wrap_t, u8 mipmap) {
  assert(obj != NULL && image != NULL);
  *obj = (GXTexObj){ .image = image, .width = width, .height = height,
    .format = format, .wrap_s = wrap_s, .wrap_t = wrap_t, .mipmap = mipmap };
  mock_gx.texture_init_count += 1;
}
void GX_InitTexObjLOD(GXTexObj *obj, u8 min_filter, u8 mag_filter,
                      f32 min_lod, f32 max_lod, f32 lod_bias,
                      u8 bias_clamp, u8 edge_lod, u8 max_aniso) {
  (void)min_lod; (void)max_lod; (void)lod_bias;
  (void)bias_clamp; (void)edge_lod; (void)max_aniso;
  assert(obj != NULL);
  obj->min_filter = min_filter;
  obj->mag_filter = mag_filter;
}
void GX_InvalidateTexAll(void) { mock_gx.invalidate_count += 1; }
void GX_DrawDone(void) { mock_gx.draw_done_count += 1; }
void GX_LoadTexObj(GXTexObj *obj, u8 mapid) {
  assert(obj != NULL && mapid == GX_TEXMAP0);
  mock_gx.texture = *obj;
}
void DCFlushRange(void *start, u32 length) {
  assert(start != NULL && ((uintptr_t)start & 31u) == 0 && length != 0);
  mock_gx.flush_count += 1;
}

void mock_gx_host_draw(void) {
  mock_gx.host_next_draw = true;
  GX_Begin(GX_TRIANGLES, GX_VTXFMT0, 3);
  GX_Position2f32(0, 0); GX_Color4u8(1, 2, 3, 255);
  GX_Position2f32(1, 0); GX_Color4u8(1, 2, 3, 255);
  GX_Position2f32(0, 1); GX_Color4u8(1, 2, 3, 255);
  GX_End();
}
