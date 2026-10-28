/* PICA200 renderer for pocket-playset frames (pocket_3ds_playset.h).
 *
 * Models, static batches and ground tiles are copied into linear memory once
 * per revision; the frame's dynamic geometry (water, shadows, particles) is
 * copied each frame into one growing linear buffer. A draw binds its source
 * buffer, uploads its bone rows (four per matrix) and issues one indexed
 * draw. State changes only when a draw's blend, cull or mode differs from the
 * previous one. */
#include "pocket_3ds_playset.h"

#include <3ds.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

#define MAX_BONES 20

typedef struct {
  void *verts;
  uint16_t *idx;
  uint32_t nverts, nidx;
  uint32_t revision;
  bool ready;
} Gpu;

typedef struct {
  float pos[3];
  int8_t nb[4];
  uint8_t rgba[4];
} Vertex;

struct p3ps_renderer {
  DVLB_s *dvlb;
  shaderProgram_s program;
  C3D_AttrInfo attributes;
  int u_proj, u_bones, u_sundir, u_suncol, u_hsky, u_hgnd, u_fogp, u_fogc,
      u_eye, u_mode;
  Gpu *models;
  uint32_t model_cap;
  Gpu *batches[3];
  uint32_t batch_cap[3];
  Vertex *dyn_verts;
  uint16_t *dyn_idx;
  uint32_t dyn_vcap, dyn_icap;
  Vertex *sky;
  uint16_t *sky_idx;
};

static void gpu_free(Gpu *g) {
  if (g->verts) linearFree(g->verts);
  if (g->idx) linearFree(g->idx);
  memset(g, 0, sizeof *g);
}

static bool gpu_fill(Gpu *g, const uint8_t *verts, uint32_t nverts,
                     const uint16_t *idx, uint32_t nidx, uint32_t revision) {
  gpu_free(g);
  if (nverts == 0 || nidx == 0) {
    g->ready = true;
    g->revision = revision;
    return true;
  }
  g->verts = linearAlloc(nverts * sizeof(Vertex));
  g->idx = linearAlloc(nidx * sizeof(uint16_t));
  if (!g->verts || !g->idx) {
    gpu_free(g);
    return false;
  }
  memcpy(g->verts, verts, nverts * sizeof(Vertex));
  memcpy(g->idx, idx, nidx * sizeof(uint16_t));
  GSPGPU_FlushDataCache(g->verts, nverts * sizeof(Vertex));
  GSPGPU_FlushDataCache(g->idx, nidx * sizeof(uint16_t));
  g->nverts = nverts;
  g->nidx = nidx;
  g->revision = revision;
  g->ready = true;
  return true;
}

static bool grow(Gpu **list, uint32_t *cap, uint32_t need) {
  if (need <= *cap) return true;
  uint32_t n = *cap ? *cap : 16;
  while (n < need) n *= 2;
  Gpu *next = realloc(*list, n * sizeof(Gpu));
  if (!next) return false;
  memset(next + *cap, 0, (n - *cap) * sizeof(Gpu));
  *list = next;
  *cap = n;
  return true;
}

p3ps_renderer *p3ps_create(const void *shader, size_t shader_size) {
  p3ps_renderer *r = calloc(1, sizeof *r);
  if (!r) return NULL;
  r->dvlb = DVLB_ParseFile((u32 *)shader, shader_size);
  if (!r->dvlb) {
    free(r);
    return NULL;
  }
  shaderProgramInit(&r->program);
  shaderProgramSetVsh(&r->program, &r->dvlb->DVLE[0]);
  shaderInstance_s *vs = r->program.vertexShader;
  r->u_proj = shaderInstanceGetUniformLocation(vs, "proj");
  r->u_bones = shaderInstanceGetUniformLocation(vs, "bones");
  r->u_sundir = shaderInstanceGetUniformLocation(vs, "sundir");
  r->u_suncol = shaderInstanceGetUniformLocation(vs, "suncol");
  r->u_hsky = shaderInstanceGetUniformLocation(vs, "hsky");
  r->u_hgnd = shaderInstanceGetUniformLocation(vs, "hgnd");
  r->u_fogp = shaderInstanceGetUniformLocation(vs, "fogp");
  r->u_fogc = shaderInstanceGetUniformLocation(vs, "fogc");
  r->u_eye = shaderInstanceGetUniformLocation(vs, "eye");
  r->u_mode = shaderInstanceGetUniformLocation(vs, "mode");
  AttrInfo_Init(&r->attributes);
  AttrInfo_AddLoader(&r->attributes, 0, GPU_FLOAT, 3);
  AttrInfo_AddLoader(&r->attributes, 1, GPU_BYTE, 4);
  AttrInfo_AddLoader(&r->attributes, 2, GPU_UNSIGNED_BYTE, 4);
  /* the sky: six vertices in screen pixels, coloured per frame */
  r->sky = linearAlloc(6 * sizeof(Vertex));
  r->sky_idx = linearAlloc(12 * sizeof(uint16_t));
  if (!r->sky || !r->sky_idx) {
    p3ps_destroy(r);
    return NULL;
  }
  static const uint16_t quads[12] = {0, 2, 3, 0, 3, 1, 2, 4, 5, 2, 5, 3};
  memcpy(r->sky_idx, quads, sizeof quads);
  GSPGPU_FlushDataCache(r->sky_idx, sizeof quads);
  return r;
}

void p3ps_forget(p3ps_renderer *r) {
  if (!r) return;
  for (uint32_t i = 0; i < r->model_cap; i++) gpu_free(&r->models[i]);
  for (int s = 0; s < 3; s++)
    for (uint32_t i = 0; i < r->batch_cap[s]; i++) gpu_free(&r->batches[s][i]);
}

void p3ps_destroy(p3ps_renderer *r) {
  if (!r) return;
  p3ps_forget(r);
  free(r->models);
  for (int s = 0; s < 3; s++) free(r->batches[s]);
  if (r->dyn_verts) linearFree(r->dyn_verts);
  if (r->dyn_idx) linearFree(r->dyn_idx);
  if (r->sky) linearFree(r->sky);
  if (r->sky_idx) linearFree(r->sky_idx);
  if (r->dvlb) {
    shaderProgramFree(&r->program);
    DVLB_Free(r->dvlb);
  }
  free(r);
}

static uint8_t byte_of(float c) {
  if (c <= 0) return 0;
  if (c >= 1) return 255;
  return (uint8_t)(c * 255.0f + 0.5f);
}

static void sky_vertex(Vertex *v, float x, float y, const float *c) {
  v->pos[0] = x;
  v->pos[1] = y;
  v->pos[2] = 0.5f;
  v->nb[0] = v->nb[1] = v->nb[3] = 0;
  v->nb[2] = 127;
  v->rgba[0] = byte_of(c[0]);
  v->rgba[1] = byte_of(c[1]);
  v->rgba[2] = byte_of(c[2]);
  v->rgba[3] = 255;
}

static void set_vec(int location, const float *v) {
  C3D_FVUnifSet(GPU_VERTEX_SHADER, location, v[0], v[1], v[2], v[3]);
}

static void identity_bone(p3ps_renderer *r) {
  C3D_FVec *rows = C3D_FVUnifWritePtr(GPU_VERTEX_SHADER, r->u_bones, 4);
  rows[0] = FVec4_New(1, 0, 0, 0);
  rows[1] = FVec4_New(0, 1, 0, 0);
  rows[2] = FVec4_New(0, 0, 1, 0);
  rows[3] = FVec4_New(1, 1, 1, 1);
}

/* The sky gradient behind everything: top colour down to the horizon line,
 * then the horizon colour to the bottom colour. */
static void draw_sky(p3ps_renderer *r, const pps_frame *f) {
  /* forward's elevation gives the horizon's height on screen */
  float fy = -f->view[9];
  float flat = sqrtf(fmaxf(1.0f - fy * fy, 1e-6f));
  float t = tanf(f->fov_y * (float)M_PI / 360.0f);
  float h = 120.0f + 120.0f * (fy / flat) / t;
  if (h < 0) h = 0;
  if (h > 240) h = 240;
  sky_vertex(&r->sky[0], 0, 0, f->sky_top);
  sky_vertex(&r->sky[1], 400, 0, f->sky_top);
  sky_vertex(&r->sky[2], 0, h, f->sky_horizon);
  sky_vertex(&r->sky[3], 400, h, f->sky_horizon);
  sky_vertex(&r->sky[4], 0, 240, f->sky_bottom);
  sky_vertex(&r->sky[5], 400, 240, f->sky_bottom);
  GSPGPU_FlushDataCache(r->sky, 6 * sizeof(Vertex));
  C3D_Mtx ortho;
  Mtx_OrthoTilt(&ortho, 0.0f, 400.0f, 240.0f, 0.0f, 1.0f, -1.0f, true);
  C3D_FVUnifMtx4x4(GPU_VERTEX_SHADER, r->u_proj, &ortho);
  identity_bone(r);
  C3D_FVUnifSet(GPU_VERTEX_SHADER, r->u_mode, 1, 1, 0, 0);
  C3D_FVUnifSet(GPU_VERTEX_SHADER, r->u_fogp, 0, 0, 0, 0);
  C3D_BufInfo buf;
  BufInfo_Init(&buf);
  BufInfo_Add(&buf, r->sky, sizeof(Vertex), 3, 0x210);
  C3D_SetBufInfo(&buf);
  C3D_DepthTest(false, GPU_ALWAYS, GPU_WRITE_COLOR);
  C3D_CullFace(GPU_CULL_NONE);
  C3D_AlphaBlend(GPU_BLEND_ADD, GPU_BLEND_ADD, GPU_ONE, GPU_ZERO, GPU_ONE,
                 GPU_ZERO);
  C3D_DrawElements(GPU_TRIANGLES, 12, C3D_UNSIGNED_SHORT, r->sky_idx);
}

static bool sync_models(p3ps_renderer *r, pps *ps, uint32_t *uploads) {
  uint32_t n = pps_model_count(ps);
  if (!grow(&r->models, &r->model_cap, n)) return false;
  for (uint32_t i = 0; i < n; i++) {
    if (r->models[i].ready) continue;
    const uint8_t *v;
    const uint16_t *idx;
    uint32_t nv, ni;
    if (pps_model_data(ps, i, &v, &nv, &idx, &ni)) continue;
    if (!gpu_fill(&r->models[i], v, nv, idx, ni, 1)) return false;
    (*uploads)++;
  }
  return true;
}

static bool sync_batches(p3ps_renderer *r, pps *ps, uint32_t source,
                         uint32_t *uploads) {
  uint32_t n = pps_batch_count(ps, source);
  if (!grow(&r->batches[source], &r->batch_cap[source], n)) return false;
  for (uint32_t i = 0; i < n; i++) {
    const uint8_t *v;
    const uint16_t *idx;
    uint32_t nv, ni, rev;
    if (pps_batch_data(ps, source, i, &v, &nv, &idx, &ni, &rev)) continue;
    Gpu *g = &r->batches[source][i];
    if (g->ready && g->revision == rev && g->nverts == nv && g->nidx == ni)
      continue;
    if (!gpu_fill(g, v, nv, idx, ni, rev)) return false;
    (*uploads)++;
  }
  /* batches past the end belong to an older bake */
  for (uint32_t i = n; i < r->batch_cap[source]; i++)
    if (r->batches[source][i].ready) gpu_free(&r->batches[source][i]);
  return true;
}

static bool sync_dynamic(p3ps_renderer *r, const pps_frame *f) {
  if (f->dyn_vertex_count > r->dyn_vcap) {
    uint32_t n = r->dyn_vcap ? r->dyn_vcap : 4096;
    while (n < f->dyn_vertex_count) n *= 2;
    if (r->dyn_verts) linearFree(r->dyn_verts);
    r->dyn_verts = linearAlloc(n * sizeof(Vertex));
    r->dyn_vcap = r->dyn_verts ? n : 0;
  }
  if (f->dyn_index_count > r->dyn_icap) {
    uint32_t n = r->dyn_icap ? r->dyn_icap : 8192;
    while (n < f->dyn_index_count) n *= 2;
    if (r->dyn_idx) linearFree(r->dyn_idx);
    r->dyn_idx = linearAlloc(n * sizeof(uint16_t));
    r->dyn_icap = r->dyn_idx ? n : 0;
  }
  if (f->dyn_vertex_count > r->dyn_vcap || f->dyn_index_count > r->dyn_icap)
    return false;
  if (f->dyn_vertex_count) {
    memcpy(r->dyn_verts, f->dyn_verts, f->dyn_vertex_count * sizeof(Vertex));
    GSPGPU_FlushDataCache(r->dyn_verts, f->dyn_vertex_count * sizeof(Vertex));
  }
  if (f->dyn_index_count) {
    memcpy(r->dyn_idx, f->dyn_idx, f->dyn_index_count * sizeof(uint16_t));
    GSPGPU_FlushDataCache(r->dyn_idx, f->dyn_index_count * sizeof(uint16_t));
  }
  return true;
}

static void eye_pass(p3ps_renderer *r, const pps_frame *f, C3D_RenderTarget *target,
                     float iod, p3ps_stats *stats) {
  C3D_FrameDrawOn(target);
  C3D_SetViewport(0, 0, 240, 400);
  C3D_BindProgram(&r->program);
  C3D_SetAttrInfo(&r->attributes);
  C3D_TexEnv *env = C3D_GetTexEnv(0);
  C3D_TexEnvInit(env);
  C3D_TexEnvSrc(env, C3D_Both, GPU_PRIMARY_COLOR, 0, 0);
  C3D_TexEnvFunc(env, C3D_Both, GPU_REPLACE);
  for (int i = 1; i < 6; i++) C3D_TexEnvInit(C3D_GetTexEnv(i));
  draw_sky(r, f);

  C3D_Mtx view, projection, vp;
  Mtx_Identity(&view);
  for (int row = 0; row < 3; row++)
    view.r[row] = FVec4_New(f->view[row * 4], f->view[row * 4 + 1],
                            f->view[row * 4 + 2], f->view[row * 4 + 3]);
  float fovy = f->fov_y * (float)M_PI / 180.0f;
  if (iod != 0.0f)
    Mtx_PerspStereoTilt(&projection, fovy, C3D_AspectRatioTop, f->near_plane,
                        f->far_plane, iod, 6.0f, false);
  else
    Mtx_PerspTilt(&projection, fovy, C3D_AspectRatioTop, f->near_plane,
                  f->far_plane, false);
  Mtx_Multiply(&vp, &projection, &view);
  C3D_FVUnifMtx4x4(GPU_VERTEX_SHADER, r->u_proj, &vp);
  set_vec(r->u_sundir, f->sun_dir);
  set_vec(r->u_suncol, f->sun_color);
  set_vec(r->u_hsky, f->hemi_sky);
  set_vec(r->u_hgnd, f->hemi_ground);
  set_vec(r->u_fogp, f->fog);
  set_vec(r->u_fogc, f->fog_color);
  set_vec(r->u_eye, f->eye);

  int last_blend = -1, last_cull = -1, last_depth = -1;
  int last_source = -1, last_id = -1;
  float last_mode = -1, last_opacity = -1;
  for (uint32_t i = 0; i < f->draw_count; i++) {
    const pps_draw *d = &f->draws[i];
    const void *verts = NULL;
    const uint16_t *idx = NULL;
    if (d->source == PPS_SOURCE_MODEL) {
      if (d->id >= r->model_cap || !r->models[d->id].ready) continue;
      verts = r->models[d->id].verts;
      idx = r->models[d->id].idx;
    } else if (d->source == PPS_SOURCE_DYNAMIC) {
      verts = r->dyn_verts;
      idx = r->dyn_idx;
    } else {
      uint32_t s = d->source == PPS_SOURCE_GROUND ? 2 : 1;
      if (d->id >= r->batch_cap[s] || !r->batches[s][d->id].ready) continue;
      verts = r->batches[s][d->id].verts;
      idx = r->batches[s][d->id].idx;
    }
    if (!verts || !idx || d->index_count == 0) continue;
    if (d->source != last_source || d->id != last_id) {
      C3D_BufInfo buf;
      BufInfo_Init(&buf);
      BufInfo_Add(&buf, verts, sizeof(Vertex), 3, 0x210);
      C3D_SetBufInfo(&buf);
      last_source = d->source;
      last_id = d->id;
    }
    if (d->blend != last_blend) {
      if (d->blend == PPS_BLEND_ADD)
        C3D_AlphaBlend(GPU_BLEND_ADD, GPU_BLEND_ADD, GPU_SRC_ALPHA, GPU_ONE,
                       GPU_ONE, GPU_ZERO);
      else if (d->blend == PPS_BLEND_ALPHA)
        C3D_AlphaBlend(GPU_BLEND_ADD, GPU_BLEND_ADD, GPU_SRC_ALPHA,
                       GPU_ONE_MINUS_SRC_ALPHA, GPU_ONE, GPU_ZERO);
      else
        C3D_AlphaBlend(GPU_BLEND_ADD, GPU_BLEND_ADD, GPU_ONE, GPU_ZERO, GPU_ONE,
                       GPU_ZERO);
      last_blend = d->blend;
    }
    int depth = (d->flags & PPS_DRAW_DEPTH_WRITE) ? 1 : 0;
    if (depth != last_depth) {
      C3D_DepthTest(true, GPU_GREATER, depth ? GPU_WRITE_ALL : GPU_WRITE_COLOR);
      last_depth = depth;
    }
    int cull = (d->flags & PPS_DRAW_CULL) ? 1 : 0;
    if (cull != last_cull) {
      C3D_CullFace(cull ? GPU_CULL_BACK_CCW : GPU_CULL_NONE);
      last_cull = cull;
    }
    float mode = (d->flags & PPS_DRAW_VERTEX_ALPHA) ? 1.0f : 0.0f;
    if (mode != last_mode || d->opacity != last_opacity) {
      C3D_FVUnifSet(GPU_VERTEX_SHADER, r->u_mode, mode, d->opacity, 0, 0);
      last_mode = mode;
      last_opacity = d->opacity;
    }
    uint32_t nb = d->bones > MAX_BONES ? MAX_BONES : d->bones;
    if (d->bone_first + nb > f->bone_count) continue;
    C3D_FVec *rows = C3D_FVUnifWritePtr(GPU_VERTEX_SHADER, r->u_bones, nb * 4);
    const float *m = f->bones + (size_t)d->bone_first * 16;
    for (uint32_t b = 0; b < nb; b++, m += 16) {
      rows[b * 4 + 0] = FVec4_New(m[0], m[1], m[2], m[3]);
      rows[b * 4 + 1] = FVec4_New(m[4], m[5], m[6], m[7]);
      rows[b * 4 + 2] = FVec4_New(m[8], m[9], m[10], m[11]);
      rows[b * 4 + 3] = FVec4_New(m[12], m[13], m[14], m[15]);
    }
    C3D_DrawElements(GPU_TRIANGLES, (int)d->index_count, C3D_UNSIGNED_SHORT,
                     idx + d->index_first);
    if (stats) {
      stats->draws++;
      stats->bones += nb;
    }
  }
}

bool p3ps_render(p3ps_renderer *r, pps *ps, C3D_RenderTarget *target,
                 C3D_RenderTarget *right, float iod, p3ps_stats *stats) {
  if (!r || !ps || !target) return false;
  const pps_frame *f = pps_prepare(ps, 400.0f / 240.0f);
  if (!f) return false;
  p3ps_stats local = {0};
  if (!sync_models(r, ps, &local.uploads) || !sync_batches(r, ps, 1, &local.uploads) ||
      !sync_batches(r, ps, 2, &local.uploads) || !sync_dynamic(r, f))
    return false;
  local.dyn_vertices = f->dyn_vertex_count;
  local.tris = f->tris;
  eye_pass(r, f, target, right ? -iod : 0.0f, &local);
  if (right) eye_pass(r, f, right, iod, NULL);
  if (stats) *stats = local;
  return true;
}
