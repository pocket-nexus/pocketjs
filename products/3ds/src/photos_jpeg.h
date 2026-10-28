/*
 * JPEG through libjpeg (devkitPro's 3ds-libjpeg-turbo on the console) for
 * photos.c. tests/fixtures/3ds-photos.c runs it natively against the
 * computer's libjpeg.
 */

#ifndef POCKETJS_3DS_PHOTOS_JPEG_H
#define POCKETJS_3DS_PHOTOS_JPEG_H

#include <stdio.h>

#include "photos_image.h"

/* Write `rgb` as a JPEG of `quality` to `file`; false when libjpeg or a
 * write failed. */
bool photo_jpeg_write(FILE *file, const uint8_t *rgb, uint32_t width, uint32_t height, int quality);
/* Decode a JPEG (an MPO decodes as its first picture) to RGB888 at the
 * smallest of 1/1, 1/2, 1/4 and 1/8 scale that still covers min_width x
 * min_height, so a thumbnail decodes 640x480 at 160x120. malloc'd; NULL
 * when it does not decode or is larger than PHOTO_DECODE_MAX_PIXELS. */
uint8_t *photo_jpeg_read(const uint8_t *jpeg, size_t length, uint32_t min_width, uint32_t min_height, uint32_t *width,
  uint32_t *height);

#endif
