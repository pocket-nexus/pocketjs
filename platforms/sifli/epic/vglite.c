/* VG Lite engine (SF32LB58): four-point texture quads, RGB-modulated blits
 * and blits of textures registered in PocketJS portable layouts. VG Lite
 * reads those layouts directly (its format names list the channels from the
 * low byte up), so no channel conversion happens at runtime; sources are
 * 64-byte aligned and cache-clean from registration on.
 *
 * Commands accumulate in the VG Lite command buffer and are flushed after
 * each blit; a fence, an engine switch or the end of the frame calls
 * vg_lite_finish. The command buffers and the tessellation buffer come from
 * a contiguous pool in SRAM handed to the library at open. */
#include "internal.h"

#if EPIC_HAS_VGLITE

#include <rtthread.h>
#include <string.h>

#include "mem_section.h"
#include "vg_lite.h"
#include "vg_lite_platform.h"

#ifdef quad
#undef quad /* an SDK header aliases `quad` */
#endif

#define POOL_BYTES ((size_t)POCKETJS_EPIC_VGLITE_POOL_KB * 1024u)
#define TESSELLATION 64

L1_NON_RET_BSS_SECT(pocketjs_epic_vglite_pool, ALIGN(64) static uint8_t g_pool[POOL_BYTES]);
L1_NON_RET_BSS_SECT(pocketjs_epic_vglite_solid, ALIGN(64) static uint32_t g_solid[16]);
ALIGN(4) static vg_lite_uint32_t g_clut[256];

static bool g_ready;
static bool g_busy;
static vg_lite_buffer_t g_target;
static const uint8_t *g_clut_source;

static uint32_t hardware_address(const void *pointer) {
  uintptr_t address = (uintptr_t)pointer;
#ifdef HCPU_MPI_SBUS_ADDR
  if (address >= 0x10000000u && address < 0x1C000000u)
    return (uint32_t)HCPU_MPI_SBUS_ADDR(address);
#endif
  return (uint32_t)address;
}

static void buffer_init(vg_lite_buffer_t *buffer, uint32_t width, uint32_t height,
                        vg_lite_buffer_format_t format, uint32_t stride, const void *memory) {
  memset(buffer, 0, sizeof(*buffer));
  buffer->width = (vg_lite_int32_t)width;
  buffer->height = (vg_lite_int32_t)height;
  buffer->stride = (vg_lite_int32_t)stride;
  buffer->tiled = VG_LITE_LINEAR;
  buffer->format = format;
  buffer->memory = (vg_lite_pointer)memory;
  buffer->address = hardware_address(memory);
  buffer->image_mode = VG_LITE_NORMAL_IMAGE_MODE;
  buffer->transparency_mode = VG_LITE_IMAGE_OPAQUE;
}

bool epic_vglite_open(void) {
  vg_module_parameters_t param;
  char name[64];
  vg_lite_uint32_t chip_id = 0;
  vg_lite_uint32_t chip_rev = 0;

  if (g_ready)
    return true;
  memset(&param, 0, sizeof(param));
  param.register_mem_base = V2D_GPU_BASE;
  param.contiguous_mem_base[0] = g_pool;
  param.contiguous_mem_size[0] = (uint32_t)POOL_BYTES;
  vg_lite_init_mem(&param);
  if (vg_lite_set_command_buffer_size((vg_lite_uint32_t)POCKETJS_EPIC_VGLITE_CMD_KB * 1024u) !=
      VG_LITE_SUCCESS) {
    rt_kprintf("[PocketJS] VG Lite: command buffer size rejected\n");
    return false;
  }
  if (vg_lite_init(TESSELLATION, TESSELLATION) != VG_LITE_SUCCESS) {
    rt_kprintf("[PocketJS] VG Lite: vg_lite_init failed\n");
    return false;
  }
  HAL_NVIC_SetPriority(V2D_GPU_IRQn, 3, 0);
  HAL_NVIC_EnableIRQ(V2D_GPU_IRQn);
  memset(name, 0, sizeof(name));
  vg_lite_get_product_info(name, &chip_id, &chip_rev);
  rt_kprintf("[PocketJS] VG Lite: %s chip 0x%x rev 0x%x, pool %uKB, command buffer %uKB\n", name,
             (unsigned)chip_id, (unsigned)chip_rev, (unsigned)(POOL_BYTES >> 10),
             (unsigned)POCKETJS_EPIC_VGLITE_CMD_KB);
  g_clut_source = NULL;
  g_ready = true;
  return true;
}

void epic_vglite_close(void) {
  if (!g_ready)
    return;
  epic_vglite_wait();
  HAL_NVIC_DisableIRQ(V2D_GPU_IRQn);
  vg_lite_close();
  g_ready = false;
}

bool epic_vglite_ready(void) { return g_ready; }

void epic_vglite_wait(void) {
  if (g_ready && g_busy) {
    uint32_t started = HAL_DBG_DWT_GetCycles();
    vg_lite_error_t error = vg_lite_finish();
    epic_profile_wait(started);
    g_busy = false;
    if (error != VG_LITE_SUCCESS) {
      /* The library cannot reset a hung GPU: later VG Lite commands are
       * rejected and their frames fail. */
      rt_kprintf("[PocketJS] VG Lite: finish failed (%d); VG Lite disabled\n", (int)error);
      g_ready = false;
    }
  }
}

void epic_vglite_bind(const epic_target *target) {
  buffer_init(&g_target, target->width, target->height, VG_LITE_BGR565, target->width * 2u,
              target->pixels);
}

void epic_vglite_forget_palette(const uint8_t *palette) {
  if (g_clut_source == palette)
    g_clut_source = NULL;
}

/* Upload a 256-entry ARGB CLUT from a 1024-byte palette. `swap_rb` for the
 * portable RGBA byte order; the native L8 palette is BGRA = ARGB words. */
static bool upload_clut(const uint8_t *palette, bool swap_rb) {
  if (palette == NULL)
    return false;
  if (g_clut_source == palette)
    return true;
  for (uint32_t index = 0; index < 256; ++index) {
    const uint8_t *entry = palette + index * 4u;
    g_clut[index] = swap_rb ? ((uint32_t)entry[3] << 24) | ((uint32_t)entry[0] << 16) |
                                  ((uint32_t)entry[1] << 8) | (uint32_t)entry[2]
                            : ((uint32_t)entry[3] << 24) | ((uint32_t)entry[2] << 16) |
                                  ((uint32_t)entry[1] << 8) | (uint32_t)entry[0];
  }
  if (vg_lite_set_CLUT(256, g_clut) != VG_LITE_SUCCESS)
    return false;
  g_clut_source = palette;
  return true;
}

/* Describe a registered texture as a VG Lite source; false for a layout this
 * engine cannot read. `has_alpha` reports per-texel alpha. */
static bool source_from_texture(const epic_texture *texture, vg_lite_buffer_t *source,
                                bool *has_alpha) {
  vg_lite_buffer_format_t format;
  uint32_t bytes_per_pixel;
  bool clut = false;
  bool swap_rb = false;

  *has_alpha = false;
  if (texture->kind == POCKET_EPIC_TEXTURE_NATIVE) {
    switch (texture->format) {
    case POCKET_EPIC_RGB565:
      format = VG_LITE_BGR565;
      bytes_per_pixel = 2;
      break;
    case POCKET_EPIC_BGRA8888:
      format = VG_LITE_BGRA8888;
      bytes_per_pixel = 4;
      *has_alpha = true;
      break;
    case POCKET_EPIC_L8:
      format = VG_LITE_INDEX_8;
      bytes_per_pixel = 1;
      clut = true;
      *has_alpha = true;
      break;
    default:
      return false;
    }
  } else {
    switch (texture->format) {
    case EPIC_PSM_5650:
      format = VG_LITE_RGB565;
      bytes_per_pixel = 2;
      break;
    case EPIC_PSM_4444:
      format = VG_LITE_RGBA4444;
      bytes_per_pixel = 2;
      *has_alpha = true;
      break;
    case EPIC_PSM_8888:
      format = VG_LITE_RGBA8888;
      bytes_per_pixel = 4;
      *has_alpha = true;
      break;
    case EPIC_PSM_T8:
      format = VG_LITE_INDEX_8;
      bytes_per_pixel = 1;
      clut = true;
      swap_rb = true;
      *has_alpha = true;
      break;
    default:
      return false;
    }
  }
  if (clut && !upload_clut(texture->palette, swap_rb))
    return false;
  buffer_init(source, texture->width, texture->height, format, texture->width * bytes_per_pixel,
              texture->pixels);
  if (*has_alpha)
    source->transparency_mode = VG_LITE_IMAGE_TRANSPARENT;
  return true;
}

static void source_solid(uint32_t abgr, vg_lite_buffer_t *source) {
  for (uint32_t index = 0; index < 16; ++index)
    g_solid[index] = abgr; /* RGBA8888 bytes r, g, b, a: the ABGR word little-endian */
  mpu_dcache_clean(g_solid, sizeof(g_solid));
  buffer_init(source, 4, 4, VG_LITE_RGBA8888, 16, g_solid);
}

int epic_vglite_blit(const pocket_epic_cmd *cmd, bool quad) {
  vg_lite_buffer_t source;
  vg_lite_rectangle_t rect;
  vg_lite_matrix_t matrix;
  vg_lite_color_t color = 0xFFFFFFFFu;
  vg_lite_blend_t blend;
  vg_lite_filter_t filter;
  vg_lite_error_t error;
  bool has_alpha = false;
  bool tinted = (cmd->color & 0x00FFFFFFu) != 0x00FFFFFFu;
  uint8_t alpha = (uint8_t)(cmd->color >> 24);
  uint32_t started;

  if (!g_ready || !epic_rect_in_target(&cmd->clip))
    return EPIC_EXEC_REJECT;
  if (cmd->source == POCKET_EPIC_SOURCE_SOLID) {
    if (alpha == 0 || (cmd->texture >> 24) == 0)
      return EPIC_EXEC_OK;
    source_solid(cmd->texture, &source);
    rect.x = 0;
    rect.y = 0;
    rect.width = 4;
    rect.height = 4;
    has_alpha = (cmd->texture >> 24) != 0xFFu;
  } else if (cmd->source == POCKET_EPIC_SOURCE_TEXTURE) {
    const epic_texture *texture = epic_texture_by_id(cmd->texture);
    if (texture == NULL || cmd->src.w == 0 || cmd->src.h == 0 || cmd->src.x >= texture->width ||
        cmd->src.y >= texture->height || cmd->src.w > texture->width - cmd->src.x ||
        cmd->src.h > texture->height - cmd->src.y ||
        !source_from_texture(texture, &source, &has_alpha))
      return EPIC_EXEC_REJECT;
    if (alpha == 0)
      return EPIC_EXEC_OK;
    rect.x = (vg_lite_int32_t)cmd->src.x;
    rect.y = (vg_lite_int32_t)cmd->src.y;
    rect.width = (vg_lite_int32_t)cmd->src.w;
    rect.height = (vg_lite_int32_t)cmd->src.h;
  } else {
    return EPIC_EXEC_REJECT;
  }

  vg_lite_identity(&matrix);
  if (quad) {
    vg_lite_float_point4_t from;
    vg_lite_float_point4_t to;
    /* Top left, bottom left, bottom right, top right of the source rectangle
     * onto the command's quad. */
    from[0].x = (vg_lite_float_t)rect.x;
    from[0].y = (vg_lite_float_t)rect.y;
    from[1].x = (vg_lite_float_t)rect.x;
    from[1].y = (vg_lite_float_t)(rect.y + rect.height);
    from[2].x = (vg_lite_float_t)(rect.x + rect.width);
    from[2].y = (vg_lite_float_t)(rect.y + rect.height);
    from[3].x = (vg_lite_float_t)(rect.x + rect.width);
    from[3].y = (vg_lite_float_t)rect.y;
    for (uint32_t index = 0; index < 4; ++index) {
      to[index].x = (vg_lite_float_t)cmd->quad[index].x;
      to[index].y = (vg_lite_float_t)cmd->quad[index].y;
    }
    if (vg_lite_get_transform_matrix(from, to, &matrix) != VG_LITE_SUCCESS)
      return EPIC_EXEC_REJECT;
  } else {
    bool mirror_x = (cmd->flags & POCKET_EPIC_MIRROR_X) != 0;
    bool mirror_y = (cmd->flags & POCKET_EPIC_MIRROR_Y) != 0;
    vg_lite_float_t scale_x;
    vg_lite_float_t scale_y;
    if (cmd->dst.w == 0 || cmd->dst.h == 0)
      return EPIC_EXEC_REJECT;
    scale_x = (vg_lite_float_t)cmd->dst.w / (vg_lite_float_t)rect.width;
    scale_y = (vg_lite_float_t)cmd->dst.h / (vg_lite_float_t)rect.height;
    /* Source texel (u, v) lands at dst + (u - src) * scale, flipped across
     * the destination when mirrored. */
    matrix.m[0][0] = mirror_x ? -scale_x : scale_x;
    matrix.m[0][2] = mirror_x ? (vg_lite_float_t)(cmd->dst.x + cmd->dst.w) +
                                    (vg_lite_float_t)rect.x * scale_x
                              : (vg_lite_float_t)cmd->dst.x - (vg_lite_float_t)rect.x * scale_x;
    matrix.m[1][1] = mirror_y ? -scale_y : scale_y;
    matrix.m[1][2] = mirror_y ? (vg_lite_float_t)(cmd->dst.y + cmd->dst.h) +
                                    (vg_lite_float_t)rect.y * scale_y
                              : (vg_lite_float_t)cmd->dst.y - (vg_lite_float_t)rect.y * scale_y;
  }

  if (tinted) {
    source.image_mode = VG_LITE_MULTIPLY_IMAGE_MODE;
    color = (cmd->color & 0x00FFFFFFu) | 0xFF000000u;
  }
  blend = (has_alpha || alpha != 0xFFu) ? VG_LITE_BLEND_SRC_OVER : VG_LITE_BLEND_NONE;
  filter = (cmd->flags & POCKET_EPIC_LINEAR) != 0 ? VG_LITE_FILTER_BI_LINEAR
                                                  : VG_LITE_FILTER_POINT;

  started = HAL_DBG_DWT_GetCycles();
  vg_lite_set_scissor((vg_lite_int32_t)cmd->clip.x, (vg_lite_int32_t)cmd->clip.y,
                      (vg_lite_int32_t)(cmd->clip.x + cmd->clip.w),
                      (vg_lite_int32_t)(cmd->clip.y + cmd->clip.h));
  vg_lite_enable_scissor();
  vg_lite_source_global_alpha(alpha != 0xFFu ? VG_LITE_SCALED : VG_LITE_NORMAL, alpha);
  error = vg_lite_blit_rect(&g_target, &source, &rect, &matrix, blend, color, filter);
  if (error == VG_LITE_SUCCESS)
    error = vg_lite_flush();
  if (error != VG_LITE_SUCCESS) {
    rt_kprintf("[PocketJS] VG Lite: blit failed (%d)\n", (int)error);
    return EPIC_EXEC_ERROR;
  }
  g_busy = true;
  epic_profile_submit(started);
  return EPIC_EXEC_OK;
}

#endif /* EPIC_HAS_VGLITE */
