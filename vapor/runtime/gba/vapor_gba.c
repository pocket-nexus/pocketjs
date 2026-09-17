/* vapor/runtime/gba/vapor_gba.c — the GBA half of the runtime.
 *
 * Mode 0 always keeps the 30x20 BG0 cell grid from vapor_core.c. RPG apps
 * additionally enable the fixed BG1 tile-world + OBJ host; their generated
 * refs still own every gameplay transition. Commits happen after vblank and
 * the debug block is mirrored to EWRAM each frame.
 */
#include "vapor.h"

#define REG(addr) (*(volatile u16 *)(addr))
#define REG_DISPCNT REG(0x04000000)
#define REG_VCOUNT REG(0x04000006)
#define REG_BG0CNT REG(0x04000008)
#define REG_BG0HOFS REG(0x04000010)
#define REG_BG0VOFS REG(0x04000012)
#define REG_KEYINPUT REG(0x04000130)
#define VP_DPAD_MASK 0x00f0
#define VP_REPEAT_DELAY_FRAMES 12
#define VP_REPEAT_INTERVAL_FRAMES 6
#define VP_BTN_SELECT 0x0001u
#define VP_BTN_START 0x0008u
#define VP_BTN_UP 0x0010u
#define VP_BTN_RIGHT 0x0020u
#define VP_BTN_DOWN 0x0040u
#define VP_BTN_LEFT 0x0080u
#define VP_BTN_LTRIGGER 0x0100u
#define VP_BTN_RTRIGGER 0x0200u
#define VP_BTN_CIRCLE 0x2000u
#define VP_BTN_CROSS 0x4000u
#define PAL_BG ((volatile u16 *)0x05000000)
#define VRAM ((volatile u16 *)0x06000000)
#define SB_MAP 8
#define SCREENBLOCK(n) ((volatile u16 *)(0x06000000 + (n) * 0x800))

#define DBG_BASE ((volatile u8 *)0x02000000)
#define DBG_FRAME ((volatile u32 *)(0x02000000 + 4))
#define DBG_FLUSHES ((volatile u32 *)(0x02000000 + 8))
#define DBG_TRIPS ((volatile u8 *)(0x02000000 + 12))
#define DBG_STATE_BYTES ((volatile u16 *)(0x02000000 + 14))
#define DBG_STATE ((volatile u8 *)(0x02000000 + 16))
#define DBG_CHARS ((volatile u8 *)(0x02000000 + 0x100))
#define DBG_PALS ((volatile u8 *)(0x02000000 + 0x360))

u8 vp_grid_ch[VP_GRID_H][VP_GRID_W];
u8 vp_grid_pal[VP_GRID_H][VP_GRID_W];

/* Freestanding: gcc lowers struct assignment to memcpy/memset calls. */
void *memcpy(void *dst, const void *src, unsigned long n) {
  u8 *d = (u8 *)dst;
  const u8 *s = (const u8 *)src;
  while (n--) *d++ = *s++;
  return dst;
}

void *memset(void *dst, int v, unsigned long n) {
  u8 *d = (u8 *)dst;
  while (n--) *d++ = (u8)v;
  return dst;
}

static void upload_font(void) {
  const u16 *src = (const u16 *)vp_font_tiles;
  volatile u16 *dst = VRAM + 16; /* tile 1; tile 0 stays blank */
  u16 i;
  for (i = 0; i < 95 * 16; i++) dst[i] = src[i];
}

static void commit_rows(void) {
  volatile u16 *sb = SCREENBLOCK(SB_MAP);
  u8 y, x;
  if (!vp_rows_dirty) return;
  for (y = 0; y < VP_GRID_H; y++) {
    if (!(vp_rows_dirty & ((u32)1 << y))) continue;
    for (x = 0; x < VP_GRID_W; x++) {
      /* glyph tile = 1 + (ascii - 0x20); palette bank in the high nibble */
      u16 entry = (u16)((1 + (vp_grid_ch[y][x] - 0x20)) | ((u16)vp_grid_pal[y][x] << 12));
      sb[(u16)y * 32 + x] = entry;
    }
  }
  vp_rows_dirty = 0;
}

static void debug_commit(u32 frame, u32 flushes) {
  u16 i;
  DBG_BASE[0] = 'P';
  DBG_BASE[1] = 'V';
  DBG_BASE[2] = 'D';
  DBG_BASE[3] = 'B';
  *DBG_FRAME = frame;
  *DBG_FLUSHES = flushes;
  *DBG_TRIPS = vp_tripwires;
  *DBG_STATE_BYTES = app_debug_state(DBG_STATE);
  for (i = 0; i < VP_GRID_H * VP_GRID_W; i++) {
    DBG_CHARS[i] = ((const u8 *)vp_grid_ch)[i];
    DBG_PALS[i] = ((const u8 *)vp_grid_pal)[i];
  }
}

static void vsync(void) {
  while (REG_VCOUNT >= 160) {}
  while (REG_VCOUNT < 160) {}
}

/* Translate GBA KEYINPUT positions to the public PocketJS BTN contract used
 * by PocketJS framework lifecycle callbacks. Unsupported PSP face buttons
 * remain clear; GBA A/B are the primary CROSS/CIRCLE actions. */
static u32 framework_buttons(u16 held) {
  u32 buttons = 0;
  if (held & (1 << 0)) buttons |= VP_BTN_CROSS;
  if (held & (1 << 1)) buttons |= VP_BTN_CIRCLE;
  if (held & (1 << 2)) buttons |= VP_BTN_SELECT;
  if (held & (1 << 3)) buttons |= VP_BTN_START;
  if (held & (1 << 4)) buttons |= VP_BTN_RIGHT;
  if (held & (1 << 5)) buttons |= VP_BTN_LEFT;
  if (held & (1 << 6)) buttons |= VP_BTN_UP;
  if (held & (1 << 7)) buttons |= VP_BTN_DOWN;
  if (held & (1 << 8)) buttons |= VP_BTN_RTRIGGER;
  if (held & (1 << 9)) buttons |= VP_BTN_LTRIGGER;
  return buttons;
}

int main(void) {
  u16 i;
  u16 prev_keys = 0x03ff;
  u8 repeat_frames[10] = { 0 };
  u32 frame = 0, flushes = 0;

  for (i = 0; i < (u16)(vp_palette_count * 16); i++) PAL_BG[i] = vp_palettes[i];
  PAL_BG[0] = vp_backdrop;
  upload_font();
#if defined(VP_ENABLE_RPG)
  if (vp_rpg_enabled) vp_rpg_video_init();
#endif
  REG_BG0CNT = (SB_MAP << 8) | 0; /* 4bpp, charblock 0, priority 0 */
  REG_BG0HOFS = 0;
  REG_BG0VOFS = 0;

  vp_row_clear(0, VP_GRID_H);
  app_init();
  app_flush();
  flushes++;

  /* RPG: mode 0 + 1D OBJ mapping + BG0/BG1/OBJ. Text apps remain BG0-only. */
#if defined(VP_ENABLE_RPG)
  REG_DISPCNT = vp_rpg_enabled ? 0x1340 : 0x0100;
#else
  REG_DISPCNT = 0x0100;
#endif

  for (;;) {
    u16 keys, edges, held;
    u8 b;
    vsync();
    commit_rows();
#if defined(VP_ENABLE_RPG)
    if (vp_rpg_enabled) vp_rpg_video_commit();
#endif
    frame++;
    debug_commit(frame, flushes);

    keys = (u16)(REG_KEYINPUT & 0x03ff);
    edges = (u16)(prev_keys & ~keys); /* KEYINPUT is active-low */
    held = (u16)(~keys & 0x03ff);
    prev_keys = keys;
    for (b = 0; b < 10; b++) {
      u16 bit = (u16)(1 << b);
      if (edges & bit) {
        app_on_button(b);
        repeat_frames[b] = (bit & VP_DPAD_MASK) ? VP_REPEAT_DELAY_FRAMES : 0;
      } else if ((held & bit) && repeat_frames[b]) {
        repeat_frames[b]--;
        if (!repeat_frames[b]) {
          app_on_button_repeat(b);
          repeat_frames[b] = VP_REPEAT_INTERVAL_FRAMES;
        }
      } else {
        repeat_frames[b] = 0;
      }
    }
    app_on_frame(framework_buttons(held));
    if (app_flush()) flushes++;
  }
}
