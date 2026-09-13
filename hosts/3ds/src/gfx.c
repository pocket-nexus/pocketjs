/*
 * PICA200 DrawList backend.
 *
 * The Rust core emits the same flat u32 word stream on every target
 * (contracts/spec/spec.ts "DRAWLIST op format"); this file is the 3DS
 * equivalent of engine/ui-cabi/src/gl/mod.rs — the walk, the texture and
 * font-atlas caches, and batching by texture and scissor are the same shape,
 * only the state they turn into is citro3d instead of GLES.
 *
 * No clipping happens here. The core's CPU clip stage guarantees every
 * coordinate is inside the viewport and i16-safe before the list is emitted.
 *
 * PICA200 constraints that shape the code:
 *   - Textures are power-of-two, 8..1024 per dimension, and must already be
 *     in the hardware's tiled layout: 8x8 tiles row-major, Morton order
 *     inside a tile. C3D_TexUpload is a plain memcpy and will happily upload
 *     garbage.
 *   - Tiled row 0 is sampled at v = 1, so the image is flipped vertically
 *     while it is being tiled and DrawList UVs then pass through unchanged.
 *   - RGBA8 texels are stored bytes A, B, G, R.
 *   - Vertex buffers must live in linearAlloc memory; BufInfo_Add rejects any
 *     pointer below physical 0x18000000, so a malloc'd buffer can never be a
 *     VBO.
 *   - There is no fragment shader. One TEV stage modulates the sampled texel
 *     by the primary colour, and untextured ops bind an 8x8 white texture, so
 *     that single stage covers every op.
 *   - There is no paletted texture format, so PSM_T8 is expanded at upload.
 */

#include "gfx.h"
#include "media.h"

#include <3ds.h>
#include <citro3d.h>
#include <stdlib.h>
#include <string.h>

#include "pocket_core.h"
#include "vshader_shbin.h"

/* contracts/spec/spec.ts DRAW_OP. */
#define DRAW_RECT 1u
#define DRAW_GRAD_RECT 2u
#define DRAW_GLYPH_RUN 3u
#define DRAW_TEX_QUAD 4u
#define DRAW_SCISSOR 5u
#define DRAW_SCISSOR_POP 6u
#define DRAW_TRI 7u
#define DRAW_TEX_TRI 8u

/* contracts/spec/spec.ts GradDir. ToTop is 0 and ToBottom is 1 — swapping the
 * two inverts every vertical gradient, which the other backends cannot hit
 * because they read the generated Rust enum. */
#define GRAD_TO_TOP 0u
#define GRAD_TO_BOTTOM 1u
#define GRAD_TO_LEFT 2u
#define GRAD_TO_RIGHT 3u

/* contracts/spec/spec.ts PSM. */
#define PSM_5650 0u
#define PSM_4444 2u
#define PSM_8888 3u
#define PSM_T8 5u

#define PICA_TEX_MIN 8u
#define PICA_TEX_MAX 1024u

/*
 * Both outputs' geometry lives in one linear-memory bump arena. Build both
 * batches before submitting either one: the GPU reads this arena
 * asynchronously, so resetting it between screens would corrupt the first.
 */
#define MAX_VERTICES 32768u
#define MAX_COMMANDS 2048u
#define MAX_CLIP_DEPTH 64u
#define MAX_SURFACES 2u

typedef struct {
  float x, y;
  float u, v;
  float r, g, b, a;
} Vertex;

typedef struct {
  int32_t x, y, w, h;
} Clip;

typedef struct {
  C3D_Tex *texture;
  uint32_t first;
  uint32_t count;
  Clip clip;
} Command;

typedef struct {
  uint32_t command_first;
  uint32_t command_count;
  uint32_t width;
  uint32_t height;
  C3D_Mtx projection;
  bool prepared;
} SurfaceBatch;

typedef struct {
  C3D_Tex texture;
  int32_t handle;
  uint64_t revision;
  /* Image size over its power-of-two envelope: DrawList UVs are normalised
   * against the image, the sampler against the envelope. */
  float u_scale;
  float v_scale;
  bool live;
} ImageTexture;

typedef struct {
  C3D_Tex texture;
  /* The core's coverage allocation doubles as the cache identity. */
  const uint8_t *coverage;
  uint32_t glyph_count;
  uint32_t coverage_width;
  uint32_t coverage_height;
  uint32_t cell_width;
  uint32_t cell_height;
  uint32_t columns;
  uint32_t texture_width;
  uint32_t texture_height;
  bool live;
} FontTexture;

static DVLB_s *shader_blob;
static shaderProgram_s shader_program;
static int projection_uniform;

static Vertex *vertices;
static uint32_t vertex_count;
static uint32_t dropped_vertices;
static uint32_t dropped_commands;
static Command commands[MAX_COMMANDS];
static uint32_t command_count;
static SurfaceBatch surfaces[MAX_SURFACES];

static C3D_Tex white;
static ImageTexture *images;
static size_t image_capacity;
static FontTexture *fonts;
static size_t font_capacity;

static bool initialized;

// ---------------------------------------------------------------------------
// word decoding
// ---------------------------------------------------------------------------

static inline float word_x(uint32_t word) {
  return (float)(int16_t)(word & 0xffffu);
}

static inline float word_y(uint32_t word) {
  return (float)(int16_t)((word >> 16) & 0xffffu);
}

static inline float word_w(uint32_t word) {
  return (float)(word & 0xffffu);
}

static inline float word_h(uint32_t word) {
  return (float)((word >> 16) & 0xffffu);
}

static inline float word_float(uint32_t word) {
  float value;
  memcpy(&value, &word, sizeof value);
  return value;
}

/* DrawList colours are u32 ABGR, whose little-endian bytes are R, G, B, A. */
static inline void unpack_color(uint32_t color, float *out) {
  out[0] = (float)(color & 0xffu) / 255.0f;
  out[1] = (float)((color >> 8) & 0xffu) / 255.0f;
  out[2] = (float)((color >> 16) & 0xffu) / 255.0f;
  out[3] = (float)((color >> 24) & 0xffu) / 255.0f;
}

// ---------------------------------------------------------------------------
// texture upload
// ---------------------------------------------------------------------------

static uint32_t next_power_of_two(uint32_t value) {
  uint32_t result = PICA_TEX_MIN;
  while (result < value) result <<= 1;
  return result;
}

/* Byte offset of (x, y) inside one 8x8 PICA tile. */
static inline uint32_t morton_offset(uint32_t x, uint32_t y) {
  return (x & 1u) | ((y & 1u) << 1) | ((x & 2u) << 1) | ((y & 2u) << 2) |
         ((x & 4u) << 2) | ((y & 4u) << 3);
}

/* One source texel as R, G, B, A — the core's byte order (see
 * engine/ui-cabi/src/gl/mod.rs texture_rgba, which expands the same formats
 * for GLES). Out-of-image reads are transparent so a non-power-of-two image
 * can sit inside a power-of-two envelope. */
static void fetch_texel(
  const PocketTexture *source,
  uint32_t x,
  uint32_t y,
  uint8_t *out
) {
  size_t index = (size_t)y * source->width + x;
  out[0] = out[1] = out[2] = out[3] = 0;
  switch (source->pixel_storage) {
    case PSM_5650: {
      if ((index + 1) * 2 > source->pixels_length) return;
      uint32_t pixel = (uint32_t)source->pixels[index * 2] |
                       ((uint32_t)source->pixels[index * 2 + 1] << 8);
      uint32_t red = pixel & 0x1fu;
      uint32_t green = (pixel >> 5) & 0x3fu;
      uint32_t blue = (pixel >> 11) & 0x1fu;
      out[0] = (uint8_t)((red << 3) | (red >> 2));
      out[1] = (uint8_t)((green << 2) | (green >> 4));
      out[2] = (uint8_t)((blue << 3) | (blue >> 2));
      out[3] = 255;
      return;
    }
    case PSM_4444: {
      if ((index + 1) * 2 > source->pixels_length) return;
      uint32_t pixel = (uint32_t)source->pixels[index * 2] |
                       ((uint32_t)source->pixels[index * 2 + 1] << 8);
      out[0] = (uint8_t)((pixel & 0x0fu) * 17u);
      out[1] = (uint8_t)(((pixel >> 4) & 0x0fu) * 17u);
      out[2] = (uint8_t)(((pixel >> 8) & 0x0fu) * 17u);
      out[3] = (uint8_t)(((pixel >> 12) & 0x0fu) * 17u);
      return;
    }
    case PSM_8888: {
      if ((index + 1) * 4 > source->pixels_length) return;
      memcpy(out, source->pixels + index * 4, 4);
      return;
    }
    case PSM_T8: {
      if (index + 1 > source->pixels_length || source->palette_length < 1024) return;
      memcpy(out, source->palette + (size_t)source->pixels[index] * 4, 4);
      return;
    }
    default:
      return;
  }
}

/*
 * Tile `width` x `height` source rows into a `texture_width` x
 * `texture_height` power-of-two envelope and hand it to the GPU.
 *
 * The vertical flip lives here: tiled row 0 is sampled at v = 1, so image row
 * 0 has to be the LAST tiled row for a DrawList UV of v = 0 to mean the top
 * of the image. A short envelope therefore leaves its padding at the top.
 */
static bool upload_tiled(
  C3D_Tex *texture,
  const PocketTexture *source,
  const uint8_t *coverage,
  uint32_t width,
  uint32_t height,
  uint32_t texture_width,
  uint32_t texture_height,
  bool linear
) {
  if (!C3D_TexInit(texture, (u16)texture_width, (u16)texture_height, GPU_RGBA8)) return false;
  size_t bytes = (size_t)texture_width * texture_height * 4;
  uint8_t *tiled = malloc(bytes);
  if (tiled == NULL) {
    C3D_TexDelete(texture);
    return false;
  }
  memset(tiled, 0, bytes);
  uint32_t tiles_across = texture_width / 8;
  for (uint32_t ty = 0; ty < texture_height; ty += 8) {
    for (uint32_t tx = 0; tx < texture_width; tx += 8) {
      uint32_t tile = (ty / 8) * tiles_across + (tx / 8);
      for (uint32_t y = 0; y < 8; y += 1) {
        uint32_t row = texture_height - 1 - (ty + y);
        if (row >= height) continue;
        for (uint32_t x = 0; x < 8; x += 1) {
          uint32_t column = tx + x;
          if (column >= width) continue;
          uint8_t rgba[4];
          if (source != NULL) {
            fetch_texel(source, column, row, rgba);
          } else {
            /* Font coverage: white ink, alpha from the glyph grid. */
            rgba[0] = rgba[1] = rgba[2] = 255;
            rgba[3] = coverage[(size_t)row * width + column];
          }
          uint8_t *destination = tiled + ((size_t)tile * 64 + morton_offset(x, y)) * 4;
          destination[0] = rgba[3];
          destination[1] = rgba[2];
          destination[2] = rgba[1];
          destination[3] = rgba[0];
        }
      }
    }
  }
  C3D_TexUpload(texture, tiled);
  /* C3D_TexUpload is a plain memcpy through the CPU's write-back cache, and
   * the PICA samples physical memory: without a flush the GPU reads whatever
   * was there before. Azahar never shows this because its texture reads go
   * through the same emulated memory the memcpy wrote. */
  GSPGPU_FlushDataCache(texture->data, (u32)texture->size);
  C3D_TexSetFilter(
    texture,
    linear ? GPU_LINEAR : GPU_NEAREST,
    linear ? GPU_LINEAR : GPU_NEAREST
  );
  C3D_TexSetWrap(texture, GPU_CLAMP_TO_EDGE, GPU_CLAMP_TO_EDGE);
  free(tiled);
  return true;
}

// ---------------------------------------------------------------------------
// resource sync
// ---------------------------------------------------------------------------

static bool upload_image(ImageTexture *entry, const PocketTexture *source) {
  if (source->width == 0 || source->height == 0) return false;
  if (source->width > PICA_TEX_MAX || source->height > PICA_TEX_MAX) return false;
  uint32_t texture_width = next_power_of_two(source->width);
  uint32_t texture_height = next_power_of_two(source->height);
  if (!upload_tiled(
        &entry->texture,
        source,
        NULL,
        source->width,
        source->height,
        texture_width,
        texture_height,
        source->linear != 0
      )) {
    return false;
  }
  entry->u_scale = (float)source->width / (float)texture_width;
  entry->v_scale = (float)source->height / (float)texture_height;
  return true;
}

/* Lay the glyph coverage cells out in a roughly square grid whose power-of-two
 * envelope the PICA can hold — engine/ui-cabi/src/gl/mod.rs font_grid picks
 * the same shape for GLES. */
static bool font_grid(
  const PocketFontAtlas *atlas,
  uint32_t *out_columns,
  uint32_t *out_width,
  uint32_t *out_height
) {
  if (atlas->coverage_width == 0 || atlas->coverage_height == 0) return false;
  if (atlas->coverage_width > PICA_TEX_MAX || atlas->coverage_height > PICA_TEX_MAX) return false;
  uint32_t max_columns = PICA_TEX_MAX / atlas->coverage_width;
  if (max_columns == 0) return false;
  uint32_t columns = 1;
  while (columns < max_columns && columns * columns < atlas->glyph_count) columns += 1;
  for (;;) {
    uint32_t rows = (atlas->glyph_count + columns - 1) / columns;
    uint32_t width = next_power_of_two(columns * atlas->coverage_width);
    uint32_t height = next_power_of_two(rows * atlas->coverage_height);
    if (width <= PICA_TEX_MAX && height <= PICA_TEX_MAX) {
      *out_columns = columns;
      *out_width = width;
      *out_height = height;
      return true;
    }
    if (columns >= max_columns) return false;
    columns = max_columns;
  }
}

static bool upload_font(FontTexture *entry, const PocketFontAtlas *atlas) {
  uint32_t columns = 0;
  uint32_t texture_width = 0;
  uint32_t texture_height = 0;
  if (!font_grid(atlas, &columns, &texture_width, &texture_height)) return false;
  size_t grid_bytes = (size_t)texture_width * texture_height;
  uint8_t *grid = calloc(grid_bytes, 1);
  if (grid == NULL) return false;
  for (uint32_t glyph = 0; glyph < atlas->glyph_count; glyph += 1) {
    size_t source = (size_t)glyph * atlas->coverage_height * atlas->coverage_width;
    if (source + (size_t)atlas->coverage_height * atlas->coverage_width > atlas->coverage_length) {
      break;
    }
    uint32_t x = (glyph % columns) * atlas->coverage_width;
    uint32_t y = (glyph / columns) * atlas->coverage_height;
    for (uint32_t row = 0; row < atlas->coverage_height; row += 1) {
      memcpy(
        grid + (size_t)(y + row) * texture_width + x,
        atlas->coverage + source + (size_t)row * atlas->coverage_width,
        atlas->coverage_width
      );
    }
  }
  bool ok = upload_tiled(
    &entry->texture,
    NULL,
    grid,
    texture_width,
    texture_height,
    texture_width,
    texture_height,
    true
  );
  free(grid);
  if (!ok) return false;
  entry->coverage = atlas->coverage;
  entry->glyph_count = atlas->glyph_count;
  entry->coverage_width = atlas->coverage_width;
  entry->coverage_height = atlas->coverage_height;
  entry->cell_width = atlas->cell_width;
  entry->cell_height = atlas->cell_height;
  entry->columns = columns;
  entry->texture_width = texture_width;
  entry->texture_height = texture_height;
  return true;
}

static void release_image(ImageTexture *entry) {
  if (entry->live) {
    C3D_TexDelete(&entry->texture);
    entry->live = false;
  }
}

static void release_font(FontTexture *entry) {
  if (entry->live) {
    C3D_TexDelete(&entry->texture);
    entry->live = false;
  }
}

static void sync_resources(void) {
  size_t slots = ui_texture_slot_count();
  if (slots > image_capacity) {
    ImageTexture *grown = realloc(images, slots * sizeof *images);
    if (grown != NULL) {
      memset(grown + image_capacity, 0, (slots - image_capacity) * sizeof *grown);
      images = grown;
      image_capacity = slots;
    } else {
      slots = image_capacity;
    }
  }
  for (size_t slot = 0; slot < image_capacity; slot += 1) {
    ImageTexture *entry = &images[slot];
    PocketTexture source;
    if (slot < slots && ui_texture_at((uint32_t)slot, &source)) {
#ifdef POCKETJS_MEDIA
      if (media_texture(source.handle)) { release_image(entry); continue; }
#endif
      if (entry->live && entry->handle == source.handle && entry->revision == source.revision) {
        continue;
      }
      release_image(entry);
      if (upload_image(entry, &source)) {
        entry->handle = source.handle;
        entry->revision = source.revision;
        entry->live = true;
      }
    } else {
      release_image(entry);
    }
  }

  size_t font_slots = ui_font_slot_count();
  if (font_slots > font_capacity) {
    FontTexture *grown = realloc(fonts, font_slots * sizeof *fonts);
    if (grown != NULL) {
      memset(grown + font_capacity, 0, (font_slots - font_capacity) * sizeof *grown);
      fonts = grown;
      font_capacity = font_slots;
    } else {
      font_slots = font_capacity;
    }
  }
  for (size_t slot = 0; slot < font_capacity; slot += 1) {
    FontTexture *entry = &fonts[slot];
    PocketFontAtlas atlas;
    if (slot < font_slots && ui_font_atlas((uint32_t)slot, &atlas)) {
      if (entry->live && entry->coverage == atlas.coverage &&
          entry->glyph_count == atlas.glyph_count) {
        continue;
      }
      release_font(entry);
      entry->live = upload_font(entry, &atlas);
    } else {
      release_font(entry);
    }
  }
}

static C3D_Tex *image_texture(int32_t handle, float *u_scale, float *v_scale) {
  if (handle < 0) return NULL;
#ifdef POCKETJS_MEDIA
  C3D_Tex *native_media=media_texture(handle);
  if(native_media) { *u_scale=*v_scale=1; return native_media; }
#endif
  size_t slot = (size_t)((uint32_t)handle & ui_texture_slot_mask());
  if (slot >= image_capacity) return NULL;
  ImageTexture *entry = &images[slot];
  if (!entry->live || entry->handle != handle) return NULL;
  *u_scale = entry->u_scale;
  *v_scale = entry->v_scale;
  return &entry->texture;
}

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

static void push_vertex(float x, float y, float u, float v, const float *color) {
  if (vertex_count >= MAX_VERTICES) {
    dropped_vertices += 1;
    return;
  }
  Vertex *vertex = &vertices[vertex_count++];
  vertex->x = x;
  vertex->y = y;
  vertex->u = u;
  vertex->v = v;
  vertex->r = color[0];
  vertex->g = color[1];
  vertex->b = color[2];
  vertex->a = color[3];
}

/* Two triangles, corner colours in top-left, top-right, bottom-right,
 * bottom-left order (the gradient corners GRAD_RECT resolves to). */
static void push_quad(
  float x0,
  float y0,
  float x1,
  float y1,
  float u0,
  float v0,
  float u1,
  float v1,
  const uint32_t *colors
) {
  float top_left[4], top_right[4], bottom_right[4], bottom_left[4];
  unpack_color(colors[0], top_left);
  unpack_color(colors[1], top_right);
  unpack_color(colors[2], bottom_right);
  unpack_color(colors[3], bottom_left);
  push_vertex(x0, y0, u0, v0, top_left);
  push_vertex(x1, y0, u1, v0, top_right);
  push_vertex(x1, y1, u1, v1, bottom_right);
  push_vertex(x0, y0, u0, v0, top_left);
  push_vertex(x1, y1, u1, v1, bottom_right);
  push_vertex(x0, y1, u0, v1, bottom_left);
}

static void flush(C3D_Tex *texture, Clip clip, uint32_t *start) {
  if (vertex_count > *start) {
    if (command_count < MAX_COMMANDS) {
      Command *command = &commands[command_count++];
      command->texture = texture;
      command->first = *start;
      command->count = vertex_count - *start;
      command->clip = clip;
    } else {
      dropped_commands += 1;
    }
  }
  *start = vertex_count;
}

static void build(
  const uint32_t *words,
  size_t length,
  uint32_t viewport_width,
  uint32_t viewport_height
) {
  Clip full = { 0, 0, (int32_t)viewport_width, (int32_t)viewport_height };
  Clip clip = full;
  Clip clip_stack[MAX_CLIP_DEPTH];
  uint32_t clip_depth = 0;
  C3D_Tex *texture = &white;
  /* Surfaces append into one shared arena. A batch starts at the current
   * tail; starting at zero would replay earlier surfaces into this one. */
  uint32_t start = vertex_count;
  size_t index = 0;

  while (index < length) {
    switch (words[index]) {
      case DRAW_RECT: {
        if (index + 4 > length) return;
        if (texture != &white) {
          flush(texture, clip, &start);
          texture = &white;
        }
        float x = word_x(words[index + 1]);
        float y = word_y(words[index + 1]);
        float w = word_w(words[index + 2]);
        float h = word_h(words[index + 2]);
        uint32_t color = words[index + 3];
        if (w > 0.0f && h > 0.0f && (color >> 24) != 0) {
          uint32_t colors[4] = { color, color, color, color };
          push_quad(x, y, x + w, y + h, 0.0f, 0.0f, 1.0f, 1.0f, colors);
        }
        index += 4;
        break;
      }
      case DRAW_GRAD_RECT: {
        if (index + 6 > length) return;
        if (texture != &white) {
          flush(texture, clip, &start);
          texture = &white;
        }
        float x = word_x(words[index + 1]);
        float y = word_y(words[index + 1]);
        float w = word_w(words[index + 2]);
        float h = word_h(words[index + 2]);
        uint32_t from = words[index + 3];
        uint32_t to = words[index + 4];
        uint32_t colors[4];
        switch (words[index + 5]) {
          case GRAD_TO_TOP:
            colors[0] = to; colors[1] = to; colors[2] = from; colors[3] = from;
            break;
          case GRAD_TO_LEFT:
            colors[0] = to; colors[1] = from; colors[2] = from; colors[3] = to;
            break;
          case GRAD_TO_RIGHT:
            colors[0] = from; colors[1] = to; colors[2] = to; colors[3] = from;
            break;
          case GRAD_TO_BOTTOM:
          default:
            colors[0] = from; colors[1] = from; colors[2] = to; colors[3] = to;
            break;
        }
        if (w > 0.0f && h > 0.0f) {
          push_quad(x, y, x + w, y + h, 0.0f, 0.0f, 1.0f, 1.0f, colors);
        }
        index += 6;
        break;
      }
      case DRAW_GLYPH_RUN: {
        if (index + 3 > length) return;
        size_t slot = words[index + 1] & 0xffu;
        size_t count = words[index + 1] >> 16;
        size_t next = index + 3 + count * 2;
        if (next > length) return;
        FontTexture *font = slot < font_capacity ? &fonts[slot] : NULL;
        if (font == NULL || !font->live) {
          index = next;
          break;
        }
        if (texture != &font->texture) {
          flush(texture, clip, &start);
          texture = &font->texture;
        }
        uint32_t color = words[index + 2];
        uint32_t colors[4] = { color, color, color, color };
        for (size_t glyph = 0; glyph < count; glyph += 1) {
          size_t body = index + 3 + glyph * 2;
          uint32_t id = words[body + 1] & 0xffffu;
          if (id >= font->glyph_count) continue;
          float x = word_x(words[body]);
          float y = word_y(words[body]);
          uint32_t column = id % font->columns;
          uint32_t row = id / font->columns;
          float u0 = (float)(column * font->coverage_width) / (float)font->texture_width;
          float v0 = (float)(row * font->coverage_height) / (float)font->texture_height;
          float u1 = (float)((column + 1) * font->coverage_width) / (float)font->texture_width;
          float v1 = (float)((row + 1) * font->coverage_height) / (float)font->texture_height;
          push_quad(
            x,
            y,
            x + (float)font->cell_width,
            y + (float)font->cell_height,
            u0,
            v0,
            u1,
            v1,
            colors
          );
        }
        index = next;
        break;
      }
      case DRAW_TEX_QUAD: {
        if (index + 9 > length) return;
        float u_scale = 1.0f;
        float v_scale = 1.0f;
        C3D_Tex *bound = image_texture((int32_t)words[index + 1], &u_scale, &v_scale);
        if (bound == NULL) {
          index += 9;
          break;
        }
        if (texture != bound) {
          flush(texture, clip, &start);
          texture = bound;
        }
        float x = word_x(words[index + 2]);
        float y = word_y(words[index + 2]);
        float w = word_w(words[index + 3]);
        float h = word_h(words[index + 3]);
        uint32_t color = words[index + 8];
        uint32_t colors[4] = { color, color, color, color };
        if (w > 0.0f && h > 0.0f) {
          push_quad(
            x,
            y,
            x + w,
            y + h,
            word_float(words[index + 4]) * u_scale,
            word_float(words[index + 5]) * v_scale,
            word_float(words[index + 6]) * u_scale,
            word_float(words[index + 7]) * v_scale,
            colors
          );
        }
        index += 9;
        break;
      }
      case DRAW_TEX_TRI: {
        if (index + 12 > length) return;
        float u_scale = 1.0f;
        float v_scale = 1.0f;
        C3D_Tex *bound = image_texture((int32_t)words[index + 1], &u_scale, &v_scale);
        if (bound == NULL) {
          index += 12;
          break;
        }
        if (texture != bound) {
          flush(texture, clip, &start);
          texture = bound;
        }
        float color[4];
        unpack_color(words[index + 11], color);
        for (size_t corner = 0; corner < 3; corner += 1) {
          size_t offset = index + 2 + corner * 3;
          push_vertex(
            word_x(words[offset]),
            word_y(words[offset]),
            word_float(words[offset + 1]) * u_scale,
            word_float(words[offset + 2]) * v_scale,
            color
          );
        }
        index += 12;
        break;
      }
      case DRAW_TRI: {
        if (index + 7 > length) return;
        if (texture != &white) {
          flush(texture, clip, &start);
          texture = &white;
        }
        for (size_t corner = 0; corner < 3; corner += 1) {
          float color[4];
          unpack_color(words[index + 4 + corner], color);
          push_vertex(
            word_x(words[index + 1 + corner]),
            word_y(words[index + 1 + corner]),
            0.0f,
            0.0f,
            color
          );
        }
        index += 7;
        break;
      }
      case DRAW_SCISSOR: {
        if (index + 3 > length) return;
        flush(texture, clip, &start);
        if (clip_depth < MAX_CLIP_DEPTH) clip_stack[clip_depth] = clip;
        clip_depth += 1;
        clip.x = (int32_t)word_x(words[index + 1]);
        clip.y = (int32_t)word_y(words[index + 1]);
        clip.w = (int32_t)word_w(words[index + 2]);
        clip.h = (int32_t)word_h(words[index + 2]);
        index += 3;
        break;
      }
      case DRAW_SCISSOR_POP: {
        flush(texture, clip, &start);
        if (clip_depth > 0) {
          clip_depth -= 1;
          clip = clip_depth < MAX_CLIP_DEPTH ? clip_stack[clip_depth] : full;
        } else {
          clip = full;
        }
        index += 1;
        break;
      }
      default:
        return;
    }
  }
  flush(texture, clip, &start);
}

// ---------------------------------------------------------------------------
// submission
// ---------------------------------------------------------------------------

/*
 * The render target is created rotated — 240 wide by 400 tall — and
 * Mtx_OrthoTilt keeps app coordinates landscape by swapping the axes, so a
 * logical rectangle has to be turned back into the raw framebuffer pixels the
 * scissor register takes.
 *
 * Both scissor axes run OPPOSITE to the logical ones, which is easy to get
 * half right: the horizontal pair counts down from the logical HEIGHT and the
 * vertical pair counts down from the logical WIDTH. Passing the vertical pair
 * un-flipped leaves the rect the right size in the right place along one axis
 * and mirrored along the other, which only shows up when the clipped content
 * is not already the size of its window.
 */
static bool apply_clip(Clip clip, uint32_t viewport_width, uint32_t viewport_height) {
  int32_t x0 = clip.x;
  int32_t y0 = clip.y;
  int32_t x1 = clip.x + clip.w;
  int32_t y1 = clip.y + clip.h;
  /* The core already clipped every coordinate to the viewport, so these
   * clamps never fire; they only keep the unsigned arithmetic below total. */
  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  if (x1 > (int32_t)viewport_width) x1 = (int32_t)viewport_width;
  if (y1 > (int32_t)viewport_height) y1 = (int32_t)viewport_height;
  if (x1 <= x0 || y1 <= y0) return false;
  C3D_SetScissor(
    GPU_SCISSOR_NORMAL,
    (uint32_t)((int32_t)viewport_height - y1),
    (uint32_t)((int32_t)viewport_width - x1),
    (uint32_t)((int32_t)viewport_height - y0),
    (uint32_t)((int32_t)viewport_width - x0)
  );
  return true;
}

void gfx_begin_frame(void) {
  if (!initialized) return;
  sync_resources();
  vertex_count = 0;
  command_count = 0;
  dropped_vertices = 0;
  dropped_commands = 0;
  memset(surfaces, 0, sizeof surfaces);
}

bool gfx_prepare_surface(
  uint32_t surface,
  const uint32_t *words,
  size_t length,
  uint32_t logical_width,
  uint32_t logical_height
) {
  if (!initialized || surface >= MAX_SURFACES || logical_width == 0 || logical_height == 0) {
    return false;
  }
  SurfaceBatch *batch = &surfaces[surface];
  if (batch->prepared) return false;
  uint32_t vertices_dropped_before = dropped_vertices;
  uint32_t commands_dropped_before = dropped_commands;
  batch->command_first = command_count;
  batch->width = logical_width;
  batch->height = logical_height;
  Mtx_OrthoTilt(
    &batch->projection,
    0.0f,
    (float)logical_width,
    (float)logical_height,
    0.0f,
    0.0f,
    1.0f,
    true
  );
  build(words, length, logical_width, logical_height);
  batch->command_count = command_count - batch->command_first;
  batch->prepared = true;
  return dropped_vertices == vertices_dropped_before &&
         dropped_commands == commands_dropped_before;
}

void gfx_finish_frame(void) {
  if (!initialized || vertex_count == 0) return;

  /* The arena is ordinary cached linear memory and the PICA reads main memory
   * directly. Flush once after BOTH outputs have been built, before either
   * render target submits draws. */
  GSPGPU_FlushDataCache(vertices, vertex_count * sizeof *vertices);
}

void gfx_draw_surface(uint32_t surface) {
  if (!initialized || surface >= MAX_SURFACES) return;
  const SurfaceBatch *batch = &surfaces[surface];
  if (!batch->prepared || batch->command_count == 0) return;

  C3D_BindProgram(&shader_program);
  C3D_FVUnifMtx4x4(GPU_VERTEX_SHADER, projection_uniform, &batch->projection);
  C3D_DepthTest(false, GPU_ALWAYS, GPU_WRITE_COLOR);
  C3D_CullFace(GPU_CULL_NONE);
  C3D_AlphaBlend(
    GPU_BLEND_ADD,
    GPU_BLEND_ADD,
    GPU_SRC_ALPHA,
    GPU_ONE_MINUS_SRC_ALPHA,
    GPU_SRC_ALPHA,
    GPU_ONE_MINUS_SRC_ALPHA
  );

  /* One stage: sampled texel times the vertex colour, for RGB and alpha. The
   * five stages behind it pass the result through untouched. */
  C3D_TexEnv *env = C3D_GetTexEnv(0);
  C3D_TexEnvInit(env);
  C3D_TexEnvSrc(env, C3D_Both, GPU_TEXTURE0, GPU_PRIMARY_COLOR, 0);
  C3D_TexEnvFunc(env, C3D_Both, GPU_MODULATE);
  for (int stage = 1; stage < 6; stage += 1) C3D_TexEnvInit(C3D_GetTexEnv(stage));

  C3D_Tex *bound = NULL;
  bool scissored = false;
  uint32_t end = batch->command_first + batch->command_count;
  for (uint32_t index = batch->command_first; index < end; index += 1) {
    const Command *command = &commands[index];
    C3D_Tex *wanted = command->texture;
    if (wanted != bound) {
      C3D_TexBind(0, wanted);
      bound = wanted;
    }
    bool full =
      command->clip.x <= 0 && command->clip.y <= 0 &&
      command->clip.x + command->clip.w >= (int32_t)batch->width &&
      command->clip.y + command->clip.h >= (int32_t)batch->height;
    if (full) {
      if (scissored) {
        C3D_SetScissor(GPU_SCISSOR_DISABLE, 0, 0, 0, 0);
        scissored = false;
      }
    } else {
      if (!apply_clip(command->clip, batch->width, batch->height)) continue;
      scissored = true;
    }
    C3D_DrawArrays(GPU_TRIANGLES, (int)command->first, (int)command->count);
  }
  if (scissored) C3D_SetScissor(GPU_SCISSOR_DISABLE, 0, 0, 0, 0);
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

bool gfx_init(uint32_t logical_width, uint32_t logical_height) {
  (void)logical_width;
  (void)logical_height;

  shader_blob = DVLB_ParseFile((u32 *)vshader_shbin, vshader_shbin_size);
  if (shader_blob == NULL) return false;
  shaderProgramInit(&shader_program);
  shaderProgramSetVsh(&shader_program, &shader_blob->DVLE[0]);
  C3D_BindProgram(&shader_program);
  projection_uniform = shaderInstanceGetUniformLocation(shader_program.vertexShader, "projection");
  if (projection_uniform < 0) return false;

  /* The DrawList is screen space, so the vertex carries no depth: the shader
   * supplies a mid-range z from a constant rather than the buffer spending
   * four bytes a vertex on the same number. */
  C3D_AttrInfo *attributes = C3D_GetAttrInfo();
  AttrInfo_Init(attributes);
  AttrInfo_AddLoader(attributes, 0, GPU_FLOAT, 2); /* position */
  AttrInfo_AddLoader(attributes, 1, GPU_FLOAT, 2); /* texcoord */
  AttrInfo_AddLoader(attributes, 2, GPU_FLOAT, 4); /* colour */

  vertices = linearAlloc((size_t)MAX_VERTICES * sizeof *vertices);
  if (vertices == NULL) return false;
  C3D_BufInfo *buffer = C3D_GetBufInfo();
  BufInfo_Init(buffer);
  if (BufInfo_Add(buffer, vertices, sizeof *vertices, 3, 0x210) < 0) return false;

  uint8_t opaque[8 * 8 * 4];
  memset(opaque, 0xff, sizeof opaque);
  PocketTexture solid = {
    .pixels = opaque,
    .pixels_length = sizeof opaque,
    .palette = NULL,
    .palette_length = 0,
    .width = 8,
    .height = 8,
    .pixel_storage = PSM_8888,
    .linear = 0,
    .handle = -1,
    .revision = 0,
  };
  if (!upload_tiled(&white, &solid, NULL, 8, 8, 8, 8, false)) return false;

  initialized = true;
  return true;
}

void gfx_reset_resources(void) {
  if (!initialized) return;
  for (size_t slot = 0; slot < image_capacity; slot += 1) release_image(&images[slot]);
  for (size_t slot = 0; slot < font_capacity; slot += 1) release_font(&fonts[slot]);
  free(images);
  free(fonts);
  images = NULL;
  fonts = NULL;
  image_capacity = 0;
  font_capacity = 0;
  vertex_count = 0;
  command_count = 0;
  dropped_vertices = 0;
  dropped_commands = 0;
  memset(surfaces, 0, sizeof surfaces);
}

void gfx_shutdown(void) {
  if (!initialized) return;
  gfx_reset_resources();
  C3D_TexDelete(&white);
  linearFree(vertices);
  vertices = NULL;
  shaderProgramFree(&shader_program);
  DVLB_Free(shader_blob);
  shader_blob = NULL;
  initialized = false;
}

uint32_t gfx_dropped_vertices(void) {
  return dropped_vertices;
}

uint32_t gfx_frame_commands(void) {
  return command_count;
}

uint32_t gfx_frame_vertices(void) {
  return vertex_count;
}
