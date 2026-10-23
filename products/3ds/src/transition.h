#ifndef POCKETJS_3DS_TRANSITION_H
#define POCKETJS_3DS_TRANSITION_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/*
 * The app-switch transition (docs/LAUNCHER.md "3DS"): a host-owned overlay
 * on both screens while one guest gives way to the next.
 *
 *   leaving   a black scrim rises over the old guest's last frame in
 *             TRANSITION_LEAVE_MS while an activity indicator fades in on
 *             the touch screen; the old guest no longer runs
 *   loading   both screens black, the indicator turning; main.c draws it
 *             between teardown and the new guest's first frame, from the
 *             bytecode wait and from QuickJS's interrupt handler
 *   arriving  the scrim and the indicator fall away over the new guest in
 *             TRANSITION_ARRIVE_MS of presented frames, each frame counting
 *             at most TRANSITION_STEP_MAX_MS, so a slow early frame of the
 *             new guest does not skip the fade
 *
 * Times are milliseconds from the caller (osGetTime on the console), so this
 * file compiles on the build machine for tests/3ds-transition.test.ts.
 *
 * The lists are DrawLists (DRAW_RECT, DRAW_TRI) in units of
 * 1/TRANSITION_SUBPIXELS px: gfx_prepare_surface takes them with the
 * surface's logical size times TRANSITION_SUBPIXELS, which places the
 * indicator's vertices at quarter pixels.
 */

#define TRANSITION_LEAVE_MS 150u
#define TRANSITION_ARRIVE_MS 250u
#define TRANSITION_STEP_MAX_MS 33u
#define TRANSITION_SUBPIXELS 4u

typedef enum {
  TRANSITION_IDLE,
  TRANSITION_LEAVING,
  TRANSITION_LOADING,
  TRANSITION_ARRIVING,
} TransitionPhase;

TransitionPhase transition_phase(void);
/* Idle or arriving -> leaving (from arriving, the scrim rises from its
 * opacity at `now`); loading is kept. */
void transition_leave(uint64_t now);
/* The scrim is opaque: leaving has run its course, or the phase is past it. */
bool transition_covered(uint64_t now);
/* -> loading. Entered without leaving, the indicator fades in instead. */
void transition_load(uint64_t now);
/* Loading -> arriving: the new guest has drawn its first frame. */
void transition_arrive(uint64_t now);
/* Once per presented frame while arriving; idle when the fade is done. */
void transition_advance(uint64_t now);

/* The overlay of the top (touch_screen false) or touch screen at `now` for
 * a surface of width x height px; 0 words when there is nothing to draw.
 * The list lives until the next call. */
size_t transition_list(bool touch_screen, uint64_t now, uint32_t width, uint32_t height, const uint32_t **words);

#endif
