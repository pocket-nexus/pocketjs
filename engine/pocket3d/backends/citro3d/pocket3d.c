#include "pocket3d.h"
#include <string.h>
#include <stdlib.h>
#include <math.h>
static DVLB_s *binary;
static shaderProgram_s program;
static int projection;
static DVLB_s *skin_binary;
static shaderProgram_s skin_program;
static int skin_projection, skin_palette, skin_lighting, skin_direction;
_Static_assert(sizeof(P3D_RigidVertex) == 40, "Rust rigid vertex ABI");
_Static_assert(sizeof(P3D_RigidRange) == 16, "Rust index range ABI");
_Static_assert(sizeof(P3D_SkinMatrix) == 48, "Rust affine matrix ABI");
bool p3d_init(const void *shader, size_t size) {
  binary = DVLB_ParseFile((u32 *)shader, size);
  if (!binary)
    return false;
  shaderProgramInit(&program);
  shaderProgramSetVsh(&program, &binary->DVLE[0]);
  projection =
      shaderInstanceGetUniformLocation(program.vertexShader, "projection");
  return projection >= 0;
}
void p3d_exit(void) {
  if (skin_binary) {
    shaderProgramFree(&skin_program);
    DVLB_Free(skin_binary);
    skin_binary = NULL;
  }
  shaderProgramFree(&program);
  if (binary)
    DVLB_Free(binary);
  binary = NULL;
}
bool p3d_skin_init(const void *shader, size_t size) {
  skin_binary = DVLB_ParseFile((u32 *)shader, size);
  if (!skin_binary) return false;
  shaderProgramInit(&skin_program);
  shaderProgramSetVsh(&skin_program, &skin_binary->DVLE[0]);
  skin_projection = shaderInstanceGetUniformLocation(skin_program.vertexShader, "projection");
  skin_palette = shaderInstanceGetUniformLocation(skin_program.vertexShader, "palette");
  skin_lighting = shaderInstanceGetUniformLocation(skin_program.vertexShader, "lighting");
  skin_direction = shaderInstanceGetUniformLocation(skin_program.vertexShader, "lightDirection");
  return skin_projection >= 0 && skin_palette >= 0 && skin_lighting >= 0 && skin_direction >= 0;
}
bool p3d_skin_create(P3D_SkinMesh *m, const P3D_SkinSource *s) {
  memset(m, 0, sizeof *m);
  if (!s || !s->vertices || !s->indices || !s->ranges || !s->vertex_count ||
      s->vertex_count > 65536 || !s->index_count || s->index_count > 300000 ||
      s->index_count % 3 || !s->range_count || s->range_count > s->index_count / 3 ||
      !s->joint_count || s->joint_count > P3D_SKIN_MAX_JOINTS) return false;
  for (uint32_t i = 0; i < s->index_count; i++) if (s->indices[i] >= s->vertex_count) return false;
  for (uint32_t i = 0; i < s->vertex_count; i++) {
    float row = s->vertices[i].matrix_row;
    if (!isfinite(row) || row < 0 || row >= s->joint_count * 3 || (unsigned)row % 3 || row != (unsigned)row) return false;
  }
  uint32_t end = 0;
  for (uint32_t i = 0; i < s->range_count; i++) {
    const P3D_RigidRange *r = &s->ranges[i];
    if (r->first != end || !r->count || r->count % 3 || r->count > s->index_count - end) return false;
    for (unsigned j = 0; j < 3; j++) if (r->joints[j] >= s->joint_count) return false;
    end += r->count;
  }
  if (end != s->index_count) return false;
  size_t vertex_bytes = s->vertex_count * sizeof *s->vertices;
  size_t bytes = vertex_bytes + s->index_count * sizeof *s->indices;
  m->memory = linearAlloc(bytes);
  m->ranges = malloc(s->range_count * sizeof *s->ranges);
  if (!m->memory || !m->ranges) { p3d_skin_free(m); return false; }
  memcpy(m->memory, s->vertices, vertex_bytes);
  m->indices = (uint16_t *)((uint8_t *)m->memory + vertex_bytes);
  memcpy(m->indices, s->indices, s->index_count * sizeof *s->indices);
  memcpy(m->ranges, s->ranges, s->range_count * sizeof *s->ranges);
  m->range_count = s->range_count;
  m->joint_count = s->joint_count;
  BufInfo_Init(&m->buffer);
  BufInfo_Add(&m->buffer, m->memory, sizeof *s->vertices, 4, 0x3210);
  GSPGPU_FlushDataCache(m->memory, bytes);
  return true;
}
void p3d_skin_free(P3D_SkinMesh *m) {
  if (m->memory) linearFree(m->memory);
  free(m->ranges);
  memset(m, 0, sizeof *m);
}
bool p3d_skin_begin(const C3D_Mtx *vp, const P3D_SkinLight *light) {
  if (!vp || !light || !isfinite(light->ambient) || !isfinite(light->diffuse) ||
      light->ambient < 0 || light->diffuse < 0 || light->ambient + light->diffuse > 1) return false;
  float norm = 0;
  for (unsigned i = 0; i < 3; i++) {
    if (!isfinite(light->direction[i])) return false;
    norm += light->direction[i] * light->direction[i];
  }
  if (!isfinite(norm) || (norm < 1e-12f && light->diffuse > 0)) return false;
  float scale = norm >= 1e-12f ? 1.f / sqrtf(norm) : 0;
  C3D_BindProgram(&skin_program);
  C3D_FVUnifMtx4x4(GPU_VERTEX_SHADER, skin_projection, vp);
  C3D_FVUnifSet(GPU_VERTEX_SHADER, skin_lighting, light->ambient, light->diffuse, 0, 0);
  C3D_FVUnifSet(GPU_VERTEX_SHADER, skin_direction, light->direction[0] * scale,
               light->direction[1] * scale, light->direction[2] * scale, 0);
  C3D_AttrInfo *a = C3D_GetAttrInfo();
  AttrInfo_Init(a);
  AttrInfo_AddLoader(a, 0, GPU_FLOAT, 3);
  AttrInfo_AddLoader(a, 1, GPU_FLOAT, 3);
  AttrInfo_AddLoader(a, 2, GPU_FLOAT, 3);
  AttrInfo_AddLoader(a, 3, GPU_FLOAT, 1);
  return true;
}
uint32_t p3d_skin_visible(const P3D_SkinMatrix *p, uint32_t count) {
  uint32_t mask = 0;
  for (uint32_t i = 0; i < count && i < P3D_SKIN_MAX_JOINTS; i++)
    if (p[i].rows[0][0] || p[i].rows[0][1] || p[i].rows[0][2]) mask |= 1u << i;
  return mask;
}
static bool range_visible(const P3D_RigidRange *r, uint32_t mask) {
  return mask & ((1u << r->joints[0]) | (1u << r->joints[1]) | (1u << r->joints[2]));
}
uint32_t p3d_skin_count(const P3D_SkinMesh *m, uint32_t visible) {
  uint32_t n = 0;
  for (uint32_t i = 0; i < m->range_count; i++) if (range_visible(&m->ranges[i], visible)) n += m->ranges[i].count;
  return n;
}
void p3d_skin_draw(const P3D_SkinMesh *m, const P3D_SkinMatrix *pose, uint32_t visible) {
  C3D_FVec *dst = C3D_FVUnifWritePtr(GPU_VERTEX_SHADER, skin_palette, m->joint_count * 3);
  for (uint32_t j = 0; j < m->joint_count; j++) for (unsigned r = 0; r < 3; r++) {
    const float *v = pose[j].rows[r];
    *dst++ = FVec4_New(v[0], v[1], v[2], v[3]);
  }
  C3D_SetBufInfo((C3D_BufInfo *)&m->buffer);
  uint32_t first = 0, count = 0;
  for (uint32_t i = 0; i <= m->range_count; i++) {
    if (i < m->range_count && range_visible(&m->ranges[i], visible)) {
      if (!count) first = m->ranges[i].first;
      count += m->ranges[i].count;
    } else if (count) {
      C3D_DrawElements(GPU_TRIANGLES, count, C3D_UNSIGNED_SHORT, m->indices + first);
      count = 0;
    }
  }
}
bool p3d_mesh_create(P3D_Mesh *m, size_t capacity) {
  memset(m, 0, sizeof *m);
  if (capacity > 300000)
    return false;
  m->vertices = linearAlloc(capacity * sizeof *m->vertices);
  if (!m->vertices)
    return false;
  m->capacity = capacity;
  BufInfo_Init(&m->buffer);
  BufInfo_Add(&m->buffer, m->vertices, sizeof *m->vertices, 2, 0x10);
  return true;
}
bool p3d_mesh_upload(P3D_Mesh *m, const P3D_ColorVertex *v, size_t n) {
  if (n > m->capacity || n % 3)
    return false;
  memcpy(m->vertices, v, n * sizeof *v);
  m->count = n;
  GSPGPU_FlushDataCache(m->vertices, n * sizeof *v);
  return true;
}
void p3d_mesh_free(P3D_Mesh *m) {
  if (m->vertices)
    linearFree(m->vertices);
  memset(m, 0, sizeof *m);
}
void p3d_begin(const C3D_Mtx *vp) {
  C3D_BindProgram(&program);
  C3D_FVUnifMtx4x4(GPU_VERTEX_SHADER, projection, vp);
  C3D_AttrInfo *a = C3D_GetAttrInfo();
  AttrInfo_Init(a);
  AttrInfo_AddLoader(a, 0, GPU_FLOAT, 3);
  AttrInfo_AddLoader(a, 1, GPU_FLOAT, 4);
  C3D_DepthTest(true, GPU_GEQUAL, GPU_WRITE_ALL);
  C3D_CullFace(GPU_CULL_NONE);
  C3D_AlphaBlend(GPU_BLEND_ADD, GPU_BLEND_ADD, GPU_SRC_ALPHA,
                 GPU_ONE_MINUS_SRC_ALPHA, GPU_ONE, GPU_ONE_MINUS_SRC_ALPHA);
  C3D_AlphaTest(false, GPU_ALWAYS, 0);
  C3D_SetScissor(GPU_SCISSOR_DISABLE, 0, 0, 0, 0);
  C3D_TexEnv *env = C3D_GetTexEnv(0);
  C3D_TexEnvInit(env);
  C3D_TexEnvSrc(env, C3D_Both, GPU_PRIMARY_COLOR, 0, 0);
  C3D_TexEnvFunc(env, C3D_Both, GPU_REPLACE);
  for (int i = 1; i < 6; i++)
    C3D_TexEnvInit(C3D_GetTexEnv(i));
}
void p3d_draw(const P3D_Mesh *m) {
  C3D_SetBufInfo((C3D_BufInfo *)&m->buffer);
  C3D_DrawArrays(GPU_TRIANGLES, 0, m->count);
}
