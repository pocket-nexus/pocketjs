/* DCF names and photo pixels — see photos_image.h. */

#include "photos_image.h"

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
