/* State shared between the executor queue (device.c) and its engines. */
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "chip.h"
#include "pocket/sifli.h"

/* PocketJS portable texture layouts (contracts/spec/spec.ts PSM). */
#define EPIC_PSM_5650 0u
#define EPIC_PSM_4444 2u
#define EPIC_PSM_8888 3u
#define EPIC_PSM_T8 5u
#define EPIC_PALETTE_BYTES 1024u

/* Engine results. */
#define EPIC_EXEC_OK 0
#define EPIC_EXEC_REJECT 1
#define EPIC_EXEC_ERROR (-1)

typedef struct {
  uint16_t *pixels;
  uint32_t width, height;
} epic_target;

typedef struct {
  bool used;
  uint32_t kind, format;
  const uint8_t *pixels;
  size_t pixel_bytes;
  const uint8_t *palette; /* 1024 bytes for L8 (BGRA) and PSM_T8 (RGBA) */
  uint32_t width, height;
} epic_texture;

/* Queue helpers used by the engines. */
const epic_target *epic_bound_target(void);
const epic_texture *epic_texture_by_id(uint32_t id);
uint8_t *epic_mask_plane(uint32_t id, size_t *length);
uint16_t *epic_tile_plane(uint32_t id, size_t *length);
void epic_profile_submit(uint32_t started);
void epic_profile_wait(uint32_t started);
bool epic_rect_in_target(const pocket_epic_rect *rect);

/* EPIC engine (epic.c). */
bool epic_hw_open(void);
void epic_hw_close(void);
void epic_hw_wait(void);
int epic_hw_fill(const pocket_epic_cmd *cmd);
int epic_hw_gradient(const pocket_epic_cmd *cmd);
int epic_hw_blend_a8(const pocket_epic_cmd *cmd);
int epic_hw_blit(const pocket_epic_cmd *cmd);
int epic_hw_tile_out(const pocket_epic_cmd *cmd);
int epic_hw_tile_in(const pocket_epic_cmd *cmd);

/* VG Lite engine (vglite.c, SF32LB58 with USING_VGLITE). */
#if EPIC_HAS_VGLITE
bool epic_vglite_open(void);
void epic_vglite_close(void);
bool epic_vglite_ready(void);
void epic_vglite_wait(void);
void epic_vglite_bind(const epic_target *target);
/* A released texture's palette may be reused: drop the cached CLUT. */
void epic_vglite_forget_palette(const uint8_t *palette);
int epic_vglite_blit(const pocket_epic_cmd *cmd, bool quad);
#endif
