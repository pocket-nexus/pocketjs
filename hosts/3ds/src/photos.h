/*
 * Photos on the SD card (contracts/spec/camera.ts, capability camera.photo):
 * JPEG files under sdmc:/DCIM named the way cameras name them, a thumbnail
 * cache under sdmc:/pocketjs/photos/thumbs, and one worker thread that
 * encodes stills and decodes photos for drawing.
 *
 * Threads. The worker takes jobs from a short queue: SAVE (a still from
 * camera.c, RGB565, encoded to JPEG with stb_image_write, its thumbnail
 * cached) and LOAD (a thumbnail from the cache or a decode with stb_image,
 * or the whole photo fitted to the touch screen). It leaves results in a
 * second queue; photos_present, on the main thread at the frame boundary,
 * uploads decoded pixels as core textures and turns results into the
 * guest's events. The core is touched only from the main thread.
 */

#ifndef POCKETJS_3DS_PHOTOS_H
#define POCKETJS_3DS_PHOTOS_H

#include <stdbool.h>
#include <stdint.h>

/* Queue still `job` for saving; the worker frees `rgb565` (malloc'd,
 * row-major, camera bit order: red in the high bits). Any thread. False when
 * the queue is full; an "error" event then reports the job. */
bool photos_save(int32_t job, uint16_t *rgb565, uint32_t width, uint32_t height);
/* Report still `job` as failed. Any thread. */
void photos_fail(int32_t job, const char *message);
const char *photos_list_json(void);
/* -2 queued (a "loaded" event follows), -1 refused. */
int32_t photos_load(const char *name, int32_t kind);
void photos_free(int32_t handle);
bool photos_remove(const char *name);
/* JSON PhotoEvent[] gathered since the last call, or NULL. */
const char *photos_events_json(void);
/* Main thread, frame boundary: upload finished decodes, publish events. */
void photos_present(void);
/* Guest teardown: finish the job in hand, drop the queue. */
void photos_teardown(void);

#endif
