#ifndef POCKETJS_3DS_STAGE_H
#define POCKETJS_3DS_STAGE_H

/*
 * The agent stage (contracts/spec/agent.ts): the top screen of a guest that
 * declares "system.agent". A cartoon room with the mascot on a cushion, a
 * side desk with its monitor, a window, a poster and a wall clock, drawn by
 * the host in stereo. The guest's primary surface is not shown.
 *
 * The mascot animates on its own once per frame (stage_tick): it breathes,
 * blinks, looks around, glances at its monitor and falls asleep when nobody
 * uses the console. The guest sets what it is doing (stage_set_mode) and what
 * its monitor shows (stage_set_screen); the microphone's level and the
 * console's input feed the animation without the guest.
 *
 * Frame order: stage_tick, then after C3D_FrameBegin stage_capture_mirror
 * (the touch screen's previous frame into the monitor texture), then
 * stage_render on the top targets.
 */

#include <citro3d.h>
#include <stdbool.h>
#include <stdint.h>

bool stage_init(void);
void stage_shutdown(void);

/* contracts/spec/agent.ts AGENT_MODE / AGENT_SCREEN. */
void stage_set_mode(int mode);
void stage_set_screen(int screen);
int stage_mode(void);
/* Microphone loudness, 0..1. */
void stage_set_level(float level);
/* A piece of the reply arrived: a small bounce while speaking. */
void stage_pulse(void);
/* The user pressed or touched something this frame. */
void stage_note_activity(void);

/* Advance the animation one frame. */
void stage_tick(void);
/* Copy the touch screen's last frame into the monitor's mirror texture.
 * Call inside a frame, before anything draws. */
void stage_capture_mirror(C3D_RenderTarget *auxiliary);
/* Draw the room into the left target, and into the right one when the 3D
 * slider is up (returns whether it did). */
bool stage_render(C3D_RenderTarget *left, C3D_RenderTarget *right);

/* One frame of the agent's own screen, RGB565 row-major from the top-left.
 * Copied at once; false when the size is not 320x240. */
bool stage_own_frame(const uint8_t *pixels, uint32_t width, uint32_t height);

/* Stage GPU time spent drawing, last frame, microseconds of CPU submission. */
uint32_t stage_last_us(void);

#endif
