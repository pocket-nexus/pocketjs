/*
 * The parts of photos.c that touch no console service: DCF names, the
 * camera's RGB565 to RGB888, JPEG through libjpeg (devkitPro's
 * 3ds-libjpeg-turbo on the console), and the box-filtered thumbnail and full
 * view in the core's PSM_5650 (red in the low bits).
 * tests/fixtures/3ds-photos.c runs them natively against the computer's
 * libjpeg.
 */

#ifndef POCKETJS_3DS_PHOTOS_IMAGE_H
#define POCKETJS_3DS_PHOTOS_IMAGE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

/* contracts/spec/camera.ts */
#define PHOTO_SCREEN_WIDTH 320u
#define PHOTO_SCREEN_HEIGHT 240u
#define PHOTO_SCREEN_TEXTURE_WIDTH 512u
#define PHOTO_SCREEN_TEXTURE_HEIGHT 256u
#define PHOTO_THUMB_SIZE 78u
#define PHOTO_THUMB_TEXTURE 128u
/* The largest picture photo_jpeg_read returns: 12 MB of RGB888. */
#define PHOTO_DECODE_MAX_PIXELS (4096u * 1024u)

/* "100POCKT": three digits from 100, five characters. */
bool photo_folder_name(const char *s);
/* "PKT_0001.JPG": four characters, four digits, JPG or MPO. */
bool photo_file_name(const char *s);
/* PHOTO_NAME: "100POCKT/PKT_0001.JPG". */
bool photo_name(const char *name);
void photo_upper(char *s);
/* The camera's RGB565 (red in the high bits) to RGB888. */
void photo_rgb565_to_rgb888(const uint16_t *source, uint8_t *rgb, size_t pixels);
/* Write `rgb` as a JPEG of `quality` to `file`; false when libjpeg or a
 * write failed. */
bool photo_jpeg_write(FILE *file, const uint8_t *rgb, uint32_t width, uint32_t height, int quality);
/* Decode a JPEG (an MPO decodes as its first picture) to RGB888 at the
 * smallest of 1/1, 1/2, 1/4 and 1/8 scale that still covers min_width x
 * min_height, so a thumbnail decodes 640x480 at 160x120. malloc'd; NULL
 * when it does not decode or is larger than PHOTO_DECODE_MAX_PIXELS. */
uint8_t *photo_jpeg_read(const uint8_t *jpeg, size_t length, uint32_t min_width, uint32_t min_height, uint32_t *width,
  uint32_t *height);
/* A PHOTO_THUMB_SIZE square from the middle, in the top-left of a
 * PHOTO_THUMB_TEXTURE texture; NULL without memory. */
uint16_t *photo_thumb(const uint8_t *rgb, uint32_t width, uint32_t height);
/* The whole image fitted into the screen on black, in the top-left of a
 * PHOTO_SCREEN_TEXTURE texture; NULL without memory. */
uint16_t *photo_full(const uint8_t *rgb, uint32_t width, uint32_t height);

#endif
