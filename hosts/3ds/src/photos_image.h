/*
 * The parts of photos.c that touch no console service: DCF names, the
 * camera's RGB565 to RGB888, and the box-filtered thumbnail and full view in
 * the core's PSM_5650 (red in the low bits). tests/fixtures/3ds-photos.c
 * runs them natively with the vendored stb.
 */

#ifndef POCKETJS_3DS_PHOTOS_IMAGE_H
#define POCKETJS_3DS_PHOTOS_IMAGE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* contracts/spec/camera.ts */
#define PHOTO_SCREEN_WIDTH 320u
#define PHOTO_SCREEN_HEIGHT 240u
#define PHOTO_SCREEN_TEXTURE_WIDTH 512u
#define PHOTO_SCREEN_TEXTURE_HEIGHT 256u
#define PHOTO_THUMB_SIZE 78u
#define PHOTO_THUMB_TEXTURE 128u

/* "100POCKT": three digits from 100, five characters. */
bool photo_folder_name(const char *s);
/* "PKT_0001.JPG": four characters, four digits, JPG or MPO. */
bool photo_file_name(const char *s);
/* PHOTO_NAME: "100POCKT/PKT_0001.JPG". */
bool photo_name(const char *name);
void photo_upper(char *s);
/* The camera's RGB565 (red in the high bits) to RGB888. */
void photo_rgb565_to_rgb888(const uint16_t *source, uint8_t *rgb, size_t pixels);
/* A PHOTO_THUMB_SIZE square from the middle, in the top-left of a
 * PHOTO_THUMB_TEXTURE texture; NULL without memory. */
uint16_t *photo_thumb(const uint8_t *rgb, uint32_t width, uint32_t height);
/* The whole image fitted into the screen on black, in the top-left of a
 * PHOTO_SCREEN_TEXTURE texture; NULL without memory. */
uint16_t *photo_full(const uint8_t *rgb, uint32_t width, uint32_t height);

#endif
