/* The Pocket3D title card for C hosts.
 *
 * A game built on Pocket3D shows this card when it starts: the mark and the
 * wordmark on the plum ground, faded in from black, held, and faded back to
 * black. POCKET3D_TITLE_TICKS ticks at 60 Hz, 2.4 seconds.
 *
 * This header draws the same frames as the pocket3d-title crate's
 * Layout::Bgr8Columns, byte for byte (tests/pocket3d-title.test.ts compares
 * them). The card needs no GPU: it writes into the frame buffer libctru hands
 * out, so a host plays it before C3D_Init.
 *
 *   gfxInitDefault();
 *   pocket3d_title_play();      // 144 vertical blanks, both screens
 *   C3D_Init(...);
 *
 * The art is pocket3d_title_art.h, baked by tools/pocket3d-title.ts.
 */
#ifndef POCKET3D_TITLE_H
#define POCKET3D_TITLE_H

#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "pocket3d_title_art.h"

#define POCKET3D_TITLE_TICKS 144u
#define POCKET3D_TITLE_FADE_IN 20u
#define POCKET3D_TITLE_FADE_OUT 28u

/* The card's light at a tick, from 0 (black) to 256 (full). */
static inline uint32_t pocket3d_title_level(uint32_t tick) {
  uint32_t n, d, t;
  if (tick >= POCKET3D_TITLE_TICKS) return 0;
  if (tick < POCKET3D_TITLE_FADE_IN) { n = tick + 1; d = POCKET3D_TITLE_FADE_IN; }
  else if (tick >= POCKET3D_TITLE_TICKS - POCKET3D_TITLE_FADE_OUT) { n = POCKET3D_TITLE_TICKS - 1 - tick; d = POCKET3D_TITLE_FADE_OUT; }
  else return 256;
  t = n * 256 / d; /* smoothstep in 8.8 fixed point */
  return (t * t * (768 - 2 * t)) >> 16;
}

/* Draw the frame for a tick into a Nintendo 3DS frame buffer: columns from the
 * left, each from the bottom of the screen up, 3 bytes a pixel (blue, green,
 * red). `stride` is pixels per column, 240. With `art` zero the screen gets
 * the ground alone, which is what the second screen shows.
 *
 * Returns 0, and writes nothing, when `length` is too short for the surface. */
static inline int pocket3d_title_draw(uint8_t *pixels, size_t length, uint32_t width, uint32_t height,
                                      uint32_t stride, uint32_t tick, int art) {
  const unsigned char *a = pocket3d_title_art_half;
  const uint32_t aw = a[4] | (uint32_t)a[5] << 8, ah = a[6] | (uint32_t)a[7] << 8, colours = a[8] | (uint32_t)a[9] << 8;
  const unsigned char *palette = a + 12, *rows = palette + colours * 3, *data = rows + ah * 4;
  const uint32_t level = pocket3d_title_level(tick);
  uint8_t lit[256][3];
  uint32_t x, y, i;
  if (width == 0 || height == 0 || stride < height || length < (size_t)width * stride * 3) return 0;
  for (i = 0; i < colours; i++) {
    lit[i][0] = (uint8_t)((palette[i * 3 + 2] * level) >> 8); /* blue */
    lit[i][1] = (uint8_t)((palette[i * 3 + 1] * level) >> 8);
    lit[i][2] = (uint8_t)((palette[i * 3] * level) >> 8);     /* red */
  }
  for (x = 0; x < width; x++) {
    uint8_t *column = pixels + (size_t)x * stride * 3;
    for (y = 0; y < height; y++) memcpy(column + y * 3, lit[0], 3);
  }
  if (!art || level == 0 || aw > width || ah > height) return 1;
  for (y = 0; y < ah; y++) {
    const unsigned char *at = data + (rows[y * 4] | (uint32_t)rows[y * 4 + 1] << 8 | (uint32_t)rows[y * 4 + 2] << 16 | (uint32_t)rows[y * 4 + 3] << 24);
    const uint32_t row = height - 1 - ((height - ah) / 2 + y); /* counted from the bottom */
    for (x = 0; x < aw; at += 2) {
      uint32_t run = (uint32_t)at[0] + 1;
      /* entry 0 is the ground, which the fill already wrote */
      if (at[1] != 0) {
        for (i = 0; i < run; i++) memcpy(pixels + ((size_t)((width - aw) / 2 + x + i) * stride + row) * 3, lit[at[1]], 3);
      }
      x += run;
    }
  }
  return 1;
}

#if defined(__3DS__) || defined(_3DS)
#include <3ds.h>

/* Play the card on both screens and return when it has ended. Call it after
 * gfxInitDefault (BGR8 frame buffers) and before C3D_Init. */
static inline void pocket3d_title_play(void) {
  uint32_t tick;
  for (tick = 0; tick < POCKET3D_TITLE_TICKS; tick++) {
    u16 across, along; /* libctru reports the buffer as stored: 240 across, the screen's width along */
    u8 *top = gfxGetFramebuffer(GFX_TOP, GFX_LEFT, &across, &along);
    pocket3d_title_draw(top, (size_t)across * along * 3, along, across, across, tick, 1);
    u8 *bottom = gfxGetFramebuffer(GFX_BOTTOM, GFX_LEFT, &across, &along);
    pocket3d_title_draw(bottom, (size_t)across * along * 3, along, across, across, tick, 0);
    gfxFlushBuffers();
    gfxSwapBuffers();
    gspWaitForVBlank();
  }
}
#endif

#endif
