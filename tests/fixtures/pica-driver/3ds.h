#ifndef MOCK_3DS_H
#define MOCK_3DS_H
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
typedef uint32_t u32;
typedef uint64_t u64;
/* The driver times its waits and transfers; the mock clock ticks per read. */
#define SYSCLOCK_ARM11 268111856ull
static uint64_t mock_ticks;
static inline u64 svcGetSystemTick(void) { return mock_ticks += 1000; }
static inline void svcSleepThread(int64_t ns) { (void)ns; }
typedef enum { GFX_TOP, GFX_BOTTOM } gfxScreen_t;
typedef enum { GFX_LEFT, GFX_RIGHT } gfx3dSide_t;
#define GX_TRANSFER_FLIP_VERT(v) 0
#define GX_TRANSFER_OUT_TILED(v) 0
#define GX_TRANSFER_RAW_COPY(v) 0
#define GX_TRANSFER_IN_FORMAT(v) 0
#define GX_TRANSFER_OUT_FORMAT(v) 0
#define GX_TRANSFER_SCALING(v) 0
#define GX_BUFFER_DIM(w, h) (((w) << 16) | (h))
static unsigned swaps[2], transfers, waits, linear_live;
static unsigned char framebuffer[400 * 240 * 3];
static bool fail_linear, stereo_enabled;
static inline bool gfxIs3D(void) { return stereo_enabled; }
static inline void *linearAlloc(size_t size) {
  if (fail_linear)
    return NULL;
  void *p = malloc(size);
  if (p)
    linear_live++;
  return p;
}
static inline void linearFree(void *p) {
  if (p)
    linear_live--;
  free(p);
}
static inline void GSPGPU_FlushDataCache(void *p, size_t n) {
  (void)p;
  (void)n;
}
static inline uint8_t *gfxGetFramebuffer(gfxScreen_t s, gfx3dSide_t side,
                                         uint16_t *w, uint16_t *h) {
  (void)side;
  *w = 240;
  *h = s == GFX_TOP ? 400 : 320;
  return framebuffer;
}
static inline void gfxScreenSwapBuffers(gfxScreen_t s, bool stereo) {
  (void)stereo;
  swaps[s]++;
}
#endif
