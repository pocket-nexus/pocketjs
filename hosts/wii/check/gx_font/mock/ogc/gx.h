#ifndef POCKET_WII_GX_FONT_MOCK_GX_H
#define POCKET_WII_GX_FONT_MOCK_GX_H

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

#define GX_VTXFMT0 0
#define GX_VA_POS 9
#define GX_VA_CLR0 11
#define GX_VA_TEX0 13
#define GX_DIRECT 1
#define GX_POS_XY 0
#define GX_F32 4
#define GX_CLR_RGBA 1
#define GX_RGBA8 5
#define GX_TEX_ST 1
#define GX_COLOR0A0 4
#define GX_DISABLE 0
#define GX_SRC_VTX 1
#define GX_LIGHTNULL 0
#define GX_DF_NONE 0
#define GX_AF_NONE 2
#define GX_TEXCOORD0 0
#define GX_TEXCOORDNULL 0xff
#define GX_TG_MTX2x4 1
#define GX_TG_TEX0 4
#define GX_IDENTITY 60
#define GX_TEVSTAGE0 0
#define GX_TEXMAP0 0
#define GX_TEXMAP_NULL 0xff
#define GX_MODULATE 0
#define GX_PASSCLR 4
#define GX_CULL_NONE 0
#define GX_ALWAYS 7
#define GX_FALSE 0
#define GX_TRUE 1
#define GX_BM_BLEND 1
#define GX_BL_SRCALPHA 4
#define GX_BL_INVSRCALPHA 5
#define GX_LO_CLEAR 0
#define GX_TRIANGLES 0x90
#define GX_TF_IA8 3
#define GX_CLAMP 0
#define GX_NEAR 0
#define GX_LINEAR 1
#define GX_ANISO_1 0

void GX_InitTexObj(GXTexObj *obj, void *image, u16 width, u16 height,
                   u8 format, u8 wrap_s, u8 wrap_t, u8 mipmap);
void GX_InitTexObjLOD(GXTexObj *obj, u8 min_filter, u8 mag_filter,
                      f32 min_lod, f32 max_lod, f32 lod_bias,
                      u8 bias_clamp, u8 edge_lod, u8 max_aniso);
void GX_InvalidateTexAll(void);
void GX_DrawDone(void);
void GX_LoadTexObj(GXTexObj *obj, u8 mapid);
void GX_ClearVtxDesc(void);
void GX_SetVtxDesc(u8 attribute, u8 type);
void GX_SetVtxAttrFmt(u8 format, u32 attribute, u32 component_type,
                      u32 component_size, u8 fractional_bits);
void GX_SetNumChans(u8 count);
void GX_SetChanCtrl(int32_t channel, u8 enable, u8 ambient_source,
                    u8 material_source, u8 light_mask, u8 diffuse_function,
                    u8 attenuation_function);
void GX_SetNumTexGens(u32 count);
void GX_SetTexCoordGen(u16 texcoord, u32 type, u32 source, u32 matrix);
void GX_SetNumTevStages(u8 count);
void GX_SetTevOrder(u8 stage, u8 coordinate, u32 map, u8 color);
void GX_SetTevOp(u8 stage, u8 mode);
void GX_SetCullMode(u8 mode);
void GX_SetZMode(u8 enable, u8 function, u8 update_enable);
void GX_SetBlendMode(u8 type, u8 source_factor, u8 destination_factor, u8 operation);
void GX_SetColorUpdate(u8 enable);
void GX_SetAlphaUpdate(u8 enable);
void GX_SetScissor(u32 x, u32 y, u32 width, u32 height);
void GX_Begin(u8 primitive, u8 format, u16 vertex_count);
void GX_End(void);
void GX_Position2f32(f32 x, f32 y);
void GX_Color4u8(u8 r, u8 g, u8 b, u8 a);
void GX_TexCoord2f32(f32 s, f32 t);

#endif
