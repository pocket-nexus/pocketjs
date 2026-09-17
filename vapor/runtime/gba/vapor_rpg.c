/* vapor/runtime/gba/vapor_rpg.c -- fixed GBA pixel host for Pocket Vapor RPGs.
 *
 * Gameplay remains compiler-generated reactive C.  This file owns only ROM
 * map queries and a small Mode 0 renderer: BG1 is the pixel world, BG0 is the
 * existing (now transparent) Vapor font, and OBJ contains the actors.
 */
#include "vapor.h"
#include "vapor_rpg_assets.generated.h"

#define REG16(addr) (*(volatile u16 *)(addr))
#define REG32(addr) (*(volatile u32 *)(addr))
#define REG_DISPCNT REG16(0x04000000)
#define REG_BG1CNT REG16(0x0400000a)
#define REG_BG1HOFS REG16(0x04000014)
#define REG_BG1VOFS REG16(0x04000016)
#define REG_WIN0H REG16(0x04000040)
#define REG_WIN0V REG16(0x04000044)
#define REG_WININ REG16(0x04000048)
#define REG_WINOUT REG16(0x0400004a)
#define REG_DMA3SAD REG32(0x040000d4)
#define REG_DMA3DAD REG32(0x040000d8)
#define REG_DMA3CNT_L REG16(0x040000dc)
#define REG_DMA3CNT_H REG16(0x040000de)

#define PAL_BG ((volatile u16 *)0x05000000)
#define PAL_OBJ ((volatile u16 *)0x05000200)
#define FONT_VRAM ((volatile u16 *)0x06000000)
#define RPG_BG_VRAM ((volatile u16 *)0x06008000) /* charblock 2 */
#define RPG_BG_MAP ((volatile u16 *)0x06004800)  /* screenblock 9 */
#define RPG_OBJ_VRAM ((volatile u16 *)0x06010000)
#define OAM ((volatile u16 *)0x07000000)
/* Presentation receipt after the shared grid debug mirrors (0x20005b8 end). */
#define RPG_DEBUG_SCROLL_X (*(volatile u16 *)0x020005c0)
#define RPG_DEBUG_SCROLL_Y (*(volatile u16 *)0x020005c2)

#define RPG_BG_BANK 15
#define RPG_ENTRY(tile) ((u16)((tile) | (RPG_BG_BANK << 12)))
#define RPG_OBJ_PRIORITY (1 << 10)
#define RPG_WORLD_CELL_PX 16
#define RPG_VIEW_W 15
#define RPG_VIEW_H 10
#define RPG_BUFFER_W 16
#define RPG_BUFFER_H 11
#define RPG_FOCUS_X 7
#define RPG_FOCUS_Y 4

enum {
  WORLD_BLANK,
  WORLD_GRASS_A,
  WORLD_GRASS_B,
  WORLD_PATH_A,
  WORLD_PATH_B,
  WORLD_WALL,
  WORLD_WATER_A,
  WORLD_WATER_B,
  WORLD_TREE,
  WORLD_FLOWER,
  WORLD_TILE_COUNT
};

enum {
  TILE_BOX_FILL = VP_RPG_UI_TILE_BASE,
  TILE_BOX_TOP,
  TILE_BOX_BOTTOM,
  TILE_BOX_LEFT,
  TILE_BOX_RIGHT,
  TILE_BOX_TL,
  TILE_BOX_TR,
  TILE_BOX_BL,
  TILE_BOX_BR,
  TILE_BATTLE_SKY,
  TILE_BATTLE_GROUND,
  TILE_HP_EMPTY,
  TILE_HP_FULL,
  TILE_HUD,
  TILE_COUNT
};

typedef char vp_rpg_bg_tile_count_must_match[
    TILE_COUNT == VP_RPG_BG_TILE_COUNT ? 1 : -1];
typedef char vp_rpg_world_tile_count_must_match[
    WORLD_TILE_COUNT == VP_RPG_WORLD_TILE_FRAME_COUNT ? 1 : -1];
typedef char vp_rpg_walk_direction_count_must_match[
    VP_RPG_WORLD_WALK_DIRECTION_COUNT == 4 ? 1 : -1];
typedef char vp_rpg_walk_frame_count_must_match[
    VP_RPG_WORLD_WALK_FRAMES == 4 ? 1 : -1];

static u16 rpg_bg_shadow[32 * 32];
static u16 rpg_oam_shadow[128 * 4];
static const vp_rpg_map *rpg_world_cache_map;
static s32 rpg_world_cache_x;
static s32 rpg_world_cache_y;
static u16 rpg_dispcnt_shadow;
static u16 rpg_bg1_hofs_shadow;
static u16 rpg_bg1_vofs_shadow;
static u16 rpg_win0h_shadow;
static u16 rpg_win0v_shadow;
static u16 rpg_winin_shadow;
static u16 rpg_winout_shadow;
static u16 rpg_dma_fill_value;
static s32 rpg_ui_mode;
static s32 rpg_ui_quest;
static s32 rpg_ui_dialog;
static s32 rpg_ui_choice;
static s32 rpg_ui_hero_hp;
static s32 rpg_ui_enemy_hp;
static s32 rpg_ui_battle_cursor;
static u8 rpg_bg_dirty;
static u8 rpg_oam_dirty;
static u8 rpg_oam_visible_slots;
static u8 rpg_oam_commit_slots;
static u8 rpg_registers_dirty;
static u8 rpg_world_cache_valid;
static u8 rpg_ui_cache_valid;
static u8 rpg_ready;

static void stage_video(u16 dispcnt, u16 win0h, u16 win0v,
                        u16 winin, u16 winout) {
  rpg_dispcnt_shadow = dispcnt;
  rpg_win0h_shadow = win0h;
  rpg_win0v_shadow = win0v;
  rpg_winin_shadow = winin;
  rpg_winout_shadow = winout;
  rpg_registers_dirty = 1;
}

static void stage_scroll(u16 x, u16 y) {
  rpg_bg1_hofs_shadow = x;
  rpg_bg1_vofs_shadow = y;
  rpg_registers_dirty = 1;
}

static void dma3_copy16(const void *source, volatile void *target,
                        u16 halfwords) {
  if (!halfwords) return;
  REG_DMA3CNT_H = 0;
  REG_DMA3SAD = (u32)source;
  REG_DMA3DAD = (u32)target;
  REG_DMA3CNT_L = halfwords;
  REG_DMA3CNT_H = 0x8000; /* immediate, incrementing, 16-bit transfer */
}

static void dma3_fill16(u16 value, void *target, u16 halfwords) {
  if (!halfwords) return;
  rpg_dma_fill_value = value;
  REG_DMA3CNT_H = 0;
  REG_DMA3SAD = (u32)&rpg_dma_fill_value;
  REG_DMA3DAD = (u32)target;
  REG_DMA3CNT_L = halfwords;
  REG_DMA3CNT_H = 0x8100; /* immediate, fixed source, 16-bit transfer */
}

static void upload_transparent_font(void) {
  volatile u16 *dst = FONT_VRAM + 16; /* tile zero remains transparent */
  u16 i;
  for (i = 0; i < 95 * 16; i++) {
    u8 a = vp_font_tiles[(u16)i * 2];
    u8 b = vp_font_tiles[(u16)i * 2 + 1];
    u8 lo = (u8)(a & 15);
    u8 hi = (u8)(a >> 4);
    if (lo == 2) lo = 0;
    if (hi == 2) hi = 0;
    a = (u8)(lo | (hi << 4));
    lo = (u8)(b & 15);
    hi = (u8)(b >> 4);
    if (lo == 2) lo = 0;
    if (hi == 2) hi = 0;
    b = (u8)(lo | (hi << 4));
    dst[i] = (u16)(a | ((u16)b << 8));
  }
}

static void reset_objects(void) {
  u16 i;
  for (i = 0; i < 128; i++) {
    rpg_oam_shadow[i * 4] = 0x0200;
    rpg_oam_shadow[i * 4 + 1] = 0;
    rpg_oam_shadow[i * 4 + 2] = 0;
    rpg_oam_shadow[i * 4 + 3] = 0;
  }
  rpg_oam_visible_slots = 0;
  rpg_oam_commit_slots = 128;
  rpg_oam_dirty = 1;
}

static void finish_objects(u8 visible) {
  u8 i;
  u8 previous = rpg_oam_visible_slots;
  for (i = visible; i < previous; i++) {
    u16 at = (u16)i * 4;
    rpg_oam_shadow[at] = 0x0200;
    rpg_oam_shadow[at + 1] = 0;
    rpg_oam_shadow[at + 2] = 0;
    rpg_oam_shadow[at + 3] = 0;
  }
  {
    u8 required = visible > previous ? visible : previous;
    if (required > rpg_oam_commit_slots) rpg_oam_commit_slots = required;
  }
  rpg_oam_visible_slots = visible;
  rpg_oam_dirty = 1;
}

static void show_object_32(u8 slot, s16 x, s16 y, u16 tile, u8 palette) {
  u16 at = (u16)slot * 4;
  rpg_oam_shadow[at] = (u16)(y & 0x00ff); /* square, regular OBJ */
  rpg_oam_shadow[at + 1] = (u16)((x & 0x01ff) | 0x8000); /* 32x32 */
  rpg_oam_shadow[at + 2] = (u16)((tile & 0x03ff) | RPG_OBJ_PRIORITY |
                                    ((u16)palette << 12));
  rpg_oam_shadow[at + 3] = 0;
  rpg_oam_dirty = 1;
}

static void show_object_64(u8 slot, s16 x, s16 y, u16 tile, u8 palette) {
  u16 at = (u16)slot * 4;
  rpg_oam_shadow[at] = (u16)(y & 0x00ff); /* square, regular OBJ */
  rpg_oam_shadow[at + 1] = (u16)((x & 0x01ff) | 0xc000); /* 64x64 */
  rpg_oam_shadow[at + 2] = (u16)((tile & 0x03ff) | RPG_OBJ_PRIORITY |
                                    ((u16)palette << 12));
  rpg_oam_shadow[at + 3] = 0;
  rpg_oam_dirty = 1;
}

static void map_fill(u8 tile) {
  u16 entry = RPG_ENTRY(tile);
  dma3_fill16(entry, rpg_bg_shadow, 32 * 32);
  rpg_bg_dirty = 1;
}

static void map_cell(u8 x, u8 y, u8 tile) {
  if (x < 32 && y < 32) {
    rpg_bg_shadow[(u16)y * 32 + x] = RPG_ENTRY(tile);
    rpg_bg_dirty = 1;
  }
}

static void map_world_cell(u8 x, u8 y, u8 frame) {
  u8 tile = (u8)(frame * VP_RPG_WORLD_TILE_FRAME_TILES);
  map_cell(x, y, tile);
  map_cell((u8)(x + 1), y, (u8)(tile + 1));
  map_cell(x, (u8)(y + 1), (u8)(tile + 2));
  map_cell((u8)(x + 1), (u8)(y + 1), (u8)(tile + 3));
}

static u8 world_tile(u8 ch, u8 x, u8 y) {
  if (ch == '#') return WORLD_WALL;
  if (ch == '=' || ch == ':' || ch == 'p')
    return ((x + y) & 1) ? WORLD_PATH_A : WORLD_PATH_B;
  if (ch == '~') return ((x + y) & 1) ? WORLD_WATER_A : WORLD_WATER_B;
  if (ch == 'T' || ch == 't') return WORLD_TREE;
  if (ch == '*') return WORLD_FLOWER;
  return ((x + y) & 1) ? WORLD_GRASS_A : WORLD_GRASS_B;
}

static void line_text(u8 row, u8 x, const char *text) {
  vp_ln_reset();
  if (text) vp_ln_str(text);
  vp_ln_commit(row, x, 0, VP_ALIGN_LEFT);
}

static void line_hp(u8 row, u8 x, s32 hp, s32 max_hp) {
  vp_ln_reset();
  vp_ln_str("HP ");
  vp_ln_int(hp);
  vp_ln_ch('/');
  vp_ln_int(max_hp);
  vp_ln_commit(row, x, 0, VP_ALIGN_LEFT);
}

static void line_choice(u8 row, u8 x, const char *text, u8 selected) {
  vp_ln_reset();
  vp_ln_ch(selected ? '>' : ' ');
  vp_ln_ch(' ');
  if (text) vp_ln_str(text);
  vp_ln_commit(row, x, 0, VP_ALIGN_LEFT);
}

static void draw_box(u8 left, u8 top, u8 right, u8 bottom) {
  u8 x, y;
  map_cell(left, top, TILE_BOX_TL);
  map_cell(right, top, TILE_BOX_TR);
  map_cell(left, bottom, TILE_BOX_BL);
  map_cell(right, bottom, TILE_BOX_BR);
  for (x = (u8)(left + 1); x < right; x++) {
    map_cell(x, top, TILE_BOX_TOP);
    map_cell(x, bottom, TILE_BOX_BOTTOM);
  }
  for (y = (u8)(top + 1); y < bottom; y++) {
    map_cell(left, y, TILE_BOX_LEFT);
    map_cell(right, y, TILE_BOX_RIGHT);
    for (x = (u8)(left + 1); x < right; x++)
      map_cell(x, y, TILE_BOX_FILL);
  }
}

static s32 camera_axis_px(s32 player_px, s32 map_size, s32 view_size,
                          s32 focus) {
  s32 camera;
  s32 maximum;
  if (map_size <= view_size) return 0;
  maximum = (map_size - view_size) * RPG_WORLD_CELL_PX;
  camera = player_px - focus * RPG_WORLD_CELL_PX;
  if (camera < 0) return 0;
  if (camera > maximum) return maximum;
  return camera;
}

static void draw_world(const vp_rpg_map *map, s32 player_x, s32 player_y,
                       s32 player_offset_x, s32 player_offset_y,
                       u8 facing, u8 player_frame, s32 quest, u8 hud) {
  u8 x, y, ox, oy, slot;
  s32 cam_px, cam_py, cam_x, cam_y, world_y, end_y;
  s32 player_px, player_py, player_sort_y;
  if (!map || !map->tiles || !map->width || !map->height) {
    finish_objects(0);
    return;
  }
  if (player_offset_x < -15) player_offset_x = -15;
  if (player_offset_x > 15) player_offset_x = 15;
  if (player_offset_y < -15) player_offset_y = -15;
  if (player_offset_y > 15) player_offset_y = 15;
  player_px = player_x * RPG_WORLD_CELL_PX + player_offset_x;
  player_py = player_y * RPG_WORLD_CELL_PX + player_offset_y;
  cam_px = camera_axis_px(player_px, map->width, RPG_VIEW_W, RPG_FOCUS_X);
  cam_py = camera_axis_px(player_py, map->height, RPG_VIEW_H, RPG_FOCUS_Y);
  cam_x = cam_px / RPG_WORLD_CELL_PX;
  cam_y = cam_py / RPG_WORLD_CELL_PX;
  stage_scroll((u16)(cam_px - cam_x * RPG_WORLD_CELL_PX),
               (u16)(cam_py - cam_y * RPG_WORLD_CELL_PX));
  ox = map->width < RPG_VIEW_W ? (u8)((RPG_VIEW_W - map->width) >> 1) : 0;
  oy = map->height < RPG_VIEW_H ? (u8)((RPG_VIEW_H - map->height) >> 1) : 0;
  if (!rpg_world_cache_valid || rpg_world_cache_map != map ||
      rpg_world_cache_x != cam_x || rpg_world_cache_y != cam_y) {
    map_fill(0);
    for (y = (u8)cam_y; y < map->height; y++) {
      u8 screen_y = (u8)(oy + y - cam_y);
      if (screen_y >= RPG_BUFFER_H) break;
      for (x = (u8)cam_x; x < map->width; x++) {
        u8 screen_x = (u8)(ox + x - cam_x);
        u16 at;
        if (screen_x >= RPG_BUFFER_W) break;
        at = (u16)y * map->width + x;
        map_world_cell((u8)(screen_x * 2), (u8)(screen_y * 2),
                       world_tile(map->tiles[at], x, y));
      }
    }
    rpg_world_cache_map = map;
    rpg_world_cache_x = cam_x;
    rpg_world_cache_y = cam_y;
    rpg_world_cache_valid = 1;
  }
  slot = 0;
  end_y = cam_y + RPG_BUFFER_H - oy;
  if (end_y > map->height) end_y = map->height;
  player_sort_y = player_py / RPG_WORLD_CELL_PX;
  for (world_y = end_y; world_y > cam_y && slot < 127;) {
    s16 actor_y;
    world_y--;
    actor_y = (s16)(oy * RPG_WORLD_CELL_PX +
                    world_y * RPG_WORLD_CELL_PX - cam_py - 16);
    if (player_x >= 0 && player_x < map->width &&
        player_y >= 0 && player_y < map->height &&
        player_sort_y == world_y) {
      u16 hero_tile = 0;
      s16 actor_x = (s16)(ox * RPG_WORLD_CELL_PX + player_px - cam_px - 8);
      s16 hero_y = (s16)(oy * RPG_WORLD_CELL_PX + player_py - cam_py - 16);
      if (facing < VP_RPG_WORLD_WALK_DIRECTION_COUNT) {
        hero_tile = (u16)(facing * VP_RPG_WORLD_ACTOR_FRAME_TILES);
        if (player_frame > 0 && player_frame <= VP_RPG_WORLD_WALK_FRAMES) {
          hero_tile = (u16)(VP_RPG_WORLD_WALK_TILE_BASE +
              ((u16)facing * VP_RPG_WORLD_WALK_FRAMES + player_frame - 1) *
                  VP_RPG_WORLD_ACTOR_FRAME_TILES);
        }
      }
      if (actor_x > -32 && actor_x < 240 && hero_y > -32 && hero_y < 160)
        show_object_32(slot++, actor_x, hero_y, hero_tile, 0);
    }
    for (x = 0; x < map->width && slot < 127; x++) {
      s16 actor_x = (s16)(ox * RPG_WORLD_CELL_PX +
                          (s32)x * RPG_WORLD_CELL_PX - cam_px - 8);
      u8 ch;
      if (actor_x <= -32 || actor_x >= 240 || actor_y <= -32 || actor_y >= 160)
        continue;
      ch = map->tiles[(u16)world_y * map->width + x];
      if (ch == 'N') {
        show_object_32(slot++, actor_x, actor_y,
                       VP_RPG_WORLD_ELDER_TILE, 1);
      } else if (ch == 'S' && quest == 1) {
        show_object_32(slot++, actor_x, actor_y,
                       VP_RPG_WORLD_SLIME_TILE, 2);
      }
    }
  }
  if (hud) {
    if (quest == 0) line_text(0, 1, "QUEST: TALK TO THE ELDER");
    else if (quest == 1) line_text(0, 1, "QUEST: DEFEAT THE SLIME");
    else if (quest == 2) line_text(0, 1, "QUEST: RETURN TO THE ELDER");
    else line_text(0, 1, "QUEST COMPLETE: VILLAGE SAVED");
  }
  finish_objects(slot);
}

static void draw_dialog(const vp_rpg_map *map, s32 player_x, s32 player_y,
                        s32 player_offset_x, s32 player_offset_y,
                        u8 facing, u8 player_frame, s32 quest,
                        s32 dialog, s32 choice) {
  const vp_rpg_dialog *d;
  draw_world(map, player_x, player_y, player_offset_x, player_offset_y,
             facing, player_frame, quest, 0);
  draw_box(1, 11, 28, 19);
  rpg_world_cache_valid = 0;
  if (!map || !map->dialogs || dialog < 1 || dialog > map->dialog_count) {
    line_text(15, 3, "...");
    return;
  }
  d = &map->dialogs[dialog - 1];
  line_text(12, 3, d->speaker);
  line_text(14, 3, d->line1);
  line_text(15, 3, d->line2);
  if (d->choice0 && d->choice0[0])
    line_choice(17, 3, d->choice0, choice == 0);
  if (d->choice1 && d->choice1[0])
    line_choice(18, 3, d->choice1, choice == 1);
}

static u8 hp_tiles(s32 hp, s32 max_hp) {
  if (hp <= 0 || max_hp <= 0) return 0;
  if (hp >= max_hp) return 10;
  return (u8)((hp * 10 + max_hp - 1) / max_hp);
}

static void draw_battle(s32 hero_hp, s32 enemy_hp, s32 cursor) {
  u8 x, y, full;
  stage_scroll(0, 0);
  rpg_world_cache_valid = 0;
  for (y = 0; y < 32; y++)
    for (x = 0; x < 32; x++)
      rpg_bg_shadow[(u16)y * 32 + x] =
          RPG_ENTRY(y < 11 ? TILE_BATTLE_SKY : TILE_BATTLE_GROUND);
  rpg_bg_dirty = 1;
  full = hp_tiles(enemy_hp, 18);
  for (x = 0; x < 10; x++)
    map_cell((u8)(2 + x), 4, x < full ? TILE_HP_FULL : TILE_HP_EMPTY);
  full = hp_tiles(hero_hp, 30);
  for (x = 0; x < 10; x++)
    map_cell((u8)(18 + x), 13, x < full ? TILE_HP_FULL : TILE_HP_EMPTY);
  draw_box(2, 14, 27, 19);
  show_object_64(0, 8, 40, VP_RPG_BATTLE_HERO_TILE, 0);
  show_object_64(1, 168, 16, VP_RPG_BATTLE_SLIME_TILE, 2);
  finish_objects(2);
  line_text(1, 2, "WILD SLIME");
  line_hp(2, 2, enemy_hp, 18);
  line_text(10, 18, "HERO");
  line_hp(11, 18, hero_hp, 30);
  line_choice(15, 4, "ATTACK", cursor == 0);
  line_choice(17, 4, "HEAL", cursor == 1);
}

u8 vp_rpg_blocked(const vp_rpg_map *map, s32 x, s32 y) {
  u32 at;
  if (!map || x < 0 || y < 0 || x >= map->width || y >= map->height)
    return 1;
  if (!map->solid) return 0;
  at = (u32)y * map->width + (u32)x;
  return map->solid[at] ? 1 : 0;
}

u8 vp_rpg_event_at(const vp_rpg_map *map, s32 x, s32 y) {
  u8 tile, i;
  u32 at;
  if (!map || !map->tiles || !map->events || x < 0 || y < 0 ||
      x >= map->width || y >= map->height)
    return 0;
  at = (u32)y * map->width + (u32)x;
  tile = map->tiles[at];
  for (i = 0; i < map->event_count; i++)
    if (map->events[i].tile == tile) return map->events[i].event;
  return 0;
}

void vp_rpg_video_init(void) {
  u16 i;
  upload_transparent_font();
  for (i = 0; i < 16; i++) {
    PAL_BG[RPG_BG_BANK * 16 + i] = vp_rpg_bg_palette[i];
  }
  for (i = 0; i < 3 * 16; i++) PAL_OBJ[i] = vp_rpg_obj_palettes[i];
  for (i = 0; i < VP_RPG_BG_TILE_COUNT * 16; i++)
    RPG_BG_VRAM[i] = vp_rpg_bg_tiles[i];
  for (i = 0; i < VP_RPG_OBJ_TILE_COUNT * 16; i++)
    RPG_OBJ_VRAM[i] = vp_rpg_obj_tiles[i];
  map_fill(0);
  reset_objects();
  REG_BG1CNT = (u16)(2 | (2 << 2) | (9 << 8));
  stage_scroll(0, 0);
  stage_video(0x1340, 0, 0, 0, 0);
  rpg_ready = 1;
}

void vp_rpg_render(const vp_rpg_map *map, u8 mode, s32 player_x,
                   s32 player_y, s32 player_offset_x,
                   s32 player_offset_y, u8 facing, u8 player_frame,
                   s32 quest, s32 dialog, s32 choice, s32 hero_hp,
                   s32 enemy_hp, s32 battle_cursor) {
  u8 ui_changed;
  if (!rpg_ready) return;
  ui_changed = !rpg_ui_cache_valid || rpg_ui_mode != mode ||
      rpg_ui_quest != quest || rpg_ui_dialog != dialog ||
      rpg_ui_choice != choice || rpg_ui_hero_hp != hero_hp ||
      rpg_ui_enemy_hp != enemy_hp ||
      rpg_ui_battle_cursor != battle_cursor;
  if (ui_changed) {
    vp_row_clear(0, VP_GRID_H);
    rpg_ui_mode = mode;
    rpg_ui_quest = quest;
    rpg_ui_dialog = dialog;
    rpg_ui_choice = choice;
    rpg_ui_hero_hp = hero_hp;
    rpg_ui_enemy_hp = enemy_hp;
    rpg_ui_battle_cursor = battle_cursor;
    rpg_ui_cache_valid = 1;
  }
  if (mode == 1) {
    /* Keep enlarged OBJ heads visible above the dialog, but clip their lower
     * pixels at its y=88 edge so arbitrary maps cannot draw actors over UI. */
    stage_video(0x3340, (u16)((0 << 8) | 240),
                (u16)((88 << 8) | 160),
                0x0003, 0x0013);
    draw_dialog(map, player_x, player_y, player_offset_x, player_offset_y,
                facing, player_frame, quest, dialog, choice);
  } else if (mode == 2) {
    stage_video(0x1340, 0, 0, 0, 0);
    draw_battle(hero_hp, enemy_hp, battle_cursor);
  } else {
    /* The map scrolls behind a fixed 8px HUD. WIN0 exposes only BG0 and the
     * backdrop in that strip, so neither world tiles nor actors can drift
     * through the screen-space status line. */
    stage_video(0x3340, (u16)((0 << 8) | 240),
                (u16)((0 << 8) | 8),
                0x0001, 0x0013);
    draw_world(map, player_x, player_y, player_offset_x, player_offset_y,
               facing, player_frame, quest, ui_changed);
  }
}

void vp_rpg_video_commit(void) {
  if (!rpg_ready) return;
  if (rpg_registers_dirty) {
    REG_BG1HOFS = rpg_bg1_hofs_shadow;
    REG_BG1VOFS = rpg_bg1_vofs_shadow;
    REG_WIN0H = rpg_win0h_shadow;
    REG_WIN0V = rpg_win0v_shadow;
    REG_WININ = rpg_winin_shadow;
    REG_WINOUT = rpg_winout_shadow;
    REG_DISPCNT = rpg_dispcnt_shadow;
    RPG_DEBUG_SCROLL_X = rpg_bg1_hofs_shadow;
    RPG_DEBUG_SCROLL_Y = rpg_bg1_vofs_shadow;
    rpg_registers_dirty = 0;
  }
  if (rpg_bg_dirty) {
    dma3_copy16(rpg_bg_shadow, RPG_BG_MAP, 32 * RPG_BUFFER_H * 2);
    rpg_bg_dirty = 0;
  }
  if (rpg_oam_dirty) {
    dma3_copy16(rpg_oam_shadow, OAM, (u16)rpg_oam_commit_slots * 4);
    rpg_oam_commit_slots = 0;
    rpg_oam_dirty = 0;
  }
}
