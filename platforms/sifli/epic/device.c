/* The EPIC executor behind pocket_epic_ops.
 *
 * Commands arrive in painter order from the renderer. EPIC (epic.c) runs
 * fills, gradients, A8 blends, native blits/rotations and tile copies one
 * transaction at a time; VG Lite (vglite.c, SF32LB58) runs four-point quads,
 * tinted blits and blits of textures registered in portable layouts. The two
 * engines share no arbitration, so a command that moves to the other engine
 * first drains the one in use. A8 planes and RGB565 tiles live in on-chip
 * SRAM so the CPU builds coverage and renders fallbacks without touching the
 * framebuffer or maintaining caches. */
#include <string.h>

#include "mem_section.h"

#include "internal.h"
#include "rotate.h"

#define MASK_BYTES ((size_t)POCKETJS_EPIC_MASK_TILE_KB * 1024u)
#define TILE_PIXELS ((size_t)POCKETJS_EPIC_CPU_TILE_KB * 1024u / sizeof(uint16_t))
#define PLANE_SLOTS 2u
#define MAX_FRAMEBUFFERS 4u

enum { ENGINE_NONE, ENGINE_EPIC, ENGINE_VGLITE };

L1_NON_RET_BSS_SECT(pocketjs_epic_masks, ALIGN(64) static uint8_t g_masks[PLANE_SLOTS][MASK_BYTES]);
L1_NON_RET_BSS_SECT(pocketjs_epic_tiles, ALIGN(64) static uint16_t g_tiles[PLANE_SLOTS][TILE_PIXELS]);

struct pocket_sifli_epic {
  bool open, vglite;
  uint32_t engine;
  uint16_t *framebuffers[MAX_FRAMEBUFFERS];
  uint32_t framebuffer_count, width, height;
  epic_target target;
  epic_texture textures[POCKETJS_EPIC_MAX_TEXTURES];
  pocket_sifli_epic_profile profile;
  pocket_epic_ops ops;
};

static pocket_sifli_epic g_epic;

const epic_target *epic_bound_target(void) { return &g_epic.target; }

const epic_texture *epic_texture_by_id(uint32_t id) {
  if (id == 0 || id > POCKETJS_EPIC_MAX_TEXTURES || !g_epic.textures[id - 1u].used)
    return NULL;
  return &g_epic.textures[id - 1u];
}

uint8_t *epic_mask_plane(uint32_t id, size_t *length) {
  if (id >= PLANE_SLOTS)
    return NULL;
  if (length != NULL)
    *length = MASK_BYTES;
  return g_masks[id];
}

uint16_t *epic_tile_plane(uint32_t id, size_t *length) {
  if (id >= PLANE_SLOTS)
    return NULL;
  if (length != NULL)
    *length = TILE_PIXELS;
  return g_tiles[id];
}

void epic_profile_submit(uint32_t started) {
  g_epic.profile.submit_cycles += (uint32_t)(HAL_DBG_DWT_GetCycles() - started);
  ++g_epic.profile.transactions;
}

void epic_profile_wait(uint32_t started) {
  g_epic.profile.wait_cycles += (uint32_t)(HAL_DBG_DWT_GetCycles() - started);
}

bool epic_rect_in_target(const pocket_epic_rect *rect) {
  const epic_target *target = &g_epic.target;
  return rect->w > 0 && rect->h > 0 && rect->x < target->width && rect->y < target->height &&
         rect->w <= target->width - rect->x && rect->h <= target->height - rect->y;
}

static void wait_all(void) {
  epic_hw_wait();
#if EPIC_HAS_VGLITE
  if (g_epic.vglite)
    epic_vglite_wait();
#endif
}

/* Make `engine` the one in use: the other engine drains first because
 * nothing orders EPIC and VG Lite writes to the same target otherwise. */
static void switch_engine(uint32_t engine) {
  if (g_epic.engine == engine)
    return;
  if (g_epic.engine == ENGINE_EPIC)
    epic_hw_wait();
#if EPIC_HAS_VGLITE
  else if (g_epic.engine == ENGINE_VGLITE)
    epic_vglite_wait();
#endif
  if (g_epic.engine != ENGINE_NONE)
    ++g_epic.profile.engine_switches;
  g_epic.engine = engine;
}

static bool epic_can_blit(const pocket_epic_cmd *cmd) {
  const epic_texture *texture;
  if (cmd->source != POCKET_EPIC_SOURCE_TEXTURE || (cmd->color & 0x00FFFFFFu) != 0x00FFFFFFu ||
      ((cmd->flags & POCKET_EPIC_MIRROR_Y) != 0 && !EPIC_HAS_V_MIRROR))
    return false;
  texture = epic_texture_by_id(cmd->texture);
  return texture != NULL && texture->kind == POCKET_EPIC_TEXTURE_NATIVE &&
         (texture->format != POCKET_EPIC_L8 || EPIC_HAS_L8);
}

static int run_blit(const pocket_epic_cmd *cmd, bool quad) {
  if (!quad && epic_can_blit(cmd)) {
    switch_engine(ENGINE_EPIC);
    return epic_hw_blit(cmd);
  }
#if EPIC_HAS_VGLITE
  if (g_epic.vglite && epic_vglite_ready()) {
    int result;
    switch_engine(ENGINE_VGLITE);
    result = epic_vglite_blit(cmd, quad);
    if (result == EPIC_EXEC_OK)
      ++g_epic.profile.vglite_commands;
    return result;
  }
#endif
  return EPIC_EXEC_REJECT;
}

static int32_t can_blit_rotate(void *context, const pocket_epic_cmd *cmd) {
  epic_rotation rotation;
  if (context != &g_epic || !g_epic.open || !EPIC_HAS_ROTATE || !cmd ||
      cmd->op != POCKET_EPIC_OP_BLIT_ROTATE || !epic_can_blit(cmd) ||
      (cmd->flags & (POCKET_EPIC_MIRROR_X | POCKET_EPIC_MIRROR_Y)) ||
      !epic_rect_in_target(&cmd->clip) || cmd->clip.w > EPIC_COORD_MAX ||
      cmd->clip.h > EPIC_COORD_MAX)
    return POCKET_STATUS_UNSUPPORTED;
  const epic_texture *texture = epic_texture_by_id(cmd->texture);
  if (cmd->src.x >= texture->width || cmd->src.y >= texture->height ||
      cmd->src.w > texture->width - cmd->src.x || cmd->src.h > texture->height - cmd->src.y)
    return POCKET_STATUS_UNSUPPORTED;
  return epic_rotation_from_quad(&cmd->src, cmd->quad, EPIC_COORD_MAX, &rotation)
             ? POCKET_STATUS_OK : POCKET_STATUS_UNSUPPORTED;
}

/* ---- pocket_epic_ops ----------------------------------------------------- */

static int32_t caps(void *context, pocket_epic_caps *out) {
  pocket_sifli_epic *epic = context;
  if (epic != &g_epic || !epic->open || out == NULL || out->struct_size < sizeof(*out))
    return POCKET_STATUS_INVALID;
  *out = (pocket_epic_caps){
      .struct_size = sizeof(*out),
      .flags = POCKET_EPIC_FILL_OPAQUE | POCKET_EPIC_FILL_ALPHA | POCKET_EPIC_GRADIENT |
               POCKET_EPIC_BLIT,
      .coordinate_limit = EPIC_COORD_MAX,
      .mask_bytes = MASK_BYTES,
      .tile_pixels = TILE_PIXELS,
      .min_fill = POCKETJS_EPIC_MIN_PIXELS,
      .min_gradient = POCKETJS_EPIC_MIN_PIXELS,
      .min_blend = POCKETJS_EPIC_MIN_PIXELS,
      .min_blit = POCKETJS_EPIC_MIN_PIXELS,
  };
#if EPIC_HAS_A8
  out->flags |= POCKET_EPIC_A8_BLEND;
#endif
#if EPIC_HAS_V_MIRROR
  out->flags |= POCKET_EPIC_BLIT_MIRROR_Y;
#endif
  if (EPIC_HAS_ROTATE) out->flags |= POCKET_EPIC_BLIT_ROTATE;
  /* VG Lite reads registered textures only: they are 64-byte aligned and
   * cache-clean from registration on. It mirrors through its matrix. */
  if (epic->vglite)
    out->flags |= POCKET_EPIC_BLIT_QUAD | POCKET_EPIC_BLIT_MODULATE |
                  POCKET_EPIC_PORTABLE_TEXTURES | POCKET_EPIC_BLIT_MIRROR_Y;
  return POCKET_STATUS_OK;
}

static int32_t begin(void *context, uint64_t target, uint32_t width, uint32_t height) {
  pocket_sifli_epic *epic = context;
  if (epic != &g_epic || !epic->open || target == 0 || target > epic->framebuffer_count ||
      width != epic->width || height != epic->height)
    return POCKET_STATUS_INVALID;
  wait_all();
  epic->engine = ENGINE_NONE;
  epic->target = (epic_target){
      .pixels = epic->framebuffers[target - 1u], .width = width, .height = height};
#if EPIC_HAS_VGLITE
  if (epic->vglite)
    epic_vglite_bind(&epic->target);
#endif
  return POCKET_STATUS_OK;
}

static int32_t submit(void *context, const pocket_epic_cmd *cmds, size_t count) {
  pocket_sifli_epic *epic = context;
  if (epic != &g_epic || !epic->open || epic->target.pixels == NULL ||
      (cmds == NULL && count != 0))
    return POCKET_STATUS_INVALID;
  for (size_t index = 0; index < count; ++index) {
    const pocket_epic_cmd *cmd = &cmds[index];
    int result;
    switch (cmd->op) {
    case POCKET_EPIC_OP_FILL:
    case POCKET_EPIC_OP_FILL_ALPHA:
      switch_engine(ENGINE_EPIC);
      result = epic_hw_fill(cmd);
      break;
    case POCKET_EPIC_OP_BLEND_A8:
      switch_engine(ENGINE_EPIC);
      result = epic_hw_blend_a8(cmd);
      break;
    case POCKET_EPIC_OP_GRADIENT:
      switch_engine(ENGINE_EPIC);
      result = epic_hw_gradient(cmd);
      break;
    case POCKET_EPIC_OP_BLIT:
      result = run_blit(cmd, false);
      break;
    case POCKET_EPIC_OP_BLIT_QUAD:
      result = run_blit(cmd, true);
      break;
    case POCKET_EPIC_OP_BLIT_ROTATE:
      switch_engine(ENGINE_EPIC);
      result = can_blit_rotate(context, cmd) == POCKET_STATUS_OK
                   ? epic_hw_blit(cmd) : EPIC_EXEC_REJECT;
      break;
    case POCKET_EPIC_OP_TILE_OUT:
      switch_engine(ENGINE_EPIC);
      result = epic_hw_tile_out(cmd);
      break;
    case POCKET_EPIC_OP_TILE_IN:
      switch_engine(ENGINE_EPIC);
      result = epic_hw_tile_in(cmd);
      break;
    case POCKET_EPIC_OP_FENCE:
      wait_all();
      result = EPIC_EXEC_OK;
      break;
    default:
      result = EPIC_EXEC_REJECT;
      break;
    }
    if (result == EPIC_EXEC_REJECT) {
      ++epic->profile.rejected;
      wait_all();
      return POCKET_STATUS_UNSUPPORTED;
    }
    if (result != EPIC_EXEC_OK) {
      wait_all();
      return POCKET_STATUS_FAILED;
    }
  }
  return POCKET_STATUS_OK;
}

static int32_t fence(void *context) {
  if (context != &g_epic || !g_epic.open)
    return POCKET_STATUS_INVALID;
  wait_all();
  return POCKET_STATUS_OK;
}

static int32_t end(void *context) {
  if (context != &g_epic || !g_epic.open)
    return POCKET_STATUS_INVALID;
  wait_all();
  g_epic.engine = ENGINE_NONE;
  g_epic.target.pixels = NULL;
  return POCKET_STATUS_OK;
}

static uint8_t *mask(void *context, uint32_t plane, size_t *length) {
  return context == &g_epic ? epic_mask_plane(plane, length) : NULL;
}

static uint16_t *tile(void *context, uint32_t id, size_t *length) {
  return context == &g_epic ? epic_tile_plane(id, length) : NULL;
}

static size_t bytes_per_pixel(uint32_t kind, uint32_t format, bool *palette) {
  *palette = false;
  if (kind == POCKET_EPIC_TEXTURE_NATIVE) {
    switch (format) {
    case POCKET_EPIC_RGB565:
      return 2;
    case POCKET_EPIC_BGRA8888:
      return 4;
    case POCKET_EPIC_L8:
      *palette = true;
      return EPIC_HAS_L8 || g_epic.vglite ? 1 : 0;
    default:
      return 0;
    }
  }
  if (kind != POCKET_EPIC_TEXTURE_PORTABLE || !g_epic.vglite)
    return 0;
  switch (format) {
  case EPIC_PSM_5650:
  case EPIC_PSM_4444:
    return 2;
  case EPIC_PSM_8888:
    return 4;
  case EPIC_PSM_T8:
    *palette = true;
    return 1;
  default:
    return 0;
  }
}

static int32_t register_texture(void *context, const pocket_epic_texture *texture,
                                uint32_t *id) {
  pocket_sifli_epic *epic = context;
  bool palette = false;
  size_t bytes;
  uint64_t required;
  if (epic != &g_epic || !epic->open || texture == NULL ||
      texture->struct_size < sizeof(*texture) || id == NULL || texture->pixels == NULL ||
      texture->width == 0 || texture->height == 0 || texture->width > UINT16_MAX ||
      texture->height > UINT16_MAX)
    return POCKET_STATUS_INVALID;
  bytes = bytes_per_pixel(texture->kind, texture->format, &palette);
  required = (uint64_t)texture->width * texture->height * bytes;
  /* The engines read memory, not the CPU cache, from 64-byte aligned rows. */
  if (bytes == 0 || ((uintptr_t)texture->pixels & 63u) != 0 ||
      (palette && (texture->palette == NULL || ((uintptr_t)texture->palette & 3u) != 0)))
    return POCKET_STATUS_UNSUPPORTED;
  if (required > texture->pixel_bytes)
    return POCKET_STATUS_INVALID;
  for (uint32_t index = 0; index < POCKETJS_EPIC_MAX_TEXTURES; ++index) {
    epic_texture *slot = &epic->textures[index];
    if (slot->used)
      continue;
    /* A no-op for XIP flash and SRAM; cleans blobs staged in cached PSRAM. */
    mpu_dcache_clean((void *)texture->pixels, (uint32_t)required);
    if (palette)
      mpu_dcache_clean((void *)texture->palette, EPIC_PALETTE_BYTES);
    *slot = (epic_texture){
        .used = true,
        .kind = texture->kind,
        .format = texture->format,
        .pixels = texture->pixels,
        .pixel_bytes = (size_t)required,
        .palette = palette ? texture->palette : NULL,
        .width = texture->width,
        .height = texture->height,
    };
    ++epic->profile.textures;
    *id = index + 1u;
    return POCKET_STATUS_OK;
  }
  /* A full registry leaves the texture to the CPU. */
  return POCKET_STATUS_UNSUPPORTED;
}

static void release_texture(void *context, uint32_t id) {
  pocket_sifli_epic *epic = context;
  epic_texture *slot;
  if (epic != &g_epic || id == 0 || id > POCKETJS_EPIC_MAX_TEXTURES ||
      !epic->textures[id - 1u].used)
    return;
  wait_all();
  slot = &epic->textures[id - 1u];
#if EPIC_HAS_VGLITE
  if (slot->palette != NULL)
    epic_vglite_forget_palette(slot->palette);
#endif
  memset(slot, 0, sizeof(*slot));
  --epic->profile.textures;
}

/* ---- lifecycle ----------------------------------------------------------- */

int32_t pocket_sifli_epic_create(const pocket_sifli_epic_config *config,
                                 pocket_sifli_epic **out) {
  if (config == NULL || out == NULL || config->struct_size < sizeof(*config) ||
      config->framebuffers == NULL || config->framebuffer_count == 0 ||
      config->framebuffer_count > MAX_FRAMEBUFFERS || config->width == 0 ||
      config->height == 0 || config->width > UINT16_MAX || config->height > UINT16_MAX)
    return POCKET_STATUS_INVALID;
  *out = NULL;
  for (uint32_t index = 0; index < config->framebuffer_count; ++index) {
    if (config->framebuffers[index] == NULL ||
        ((uintptr_t)config->framebuffers[index] & 63u) != 0)
      return POCKET_STATUS_INVALID;
  }
  if (g_epic.open)
    return POCKET_STATUS_UNSUPPORTED;
  memset(&g_epic, 0, sizeof(g_epic));
  if (!epic_hw_open())
    return POCKET_STATUS_FAILED;
#if EPIC_HAS_VGLITE
  g_epic.vglite = epic_vglite_open();
#endif
  memcpy(g_epic.framebuffers, config->framebuffers,
         config->framebuffer_count * sizeof(config->framebuffers[0]));
  g_epic.framebuffer_count = config->framebuffer_count;
  g_epic.width = config->width;
  g_epic.height = config->height;
  g_epic.engine = ENGINE_NONE;
  g_epic.profile.struct_size = sizeof(g_epic.profile);
  g_epic.ops = (pocket_epic_ops){
      .struct_size = sizeof(g_epic.ops),
      .context = &g_epic,
      .caps = caps,
      .begin = begin,
      .submit = submit,
      .fence = fence,
      .end = end,
      .mask = mask,
      .tile = tile,
      .register_texture = register_texture,
      .release_texture = release_texture,
      .can_blit_rotate = can_blit_rotate,
  };
  g_epic.open = true;
  *out = &g_epic;
  return POCKET_STATUS_OK;
}

const pocket_epic_ops *pocket_sifli_epic_ops(pocket_sifli_epic *epic) {
  return epic == &g_epic && epic->open ? &epic->ops : NULL;
}

void pocket_sifli_epic_profile_get(pocket_sifli_epic *epic, pocket_sifli_epic_profile *out,
                                   bool reset) {
  if (epic != &g_epic || !epic->open)
    return;
  if (out != NULL && out->struct_size >= sizeof(*out))
    *out = epic->profile;
  if (reset) {
    const uint32_t textures = epic->profile.textures;
    memset(&epic->profile, 0, sizeof(epic->profile));
    epic->profile.struct_size = sizeof(epic->profile);
    epic->profile.textures = textures;
  }
}

void pocket_sifli_epic_destroy(pocket_sifli_epic *epic) {
  if (epic != &g_epic || !epic->open)
    return;
  wait_all();
#if EPIC_HAS_VGLITE
  if (epic->vglite)
    epic_vglite_close();
#endif
  epic_hw_close();
  memset(&g_epic, 0, sizeof(g_epic));
}
