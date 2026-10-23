/* DCF names and photo pixels — see photos_image.h. */

#include "photos_image.h"

#include <jpeglib.h>
#include <setjmp.h>
#include <stdlib.h>
#include <string.h>

static bool upper_alnum(char c) {
  return (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_';
}

static bool digit(char c) {
  return c >= '0' && c <= '9';
}

bool photo_folder_name(const char *s) {
  if (strlen(s) != 8 || s[0] < '1' || s[0] > '9' || !digit(s[1]) || !digit(s[2])) return false;
  for (int i = 3; i < 8; i += 1) if (!upper_alnum(s[i])) return false;
  return true;
}

bool photo_file_name(const char *s) {
  if (strlen(s) != 12 || s[8] != '.') return false;
  for (int i = 0; i < 4; i += 1) if (!upper_alnum(s[i])) return false;
  for (int i = 4; i < 8; i += 1) if (!digit(s[i])) return false;
  return strcmp(s + 9, "JPG") == 0 || strcmp(s + 9, "MPO") == 0;
}

bool photo_name(const char *name) {
  if (strlen(name) != 21 || name[8] != '/') return false;
  char folder[9];
  memcpy(folder, name, 8);
  folder[8] = '\0';
  return photo_folder_name(folder) && photo_file_name(name + 9);
}

void photo_upper(char *s) {
  for (; *s; s += 1) if (*s >= 'a' && *s <= 'z') *s = (char)(*s - 'a' + 'A');
}

void photo_rgb565_to_rgb888(const uint16_t *source, uint8_t *rgb, size_t pixels) {
  for (size_t i = 0; i < pixels; i += 1) {
    uint16_t p = source[i];
    uint32_t r = (p >> 11) & 0x1fu, g = (p >> 5) & 0x3fu, b = p & 0x1fu;
    rgb[i * 3u] = (uint8_t)((r << 3) | (r >> 2));
    rgb[i * 3u + 1u] = (uint8_t)((g << 2) | (g >> 4));
    rgb[i * 3u + 2u] = (uint8_t)((b << 3) | (b >> 2));
  }
}

/* libjpeg reports a fatal error by calling error_exit; this one returns to
 * the setjmp in the caller instead of exiting, and warnings print nothing. */
typedef struct {
  struct jpeg_error_mgr base;
  jmp_buf escape;
} JpegError;

static void jpeg_escape(j_common_ptr cinfo) {
  longjmp(((JpegError *)(void *)cinfo->err)->escape, 1);
}

static void jpeg_quiet(j_common_ptr cinfo, int level) {
  (void)cinfo;
  (void)level;
}

static void jpeg_errors(JpegError *error) {
  jpeg_std_error(&error->base);
  error->base.error_exit = jpeg_escape;
  error->base.emit_message = jpeg_quiet;
}

bool photo_jpeg_write(FILE *file, const uint8_t *rgb, uint32_t width, uint32_t height, int quality) {
  struct jpeg_compress_struct cinfo;
  JpegError error;
  cinfo.err = &error.base;
  jpeg_errors(&error);
  if (setjmp(error.escape)) {
    jpeg_destroy_compress(&cinfo);
    return false;
  }
  jpeg_create_compress(&cinfo);
  jpeg_stdio_dest(&cinfo, file);
  cinfo.image_width = width;
  cinfo.image_height = height;
  cinfo.input_components = 3;
  cinfo.in_color_space = JCS_RGB;
  jpeg_set_defaults(&cinfo);
  jpeg_set_quality(&cinfo, quality, TRUE);
  jpeg_start_compress(&cinfo, TRUE);
  while (cinfo.next_scanline < height) {
    JSAMPROW row = (JSAMPROW)(rgb + (size_t)cinfo.next_scanline * width * 3u);
    jpeg_write_scanlines(&cinfo, &row, 1);
  }
  jpeg_finish_compress(&cinfo);
  jpeg_destroy_compress(&cinfo);
  return true;
}

uint8_t *photo_jpeg_read(const uint8_t *jpeg, size_t length, uint32_t min_width, uint32_t min_height, uint32_t *width,
  uint32_t *height) {
  struct jpeg_decompress_struct cinfo;
  JpegError error;
  uint8_t *volatile rgb = NULL;
  cinfo.err = &error.base;
  jpeg_errors(&error);
  if (setjmp(error.escape)) {
    jpeg_destroy_decompress(&cinfo);
    free(rgb);
    return NULL;
  }
  jpeg_create_decompress(&cinfo);
  jpeg_mem_src(&cinfo, (unsigned char *)jpeg, (unsigned long)length);
  jpeg_read_header(&cinfo, TRUE);
  unsigned denominator = 8;
  while (denominator > 1 && ((cinfo.image_width + denominator - 1) / denominator < min_width ||
                             (cinfo.image_height + denominator - 1) / denominator < min_height)) {
    denominator /= 2;
  }
  cinfo.scale_num = 1;
  cinfo.scale_denom = denominator;
  cinfo.out_color_space = JCS_RGB;
  jpeg_start_decompress(&cinfo);
  uint32_t w = cinfo.output_width, h = cinfo.output_height;
  if (w == 0 || h == 0 || (uint64_t)w * h > PHOTO_DECODE_MAX_PIXELS || cinfo.output_components != 3) {
    jpeg_destroy_decompress(&cinfo);
    return NULL;
  }
  rgb = malloc((size_t)w * h * 3u);
  if (rgb == NULL) {
    jpeg_destroy_decompress(&cinfo);
    return NULL;
  }
  while (cinfo.output_scanline < h) {
    JSAMPROW row = (JSAMPROW)(rgb + (size_t)cinfo.output_scanline * w * 3u);
    jpeg_read_scanlines(&cinfo, &row, 1);
  }
  jpeg_finish_decompress(&cinfo);
  jpeg_destroy_decompress(&cinfo);
  *width = w;
  *height = h;
  return rgb;
}

static inline uint16_t pack_5650(uint32_t r, uint32_t g, uint32_t b) {
  return (uint16_t)((r >> 3) | ((g >> 2) << 5) | ((b >> 3) << 11));
}

/* The mean of the source rectangle [x0, x1) x [y0, y1) of RGB888 `rgb`. */
static uint16_t box_mean(const uint8_t *rgb, uint32_t stride, uint32_t x0, uint32_t x1, uint32_t y0, uint32_t y1) {
  uint32_t r = 0, g = 0, b = 0, n = 0;
  if (x1 <= x0) x1 = x0 + 1;
  if (y1 <= y0) y1 = y0 + 1;
  for (uint32_t y = y0; y < y1; y += 1) {
    const uint8_t *row = rgb + (size_t)y * stride * 3u;
    for (uint32_t x = x0; x < x1; x += 1) {
      r += row[x * 3u];
      g += row[x * 3u + 1u];
      b += row[x * 3u + 2u];
      n += 1;
    }
  }
  return pack_5650(r / n, g / n, b / n);
}

uint16_t *photo_thumb(const uint8_t *rgb, uint32_t width, uint32_t height) {
  uint16_t *out = calloc(PHOTO_THUMB_TEXTURE * PHOTO_THUMB_TEXTURE, 2);
  if (out == NULL || width == 0 || height == 0) return out;
  uint32_t side = width < height ? width : height;
  uint32_t left = (width - side) / 2u, top = (height - side) / 2u;
  for (uint32_t y = 0; y < PHOTO_THUMB_SIZE; y += 1) {
    uint32_t y0 = top + y * side / PHOTO_THUMB_SIZE, y1 = top + (y + 1u) * side / PHOTO_THUMB_SIZE;
    for (uint32_t x = 0; x < PHOTO_THUMB_SIZE; x += 1) {
      uint32_t x0 = left + x * side / PHOTO_THUMB_SIZE, x1 = left + (x + 1u) * side / PHOTO_THUMB_SIZE;
      out[y * PHOTO_THUMB_TEXTURE + x] = box_mean(rgb, width, x0, x1, y0, y1);
    }
  }
  return out;
}

uint16_t *photo_full(const uint8_t *rgb, uint32_t width, uint32_t height) {
  uint16_t *out = calloc(PHOTO_SCREEN_TEXTURE_WIDTH * PHOTO_SCREEN_TEXTURE_HEIGHT, 2);
  if (out == NULL || width == 0 || height == 0) return out;
  uint32_t fit_w = PHOTO_SCREEN_WIDTH, fit_h = height * PHOTO_SCREEN_WIDTH / width;
  if (fit_h > PHOTO_SCREEN_HEIGHT) {
    fit_h = PHOTO_SCREEN_HEIGHT;
    fit_w = width * PHOTO_SCREEN_HEIGHT / height;
  }
  if (fit_w == 0 || fit_h == 0) return out;
  uint32_t left = (PHOTO_SCREEN_WIDTH - fit_w) / 2u, top = (PHOTO_SCREEN_HEIGHT - fit_h) / 2u;
  for (uint32_t y = 0; y < fit_h; y += 1) {
    uint32_t y0 = y * height / fit_h, y1 = (y + 1u) * height / fit_h;
    for (uint32_t x = 0; x < fit_w; x += 1) {
      uint32_t x0 = x * width / fit_w, x1 = (x + 1u) * width / fit_w;
      out[(top + y) * PHOTO_SCREEN_TEXTURE_WIDTH + left + x] = box_mean(rgb, width, x0, x1, y0, y1);
    }
  }
  return out;
}
