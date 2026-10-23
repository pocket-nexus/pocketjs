#ifndef MOCK_CITRO3D_H
#define MOCK_CITRO3D_H
#include "3ds.h"
#include <assert.h>
#include <stddef.h>
#include <string.h>
typedef enum { GPU_RGBA8 } GPU_TEXCOLOR;
enum {
  GPU_RB_RGBA8 = 0,
  GPU_TEX_2D,
  GPU_LINEAR,
  GPU_NEAREST,
  GPU_CLAMP_TO_EDGE,
  GPU_FLOAT,
  GPU_VERTEX_SHADER,
  GPU_ALWAYS,
  GPU_WRITE_COLOR,
  GPU_CULL_NONE,
  GPU_BLEND_ADD,
  GPU_SRC_ALPHA,
  GPU_ONE_MINUS_SRC_ALPHA,
  C3D_Both,
  GPU_TEXTURE0,
  GPU_PRIMARY_COLOR,
  GPU_MODULATE,
  GPU_SCISSOR_NORMAL,
  GPU_SCISSOR_DISABLE,
  GPU_TRIANGLES
};
typedef struct {
  void *data;
  size_t size;
  unsigned maxLevel;
} C3D_Tex;
typedef struct {
  unsigned width, height, maxLevel;
  GPU_TEXCOLOR format;
  unsigned type;
  bool vram;
} C3D_TexInitParams;
typedef struct {
  int DVLE[1];
} DVLB_s;
typedef struct {
  void *vertexShader;
} shaderProgram_s;
typedef struct {
  int n;
} C3D_AttrInfo;
typedef struct {
  void *vertices;
} C3D_BufInfo;
typedef struct {
  float data[16];
} C3D_Mtx;
typedef struct {
  void *colorBuf;
  unsigned width, height;
  int colorFmt;
} C3D_FrameBuf;
typedef struct {
  C3D_FrameBuf frameBuf;
  bool linked;
} C3D_RenderTarget;
typedef struct {
  int n;
} C3D_TexEnv;
static unsigned tex_live, draws, begins, ends;
static bool native_open, queued, fail_tex, fail_buffer;
static C3D_Tex *bound_texture;
static C3D_BufInfo bound_buffers;
static C3D_TexEnv environments[6];
static uint32_t last_scissor[4];
static inline size_t C3D_TexCalcTotalSize(size_t size, unsigned levels) {
  size_t n = 0;
  for (unsigned i = 0; i <= levels; i++) {
    n += size;
    size /= 4;
  }
  return n;
}
static inline bool C3D_TexInitWithParams(C3D_Tex *t, void *cube,
                                         C3D_TexInitParams p) {
  (void)cube;
  if (fail_tex)
    return false;
  t->size = p.width * p.height * 4;
  t->maxLevel = p.maxLevel;
  t->data = malloc(C3D_TexCalcTotalSize(t->size, t->maxLevel));
  if (t->data)
    tex_live++;
  return t->data != NULL;
}
static inline void C3D_TexDelete(C3D_Tex *t) {
  assert(!queued);
  free(t->data);
  t->data = NULL;
  tex_live--;
}
static inline void C3D_TexFlush(C3D_Tex *t) { (void)t; }
static inline void C3D_TexSetFilter(C3D_Tex *t, int a, int b) {
  (void)t;
  (void)a;
  (void)b;
}
static inline void C3D_TexSetWrap(C3D_Tex *t, int a, int b) {
  (void)t;
  (void)a;
  (void)b;
}
static inline void C3D_TexBind(int slot, C3D_Tex *t) {
  (void)slot;
  bound_texture = t;
}
static inline DVLB_s *DVLB_ParseFile(u32 *p, u32 n) {
  (void)p;
  (void)n;
  return calloc(1, sizeof(DVLB_s));
}
static inline void DVLB_Free(DVLB_s *p) { free(p); }
static inline void shaderProgramInit(shaderProgram_s *p) {
  p->vertexShader = p;
}
static inline void shaderProgramSetVsh(shaderProgram_s *p, void *v) {
  (void)p;
  (void)v;
}
static inline int shaderInstanceGetUniformLocation(void *p, const char *n) {
  (void)p;
  (void)n;
  return 0;
}
static inline void shaderProgramFree(shaderProgram_s *p) { (void)p; }
static inline void AttrInfo_Init(C3D_AttrInfo *a) { memset(a, 0, sizeof *a); }
static inline void AttrInfo_AddLoader(C3D_AttrInfo *a, int b, int c, int d) {
  (void)a;
  (void)b;
  (void)c;
  (void)d;
}
static inline void BufInfo_Init(C3D_BufInfo *b) { memset(b, 0, sizeof *b); }
static inline int BufInfo_Add(C3D_BufInfo *b, void *p, size_t n, int a, int c) {
  (void)n;
  (void)a;
  (void)c;
  b->vertices = p;
  return fail_buffer ? -1 : 0;
}
#define C3D_FRAME_SYNCDRAW 1u
#define C3D_FRAME_NONBLOCK 2u
#define C3D_CLEAR_ALL 3u
/* Host-only overlay frames clear their targets before drawing. */
static inline void C3D_RenderTargetClear(C3D_RenderTarget *t, unsigned flags,
                                         unsigned color, unsigned depth) {
  (void)t;
  (void)flags;
  (void)color;
  (void)depth;
}
static inline bool C3D_FrameBegin(unsigned flags) {
  (void)flags;
  if (native_open)
    return false;
  native_open = true;
  queued = false;
  waits++;
  begins++;
  return true;
}
static inline void C3D_FrameEnd(unsigned flags) {
  (void)flags;
  assert(native_open);
  native_open = false;
  ends++;
}
static inline void C3D_SetBufInfo(C3D_BufInfo *b) { bound_buffers = *b; }
static inline void C3D_FrameDrawOn(C3D_RenderTarget *t) {
  (void)t;
  assert(native_open);
}
static inline void C3D_SetViewport(int a, int b, int c, int d) {
  (void)a;
  (void)b;
  (void)c;
  (void)d;
}
static inline void Mtx_OrthoTilt(C3D_Mtx *m, float a, float b, float c, float d,
                                 float e, float f, bool g) {
  (void)m;
  (void)a;
  (void)b;
  (void)c;
  (void)d;
  (void)e;
  (void)f;
  (void)g;
}
static inline void C3D_BindProgram(shaderProgram_s *p) { (void)p; }
static inline void C3D_SetAttrInfo(C3D_AttrInfo *p) { (void)p; }
static inline void C3D_FVUnifMtx4x4(int a, int b, C3D_Mtx *c) {
  (void)a;
  (void)b;
  (void)c;
}
static inline void C3D_DepthTest(bool a, int b, int c) {
  (void)a;
  (void)b;
  (void)c;
}
static inline void C3D_CullFace(int a) { (void)a; }
static inline void C3D_AlphaBlend(int a, int b, int c, int d, int e, int f) {
  (void)a;
  (void)b;
  (void)c;
  (void)d;
  (void)e;
  (void)f;
}
static inline C3D_TexEnv *C3D_GetTexEnv(int i) { return &environments[i]; }
static inline void C3D_TexEnvInit(C3D_TexEnv *p) { (void)p; }
static inline void C3D_TexEnvSrc(C3D_TexEnv *p, int a, int b, int c, int d) {
  (void)p;
  (void)a;
  (void)b;
  (void)c;
  (void)d;
}
static inline void C3D_TexEnvFunc(C3D_TexEnv *p, int a, int b) {
  (void)p;
  (void)a;
  (void)b;
}
static inline void C3D_SetScissor(int mode, uint32_t a, uint32_t b, uint32_t c,
                                  uint32_t d) {
  if (mode == GPU_SCISSOR_NORMAL) {
    last_scissor[0] = a;
    last_scissor[1] = b;
    last_scissor[2] = c;
    last_scissor[3] = d;
  }
}
static inline void C3D_DrawArrays(int a, int first, int count) {
  (void)a;
  (void)first;
  assert(count > 0);
  assert(bound_texture && bound_buffers.vertices);
  assert(native_open);
  draws++;
  queued = true;
}
static inline void C3D_SyncDisplayTransfer(u32 *source, u32 srcdim, u32 *dest,
                                           u32 dim, u32 flags) {
  (void)source;
  (void)srcdim;
  (void)dest;
  (void)dim;
  (void)flags;
  assert(!native_open && !queued);
  transfers++;
}
#endif
