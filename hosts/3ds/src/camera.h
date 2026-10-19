/*
 * `globalThis.camera` (contracts/spec/camera.ts, capability camera.qr): the
 * outer camera at 320x240 RGB565 into one host texture, plus a quirc QR
 * decoder on a worker thread.
 *
 * Threads. A worker brings the camera service up (camInit and the CAMU
 * configuration block for a few hundred milliseconds, so open() returns at
 * once) and then runs decode passes on request. The main thread arms one
 * CAMU_SetReceiving at a time and polls its event with a zero timeout in
 * camera_present, the GPU-idle frame boundary: a completed frame is copied
 * into the 512x256 texture by one display transfer, and at most every
 * CAMERA_SCAN_MS a copy of it is handed to the worker. No frame waits on the
 * camera or the decoder.
 *
 * The texture resolves like the media texture: open() registers a blank
 * 512x256 image with the core so the guest holds an ordinary handle, and
 * gfx.c draws this module's C3D texture in its place (camera_texture).
 */

#ifndef POCKETJS_3DS_CAMERA_H
#define POCKETJS_3DS_CAMERA_H

#include <citro3d.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

int32_t camera_open(void);
/* Guest close: stop capture and the worker now; the GPU texture is released
 * at the next camera_present, after the frames that drew it retired. */
void camera_close(void);
/* The newest payload decoded since the last call, or NULL. */
const char *camera_poll(size_t *length);
const char *camera_info_json(void);
/* GPU-idle frame boundary: collect a captured frame, upload it, re-arm. */
void camera_present(void);
C3D_Tex *camera_texture(int32_t handle);
/* Guest teardown (GPU idle): release everything immediately. */
void camera_teardown(void);

#endif
