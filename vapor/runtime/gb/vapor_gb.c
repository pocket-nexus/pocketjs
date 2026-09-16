/* vapor/runtime/gb/vapor_gb.c — the Game Boy (DMG) half of the runtime.
 *
 * The 20x18 cell grid from vapor_core.c lives (with the debug header) at
 * absolute WRAM addresses — the shadow grid IS the debug block, so the
 * harness always reads the logical screen even while the physical VRAM
 * commit trickles through vblank a few staged rows per frame.
 *
 * DMG has one background palette, so logical palettes map to glyph STYLES:
 * two baked font copies (normal / inverse) selected per cell through
 * vp_pal_style. BG map at 0x9800, unsigned tile addressing (0x8000), no
 * scroll, no window, no sprites. Joypad matrix normalized to the GBA bit
 * order the whole stack shares. Pocket Static hal_gb lineage.
 */
#include "vapor.h"

#define REG8(a) (*(volatile u8 *)(a))
#define rP1 REG8(0xFF00)
#define rLCDC REG8(0xFF40)
#define rSTAT REG8(0xFF41)
#define rSCY REG8(0xFF42)
#define rSCX REG8(0xFF43)
#define rLY REG8(0xFF44)
#define rBGP REG8(0xFF47)
#define VRAM8(a) ((volatile u8 *)(a))
#define BG_MAP 0x9800

/* debug block: header 16 + state 48 + chars 360 + pals 360 = 784 B */
#define DBG_BASE 0xD800
__at(DBG_BASE) volatile u8 vp_dbg_hdr[16];
__at(DBG_BASE + 16) volatile u8 vp_dbg_state[48];
__at(DBG_BASE + 64) u8 vp_grid_ch[VP_GRID_H][VP_GRID_W];
__at(DBG_BASE + 64 + VP_GRID_H * VP_GRID_W) u8 vp_grid_pal[VP_GRID_H][VP_GRID_W];

static u32 frame_no, flush_no;

static void wait_vblank(void) {
  while (rLY >= 144) {}
  while (rLY < 144) {}
}

/* VRAM commit, DMG-honest edition. The per-cell style conversion is far
 * too slow for the ~1140-M-cycle vblank window (the PPU silently drops
 * writes once mode 3 starts — that exact bug shipped once: the status row
 * landed, the list row vanished). So rows are CONVERTED to tile bytes in
 * main time (fill_stage) and the vblank does only STAT-guarded raw copies
 * (blit_stage); a row's pending bit clears when its copy lands, never
 * when it is merely staged — missed rows are re-staged next frame. */
#define STAGE_ROWS 3
static u8 stage_tiles[STAGE_ROWS * VP_GRID_W];
static u8 stage_row[STAGE_ROWS];
static u8 stage_n;
static u32 vram_pending;

static void fill_stage(void) {
  u8 y, x;
  u8 *st;
  vram_pending |= vp_rows_dirty;
  vp_rows_dirty = 0;
  stage_n = 0;
  for (y = 0; y < VP_GRID_H && stage_n < STAGE_ROWS; y++) {
    const u8 *rc;
    const u8 *rp;
    if (!(vram_pending & vp_bit32[y])) continue;
    rc = (const u8 *)vp_grid_ch + (u16)y * VP_GRID_W;
    rp = (const u8 *)vp_grid_pal + (u16)y * VP_GRID_W;
    st = stage_tiles + (u16)stage_n * VP_GRID_W; /* u16: no __muluchar */
    for (x = 0; x < VP_GRID_W; x++)
      st[x] = (u8)(1 + (u8)(rc[x] - 0x20) + (vp_pal_style[rp[x]] ? 95 : 0));
    stage_row[stage_n] = y;
    stage_n++;
  }
}

static void blit_stage(void) {
  u8 r, n;
  for (r = 0; r < stage_n; r++) {
    volatile u8 *out;
    const u8 *st;
    /* sdcc's copy loop runs a 20-byte row in roughly 4-5 scanlines, and
     * the PPU silently drops any write that lands in mode 3 — so a row
     * may only START while at least 5 vblank lines remain. A row that
     * misses the window keeps its pending bit and lands next frame. */
    if ((rSTAT & 3) != 1 || rLY > 148) return;
    out = VRAM8(BG_MAP + (u16)stage_row[r] * 32);
    st = stage_tiles + (u16)r * VP_GRID_W;
    n = VP_GRID_W;
    do {
      *out++ = *st++;
    } while (--n);
    vram_pending &= ~vp_bit32[stage_row[r]];
  }
}

static void debug_commit(void) {
  u16 n;
  vp_dbg_hdr[0] = 'P';
  vp_dbg_hdr[1] = 'V';
  vp_dbg_hdr[2] = 'D';
  vp_dbg_hdr[3] = 'B';
  *(volatile u32 *)(vp_dbg_hdr + 4) = frame_no;
  *(volatile u32 *)(vp_dbg_hdr + 8) = flush_no;
  vp_dbg_hdr[12] = vp_tripwires;
  n = app_debug_state(vp_dbg_state);
  vp_dbg_hdr[14] = (u8)n;
  vp_dbg_hdr[15] = (u8)(n >> 8);
}

static u8 read_keys(void) {
  u8 pad, btn;
  rP1 = 0x20; /* select dpad */
  pad = rP1;
  pad = rP1;
  pad = (u8)(~pad & 0x0f); /* right,left,up,down (bits 0-3) */
  rP1 = 0x10; /* select buttons */
  btn = rP1;
  btn = rP1;
  btn = rP1;
  btn = (u8)(~btn & 0x0f); /* a,b,select,start */
  rP1 = 0x30;
  /* normalize to the shared order: a,b,select,start,right,left,up,down */
  return (u8)(btn | (pad << 4));
}

static void upload_font(void) {
  /* vp_font_tiles is 1bpp: 95 glyphs x 8 rows, MSB = leftmost pixel. DMG tiles
   * are 2bpp interleaved (per row: plane 0 byte, then plane 1 byte), and the
   * two baked styles are shade 3 on 0 and its inverse — so a set bit means
   * shade 3 (both planes set) and a clear bit means shade 0 (both clear).
   * Every row is therefore `bits, bits`, and style 1 is style 0 complemented.
   * Expand here rather than shipping 3040 B of ROM holding 760 B of bits.
   * Tile 0 stays blank; style 1 follows style 0's 95 tiles. */
  volatile u8 *d = VRAM8(0x8000 + 16);
  volatile u8 *inv = VRAM8(0x8000 + 16 + 95 * 16);
  const u8 *src = vp_font_tiles;
  u16 i;
  for (i = 0; i < (u16)(95 * 8); i++) {
    u8 bits = src[i];
    *d++ = bits;
    *d++ = bits;
    bits = (u8)~bits;
    *inv++ = bits;
    *inv++ = bits;
  }
}

void main(void) {
  u8 prev = 0;
  u16 i;
  volatile u8 *d;

  vp_dbg_hdr[0] = 'P';
  vp_dbg_hdr[1] = 'V';
  vp_dbg_hdr[2] = 'D';
  vp_dbg_hdr[3] = 'B';
  vp_dbg_hdr[13] = 1; /* boot progress marker */

  wait_vblank();
  rLCDC = 0x00; /* LCD off: free VRAM access */
  rBGP = 0xE4;  /* identity ramp 3,2,1,0 */
  upload_font();
  d = VRAM8(BG_MAP);
  for (i = 0; i < 32 * 32; i++) d[i] = 0; /* blank map */
  rSCX = 0;
  rSCY = 0;

  vp_row_clear(0, VP_GRID_H);
  vp_dbg_hdr[13] = 2;
  app_init();
  vp_dbg_hdr[13] = 3;
  app_flush();
  flush_no++;
  vp_dbg_hdr[13] = 4;
  vram_pending = 0xFFFFFFFF; /* full first paint */
  vp_rows_dirty = 0;

  /* blast the whole first frame while the LCD is still off */
  {
    u8 y, x;
    for (y = 0; y < VP_GRID_H; y++) {
      volatile u8 *out = VRAM8(BG_MAP + (u16)y * 32);
      const u8 *rc = (const u8 *)vp_grid_ch + (u16)y * VP_GRID_W;
      const u8 *rp = (const u8 *)vp_grid_pal + (u16)y * VP_GRID_W;
      for (x = 0; x < VP_GRID_W; x++) {
        u8 style = vp_pal_style[rp[x]];
        out[x] = (u8)(1 + (u8)(rc[x] - 0x20) + (style ? 95 : 0));
      }
    }
    vram_pending = 0;
  }

  rLCDC = 0x80 | 0x01 | 0x10; /* LCD on, BG on, unsigned tiles at 0x8000 */

  for (;;) {
    u8 keys, edges, b;
    fill_stage(); /* main time: convert dirty rows to tile bytes */
    wait_vblank();
    blit_stage(); /* vblank: raw copies only */
    frame_no++;
    debug_commit();

    keys = read_keys();
    edges = (u8)(keys & (u8)~prev);
    prev = keys;
    for (b = 0; b < 8; b++)
      if (edges & (u8)(1 << b)) app_on_button(b);
    if (app_flush()) flush_no++;
  }
}
