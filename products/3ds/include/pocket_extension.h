#ifndef POCKETJS_3DS_EXTENSION_H
#define POCKETJS_3DS_EXTENSION_H

/*
 * A product extension: a program's own code linked into this product for a guest that
 * declares "system.extension" (README.md, Product extensions). It draws the top screen
 * and publishes its own global; the guest's interface lives on the touch screen, and
 * its primary surface is laid out and not shown.
 *
 * Frame order on the main thread: tick, then after the previous frame has retired
 * frame_begin, then the canonical tick, whose primary display calls render, then
 * after_frame outside the frame.
 */

#include <citro3d.h>
#include <quickjs.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* The size of citro3d's command buffer. */
size_t pocket_extension_command_buffer_bytes(void);
/* The link feature whose name prefixes its microphone messages. */
const char *pocket_extension_link_feature(void);

/* At startup, before any guest boots. False fails the boot. */
bool pocket_extension_init(void);
void pocket_extension_shutdown(void);

/* Set before the guest boots: a guest without the capability keeps the top screen. */
void pocket_extension_set_enabled(bool enabled);
bool pocket_extension_enabled(void);
/* Publishes the extension's global. */
void pocket_extension_install(JSContext *context, JSValueConst global);
/* The program should exit. */
bool pocket_extension_quit_requested(void);

/* Returns the buttons the guest's interface sees this frame. */
int32_t pocket_extension_tick(int32_t buttons, int32_t analog, int32_t right_analog);
/* The GPU has finished the previous frame. */
void pocket_extension_frame_begin(void);
/* Draws the top screen in the current native frame; `right` is the right eye. */
void pocket_extension_render(C3D_RenderTarget *target, C3D_RenderTarget *right);
/* Outside the frame: GPU readback, and anything that opens an applet. */
void pocket_extension_after_frame(void);

/* A ctrl message from the link. True when it was the extension's. */
bool pocket_extension_link_ctrl(const char *json, size_t length);

/* The step of the main loop about to run, for a stall report. */
void pocket_extension_trace(const char *step);
/* QuickJS's interrupt hook ran. */
void pocket_extension_script_tick(void);

#endif
