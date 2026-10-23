/* PICA Renderer/Display implementation over the public driver ABI. */
#include "pocket_pica.h"
#include "pocket_pica_driver.h"
#include <3ds.h>
#include <limits.h>
#include <math.h>
#include <pocket_spec.h>
#include <stdlib.h>
#include <string.h>

#define PICA_TEX_MIN 8u
#define PICA_TEX_MAX 1024u
#define MAX_VERTICES 32768u
#define MAX_COMMANDS 2048u
/* Host overlays carry flat geometry only: a scrim and an indicator. */
#define OVERLAY_VERTICES 4096u
#define OVERLAY_COMMANDS 256u
#define PSM_5650 0u
#define PSM_4444 2u
#define PSM_8888 3u
#define PSM_T8 5u
#define HAS(p, type, field)                                                    \
  ((p) && (p)->struct_size >= offsetof(type, field) + sizeof((p)->field))
#define READ_RECORD(dst, src, type, field)                                     \
  (HAS(src, type, field)                                                       \
       ? (memset(&(dst), 0, sizeof(dst)),                                      \
          memcpy(&(dst), (src),                                                \
                 (src)->struct_size < sizeof(dst) ? (src)->struct_size         \
                                                  : sizeof(dst)),              \
          true)                                                                \
       : false)
#define WRITE_RECORD(out, value, type, field)                                  \
  (HAS(out, type, field)                                                       \
       ? (memcpy((out), &(value),                                              \
                 (out)->struct_size < sizeof(value) ? (out)->struct_size       \
                                                    : sizeof(value)),          \
          true)                                                                \
       : false)

typedef struct {
  float x, y, u, v, r, g, b, a;
} Vertex;
typedef struct {
  int32_t x0, y0, x1, y1;
} Clip;
typedef struct Cache Cache;
typedef struct Submission Submission;
typedef struct {
  C3D_Tex *texture;
  uint32_t first, count;
  Clip clip;
} Command;
struct Cache {
  Cache *next;
  C3D_Tex texture;
  int32_t handle;
  uint64_t revision, stamp;
  uint32_t page;
  bool font;
  size_t bytes, refs;
  float us, vs;
};
struct Submission {
  Submission *next;
  uint64_t id;
  Vertex *vertices;
  uint32_t vertex_count, vertex_capacity;
  Command *commands;
  uint32_t command_count, command_capacity;
  Cache **refs;
  size_t ref_count;
  pocket_pica_native_texture *native;
  size_t native_count;
  bool terminal;
  struct pocket_pica_display *display;
  /* Commands from overlay_command draw the host overlay at its own logical
   * size; boundary keeps its first command apart from the guest's last. */
  uint32_t overlay_command, overlay_width, overlay_height;
  bool boundary;
};
struct pocket_pica_renderer {
  pocket_pica_config config;
  DVLB_s *shader;
  shaderProgram_s program;
  C3D_AttrInfo attributes;
  int projection;
  C3D_Tex white;
  bool white_live, frame_open;
  Cache *cache;
  size_t cache_bytes;
  uint64_t next_id, stamp;
  Submission *pending;
  Submission *overlay; /* Storage for host-only frames; never pending. */
  struct pocket_pica_display *displays;
  uint32_t vertices, commands;
  size_t words[2];
};
struct pocket_pica_display {
  struct pocket_pica_display *next;
  pocket_pica_renderer *renderer;
  C3D_RenderTarget *target, *right;
  uint32_t role, width, height;
  uint64_t id, token;
  pocket_rect region;
  bool acquired, flushed;
};
static uint64_t next_target_identity;

typedef struct {
  pocket_pica_renderer *renderer;
  Submission *submission;
  pocket_render_resources resources;
  uint32_t width, height;
} Build;

static float word_x(uint32_t word) { return (float)(int16_t)word; }
static float word_y(uint32_t word) { return (float)(int16_t)(word >> 16); }
static float word_w(uint32_t word) { return (float)(word & 65535u); }
static float word_h(uint32_t word) { return (float)(word >> 16); }
static float word_float(uint32_t word) {
  float v;
  memcpy(&v, &word, 4);
  return v;
}
static void unpack_color(uint32_t c, float *v) {
  for (unsigned i = 0; i < 4; i++)
    v[i] = (float)((c >> (i * 8)) & 255u) / 255.0f;
}
static uint32_t next_power_of_two(uint32_t value) {
  uint32_t result = PICA_TEX_MIN;
  while (result < value)
    result <<= 1;
  return result;
}

/* Byte offset of (x, y) inside one 8x8 PICA tile. */
static inline uint32_t morton_offset(uint32_t x, uint32_t y) {
  return (x & 1u) | ((y & 1u) << 1) | ((x & 2u) << 1) | ((y & 2u) << 2) |
         ((x & 4u) << 2) | ((y & 4u) << 3);
}

/* One source texel as R, G, B, A — the core's byte order (see
 * devices/gles/pocket-gles/src/pixels.rs, which expands the same formats
 * for GLES). Out-of-image reads are transparent so a non-power-of-two image
 * can sit inside a power-of-two envelope. */
static void fetch_texel(const pocket_texture_view *source, uint32_t x,
                        uint32_t y, uint8_t *out) {
  size_t index = (size_t)y * source->width + x;
  out[0] = out[1] = out[2] = out[3] = 0;
  switch (source->psm) {
  case PSM_5650: {
    if ((index + 1) * 2 > source->byte_length)
      return;
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
    if ((index + 1) * 2 > source->byte_length)
      return;
    uint32_t pixel = (uint32_t)source->pixels[index * 2] |
                     ((uint32_t)source->pixels[index * 2 + 1] << 8);
    out[0] = (uint8_t)((pixel & 0x0fu) * 17u);
    out[1] = (uint8_t)(((pixel >> 4) & 0x0fu) * 17u);
    out[2] = (uint8_t)(((pixel >> 8) & 0x0fu) * 17u);
    out[3] = (uint8_t)(((pixel >> 12) & 0x0fu) * 17u);
    return;
  }
  case PSM_8888: {
    if ((index + 1) * 4 > source->byte_length)
      return;
    memcpy(out, source->pixels + index * 4, 4);
    return;
  }
  case PSM_T8: {
    if (index + 1 > source->byte_length || source->palette_byte_length < 1024)
      return;
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
static bool upload_tiled(C3D_Tex *texture, const pocket_texture_view *source,
                         const uint8_t *coverage, uint32_t width,
                         uint32_t height, uint32_t texture_width,
                         uint32_t texture_height, bool linear) {
  size_t bytes = (size_t)texture_width * texture_height * 4;
  if (!pocket_pica_texture_init(texture, texture_width, texture_height, 1,
                                GPU_RGBA8, bytes))
    return false;
  uint8_t *tiled = malloc(bytes);
  if (tiled == NULL) {
    pocket_pica_texture_destroy(texture);
    return false;
  }
  memset(tiled, 0, bytes);
  uint32_t tiles_across = texture_width / 8;
  for (uint32_t ty = 0; ty < texture_height; ty += 8) {
    for (uint32_t tx = 0; tx < texture_width; tx += 8) {
      uint32_t tile = (ty / 8) * tiles_across + (tx / 8);
      for (uint32_t y = 0; y < 8; y += 1) {
        uint32_t row = texture_height - 1 - (ty + y);
        if (row >= height)
          continue;
        for (uint32_t x = 0; x < 8; x += 1) {
          uint32_t column = tx + x;
          if (column >= width)
            continue;
          uint8_t rgba[4];
          if (source != NULL) {
            fetch_texel(source, column, row, rgba);
          } else {
            /* Font coverage: white ink, alpha from the glyph grid. */
            rgba[0] = rgba[1] = rgba[2] = 255;
            rgba[3] = coverage[(size_t)row * width + column];
          }
          uint8_t *destination =
              tiled + ((size_t)tile * 64 + morton_offset(x, y)) * 4;
          destination[0] = rgba[3];
          destination[1] = rgba[2];
          destination[2] = rgba[1];
          destination[3] = rgba[0];
        }
      }
    }
  }
  if (!pocket_pica_texture_upload(texture, tiled, bytes)) {
    free(tiled);
    pocket_pica_texture_destroy(texture);
    return false;
  }
  C3D_TexSetFilter(texture, linear ? GPU_LINEAR : GPU_NEAREST,
                   linear ? GPU_LINEAR : GPU_NEAREST);
  C3D_TexSetWrap(texture, GPU_CLAMP_TO_EDGE, GPU_CLAMP_TO_EDGE);
  free(tiled);
  return true;
}

static void cache_delete(pocket_pica_renderer *r, Cache **slot) {
  Cache *entry = *slot;
  *slot = entry->next;
  r->cache_bytes -= entry->bytes;
  pocket_pica_texture_destroy(&entry->texture);
  free(entry);
}
static bool reserve_cache(pocket_pica_renderer *r, size_t bytes) {
  if (bytes > r->config.texture_budget)
    return false;
  while (r->cache_bytes > r->config.texture_budget - bytes) {
    Cache **oldest = NULL;
    for (Cache **p = &r->cache; *p; p = &(*p)->next)
      if (!(*p)->refs && (!oldest || (*p)->stamp < (*oldest)->stamp))
        oldest = p;
    if (!oldest)
      return false;
    cache_delete(r, oldest);
  }
  return true;
}
static bool pin(Submission *s, Cache *entry) {
  for (size_t i = 0; i < s->ref_count; i++)
    if (s->refs[i] == entry)
      return true;
  if (s->ref_count >= MAX_COMMANDS)
    return false;
  s->refs[s->ref_count++] = entry;
  entry->refs++;
  return true;
}
static Cache *find_cache(Build *b, int32_t handle, uint64_t revision, bool font,
                         uint32_t page) {
  for (Cache *p = b->renderer->cache; p; p = p->next)
    if (p->handle == handle && p->revision == revision && p->font == font &&
        p->page == page) {
      p->stamp = ++b->renderer->stamp;
      return pin(b->submission, p) ? p : NULL;
    }
  return NULL;
}
static bool publish_cache(Build *b, Cache *entry) {
  if (!pin(b->submission, entry)) {
    pocket_pica_texture_destroy(&entry->texture);
    free(entry);
    return false;
  }
  entry->stamp = ++b->renderer->stamp;
  entry->next = b->renderer->cache;
  b->renderer->cache = entry;
  b->renderer->cache_bytes += entry->bytes;
  return true;
}
static int32_t image_texture(Build *b, int32_t handle, C3D_Tex **out, float *us,
                             float *vs) {
  *out = NULL;
  *us = *vs = 1;
  if (handle < 0)
    return POCKET_STATUS_OK;
  pocket_pica_renderer *r = b->renderer;
  Submission *s = b->submission;
  if (r->config.resolve) {
    pocket_pica_native_texture native = {0};
    int32_t status = r->config.resolve(r->config.context, handle, &native);
    if (status)
      return status;
    if (native.texture) {
      if (s->native_count >= MAX_COMMANDS || !isfinite(native.u_scale) ||
          !isfinite(native.v_scale)) {
        r->config.release(r->config.context, native.lease);
        return POCKET_STATUS_FAILED;
      }
      s->native[s->native_count++] = native;
      *out = native.texture;
      *us = native.u_scale;
      *vs = native.v_scale;
      return POCKET_STATUS_OK;
    }
  }
  const pocket_render_resources *res = &b->resources;
  uint64_t revision = res->raster_revision;
  if (res->texture_revision &&
      res->texture_revision(res->context, handle, &revision))
    return 0;
  Cache *cached = find_cache(b, handle, revision, false, 0);
  if (cached) {
    *out = &cached->texture;
    *us = cached->us;
    *vs = cached->vs;
    return 0;
  }
  pocket_texture_view source = {.struct_size = sizeof source};
  if (!res->texture || res->texture(res->context, handle, &source))
    return 0;
  if (source.struct_size <
          offsetof(pocket_texture_view, linear) + sizeof source.linear ||
      !source.width || !source.height || source.width > 1024 ||
      source.height > 1024 || !source.pixels)
    return POCKET_STATUS_INVALID;
  size_t pixel_bytes = source.psm == PSM_8888 ? 4
                       : source.psm == PSM_T8 ? 1
                                              : 2;
  if (source.psm != PSM_8888 && source.psm != PSM_T8 &&
      source.psm != PSM_5650 && source.psm != PSM_4444)
    return POCKET_STATUS_UNSUPPORTED;
  if (source.byte_length < (size_t)source.width * source.height * pixel_bytes ||
      (source.psm == PSM_T8 &&
       (!source.palette || source.palette_byte_length < 1024)))
    return POCKET_STATUS_INVALID;
  uint32_t w = next_power_of_two(source.width),
           h = next_power_of_two(source.height);
  size_t bytes = (size_t)w * h * 4;
  if (!reserve_cache(r, bytes))
    return POCKET_STATUS_FAILED;
  Cache *entry = calloc(1, sizeof *entry);
  if (!entry)
    return POCKET_STATUS_FAILED;
  if (!upload_tiled(&entry->texture, &source, NULL, source.width, source.height,
                    w, h, source.linear != 0)) {
    free(entry);
    return POCKET_STATUS_FAILED;
  }
  entry->handle = handle;
  entry->revision = revision;
  entry->bytes = bytes;
  entry->us = (float)source.width / w;
  entry->vs = (float)source.height / h;
  if (!publish_cache(b, entry))
    return POCKET_STATUS_FAILED;
  *out = &entry->texture;
  *us = entry->us;
  *vs = entry->vs;
  return 0;
}
static int32_t font_texture(Build *b, uint8_t slot, uint32_t gid,
                            const pocket_font_view *font, C3D_Tex **out,
                            float *uv) {
  pocket_glyph_page page = {.struct_size = sizeof page};
  int32_t status = pocket_glyph_page_a8(font, gid, 1024, NULL, 0, &page);
  if (status)
    return status;
  memcpy(uv, page.uv, sizeof page.uv);
  uint64_t revision = b->resources.raster_revision;
  if (b->resources.font_revision &&
      b->resources.font_revision(b->resources.context, slot, &revision))
    return POCKET_STATUS_INVALID;
  Cache *entry = find_cache(b, slot, revision, true, page.page);
  if (entry) {
    for (unsigned i = 0; i < 4; i++)
      uv[i] *= (i & 1) ? entry->vs : entry->us;
    *out = &entry->texture;
    return 0;
  }
  size_t bytes = (size_t)page.width * page.height;
  uint32_t tw = next_power_of_two(page.width),
           th = next_power_of_two(page.height);
  if (!reserve_cache(b->renderer, (size_t)tw * th * 4))
    return POCKET_STATUS_FAILED;
  uint8_t *coverage = malloc(bytes);
  if (!coverage)
    return POCKET_STATUS_FAILED;
  status = pocket_glyph_page_a8(font, gid, 1024, coverage, bytes, &page);
  entry = calloc(1, sizeof *entry);
  if (status || !entry ||
      !upload_tiled(&entry->texture, NULL, coverage, page.width, page.height,
                    tw, th, true)) {
    free(coverage);
    free(entry);
    return status ? status : POCKET_STATUS_FAILED;
  }
  free(coverage);
  entry->font = true;
  entry->handle = slot;
  entry->page = page.page;
  entry->revision = revision;
  entry->bytes = (size_t)tw * th * 4;
  entry->us = (float)page.width / tw;
  entry->vs = (float)page.height / th;
  if (!publish_cache(b, entry))
    return POCKET_STATUS_FAILED;
  for (unsigned i = 0; i < 4; i++)
    uv[i] *= (i & 1) ? entry->vs : entry->us;
  *out = &entry->texture;
  return 0;
}
static void vertex(Submission *s, float x, float y, float u, float v,
                   uint32_t rgba) {
  Vertex *p = &s->vertices[s->vertex_count++];
  p->x = x;
  p->y = y;
  p->u = u;
  p->v = v;
  unpack_color(rgba, &p->r);
}
static void quad(Submission *s, float x, float y, float w, float h,
                 const float *uv, const uint32_t *c) {
  vertex(s, x, y, uv[0], uv[1], c[0]);
  vertex(s, x + w, y, uv[2], uv[1], c[1]);
  vertex(s, x + w, y + h, uv[2], uv[3], c[2]);
  vertex(s, x, y, uv[0], uv[1], c[0]);
  vertex(s, x + w, y + h, uv[2], uv[3], c[2]);
  vertex(s, x, y + h, uv[0], uv[3], c[3]);
}
static bool command(Submission *s, C3D_Tex *texture, Clip clip,
                    uint32_t count) {
  if (count > s->vertex_capacity - s->vertex_count)
    return false;
  if (s->command_count && !s->boundary) {
    Command *last = &s->commands[s->command_count - 1];
    if (last->texture == texture && !memcmp(&last->clip, &clip, sizeof clip)) {
      last->count += count;
      return true;
    }
  }
  if (s->command_count >= s->command_capacity)
    return false;
  s->commands[s->command_count++] =
      (Command){texture, s->vertex_count, count, clip};
  s->boundary = false;
  return true;
}
static int32_t visit(void *context, const pocket_draw_op *raw) {
  Build *b = context;
  Submission *s = b->submission;
  pocket_draw_op op;
  if (!READ_RECORD(op, raw, pocket_draw_op, word_count) || !op.words ||
      !op.word_count)
    return POCKET_STATUS_INVALID;
  const uint32_t *w = op.words;
  uint32_t scale = HAS(raw, pocket_draw_op, scale) ? op.scale : 1;
  if (!scale)
    return POCKET_STATUS_INVALID;
  Clip clip = {0, 0, (int32_t)b->width, (int32_t)b->height};
  if (HAS(raw, pocket_draw_op, clip) && op.clip) {
    if (!HAS(op.clip, pocket_logical_clip, y1))
      return POCKET_STATUS_INVALID;
    clip = (Clip){op.clip->x0, op.clip->y0, op.clip->x1, op.clip->y1};
  }
  if (clip.x0 < 0)
    clip.x0 = 0;
  if (clip.y0 < 0)
    clip.y0 = 0;
  if (clip.x1 > (int32_t)b->width)
    clip.x1 = b->width;
  if (clip.y1 > (int32_t)b->height)
    clip.y1 = b->height;
  if (clip.x1 <= clip.x0 || clip.y1 <= clip.y0)
    return 0;
  C3D_Tex *texture = &b->renderer->white;
  uint32_t colors[4];
  float uv[4] = {0, 0, 1, 1};
  if (w[0] == POCKET_DRAW_OP_SCISSOR || w[0] == POCKET_DRAW_OP_SCISSOR_POP)
    return 0;
  if (w[0] == POCKET_DRAW_OP_GLYPH_RUN) {
    uint8_t slot = (uint8_t)w[1];
    uint32_t count = w[1] >> 16;
    pocket_font_view font = {.struct_size = sizeof font};
    if (!b->resources.font_atlas ||
        b->resources.font_atlas(b->resources.context, slot, &font))
      return 0;
    if (font.struct_size <
        offsetof(pocket_font_view, glyph_count) + sizeof font.glyph_count)
      return POCKET_STATUS_INVALID;
    for (unsigned i = 0; i < 4; i++)
      colors[i] = w[2];
    for (uint32_t i = 0; i < count; i++) {
      uint32_t gid = w[4 + 2 * i] & 65535u;
      if (gid >= font.glyph_count)
        continue;
      int32_t status = font_texture(b, slot, gid, &font, &texture, uv);
      if (status)
        return status;
      if (!command(s, texture, clip, 6))
        return POCKET_STATUS_FAILED;
      quad(s, word_x(w[3 + 2 * i]) * scale, word_y(w[3 + 2 * i]) * scale,
           (float)font.cell_width * scale, (float)font.cell_height * scale, uv,
           colors);
    }
    return 0;
  }
  if (w[0] == POCKET_DRAW_OP_TEX_QUAD || w[0] == POCKET_DRAW_OP_TEX_TRI) {
    float us, vs;
    int32_t status = image_texture(b, (int32_t)w[1], &texture, &us, &vs);
    if (status || !texture)
      return status;
    if (w[0] == POCKET_DRAW_OP_TEX_TRI) {
      if (!command(s, texture, clip, 3))
        return POCKET_STATUS_FAILED;
      for (unsigned i = 0; i < 3; i++)
        vertex(s, word_x(w[2 + i * 3]) * scale, word_y(w[2 + i * 3]) * scale,
               word_float(w[3 + i * 3]) * us, word_float(w[4 + i * 3]) * vs,
               w[11]);
      return 0;
    }
    for (unsigned i = 0; i < 4; i++) {
      uv[i] = word_float(w[4 + i]) * ((i & 1) ? vs : us);
      colors[i] = w[8];
    }
    if (!command(s, texture, clip, 6))
      return POCKET_STATUS_FAILED;
    quad(s, word_x(w[2]) * scale, word_y(w[2]) * scale, word_w(w[3]) * scale,
         word_h(w[3]) * scale, uv, colors);
    return 0;
  }
  if (w[0] == POCKET_DRAW_OP_TRI) {
    if (!command(s, texture, clip, 3))
      return POCKET_STATUS_FAILED;
    for (unsigned i = 0; i < 3; i++)
      vertex(s, word_x(w[1 + i]) * scale, word_y(w[1 + i]) * scale, 0, 0,
             w[4 + i]);
    return 0;
  }
  if (w[0] != POCKET_DRAW_OP_RECT && w[0] != POCKET_DRAW_OP_GRAD_RECT)
    return POCKET_STATUS_UNSUPPORTED;
  for (unsigned i = 0; i < 4; i++)
    colors[i] = w[3];
  if (w[0] == POCKET_DRAW_OP_GRAD_RECT) {
    switch (w[5]) {
    case 0:
      colors[0] = colors[1] = w[4];
      break;
    case 2:
      colors[0] = colors[3] = w[4];
      break;
    case 3:
      colors[1] = colors[2] = w[4];
      break;
    default:
      colors[2] = colors[3] = w[4];
      break;
    }
  }
  if (!command(s, texture, clip, 6))
    return POCKET_STATUS_FAILED;
  quad(s, word_x(w[1]) * scale, word_y(w[1]) * scale, word_w(w[2]) * scale,
       word_h(w[2]) * scale, uv, colors);
  return 0;
}

/* End the open frame and wait for the GPU to finish it. */
static void gpu_idle(pocket_pica_renderer *r) {
  C3D_FrameEnd(0);
  /* Blocking FrameBegin waits and clears the preceding GPU queue. FrameSync
   * only waits for VBlank and cannot establish this resource lifetime. */
  if (!C3D_FrameBegin(0))
    abort(); /* Context ownership was violated. */
  C3D_TexBind(0, &r->white);
  C3D_BufInfo empty;
  BufInfo_Init(&empty);
  C3D_SetBufInfo(&empty);
  C3D_FrameEnd(0);
}
static bool drain(pocket_pica_renderer *r) {
  if (!r->frame_open)
    return true;
  r->frame_open = false;
  gpu_idle(r);
  for (Submission *p = r->pending; p; p = p->next)
    p->terminal = true;
  return true;
}
static void release_submission(pocket_pica_renderer *r, Submission *s) {
  for (size_t i = 0; i < s->ref_count; i++)
    s->refs[i]->refs--;
  for (size_t i = 0; i < s->native_count; i++)
    r->config.release(r->config.context, s->native[i].lease);
  linearFree(s->vertices);
  free(s->commands);
  free(s->refs);
  free(s->native);
  free(s);
}
static void draw_commands(pocket_pica_renderer *r, Submission *s,
                          C3D_RenderTarget *target, uint32_t first,
                          uint32_t end, uint32_t logical_w,
                          uint32_t logical_h) {
  pocket_pica_display *display = s->display;
  if (first >= end)
    return;
  C3D_FrameDrawOn(target);
  C3D_SetViewport(0, 0, display->height, display->width);
  C3D_Mtx projection;
  Mtx_OrthoTilt(&projection, 0, (float)logical_w, (float)logical_h, 0, 0, 1,
                true);
  C3D_BufInfo buffers;
  BufInfo_Init(&buffers);
  if (BufInfo_Add(&buffers, s->vertices, sizeof(Vertex), 3, 0x210) < 0)
    abort();
  C3D_BindProgram(&r->program);
  C3D_SetAttrInfo(&r->attributes);
  C3D_SetBufInfo(&buffers);
  C3D_FVUnifMtx4x4(GPU_VERTEX_SHADER, r->projection, &projection);
  C3D_DepthTest(false, GPU_ALWAYS, GPU_WRITE_COLOR);
  C3D_CullFace(GPU_CULL_NONE);
  C3D_AlphaBlend(GPU_BLEND_ADD, GPU_BLEND_ADD, GPU_SRC_ALPHA,
                 GPU_ONE_MINUS_SRC_ALPHA, GPU_SRC_ALPHA,
                 GPU_ONE_MINUS_SRC_ALPHA);
  C3D_TexEnv *env = C3D_GetTexEnv(0);
  C3D_TexEnvInit(env);
  C3D_TexEnvSrc(env, C3D_Both, GPU_TEXTURE0, GPU_PRIMARY_COLOR, 0);
  C3D_TexEnvFunc(env, C3D_Both, GPU_MODULATE);
  for (int i = 1; i < 6; i++)
    C3D_TexEnvInit(C3D_GetTexEnv(i));
  for (uint32_t i = first; i < end; i++) {
    Command *cmd = &s->commands[i];
    uint32_t x0 = (uint64_t)cmd->clip.x0 * display->width / logical_w;
    uint32_t y0 = (uint64_t)cmd->clip.y0 * display->height / logical_h;
    uint32_t x1 =
        ((uint64_t)cmd->clip.x1 * display->width + logical_w - 1) / logical_w;
    uint32_t y1 =
        ((uint64_t)cmd->clip.y1 * display->height + logical_h - 1) / logical_h;
    C3D_SetScissor(GPU_SCISSOR_NORMAL, display->height - y1,
                   display->width - x1, display->height - y0,
                   display->width - x0);
    C3D_TexBind(0, cmd->texture);
    C3D_DrawArrays(GPU_TRIANGLES, cmd->first, cmd->count);
  }
  C3D_SetScissor(GPU_SCISSOR_DISABLE, 0, 0, 0, 0);
}
/* The guest's commands on the display's target. */
static void draw(pocket_pica_renderer *r, Submission *s, uint32_t logical_w,
                 uint32_t logical_h) {
  draw_commands(r, s, s->display->target, 0, s->overlay_command, logical_w,
                logical_h);
}
/* The host overlay's commands over both eyes of a stereo display. */
static void draw_overlay(pocket_pica_renderer *r, Submission *s) {
  pocket_pica_display *display = s->display;
  if (s->overlay_command >= s->command_count)
    return;
  draw_commands(r, s, display->target, s->overlay_command, s->command_count,
                s->overlay_width, s->overlay_height);
  if (display->right && gfxIs3D())
    draw_commands(r, s, display->right, s->overlay_command, s->command_count,
                  s->overlay_width, s->overlay_height);
}
/* Visit a host overlay list into s at its own logical size, after the guest's
 * commands. No resource lookups: the overlay carries flat geometry only. */
static int32_t build_overlay(pocket_pica_renderer *r, Submission *s,
                             const pocket_pica_overlay *overlay) {
  pocket_pica_display *display = s->display;
  s->overlay_command = s->command_count;
  s->overlay_width = s->overlay_height = 0;
  if (!overlay->subpixels || !overlay->list.word_count)
    return 0;
  if (overlay->subpixels > 64)
    return POCKET_STATUS_INVALID;
  pocket_render_resources resources = {
      .struct_size = sizeof resources,
      .viewport_width = (float)(display->width * overlay->subpixels),
      .viewport_height = (float)(display->height * overlay->subpixels)};
  Build b = {r, s, resources, display->width * overlay->subpixels,
             display->height * overlay->subpixels};
  s->boundary = true;
  int32_t status =
      pocket_draw_list_visit(&overlay->list, &resources, 1, visit, &b);
  s->boundary = false;
  if (status)
    return status;
  s->overlay_width = b.width;
  s->overlay_height = b.height;
  return 0;
}
static int32_t renderer_descriptor(void *context,
                                   pocket_renderer_descriptor *out) {
  if (!context)
    return POCKET_STATUS_INVALID;
  static const uint32_t formats[] = {POCKET_PIXEL_FORMAT_RGBA8888};
  /* IMMEDIATE: render records into an open citro3d frame that only the
   * renderer wait ends and drains. A frame left open across the guest turn
   * would block host overlays and native frames. */
  pocket_renderer_descriptor value = {sizeof value,
                                      formats,
                                      1,
                                      POCKET_TARGET_DEVICE_OWNED,
                                      POCKET_SYNC_IMMEDIATE,
                                      POCKET_DRAW_LIST_VERSION,
                                      0};
  return WRITE_RECORD(out, value, pocket_renderer_descriptor, zero_copy)
             ? 0
             : POCKET_STATUS_INVALID;
}
static int32_t render(void *context, const pocket_frame_input *raw,
                      uint64_t *out) {
  pocket_pica_renderer *r = context;
  pocket_frame_input frame;
  pocket_target target;
  pocket_render_resources resources;
  pocket_rect region;
  if (!r || !out || !READ_RECORD(frame, raw, pocket_frame_input, target) ||
      !READ_RECORD(target, frame.target, pocket_target, device_handle) ||
      !READ_RECORD(resources, frame.resources, pocket_render_resources,
                   font_atlas) ||
      !READ_RECORD(region, target.region, pocket_rect, height) ||
      target.kind != POCKET_TARGET_DEVICE_OWNED ||
      target.pixel_format != POCKET_PIXEL_FORMAT_RGBA8888 ||
      !isfinite(resources.viewport_width) ||
      !isfinite(resources.viewport_height) || resources.viewport_width < 1 ||
      resources.viewport_height < 1 || resources.viewport_width > 65535 ||
      resources.viewport_height > 65535)
    return POCKET_STATUS_INVALID;
  /* A standalone prefix can end in the middle of a newly appended field.
   * Never turn those partial bytes into a callable function pointer. */
  if (!HAS(frame.resources, pocket_render_resources, texture_revision))
    resources.texture_revision = NULL;
  if (!HAS(frame.resources, pocket_render_resources, font_revision))
    resources.font_revision = NULL;
  if (!HAS(frame.resources, pocket_render_resources, font_texture_width))
    resources.font_texture_width = NULL;
  pocket_pica_display *display = r->displays;
  while (display && display->id != target.device_handle)
    display = display->next;
  if (!display || !display->acquired || region.x || region.y ||
      region.width != display->width || region.height != display->height)
    return POCKET_STATUS_INVALID;
  for (Submission *p = r->pending; p; p = p->next)
    if (p->display == display)
      return POCKET_STATUS_INVALID;
  Submission *s = calloc(1, sizeof *s);
  if (!s)
    return POCKET_STATUS_FAILED;
  s->vertex_capacity = MAX_VERTICES;
  s->command_capacity = MAX_COMMANDS;
  s->vertices = linearAlloc((size_t)MAX_VERTICES * sizeof(Vertex));
  s->commands = calloc(MAX_COMMANDS, sizeof(Command));
  s->refs = calloc(MAX_COMMANDS, sizeof(Cache *));
  s->native = calloc(MAX_COMMANDS, sizeof(pocket_pica_native_texture));
  if (!s->vertices || !s->commands || !s->refs || !s->native) {
    release_submission(r, s);
    return POCKET_STATUS_FAILED;
  }
  C3D_BufInfo checked;
  BufInfo_Init(&checked);
  if (BufInfo_Add(&checked, s->vertices, sizeof(Vertex), 3, 0x210) < 0) {
    release_submission(r, s);
    return POCKET_STATUS_FAILED;
  }
  s->display = display;
  Build b = {r, s, resources, (uint32_t)resources.viewport_width,
             (uint32_t)resources.viewport_height};
  pocket_pica_overlay overlay = {
      .list = {.struct_size = sizeof overlay.list,
               .version = POCKET_DRAW_LIST_VERSION},
      .subpixels = 1};
  bool host = r->config.overlay &&
              r->config.overlay(r->config.context, display->role, &overlay);
  const pocket_draw_list *list =
      host && overlay.replace ? &overlay.list : frame.list;
  int32_t status = pocket_draw_list_visit(list, frame.resources, 1, visit, &b);
  if (!status && host && !overlay.replace)
    status = build_overlay(r, s, &overlay);
  else
    s->overlay_command = s->command_count;
  if (status) {
    release_submission(r, s);
    return status;
  }
  /* Only driver-owned bytes survive this function. No FrameInput pointer,
   * DrawList word or resource view is retained by a deferred submission. */
  if (!r->frame_open) {
    if (!C3D_FrameBegin(0)) {
      release_submission(r, s);
      return POCKET_STATUS_FAILED;
    }
    r->frame_open = true;
    r->vertices = r->commands = 0;
  }
  s->id = ++r->next_id;
  s->next = r->pending;
  r->pending = s;
  GSPGPU_FlushDataCache(s->vertices, s->vertex_count * sizeof(Vertex));
  bool replaced =
      r->config.scene && r->config.scene(r->config.context, display->role,
                                         display->target, display->right);
  if (!replaced)
    draw(r, s, b.width, b.height);
  draw_overlay(r, s);
  r->words[display->role] = list->word_count;
  r->vertices += s->vertex_count;
  r->commands += s->command_count;
  *out = s->id;
  return 0;
}
static int32_t render_wait(void *context, uint64_t id) {
  pocket_pica_renderer *r = context;
  if (!r)
    return POCKET_STATUS_INVALID;
  Submission *s = r->pending;
  while (s && s->id != id)
    s = s->next;
  if (!s)
    return POCKET_STATUS_INVALID;
  drain(r);
  return 0;
}
static void retire(void *context, uint64_t id) {
  pocket_pica_renderer *r = context;
  if (!r)
    return;
  Submission **slot = &r->pending;
  while (*slot && (*slot)->id != id)
    slot = &(*slot)->next;
  if (!*slot)
    return;
  if (!(*slot)->terminal)
    drain(r);
  Submission *s = *slot;
  *slot = s->next;
  release_submission(r, s);
}
static int32_t display_descriptor(void *context,
                                  pocket_display_descriptor *out) {
  pocket_pica_display *d = context;
  if (!d)
    return POCKET_STATUS_INVALID;
  pocket_display_descriptor value = {
      .struct_size = sizeof value,
      .role = d->role,
      .width = d->width,
      .height = d->height,
      .pixel_format = POCKET_PIXEL_FORMAT_RGBA8888,
      .stride_bytes = (size_t)d->width * 4,
      .target_kind = POCKET_TARGET_DEVICE_OWNED,
      .flags = POCKET_DISPLAY_DEVICE_ROTATION | POCKET_DISPLAY_DEVICE_SCALING,
      .refresh_width = d->width,
      .refresh_height = d->height,
      .window_x_alignment = 1,
      .window_y_alignment = 1,
      .vsync_source = POCKET_VSYNC_NONE};
  return WRITE_RECORD(out, value, pocket_display_descriptor, vsync_source)
             ? 0
             : POCKET_STATUS_INVALID;
}
static int32_t acquire(void *context, const pocket_rect *raw,
                       pocket_target *out) {
  pocket_pica_display *d = context;
  pocket_rect region;
  if (!d || d->flushed || !READ_RECORD(region, raw, pocket_rect, height) ||
      region.x || region.y || region.width != d->width ||
      region.height != d->height || !HAS(out, pocket_target, device_handle))
    return POCKET_STATUS_INVALID;
  for (Submission *p = d->renderer->pending; p; p = p->next)
    if (p->display == d)
      return POCKET_STATUS_INVALID;
  d->region = region;
  d->acquired = true;
  pocket_target value = {sizeof value, POCKET_TARGET_DEVICE_OWNED,
                         &d->region,   POCKET_PIXEL_FORMAT_RGBA8888,
                         NULL,         d->id};
  WRITE_RECORD(out, value, pocket_target, device_handle);
  return 0;
}
static void transfer(pocket_pica_display *d, C3D_RenderTarget *target,
                     gfx3dSide_t side) {
  gfxScreen_t screen =
      d->role == POCKET_DISPLAY_ROLE_PRIMARY ? GFX_TOP : GFX_BOTTOM;
  uint16_t w, h;
  uint8_t *pixels = gfxGetFramebuffer(screen, side, &w, &h);
  if (!pixels)
    abort();
  uint32_t flags = GX_TRANSFER_FLIP_VERT(0) | GX_TRANSFER_OUT_TILED(0) |
                   GX_TRANSFER_RAW_COPY(0) |
                   GX_TRANSFER_IN_FORMAT(GX_TRANSFER_FMT_RGBA8) |
                   GX_TRANSFER_OUT_FORMAT(GX_TRANSFER_FMT_RGB8) |
                   GX_TRANSFER_SCALING(GX_TRANSFER_SCALE_NO);
  C3D_SyncDisplayTransfer((u32 *)target->frameBuf.colorBuf,
                          GX_BUFFER_DIM(d->height, d->width), (u32 *)pixels,
                          GX_BUFFER_DIM(w, h), flags);
}
static int32_t display_flush(void *context, const pocket_rect *regions,
                             size_t count, uint64_t *token) {
  pocket_pica_display *d = context;
  if (!d || !d->acquired || d->flushed || !token || !regions || count != 1)
    return POCKET_STATUS_INVALID;
  if (!HAS(regions, pocket_rect, height) || regions->x || regions->y ||
      regions->width != d->width || regions->height != d->height)
    return POCKET_STATUS_INVALID;
  drain(d->renderer);
  /* No citro3d frame is open: SyncDisplayTransfer now waits for PPF before
   * return. Within an open frame it would only append another queued command.
   */
  transfer(d, d->target, GFX_LEFT);
  /* In 2D mode libctru aliases the right framebuffer to the left one. */
  bool stereo = d->right && gfxIs3D();
  if (stereo)
    transfer(d, d->right, GFX_RIGHT);
  gfxScreenSwapBuffers(
      d->role == POCKET_DISPLAY_ROLE_PRIMARY ? GFX_TOP : GFX_BOTTOM, stereo);
  d->acquired = false;
  d->flushed = true;
  *token = ++d->token;
  return 0;
}
static int32_t display_wait(void *context, uint64_t token) {
  pocket_pica_display *d = context;
  if (!d || !d->flushed || token != d->token)
    return POCKET_STATUS_INVALID;
  /* PPF has completed both copies. The host schedules one shared tick/vblank
   * boundary; waiting once per display here would halve a dual-screen rate. */
  d->flushed = false;
  return 0;
}
static uint32_t display_vsync(void *context) {
  (void)context;
  return POCKET_VSYNC_NONE;
}
static const pocket_renderer_v1 renderer_api = {sizeof renderer_api,
                                                renderer_descriptor,
                                                render,
                                                render_wait,
                                                retire,
                                                NULL};
static const pocket_display_output_v1 display_api = {
    sizeof display_api, display_descriptor, acquire, display_flush,
    display_wait,       display_vsync,      NULL};
const pocket_renderer_v1 *pocket_pica_renderer_vtable(void) {
  return &renderer_api;
}
const pocket_display_output_v1 *pocket_pica_display_vtable(void) {
  return &display_api;
}
pocket_pica_renderer *
pocket_pica_renderer_create(const pocket_pica_config *config) {
  if (!config || !config->shader || !config->shader_size ||
      config->shader_size > UINT32_MAX ||
      (!!config->resolve != !!config->release))
    return NULL;
  pocket_pica_renderer *r = calloc(1, sizeof *r);
  if (!r)
    return NULL;
  r->config = *config;
  if (!r->config.texture_budget)
    r->config.texture_budget = 16u * 1024u * 1024u;
  r->shader = DVLB_ParseFile((u32 *)config->shader, (u32)config->shader_size);
  if (!r->shader) {
    free(r);
    return NULL;
  }
  shaderProgramInit(&r->program);
  shaderProgramSetVsh(&r->program, &r->shader->DVLE[0]);
  r->projection =
      shaderInstanceGetUniformLocation(r->program.vertexShader, "projection");
  if (r->projection < 0) {
    pocket_pica_renderer_destroy(r);
    return NULL;
  }
  AttrInfo_Init(&r->attributes);
  AttrInfo_AddLoader(&r->attributes, 0, GPU_FLOAT, 2);
  AttrInfo_AddLoader(&r->attributes, 1, GPU_FLOAT, 2);
  AttrInfo_AddLoader(&r->attributes, 2, GPU_FLOAT, 4);
  uint8_t coverage[64];
  memset(coverage, 255, sizeof coverage);
  if (!upload_tiled(&r->white, NULL, coverage, 8, 8, 8, 8, false)) {
    pocket_pica_renderer_destroy(r);
    return NULL;
  }
  r->white_live = true;
  return r;
}
pocket_pica_display *
pocket_pica_display_create(pocket_pica_renderer *r, uint32_t role,
                           C3D_RenderTarget *target, C3D_RenderTarget *right,
                           uint32_t width, uint32_t height) {
  if (!r || !target || !width || !height || width > 1024 || height > 1024 ||
      role > POCKET_DISPLAY_ROLE_AUXILIARY ||
      width != (role == POCKET_DISPLAY_ROLE_PRIMARY ? 400u : 320u) ||
      height != 240u || target->linked || !target->frameBuf.colorBuf ||
      target->frameBuf.colorFmt != GPU_RB_RGBA8 ||
      target->frameBuf.width != height || target->frameBuf.height != width ||
      (right &&
       (right == target || right->linked || !right->frameBuf.colorBuf ||
        right->frameBuf.colorFmt != GPU_RB_RGBA8 ||
        right->frameBuf.width != height || right->frameBuf.height != width)) ||
      (right && role != POCKET_DISPLAY_ROLE_PRIMARY))
    return NULL;
  for (pocket_pica_display *p = r->displays; p; p = p->next)
    if (p->role == role || p->target == target || p->right == target ||
        (right && (p->target == right || p->right == right)))
      return NULL;
  pocket_pica_display *d = calloc(1, sizeof *d);
  if (!d)
    return NULL;
  d->renderer = r;
  d->target = target;
  d->right = right;
  d->role = role;
  d->width = width;
  d->height = height;
  if (next_target_identity == UINT64_MAX) {
    free(d);
    return NULL;
  }
  d->id = ++next_target_identity;
  d->next = r->displays;
  r->displays = d;
  return d;
}
void pocket_pica_display_destroy(pocket_pica_display *d) {
  if (!d)
    return;
  pocket_pica_renderer *r = d->renderer;
  drain(r);
  Submission **s = &r->pending;
  while (*s) {
    if ((*s)->display == d) {
      Submission *p = *s;
      *s = p->next;
      release_submission(r, p);
    } else
      s = &(*s)->next;
  }
  pocket_pica_display **p = &r->displays;
  while (*p && *p != d)
    p = &(*p)->next;
  if (*p)
    *p = d->next;
  free(d);
}
void pocket_pica_renderer_reset(pocket_pica_renderer *r) {
  if (!r)
    return;
  drain(r);
  while (r->pending) {
    Submission *s = r->pending;
    r->pending = s->next;
    release_submission(r, s);
  }
  while (r->cache)
    cache_delete(r, &r->cache);
  r->vertices = r->commands = 0;
  for (pocket_pica_display *d = r->displays; d; d = d->next)
    d->acquired = d->flushed = false;
}
void pocket_pica_renderer_destroy(pocket_pica_renderer *r) {
  if (!r)
    return;
  pocket_pica_renderer_reset(r);
  if (r->overlay)
    release_submission(r, r->overlay);
  r->overlay = NULL;
  while (r->displays)
    pocket_pica_display_destroy(r->displays);
  if (r->white_live)
    pocket_pica_texture_destroy(&r->white);
  shaderProgramFree(&r->program);
  if (r->shader)
    DVLB_Free(r->shader);
  free(r);
}
uint32_t pocket_pica_renderer_vertices(const pocket_pica_renderer *r) {
  return r ? r->vertices : 0;
}
uint32_t pocket_pica_renderer_commands(const pocket_pica_renderer *r) {
  return r ? r->commands : 0;
}

size_t pocket_pica_renderer_words(const pocket_pica_renderer *r,
                                  uint32_t role) {
  return r && role < 2 ? r->words[role] : 0;
}

static Submission *overlay_storage(pocket_pica_renderer *r) {
  if (r->overlay)
    return r->overlay;
  Submission *s = calloc(1, sizeof *s);
  if (!s)
    return NULL;
  s->vertex_capacity = OVERLAY_VERTICES;
  s->command_capacity = OVERLAY_COMMANDS;
  s->vertices = linearAlloc((size_t)OVERLAY_VERTICES * sizeof(Vertex));
  s->commands = calloc(OVERLAY_COMMANDS, sizeof(Command));
  s->refs = calloc(OVERLAY_COMMANDS, sizeof(Cache *));
  s->native = calloc(OVERLAY_COMMANDS, sizeof(pocket_pica_native_texture));
  if (!s->vertices || !s->commands || !s->refs || !s->native) {
    release_submission(r, s);
    return NULL;
  }
  r->overlay = s;
  return s;
}
bool pocket_pica_renderer_present_overlays(pocket_pica_renderer *r) {
  if (!r || !r->config.overlay || r->frame_open || r->pending)
    return false;
  Submission *s = overlay_storage(r);
  if (!s || !C3D_FrameBegin(C3D_FRAME_NONBLOCK))
    return false;
  /* The main thread's reset reads frame_open while this runs; the host
   * frame keeps its own lifetime and leaves that flag alone. */
  for (pocket_pica_display *d = r->displays; d; d = d->next) {
    bool stereo = d->right && gfxIs3D();
    C3D_RenderTargetClear(d->target, C3D_CLEAR_ALL, 0x000000ff, 0);
    if (stereo)
      C3D_RenderTargetClear(d->right, C3D_CLEAR_ALL, 0x000000ff, 0);
    pocket_pica_overlay overlay = {
        .list = {.struct_size = sizeof overlay.list,
                 .version = POCKET_DRAW_LIST_VERSION},
        .subpixels = 1};
    if (!r->config.overlay(r->config.context, d->role, &overlay))
      continue;
    s->vertex_count = s->command_count = 0;
    s->display = d;
    if (build_overlay(r, s, &overlay))
      continue;
    GSPGPU_FlushDataCache(s->vertices, s->vertex_count * sizeof(Vertex));
    draw_overlay(r, s);
  }
  /* As display_flush: rendering is terminal before the display transfer. */
  gpu_idle(r);
  for (pocket_pica_display *d = r->displays; d; d = d->next) {
    bool stereo = d->right && gfxIs3D();
    transfer(d, d->target, GFX_LEFT);
    if (stereo)
      transfer(d, d->right, GFX_RIGHT);
    gfxScreenSwapBuffers(
        d->role == POCKET_DISPLAY_ROLE_PRIMARY ? GFX_TOP : GFX_BOTTOM, stereo);
  }
  return true;
}
