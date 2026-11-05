#ifndef POCKET_OFFLOAD_COVERAGE_H
#define POCKET_OFFLOAD_COVERAGE_H
#include <stdint.h>
#include <stddef.h>
#include <string.h>
static inline int coverage_digit(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  return c == '+' ? 62 : c == '/' ? 63 : -1;
}
#ifndef POCKET_COVERAGE_PIXELS
#define POCKET_COVERAGE_PIXELS 8192
#endif
/* The caller supplies POCKET_COVERAGE_PIXELS RGBA pixels as scratch space.
 * Input is 2-bit alpha, four pixels per byte, low bits first. */
static inline unsigned coverage_height(unsigned height) {
  unsigned padded = 16; while (padded < height && padded < 128) padded *= 2;
  return padded;
}
static inline int coverage_decode(const char *base64, size_t length, unsigned width, unsigned height, uint32_t color, uint8_t *rgba) {
  if (!width || width > 512 || width % 4 || !height || height > 128 || width * height > 8192) return 0;
  unsigned envelope = 8; while (envelope < width) envelope *= 2;
  if (envelope * coverage_height(height) > POCKET_COVERAGE_PIXELS) return 0;
  unsigned count = width * height, bytes = count / 4;
  if (length != ((bytes + 2) / 3) * 4) return 0;
  memset(rgba, 0, envelope * coverage_height(height) * 4);
  unsigned pixel = 0;
  for (size_t i = 0; i < length; i += 4) {
    uint32_t value = 0;
    for (unsigned j = 0; j < 4; j++) {
      int digit = coverage_digit(base64[i + j]);
      if (digit < 0) {
        if (base64[i + j] != '=' || i + 4 != length || j < 2) return 0;
        digit = 0;
      }
      value = (value << 6) | (unsigned)digit;
    }
    for (int byte = 2; byte >= 0 && pixel < count; byte--) {
      unsigned packed = (value >> (byte * 8)) & 255;
      for (unsigned part = 0; part < 4; part++, pixel++) {
        uint8_t *p = rgba + ((pixel / width) * envelope + pixel % width) * 4;
        p[0] = color; p[1] = color >> 8; p[2] = color >> 16;
        p[3] = ((packed >> (part * 2)) & 3) * 85;
      }
    }
  }
  return (int)envelope;
}
static inline int coverage_hex(char c) {
  return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1;
}
/* Optional horizontal palette: one hex index per column, up to 16 RGB colors.
 * Fixed work, same scratch allocation and one uploaded texture. */
static inline int coverage_colorize(const char *columns, size_t columns_length,
    const char *palette, size_t palette_length, unsigned width, unsigned height, unsigned envelope, uint8_t *rgba) {
  if (!width || width > 512 || !height || height > 128 || envelope < width || envelope > 512 || envelope * coverage_height(height) > POCKET_COVERAGE_PIXELS ||
      columns_length != width || !palette_length || palette_length > 96 || palette_length % 6) return 0;
  uint8_t colors[16][3];
  for (size_t i = 0; i < palette_length; i += 2) {
    int a = coverage_hex(palette[i]), b = coverage_hex(palette[i + 1]);
    if (a < 0 || b < 0) return 0;
    colors[i / 6][(i % 6) / 2] = (uint8_t)((a << 4) | b);
  }
  for (unsigned x = 0; x < width; x++) {
    int ink = coverage_hex(columns[x]);
    if (ink < 0 || (unsigned)ink >= palette_length / 6) return 0;
  }
  for (unsigned y = 0; y < height; y++) for (unsigned x = 0; x < width; x++) {
    uint8_t *p = rgba + (y * envelope + x) * 4;
    memcpy(p, colors[coverage_hex(columns[x])], 3);
  }
  return 1;
}
#endif
