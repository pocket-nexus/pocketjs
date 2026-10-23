/* Native harness for products/3ds/src/photos_image.c, linked against the
 * computer's libjpeg (tests/camera-photo.test.ts).
 *
 *   3ds-photos names <name>...    one line per name: "<name> 1|0"
 *   3ds-photos roundtrip <w> <h>  encode a synthetic RGB565 still as photos.c
 *                                 does, decode it, and print JSON facts */

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../products/3ds/src/photos_image.h"

/* The camera's RGB565 (red high): left half red, right half blue, a white
 * square in the middle. */
static uint16_t synthetic(uint32_t x, uint32_t y, uint32_t w, uint32_t h) {
  if (x > w * 3 / 8 && x < w * 5 / 8 && y > h * 3 / 8 && y < h * 5 / 8) return 0xffff;
  return x < w / 2 ? (uint16_t)(0x1f << 11) : (uint16_t)0x1f;
}

/* PSM_5650 (red low) to "r,g,b" scaled to 8 bits. */
static void print_5650(const char *label, uint16_t p) {
  unsigned r = (p & 0x1fu) << 3, g = ((p >> 5) & 0x3fu) << 2, b = ((p >> 11) & 0x1fu) << 3;
  printf("\"%s\":[%u,%u,%u]", label, r, g, b);
}

int main(int argc, char **argv) {
  if (argc >= 2 && strcmp(argv[1], "names") == 0) {
    for (int i = 2; i < argc; i += 1) printf("%s %d\n", argv[i], photo_name(argv[i]) ? 1 : 0);
    return 0;
  }
  if (argc == 4 && strcmp(argv[1], "roundtrip") == 0) {
    uint32_t w = (uint32_t)atoi(argv[2]), h = (uint32_t)atoi(argv[3]);
    uint16_t *still = malloc((size_t)w * h * 2u);
    uint8_t *rgb = malloc((size_t)w * h * 3u);
    for (uint32_t y = 0; y < h; y += 1) for (uint32_t x = 0; x < w; x += 1) still[y * w + x] = synthetic(x, y, w, h);
    photo_rgb565_to_rgb888(still, rgb, (size_t)w * h);
    FILE *file = tmpfile();
    int written = file != NULL && photo_jpeg_write(file, rgb, w, h, 90);
    size_t length = file != NULL ? (size_t)ftell(file) : 0;
    uint8_t *jpeg = malloc(length + 1u);
    if (file != NULL) {
      rewind(file);
      length = fread(jpeg, 1, length, file);
      fclose(file);
    }
    uint32_t dw = 0, dh = 0, tw = 0, th = 0, sw = 0, sh = 0;
    uint8_t *decoded = photo_jpeg_read(jpeg, length, w, h, &dw, &dh);
    double error = 0;
    for (size_t i = 0; decoded != NULL && i < (size_t)w * h * 3u; i += 1) error += fabs((double)decoded[i] - rgb[i]);
    error /= (double)w * h * 3.0;
    /* The sizes photos.c asks for: a thumbnail, then the touch screen. */
    uint8_t *small = photo_jpeg_read(jpeg, length, PHOTO_THUMB_SIZE, PHOTO_THUMB_SIZE, &tw, &th);
    uint8_t *screen = photo_jpeg_read(jpeg, length, PHOTO_SCREEN_WIDTH, PHOTO_SCREEN_HEIGHT, &sw, &sh);
    uint16_t *thumb = photo_thumb(small, tw, th);
    uint16_t *full = photo_full(screen, sw, sh);
    printf("{\"written\":%d,\"bytes\":%zu,\"soi\":%d,\"width\":%u,\"height\":%u,\"meanError\":%.2f,", written, length,
      length > 2 && jpeg[0] == 0xff && jpeg[1] == 0xd8, dw, dh, error);
    printf("\"thumbDecode\":[%u,%u],\"screenDecode\":[%u,%u],", tw, th, sw, sh);
    printf("\"garbage\":%d,", photo_jpeg_read(rgb, 64, 1, 1, &tw, &th) == NULL);
    print_5650("thumbCentre", thumb[(PHOTO_THUMB_SIZE / 2) * PHOTO_THUMB_TEXTURE + PHOTO_THUMB_SIZE / 2]);
    printf(",");
    print_5650("thumbLeft", thumb[(PHOTO_THUMB_SIZE / 2) * PHOTO_THUMB_TEXTURE + 2]);
    printf(",");
    print_5650("thumbOutside", thumb[(PHOTO_THUMB_SIZE + 4) * PHOTO_THUMB_TEXTURE + 4]);
    printf(",");
    print_5650("fullTopLeft", full[2 * PHOTO_SCREEN_TEXTURE_WIDTH + 2]);
    printf(",");
    print_5650("fullTopRight", full[2 * PHOTO_SCREEN_TEXTURE_WIDTH + PHOTO_SCREEN_WIDTH - 3]);
    printf(",");
    print_5650("fullBelow", full[(PHOTO_SCREEN_HEIGHT + 4) * PHOTO_SCREEN_TEXTURE_WIDTH + 4]);
    printf("}\n");
    free(decoded);
    free(small);
    free(screen);
    free(thumb);
    free(full);
    free(jpeg);
    free(rgb);
    free(still);
    return 0;
  }
  fprintf(stderr, "usage: 3ds-photos names <name>... | roundtrip <w> <h>\n");
  return 2;
}
