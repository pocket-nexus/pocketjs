/* vapor/runtime/vapor.h — the Pocket Vapor runtime contract, all targets.
 *
 * Two parties compile against this header: the fixed per-console runtime
 * (gba/vapor_gba.c, gb/vapor_gb.c, nes/vapor_nes.c,
 * esp32/vapor_esp32.c, playdate/vapor_playdate.c) and the
 * compiler-generated application (gen_app.c).
 * The runtime owns the cell grid, video commit, input edges, the frame loop
 * and the debug block; the generated
 * app owns all reactive state, computeds, paint effects and button
 * handlers. No allocator exists anywhere — every byte is planned at
 * compile time.
 *
 * Portability: this compiles under arm-none-eabi-gcc (ARM7TDMI), sdcc
 * (SM83), cc65 (6502), and xtensa-esp-elf-gcc. `int` is 16-bit on the
 * 8-bit consoles, so the 32-bit types are `long`; cc65 is C89, so
 * `inline` vanishes there.
 */
#ifndef POCKET_VAPOR_H
#define POCKET_VAPOR_H

typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned long u32;
typedef signed char s8;
typedef signed short s16;
typedef signed long s32;

#if defined(__CC65__)
#define inline
#endif

/* Geometry + budgets: per-target, injected by the compiler as #defines in
 * gen_app.c before this header; the defaults are the GBA profile. */
#ifndef VP_GRID_W
#define VP_GRID_W 30
#endif
#ifndef VP_GRID_H
#define VP_GRID_H 20
#endif
#ifndef VP_STR_CAP
#define VP_STR_CAP 24 /* max chars in a pooled/scratch string */
#endif
#ifndef VP_VIEW_CAP
#define VP_VIEW_CAP 32 /* max elements a list view can hold */
#endif

/* A bounded string: len + bytes, no heap, no NUL required. */
typedef struct {
  u8 len;
  char b[VP_STR_CAP];
} vp_sb;

/* A list view: indices into an app pool, produced by filter/slice chains. */
typedef struct {
  u8 len;
  u8 idx[VP_VIEW_CAP];
} vp_view;

/* ---- RPG host --------------------------------------------------------------
 * Static world/dialogue data is emitted by the Pocket Vapor compiler. Dynamic
 * gameplay state remains in ordinary generated refs; these records only give
 * the fixed GBA renderer and pure map-query helpers access to ROM assets. */
typedef struct {
  u8 tile;
  u8 event;
} vp_rpg_event;

typedef struct {
  const char *speaker;
  const char *line1;
  const char *line2;
  const char *choice0;
  const char *choice1;
} vp_rpg_dialog;

typedef struct {
  u8 width;
  u8 height;
  const u8 *tiles;       /* width * height source glyphs */
  const u8 *solid;       /* width * height, 0 or 1 */
  const vp_rpg_event *events;
  u8 event_count;
  const vp_rpg_dialog *dialogs;
  u8 dialog_count;
} vp_rpg_map;

u8 vp_rpg_blocked(const vp_rpg_map *map, s32 x, s32 y);
u8 vp_rpg_event_at(const vp_rpg_map *map, s32 x, s32 y);
void vp_rpg_video_init(void);
void vp_rpg_render(const vp_rpg_map *map, u8 mode, s32 player_x,
                   s32 player_y, s32 player_offset_x,
                   s32 player_offset_y, u8 facing, u8 player_frame,
                   s32 quest, s32 dialog, s32 choice, s32 hero_hp,
                   s32 enemy_hp, s32 battle_cursor);
void vp_rpg_video_commit(void);

/* ---- grid (runtime-owned) -------------------------------------------------- */
void vp_row_clear(u8 y0, u8 y1); /* rows [y0, y1): space, pair 0 */

/* Row painting is compose-then-commit: parts append into a line scratch,
 * commit places the line (left at x / centered / right), painting the FULL
 * row in the row's style pair — a row owns its whole line. */
#define VP_ALIGN_LEFT 0
#define VP_ALIGN_CENTER 1
#define VP_ALIGN_RIGHT 2
void vp_ln_reset(void);
void vp_ln_str(const char *s);
void vp_ln_sb(const vp_sb *s);
void vp_ln_ch(char c);
void vp_ln_int(s32 v);
void vp_ln_commit(u8 y, u8 x, u8 pal, u8 align);

/* ---- strings ---------------------------------------------------------------- */
void vp_sb_reset(vp_sb *s);
void vp_sb_str(vp_sb *s, const char *lit);
void vp_sb_sb(vp_sb *s, const vp_sb *src);
void vp_sb_ch(vp_sb *s, char c);
/* JS String.prototype.slice(start, end) with clamping, ASCII only. */
void vp_sb_slice(vp_sb *dst, const vp_sb *src, s32 start, s32 end);
/* Assign tmp into dst; returns 1 if the value changed (Vue set semantics). */
u8 vp_sb_assign(vp_sb *dst, const vp_sb *tmp);
u8 vp_sb_eq(const vp_sb *a, const vp_sb *b);

/* ---- tripwires -------------------------------------------------------------- */
#define VP_TRIP_POOL_FULL 1
#define VP_TRIP_STR_TRUNC 2
#define VP_TRIP_VIEW_FULL 4
#define VP_TRIP_PLATFORM_RENDER 8
extern u8 vp_tripwires;

/* core state shared with the per-target runtime */
extern u32 vp_rows_dirty;
extern const u32 vp_bit32[32]; /* vp_bit32[n] == 1UL << n */

/* ---- generated app hooks ----------------------------------------------------- */
#define VP_RELATIVE_AXIS_PRIMARY 0
#define VP_RELATIVE_AXIS_SECONDARY 1
void app_init(void);      /* seed state + first paint (all effects) */
void app_on_button(u8 b); /* one press edge, GBA key bit index */
/* One fixed semantic tick with the hardware-neutral framework BTN mask. */
void app_on_frame(u32 buttons);
void app_on_button_repeat(u8 b); /* normalized held-D-pad repeat */
/* Signed physical motion on a hardware-neutral relative axis. Axis 0 is
 * RelativeAxis.Primary. Rotary hosts use millidegrees and preserve the
 * signed total; applications own detents and sensitivity. */
void app_on_axis_delta(u8 axis, s32 delta);
u8 app_flush(void);       /* computeds + dirty effects; 1 if painted */
u16 app_debug_state(volatile u8 *out); /* mirror reactive state; returns bytes */

/* generated data the runtime uploads at boot (per-target encodings):
 *   GBA: vp_font_tiles 95x32B 4bpp, vp_palettes/vp_palette_count/vp_backdrop
 *   GB:  vp_font_tiles (2 styles x 95) x 16B 2bpp interleaved
 *   NES: vp_font_tiles (2 styles x 95) x 16B 2bpp planar
 *   ESP32: vp_font_tiles 95x8B 1bpp, direct RGB565 ink/paper tables
 *   Playdate: vp_font_tiles 95x8B 1bpp, vp_pal_style maps pair -> normal/inverse
 *   GB/NES/Playdate: vp_pal_style maps logical palette -> glyph style (0/1) */
extern const u8 vp_font_tiles[];
extern const u16 vp_palettes[];
extern const u8 vp_palette_count;
extern const u16 vp_backdrop;
extern const u16 vp_ink565[];
extern const u16 vp_paper565[];
extern const u8 vp_pal_style[];
extern const char vp_app_title[]; /* cartridge title, <= 12 chars */
extern const u8 vp_rpg_enabled;   /* compiler-selected GBA pixel host */

#endif
