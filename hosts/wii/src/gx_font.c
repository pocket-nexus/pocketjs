#include "gx_font.h"
#include "drawlist.h"

#include <malloc.h>
#include <ogc/cache.h>
#include <ogc/gx.h>
#include <stdlib.h>
#include <string.h>

#define POCKET_WII_GX_FONT_MAX_DIM 1024u
#define POCKET_WII_GX_FONT_MAX_COVERAGE (1024u * 1024u)
#define POCKET_WII_GX_FONT_MAX_BATCH (UINT16_MAX / 6u)

/* ponytail: scan at most 1 MiB per glyph run; add a core atlas revision counter if profiling shows this cost. */
typedef struct {
  const uint8_t *identity;
  uint64_t hash;
  size_t coverage_len;
  uint32_t cell_width;
  uint32_t cell_height;
  uint32_t coverage_width;
  uint32_t coverage_height;
  uint32_t glyph_count;
  uint32_t columns;
  uint16_t width;
  uint16_t height;
  size_t image_size;
  uint8_t *image;
  GXTexObj object;
} FontTexture;

_Static_assert(sizeof(GXTexObj) > 0, "libogc GX texture ABI");
#if UINTPTR_MAX == UINT32_MAX
_Static_assert(offsetof(PocketWiiFontAtlas, glyph_count) == 24, "Wii font atlas glyph count offset");
_Static_assert(sizeof(PocketWiiFontAtlas) == 28, "Wii font atlas ABI size");
#endif

extern size_t ui_font_slot_count(void);
extern int32_t ui_font_atlas(uint32_t slot, PocketWiiFontAtlas *out);

static FontTexture *fonts;
static size_t font_count;

static bool cache_grow(size_t slot) {
  if (slot < font_count) return true;
  size_t count = font_count == 0 ? 4 : font_count;
  while (count <= slot) {
    if (count > SIZE_MAX / 2) return false;
    count *= 2;
  }
  if (count > SIZE_MAX / sizeof(*fonts)) return false;
  FontTexture *grown = realloc(fonts, count * sizeof(*fonts));
  if (grown == NULL) return false;
  memset(grown + font_count, 0, (count - font_count) * sizeof(*fonts));
  fonts = grown;
  font_count = count;
  return true;
}

static bool next_power_of_two(uint32_t value, uint32_t *out) {
  if (value == 0 || value > POCKET_WII_GX_FONT_MAX_DIM) return false;
  uint32_t power = 1;
  while (power < value) power <<= 1;
  *out = power;
  return true;
}

static bool font_grid(
  const PocketWiiFontAtlas *atlas,
  uint32_t *out_columns,
  uint16_t *out_width,
  uint16_t *out_height
) {
  if (atlas->coverage_width == 0 || atlas->coverage_height == 0 ||
      atlas->coverage_width > POCKET_WII_GX_FONT_MAX_DIM ||
      atlas->coverage_height > POCKET_WII_GX_FONT_MAX_DIM) {
    return false;
  }

  uint32_t max_columns = POCKET_WII_GX_FONT_MAX_DIM / atlas->coverage_width;
  for (uint32_t columns = 1; columns <= max_columns; columns += 1) {
    if (columns < max_columns &&
        (uint64_t)columns * columns < atlas->glyph_count) {
      continue;
    }
    uint32_t rows = (atlas->glyph_count + columns - 1) / columns;
    uint32_t width;
    uint32_t height;
    if (next_power_of_two(columns * atlas->coverage_width, &width) &&
        next_power_of_two(rows * atlas->coverage_height, &height)) {
      *out_columns = columns;
      *out_width = (uint16_t)width;
      *out_height = (uint16_t)height;
      return true;
    }
  }
  return false;
}

static bool font_valid(const PocketWiiFontAtlas *atlas) {
  if (atlas == NULL || atlas->coverage == NULL || atlas->glyph_count == 0 ||
      atlas->cell_width == 0 || atlas->cell_height == 0 ||
      atlas->coverage_width == 0 || atlas->coverage_height == 0 ||
      atlas->coverage_width > POCKET_WII_GX_FONT_MAX_DIM ||
      atlas->coverage_height > POCKET_WII_GX_FONT_MAX_DIM ||
      atlas->coverage_width % atlas->cell_width != 0 ||
      atlas->coverage_height % atlas->cell_height != 0 ||
      atlas->coverage_width / atlas->cell_width !=
        atlas->coverage_height / atlas->cell_height ||
      atlas->coverage_len > POCKET_WII_GX_FONT_MAX_COVERAGE) {
    return false;
  }

  if ((size_t)atlas->coverage_width > SIZE_MAX / atlas->coverage_height) return false;
  size_t glyph_bytes = (size_t)atlas->coverage_width * atlas->coverage_height;
  if (glyph_bytes == 0 || atlas->glyph_count > SIZE_MAX / glyph_bytes) return false;
  return atlas->coverage_len == glyph_bytes * atlas->glyph_count;
}

static uint64_t coverage_hash(const uint8_t *coverage, size_t length) {
  uint64_t hash = UINT64_C(14695981039346656037);
  for (size_t i = 0; i < length; i += 1) {
    hash ^= coverage[i];
    hash *= UINT64_C(1099511628211);
  }
  return hash;
}

static bool image_size_for(uint16_t width, uint16_t height, size_t *out) {
  size_t tiles_x = ((size_t)width + 3) / 4;
  size_t tiles_y = ((size_t)height + 3) / 4;
  if (tiles_x > SIZE_MAX / tiles_y || tiles_x * tiles_y > SIZE_MAX / 32) {
    return false;
  }
  *out = tiles_x * tiles_y * 32;
  return true;
}

static bool upload_font(FontTexture *entry, const PocketWiiFontAtlas *atlas, uint64_t hash) {
  uint32_t columns;
  uint16_t width;
  uint16_t height;
  size_t image_size;
  if (!font_grid(atlas, &columns, &width, &height) ||
      !image_size_for(width, height, &image_size) || image_size > UINT32_MAX) {
    return false;
  }

  uint8_t *image = entry->image;
  if (image == NULL || entry->image_size != image_size) {
    image = memalign(32, image_size);
    if (image == NULL) return false;
  }
  if (entry->image != NULL) GX_DrawDone();
  memset(image, 0, image_size);

  size_t tiles_x = ((size_t)width + 3) / 4;
  size_t glyph_bytes = (size_t)atlas->coverage_width * atlas->coverage_height;
  for (uint32_t glyph = 0; glyph < atlas->glyph_count; glyph += 1) {
    uint32_t origin_x = (glyph % columns) * atlas->coverage_width;
    uint32_t origin_y = (glyph / columns) * atlas->coverage_height;
    const uint8_t *coverage = atlas->coverage + (size_t)glyph * glyph_bytes;
    for (uint32_t y = 0; y < atlas->coverage_height; y += 1) {
      for (uint32_t x = 0; x < atlas->coverage_width; x += 1) {
        uint32_t tex_x = origin_x + x;
        uint32_t tex_y = origin_y + y;
        size_t tile = ((size_t)(tex_y / 4) * tiles_x + tex_x / 4) * 32;
        size_t pixel = ((size_t)(tex_y & 3) * 4 + (tex_x & 3)) * 2;
        image[tile + pixel] = coverage[(size_t)y * atlas->coverage_width + x];
        image[tile + pixel + 1] = 255;
      }
    }
  }

  DCFlushRange(image, (u32)image_size);
  GX_InvalidateTexAll();
  GX_InitTexObj(&entry->object, image, width, height, GX_TF_IA8,
                GX_CLAMP, GX_CLAMP, GX_FALSE);
  GX_InitTexObjLOD(&entry->object, GX_LINEAR, GX_LINEAR, 0.0f, 0.0f, 0.0f,
                   GX_FALSE, GX_FALSE, GX_ANISO_1);

  if (entry->image != image) free(entry->image);
  entry->image = image;
  entry->image_size = image_size;
  entry->identity = atlas->coverage;
  entry->hash = hash;
  entry->coverage_len = atlas->coverage_len;
  entry->cell_width = atlas->cell_width;
  entry->cell_height = atlas->cell_height;
  entry->coverage_width = atlas->coverage_width;
  entry->coverage_height = atlas->coverage_height;
  entry->glyph_count = atlas->glyph_count;
  entry->columns = columns;
  entry->width = width;
  entry->height = height;
  return true;
}

static bool font_for_slot(uint32_t slot, FontTexture **out) {
  if ((size_t)slot >= ui_font_slot_count() || !cache_grow(slot)) return false;
  PocketWiiFontAtlas atlas = {0};
  if (!ui_font_atlas(slot, &atlas)) return false;
  if (!font_valid(&atlas)) return false;

  uint64_t hash = coverage_hash(atlas.coverage, atlas.coverage_len);
  FontTexture *entry = &fonts[slot];
  if (entry->image == NULL || entry->identity != atlas.coverage ||
      entry->hash != hash || entry->coverage_len != atlas.coverage_len ||
      entry->cell_width != atlas.cell_width || entry->cell_height != atlas.cell_height ||
      entry->coverage_width != atlas.coverage_width ||
      entry->coverage_height != atlas.coverage_height ||
      entry->glyph_count != atlas.glyph_count) {
    if (!upload_font(entry, &atlas, hash)) return false;
  }
  *out = entry;
  return true;
}

static int32_t word_x(uint32_t word) {
  return (int16_t)(word & 0xffffu);
}

static int32_t word_y(uint32_t word) {
  return (int16_t)(word >> 16);
}

static void vertex(float x, float y, float u, float v, uint32_t color) {
  GX_Position2f32(x, y);
  GX_Color4u8((uint8_t)color, (uint8_t)(color >> 8),
              (uint8_t)(color >> 16), (uint8_t)(color >> 24));
  GX_TexCoord2f32(u, v);
}

static void draw_glyph(const FontTexture *font, int32_t x, int32_t y, uint32_t gid,
                       uint32_t color) {
  uint32_t column = gid % font->columns;
  uint32_t row = gid / font->columns;
  float u0 = (float)(column * font->coverage_width) / (float)font->width;
  float v0 = (float)(row * font->coverage_height) / (float)font->height;
  float u1 = (float)((column + 1) * font->coverage_width) / (float)font->width;
  float v1 = (float)((row + 1) * font->coverage_height) / (float)font->height;
  float x0 = (float)x;
  float y0 = (float)y;
  float x1 = x0 + (float)font->cell_width;
  float y1 = y0 + (float)font->cell_height;

  vertex(x0, y0, u0, v0, color);
  vertex(x1, y0, u1, v0, color);
  vertex(x1, y1, u1, v1, color);
  vertex(x0, y0, u0, v0, color);
  vertex(x1, y1, u1, v1, color);
  vertex(x0, y1, u0, v1, color);
}

static void begin_glyph_state(FontTexture *font) {
  GX_ClearVtxDesc();
  GX_SetVtxDesc(GX_VA_POS, GX_DIRECT);
  GX_SetVtxDesc(GX_VA_CLR0, GX_DIRECT);
  GX_SetVtxDesc(GX_VA_TEX0, GX_DIRECT);
  GX_SetVtxAttrFmt(GX_VTXFMT0, GX_VA_POS, GX_POS_XY, GX_F32, 0);
  GX_SetVtxAttrFmt(GX_VTXFMT0, GX_VA_CLR0, GX_CLR_RGBA, GX_RGBA8, 0);
  GX_SetVtxAttrFmt(GX_VTXFMT0, GX_VA_TEX0, GX_TEX_ST, GX_F32, 0);
  GX_SetNumChans(1);
  GX_SetChanCtrl(GX_COLOR0A0, GX_DISABLE, GX_SRC_VTX, GX_SRC_VTX,
                 GX_LIGHTNULL, GX_DF_NONE, GX_AF_NONE);
  GX_SetNumTexGens(1);
  GX_SetTexCoordGen(GX_TEXCOORD0, GX_TG_MTX2x4, GX_TG_TEX0, GX_IDENTITY);
  GX_SetNumTevStages(1);
  GX_SetTevOrder(GX_TEVSTAGE0, GX_TEXCOORD0, GX_TEXMAP0, GX_COLOR0A0);
  GX_SetTevOp(GX_TEVSTAGE0, GX_MODULATE);
  GX_SetCullMode(GX_CULL_NONE);
  GX_SetZMode(GX_DISABLE, GX_ALWAYS, GX_FALSE);
  GX_SetBlendMode(GX_BM_BLEND, GX_BL_SRCALPHA, GX_BL_INVSRCALPHA, GX_LO_CLEAR);
  GX_SetColorUpdate(GX_TRUE);
  GX_SetAlphaUpdate(GX_TRUE);
  GX_LoadTexObj(&font->object, GX_TEXMAP0);
}

static void restore_solid_state(void) {
  GX_ClearVtxDesc();
  GX_SetVtxDesc(GX_VA_POS, GX_DIRECT);
  GX_SetVtxDesc(GX_VA_CLR0, GX_DIRECT);
  GX_SetNumTexGens(0);
  GX_SetTevOrder(GX_TEVSTAGE0, GX_TEXCOORDNULL, GX_TEXMAP_NULL, GX_COLOR0A0);
  GX_SetTevOp(GX_TEVSTAGE0, GX_PASSCLR);
}

bool pocket_wii_gx_font_op(
  const PocketWiiGXContext *context,
  const uint32_t *op,
  size_t word_count
) {
  if (context == NULL || context->width == 0 || context->height == 0 ||
      op == NULL || word_count < 3 || op[0] != POCKET_WII_DRAW_GLYPH_RUN) {
    return false;
  }
  uint32_t header = op[1];
  size_t glyph_count = header >> 16;
  if ((header & 0x0000ff00u) != 0 || glyph_count > (SIZE_MAX - 3) / 2 ||
      word_count != 3 + glyph_count * 2) {
    return false;
  }
  if ((op[2] >> 24) == 0) return true;

  uint32_t slot = header & 0xffu;
  FontTexture *font;
  if (!font_for_slot(slot, &font)) return false;

  size_t valid_count = 0;
  for (size_t glyph = 0; glyph < glyph_count; glyph += 1) {
    size_t body = 3 + glyph * 2;
    if ((op[body + 1] & 0xffff0000u) != 0) return false;
    if ((op[body + 1] & 0xffffu) < font->glyph_count) valid_count += 1;
  }
  if (valid_count == 0) return true;

  begin_glyph_state(font);
  size_t emitted = 0;
  size_t batch_count = valid_count < POCKET_WII_GX_FONT_MAX_BATCH
    ? valid_count : POCKET_WII_GX_FONT_MAX_BATCH;
  GX_Begin(GX_TRIANGLES, GX_VTXFMT0, (u16)(batch_count * 6));
  for (size_t glyph = 0; glyph < glyph_count; glyph += 1) {
    size_t body = 3 + glyph * 2;
    uint32_t gid = op[body + 1] & 0xffffu;
    if (gid >= font->glyph_count) continue;
    draw_glyph(font, word_x(op[body]), word_y(op[body]), gid, op[2]);
    emitted += 1;
    if (emitted < valid_count && emitted % POCKET_WII_GX_FONT_MAX_BATCH == 0) {
      GX_End();
      batch_count = valid_count - emitted;
      if (batch_count > POCKET_WII_GX_FONT_MAX_BATCH) {
        batch_count = POCKET_WII_GX_FONT_MAX_BATCH;
      }
      GX_Begin(GX_TRIANGLES, GX_VTXFMT0, (u16)(batch_count * 6));
    }
  }
  GX_End();
  restore_solid_state();
  return true;
}

void pocket_wii_gx_font_cache_clear(void) {
  bool live = false;
  for (size_t slot = 0; slot < font_count; slot += 1) {
    if (fonts[slot].image != NULL) live = true;
  }
  if (live) GX_DrawDone();
  for (size_t slot = 0; slot < font_count; slot += 1) free(fonts[slot].image);
  free(fonts);
  fonts = NULL;
  font_count = 0;
}
