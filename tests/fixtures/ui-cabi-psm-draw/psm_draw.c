/*
 * Host-side coverage for the texture pattern reported in issue #415
 * ("d211-linux: rendering a PSM 5650 texture kills the app"). This fixture
 * drives the shared software raster through its C ABI, with no JavaScript
 * and no framebuffer device. It does not reproduce the device environment:
 *
 *   ui_create_node(image)
 *   ui_upload_img_entry (IMG entry baked by framework/compiler/pak.ts)
 *   ui_set_image + ui_insert_before + ui_tick
 *   ui_render_incremental_scaled(1)  (the device's actual entry point)
 *
 * It runs PSM 5650, 4444, and 8888 for both an 8x8 image (two init/shutdown
 * cycles) and the issue's real shape: two 512x512 pow2 tiles (the second
 * inset by 288 px) on an 800x480 surface. Any panic in the no_std archive
 * (panic=abort) or out-of-bounds access kills the process with a signal
 * instead of returning 0.
 *
 * IMG entry layout (framework/compiler/pak.ts encodeImageEntry):
 *   u16 w, u16 h, u8 psm, u8 flags, u16 reserved, then w*h*bpp pixels.
 * PSM (contracts/spec/spec.ts): 0 = 5650, 2 = 4444, 3 = 8888.
 */

#include "pocket_ui_cabi.h"

/* PR #407 adds this declaration to pocket_ui_cabi.h; the symbol
 * already ship in the main-branch archive (engine/ui-cabi/src/lib.rs,
 * ui_render_scaled/ui_render_incremental_scaled). The d211 device calls
 * ui_render_incremental_scaled(POCKET_RASTER_DENSITY). Drop these once the
 * PR #407 header lands in main. */
const uint8_t *ui_render_incremental_scaled(uint32_t scale);

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

enum {
  PSM_5650 = 0,
  PSM_4444 = 2,
  PSM_8888 = 3,
};

/* contracts/spec/spec.ts PROP. */
enum {
  PROP_WIDTH = 1,
  PROP_HEIGHT = 2,
  PROP_POS_TYPE = 24,
  PROP_INSET_T = 25,
  PROP_INSET_L = 28,
};
/* contracts/spec/spec.ts NODE_TYPE / PosType. */
enum { NODE_IMAGE = 2, POS_ABSOLUTE = 1 };

static void build_entry(uint8_t *out, uint16_t w, uint16_t h, uint32_t psm) {
  uint16_t p16;
  out[0] = (uint8_t)(w & 0xff);
  out[1] = (uint8_t)(w >> 8);
  out[2] = (uint8_t)(h & 0xff);
  out[3] = (uint8_t)(h >> 8);
  out[4] = (uint8_t)psm;
  out[5] = 0; /* flags */
  out[6] = 0;
  out[7] = 0; /* reserved */
  for (size_t i = 0; i < (size_t)w * h; i++) {
    switch (psm) {
    case PSM_5650:
      /* B5:G6:R5, red in the low five bits -> 0x001f, LE bytes 1f 00. */
      p16 = 0x001fu;
      out[8 + i * 2] = (uint8_t)(p16 & 0xff);
      out[8 + i * 2 + 1] = (uint8_t)(p16 >> 8);
      break;
    case PSM_4444:
      /* A<<12|B<<8|G<<4|R: opaque red -> 0xf00f, LE bytes 0f f0. */
      p16 = 0xf00fu;
      out[8 + i * 2] = (uint8_t)(p16 & 0xff);
      out[8 + i * 2 + 1] = (uint8_t)(p16 >> 8);
      break;
    case PSM_8888:
      /* Byte order R, G, B, A (ABGR u32 LE). */
      out[8 + i * 4 + 0] = 255;
      out[8 + i * 4 + 1] = 0;
      out[8 + i * 4 + 2] = 0;
      out[8 + i * 4 + 3] = 255;
      break;
    }
  }
}

static int pixel_is_red(const uint8_t *fb, uint32_t stride, int x, int y) {
  const uint8_t *px = fb + (size_t)y * stride + (size_t)x * 4;
  return px[2] > 240 && px[1] < 16 && px[0] < 16 && px[3] == 255;
}

/* 8x8 opaque red image for one psm: upload, draw on the root's top-left, and
 * sample the composited BGRA framebuffer at (2,2). */
static int run_small(uint32_t psm, const char *name) {
  const size_t bpp = psm == PSM_8888 ? 4u : 2u;
  uint8_t entry[8u + 8u * 8u * 4u];
  build_entry(entry, 8, 8, psm);

  ui_init(1);
  ui_set_viewport(800.0f, 480.0f);

  /* The core pre-creates the root at ROOT_ID 1 (engine/core/src/tree.rs). */
  const int32_t root = 1;
  int32_t image = ui_create_node(NODE_IMAGE);
  if (image < 0) {
    fprintf(stderr, "%s: create_node failed image=%d\n", name, image);
    return 1;
  }
  ui_set_prop(root, PROP_WIDTH, 800.0);
  ui_set_prop(root, PROP_HEIGHT, 480.0);
  ui_set_prop(image, PROP_WIDTH, 8.0);
  ui_set_prop(image, PROP_HEIGHT, 8.0);

  int32_t texture = ui_upload_img_entry(entry, 8u + 8u * 8u * bpp);
  if (texture < 0) {
    fprintf(stderr, "%s: ui_upload_img_entry returned %d\n", name, texture);
    ui_shutdown();
    return 1;
  }
  ui_set_image(image, texture);
  ui_insert_before(root, image, 0); /* 0 = append */

  /* One core tick performs layout; render_incremental composites. This is
   * the exact sequence pocket_legacy_runtime_tick runs on the d211 device. */
  ui_tick();
  const uint8_t *framebuffer = ui_render_incremental_scaled(1);
  if (framebuffer == NULL) {
    fprintf(stderr, "%s: ui_render_incremental_scaled returned NULL\n", name);
    ui_shutdown();
    return 1;
  }

  int red = pixel_is_red(framebuffer, ui_framebuffer_stride(), 2, 2);
  printf("%s: 8x8 upload=%d pixel(2,2) %s\n", name, texture,
         red ? "RED-OK" : "WRONG-COLOR");

  ui_shutdown();
  return red ? 0 : 1;
}

/* The issue's actual shape: an 800x480 opaque artwork baked as two pow2
 * 512x512 tiles (the second offset by 288 px), drawn on an 800x480 surface.
 * 5650 payload is 512 KiB/tile; 8888 is 1 MiB/tile. */
static int run_fullscreen(uint32_t psm, const char *name) {
  const size_t bpp = psm == PSM_8888 ? 4u : 2u;
  const size_t byte_len = 8u + 512u * 512u * bpp;
  uint8_t *entry = malloc(byte_len);
  if (entry == NULL) {
    fprintf(stderr, "%s: out of host memory\n", name);
    return 1;
  }
  build_entry(entry, 512, 512, psm);

  ui_init(1);
  ui_set_viewport(800.0f, 480.0f);
  const int32_t root = 1;
  ui_set_prop(root, PROP_WIDTH, 800.0);
  ui_set_prop(root, PROP_HEIGHT, 480.0);

  int failures = 0;
  int32_t tiles[2] = {-1, -1};
  const int tile_x[2] = {0, 288};
  for (int t = 0; t < 2; t++) {
    int32_t image = ui_create_node(NODE_IMAGE);
    tiles[t] = ui_upload_img_entry(entry, byte_len);
    if (image < 0 || tiles[t] < 0) {
      fprintf(stderr, "%s: tile %d upload failed image=%d tex=%d\n", name, t,
              image, tiles[t]);
      failures = 1;
      break;
    }
    ui_set_prop(image, PROP_POS_TYPE, POS_ABSOLUTE);
    ui_set_prop(image, PROP_WIDTH, 512.0);
    ui_set_prop(image, PROP_HEIGHT, 512.0);
    ui_set_prop(image, PROP_INSET_T, 0.0);
    ui_set_prop(image, PROP_INSET_L, (double)tile_x[t]);
    ui_set_image(image, tiles[t]);
    ui_insert_before(root, image, 0);
  }

  ui_tick();
  const uint8_t *fb = ui_render_incremental_scaled(1);
  if (fb == NULL) {
    fprintf(stderr, "%s: fullscreen render returned NULL\n", name);
    failures = 1;
  } else if (!failures) {
    const uint32_t stride = ui_framebuffer_stride();
    /* Interior of tile A, its far corner, tile B's interior and far corner. */
    const int probes[][2] = {{10, 10}, {500, 470}, {588, 200}, {790, 470}};
    for (size_t i = 0; i < sizeof probes / sizeof probes[0]; i++) {
      if (!pixel_is_red(fb, stride, probes[i][0], probes[i][1])) {
        fprintf(stderr, "%s: probe (%d,%d) is not red\n", name, probes[i][0],
                probes[i][1]);
        failures = 1;
      }
    }
  }
  printf("%s: two 512x512 tiles tex={%d,%d} probes %s\n", name, tiles[0],
         tiles[1], failures ? "FAILED" : "RED-OK");

  free(entry);
  ui_shutdown();
  return failures;
}

int main(void) {
  int failures = 0;
  /* Two init/upload/draw/shutdown cycles exercise texture-table teardown. */
  for (int round = 0; round < 2; round++) {
    failures += run_small(PSM_5650, "PSM_5650");
    failures += run_small(PSM_4444, "PSM_4444");
    failures += run_small(PSM_8888, "PSM_8888");
  }
  failures += run_fullscreen(PSM_5650, "PSM_5650");
  failures += run_fullscreen(PSM_4444, "PSM_4444");
  failures += run_fullscreen(PSM_8888, "PSM_8888");
  if (failures != 0) {
    fprintf(stderr, "psm draw: %d case(s) failed\n", failures);
    return 1;
  }
  puts("psm draw: 5650/4444/8888 upload, 8x8 and 512x512 two-tile draw, "
       "all red");
  return 0;
}
