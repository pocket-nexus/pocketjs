#include <malloc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <gccore.h>
#include <ogc/system.h>

#include "drawlist.h"
#include "gx_solid.h"

#define FIFO_SIZE (256 * 1024)

typedef struct {
  PocketWiiGXContext *gx;
  size_t index;
} DrawContext;

static bool draw_solid(const uint32_t *op, size_t word_count, void *context) {
  DrawContext *draw = context;
  draw->index += 1;
  return pocket_wii_gx_solid_op(draw->gx, op, word_count);
}

static int expect_color(const char *name, uint16_t x, uint16_t y,
                        uint8_t r, uint8_t g, uint8_t b) {
  GXColor actual;
  GX_PeekARGB(x, y, &actual);
  if (abs((int)actual.r - r) <= 8 &&
      abs((int)actual.g - g) <= 8 &&
      abs((int)actual.b - b) <= 8) {
    return 1;
  }
  printf("W18a FAIL %s @(%u,%u): got RGBA %u,%u,%u,%u expected RGB %u,%u,%u\n",
         name, x, y, actual.r, actual.g, actual.b, actual.a, r, g, b);
  return 0;
}

int main(void) {
  SYS_STDIO_Report(true);
  VIDEO_Init();
  GXRModeObj *mode = VIDEO_GetPreferredMode(NULL);
  void *xfb = MEM_K0_TO_K1(SYS_AllocateFramebuffer(mode));
  void *fifo = MEM_K0_TO_K1(memalign(32, FIFO_SIZE));
  if (xfb == NULL || fifo == NULL) {
    puts("W18a FAIL framebuffer allocation");
    return 1;
  }
  memset(fifo, 0, FIFO_SIZE);
  VIDEO_Configure(mode);
  VIDEO_SetNextFramebuffer(xfb);
  VIDEO_SetBlack(false);
  VIDEO_Flush();
  VIDEO_WaitVSync();

  GX_Init(fifo, FIFO_SIZE);
  GX_SetPixelFmt(GX_PF_RGB8_Z24, GX_ZC_LINEAR);
  GX_SetCopyClear((GXColor){0, 0, 0, 255}, GX_MAX_Z24);
  GX_SetScissor(0, 0, mode->fbWidth, mode->efbHeight);
  GX_SetDispCopySrc(0, 0, mode->fbWidth, mode->efbHeight);
  GX_SetDispCopyDst(mode->fbWidth, mode->xfbHeight);
  GX_SetDispCopyYScale(GX_GetYScaleFactor(mode->efbHeight, mode->xfbHeight));
  GX_SetCopyFilter(mode->aa, mode->sample_pattern, GX_TRUE, mode->vfilter);
  GX_CopyDisp(xfb, GX_TRUE);
  GX_DrawDone();

  static const uint32_t words[] = {
    1, 0x000a000au, 0x003c0050u, 0xff0000ffu,          /* red RECT */
    1, 0x0014001eu, 0x003c0050u, 0xff00ff00u,          /* green RECT */
    7, 0x0014001eu, 0x00140046u, 0x003c001eu,
       0xffff0000u, 0xffff0000u, 0xffff0000u,           /* blue TRI */
    1, 0x0014003cu, 0x0014001eu, 0x80ff0000u,          /* half-alpha blue */
  };
  PocketWiiGXContext gx;
  DrawContext draw = { &gx, 0 };
  if (!pocket_wii_gx_context_begin(&gx, 40, 30, 240, 136) ||
      pocket_wii_drawlist_walk(words, sizeof words / sizeof words[0],
                               draw_solid, &draw) != POCKET_WII_DRAWLIST_OK ||
      draw.index != 4) {
    puts("W18a FAIL drawlist dispatch");
    return 1;
  }
  GX_DrawDone();

  /* Destination is (40,30,240,136), so logical coordinates scale by 1/2. */
  int ok = expect_color("outside destination", 35, 40, 0, 0, 0) &&
           expect_color("red position / ABGR", 48, 38, 255, 0, 0) &&
           expect_color("green painter order", 72, 48, 0, 255, 0) &&
           expect_color("blue TRI painter order", 58, 42, 0, 0, 255) &&
           expect_color("alpha blend", 78, 45, 0, 127, 128) &&
           expect_color("green right edge", 92, 45, 0, 255, 0) &&
           expect_color("outside geometry", 100, 80, 0, 0, 0);
  if (!ok) return 1;
  puts("W18a PASS: 1/2 destination mapping, ABGR channels, alpha, and RECT/TRI painter order");
  return 0;
}
