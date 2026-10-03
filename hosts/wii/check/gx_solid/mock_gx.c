#include <assert.h>
#include <string.h>

#include <ogc/gu.h>
#include "mock/mock_gx.h"

MockGX mock_gx;

void guMtxIdentity(Mtx matrix) {
  memset(matrix, 0, sizeof(Mtx));
  for (unsigned int i = 0; i < 3; i += 1) matrix[i][i] = 1.0f;
}

void guOrtho(Mtx44 matrix, f32 top, f32 bottom, f32 left, f32 right,
             f32 near_z, f32 far_z) {
  memset(matrix, 0, sizeof(Mtx44));
  matrix[0][0] = left;
  matrix[1][1] = top;
  matrix[2][2] = near_z;
  matrix[3][3] = right + bottom + far_z;
  mock_gx.top = top;
  mock_gx.bottom = bottom;
  mock_gx.left = left;
  mock_gx.right = right;
}

void GX_LoadPosMtxImm(Mtx matrix, u32 index) { (void)matrix; (void)index; }
void GX_SetCurrentMtx(u32 index) { (void)index; }
void GX_LoadProjectionMtx(Mtx44 matrix, u8 type) {
  (void)matrix;
  assert(type == GX_ORTHOGRAPHIC);
}
void GX_SetViewport(f32 x, f32 y, f32 width, f32 height, f32 near_z, f32 far_z) {
  (void)near_z;
  (void)far_z;
  mock_gx.x = x;
  mock_gx.y = y;
  mock_gx.width = width;
  mock_gx.height = height;
}
void GX_SetScissor(u32 x, u32 y, u32 width, u32 height) {
  assert(mock_gx.scissor_count <
         sizeof(mock_gx.scissors) / sizeof(mock_gx.scissors[0]));
  mock_gx.scissor = (MockScissor){ x, y, width, height };
  mock_gx.scissors[mock_gx.scissor_count++] = mock_gx.scissor;
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
void GX_SetNumTevStages(u8 count) { (void)count; }
void GX_SetTevOrder(u8 stage, u8 coordinate, u32 map, u8 color) {
  (void)stage; (void)coordinate; (void)map; (void)color;
}
void GX_SetTevOp(u8 stage, u8 mode) { (void)stage; (void)mode; }
void GX_SetCullMode(u8 mode) { (void)mode; }
void GX_SetZMode(u8 enable, u8 function, u8 update_enable) {
  (void)enable; (void)function; (void)update_enable;
}
void GX_SetBlendMode(u8 type, u8 source_factor, u8 destination_factor, u8 operation) {
  mock_gx.blend_type = type;
  mock_gx.source_factor = source_factor;
  mock_gx.destination_factor = destination_factor;
  (void)operation;
}
void GX_SetAlphaCompare(u8 compare0, u8 reference0, u8 operation,
                        u8 compare1, u8 reference1) {
  mock_gx.alpha_compare0 = compare0;
  mock_gx.alpha_reference0 = reference0;
  mock_gx.alpha_operation = operation;
  mock_gx.alpha_compare1 = compare1;
  mock_gx.alpha_reference1 = reference1;
  mock_gx.alpha_compare_calls += 1;
}
void GX_SetColorUpdate(u8 enable) { (void)enable; }
void GX_SetAlphaUpdate(u8 enable) { (void)enable; }
void GX_Begin(u8 primitive, u8 format, u16 vertex_count) {
  assert(format == GX_VTXFMT0);
  assert(mock_gx.draw_count < sizeof(mock_gx.draws) / sizeof(mock_gx.draws[0]));
  assert(mock_gx.vertex_count + vertex_count <=
         sizeof(mock_gx.vertices) / sizeof(mock_gx.vertices[0]));
  mock_gx.primitive = primitive;
  mock_gx.expected_vertices = vertex_count;
  mock_gx.begin_vertex = mock_gx.vertex_count;
  mock_gx.draws[mock_gx.draw_count++] = mock_gx.vertex_count;
  mock_gx.draw_scissors[mock_gx.draw_count - 1] = mock_gx.scissor;
}
void GX_End(void) {
  assert(mock_gx.vertex_count - mock_gx.begin_vertex == mock_gx.expected_vertices);
}
void GX_Position2f32(f32 x, f32 y) {
  assert(mock_gx.primitive == GX_TRIANGLES);
  assert(mock_gx.vertex_count < sizeof(mock_gx.vertices) / sizeof(mock_gx.vertices[0]));
  MockVertex *vertex = &mock_gx.vertices[mock_gx.vertex_count++];
  vertex->x = mock_gx.x + x * mock_gx.width / (mock_gx.right - mock_gx.left);
  vertex->y = mock_gx.y + y * mock_gx.height / (mock_gx.bottom - mock_gx.top);
}
void GX_Color4u8(u8 r, u8 g, u8 b, u8 a) {
  MockVertex *vertex = &mock_gx.vertices[mock_gx.vertex_count - 1];
  vertex->r = r;
  vertex->g = g;
  vertex->b = b;
  vertex->a = a;
}
