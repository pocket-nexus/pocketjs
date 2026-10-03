#ifndef POCKET_WII_GX_TEXTURE_MOCK_GX_H
#define POCKET_WII_GX_TEXTURE_MOCK_GX_H

#include <stdint.h>

typedef uint8_t u8;
typedef uint16_t u16;
typedef uint32_t u32;
typedef float f32;

typedef struct {
  void *image;
  u16 width;
  u16 height;
  u8 format;
  u8 wrap_s;
  u8 wrap_t;
  u8 mipmap;
  u8 min_filter;
  u8 mag_filter;
} GXTexObj;

#define GX_TF_RGBA8 6
#define GX_CLAMP 0
#define GX_FALSE 0
#define GX_TRUE 1
#define GX_NEAR 0
#define GX_LINEAR 1
#define GX_ANISO_1 0

void GX_InitTexObj(GXTexObj *obj, void *image, u16 width, u16 height,
                   u8 format, u8 wrap_s, u8 wrap_t, u8 mipmap);
void GX_InitTexObjLOD(GXTexObj *obj, u8 min_filter, u8 mag_filter,
                      f32 min_lod, f32 max_lod, f32 lod_bias,
                      u8 bias_clamp, u8 edge_lod, u8 max_aniso);
void GX_DrawDone(void);
void GX_InvalidateTexAll(void);

#endif
