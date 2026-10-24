/*
 * Photos under <storage>/DCIM (contracts/spec/camera.ts, capability
 * camera.photo): JPEG files named the way cameras name them, a thumbnail
 * cache under <storage>/photos/thumbs, and one worker task that encodes and
 * decodes through the ESP32-P4 JPEG codec.
 *
 * The worker takes jobs from a short queue: SAVE (a still from camera.c,
 * RGB565 with red in the high bits, encoded and its thumbnail cached) and
 * LOAD (a thumbnail from the cache or decoded, or the whole photo fitted to
 * 320x240). photos_present, on the owner task between ticks, uploads decoded
 * pixels as textures of the running guest and turns results into the guest's
 * events. The runtime is touched only from the owner task.
 */

#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "pocket_runtime.h"

void photos_setup(const char *storage_root, int worker_core);
void photos_bind(pocket_runtime *owner);
/* Queue still `job` for saving; the worker frees `rgb565`, which came from
 * photos_alloc_still. Any task. False when the queue is full; an "error"
 * event then reports the job. */
bool photos_save(int32_t job, uint16_t *rgb565, uint32_t width,
                 uint32_t height);
/* A buffer the PPA writes a width x height RGB565 still to and the JPEG
 * encoder reads it from. */
uint16_t *photos_alloc_still(uint32_t width, uint32_t height);
/* Report still `job` as failed. Any task. */
void photos_fail(int32_t job, const char *message);
const char *photos_list_json(void);
/* -2 queued (a "loaded" event follows), -1 refused. */
int32_t photos_load(const char *name, int32_t kind);
void photos_free(int32_t handle);
bool photos_remove(const char *name);
/* JSON PhotoEvent[] gathered since the last call, or NULL. */
const char *photos_events_json(void);
void photos_present(void);
void photos_teardown(void);
