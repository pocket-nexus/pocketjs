/* vapor/runtime/gba/vapor_gba.c — the GBA half of the runtime.
 *
 * Mode 0, BG0 only: the 30x20 cell grid from vapor_core.c rendered as font
 * tiles with real per-bank palettes. Cells diff at write time and mark row
 * bits; the commit after vblank copies only dirty rows into the
 * screenblock. The debug block is mirrored to EWRAM each frame.
 */
#include "vapor.h"

#define REG(addr) (*(volatile u16 *)(addr))
#define REG_DISPCNT REG(0x04000000)
#define REG_VCOUNT REG(0x04000006)
#define REG_BG0CNT REG(0x04000008)
#define REG_BG0HOFS REG(0x04000010)
#define REG_BG0VOFS REG(0x04000012)
#define REG_KEYINPUT REG(0x04000130)
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

/* The ROM carries the font 1bpp (95 glyphs x 8 B, MSB = leftmost pixel) and
 * BG0 is 4bpp, so each row byte expands to 4 B of tile data with pixel 1 = ink
 * and 2 = paper. Expanding here rather than shipping the expanded 3040 B table
 * trades one boot loop for 2196 B less ROM in every app. VRAM rejects 8-bit
 * writes, so each row goes out as two u16: low pixels first, leftmost pixel in
 * the low nibble. */
static void upload_font(void) {
  volatile u16 *dst = VRAM + 16; /* tile 1; tile 0 stays blank */
  u16 i;
  for (i = 0; i < 95 * 8; i++) {
    u8 row = vp_font_tiles[i];
    u16 lo = 0, hi = 0;
    u8 x;
    for (x = 0; x < 4; x++) {
      lo |= (u16)((row >> (7 - x)) & 1 ? 1 : 2) << (x * 4);
      hi |= (u16)((row >> (3 - x)) & 1 ? 1 : 2) << (x * 4);
    }
    *dst++ = lo;
    *dst++ = hi;
  }
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

int main(void) {
  u16 i;
  u16 prev_keys = 0x03ff;
  u32 frame = 0, flushes = 0;

  for (i = 0; i < (u16)(vp_palette_count * 16); i++) PAL_BG[i] = vp_palettes[i];
  PAL_BG[0] = vp_backdrop;
  upload_font();
  REG_BG0CNT = (SB_MAP << 8) | 0; /* 4bpp, charblock 0, priority 0 */
  REG_BG0HOFS = 0;
  REG_BG0VOFS = 0;

  vp_row_clear(0, VP_GRID_H);
  app_init();
  app_flush();
  flushes++;

  REG_DISPCNT = 0x0100; /* mode 0, BG0 on */

  for (;;) {
    u16 keys, edges;
    u8 b;
    vsync();
    commit_rows();
    frame++;
    debug_commit(frame, flushes);

    keys = (u16)(REG_KEYINPUT & 0x03ff);
    edges = (u16)(prev_keys & ~keys); /* KEYINPUT is active-low */
    prev_keys = keys;
    for (b = 0; b < 10; b++)
      if (edges & (u16)(1 << b)) app_on_button(b);
    if (app_flush()) flushes++;
  }
}
