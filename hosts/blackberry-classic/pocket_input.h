#ifndef POCKET_BLACKBERRY_CLASSIC_INPUT_H
#define POCKET_BLACKBERRY_CLASSIC_INPUT_H

#include <stdint.h>

/*
 * Host-side input state shared by the BlackBerry QNX and Android hosts. Platform event callbacks feed it through the functions below; the
 * frame loop samples it exactly once per guest turn. The module is plain C
 * with no platform headers, so the unit test in
 * tests/fixtures/pocket-input-test.c compiles with the host compiler.
 *
 * Input sampling semantics:
 *  - a key down produces one press edge (platform key repeats do not) and
 *    holds the button until the key goes up;
 *  - relative motion accumulates per axis; crossing the threshold emits one
 *    d-pad pulse in that direction and resets that axis;
 *  - the relative device's primary button is the press button (CIRCLE), with
 *    its own held state so it cannot release a key that holds the same bit;
 *  - one contact is tracked from its DOWN to its UP; other contacts are
 *    ignored; a contact that went down and up between two samples still
 *    reports exactly one down sample (the latch), and a release is reported
 *    at the very next sample.
 */

typedef enum {
  POCKET_TOUCH_DOWN,
  POCKET_TOUCH_MOVE,
  POCKET_TOUCH_UP,
  POCKET_TOUCH_CANCEL
} PocketTouchPhase;

typedef struct {
  uint32_t held_keys;
  uint32_t held_primary;
  uint32_t pressed;
  float relative_x;
  float relative_y;
  float relative_threshold;
  int primary_down;
  int touch_id;
  int touch_down;
  int touch_latched;
  float touch_x;
  float touch_y;
} PocketInputState;

typedef struct {
  uint32_t buttons;
  int touch_down;
  float touch_x;
  float touch_y;
} PocketInputSample;

void pocket_input_init(PocketInputState *state, float relative_threshold);

/* A platform key already mapped onto a portable button bit (0 = unmapped). */
void pocket_input_button(PocketInputState *state, uint32_t button, int down, int repeat);

/* A one-shot press edge for inputs without a release event (system keys). */
void pocket_input_pulse(PocketInputState *state, uint32_t button);

/* Relative pointing motion; d-pad pulses on threshold crossings. */
void pocket_input_relative(PocketInputState *state, float delta_x, float delta_y);

/* The relative device's primary button, level-triggered. */
void pocket_input_primary(PocketInputState *state, int down);

/* One contact with a platform id and position in any consistent unit. */
void pocket_input_touch(
  PocketInputState *state,
  PocketTouchPhase phase,
  int id,
  float x,
  float y
);

/* The per-frame sample; clears press edges and the touch latch. */
void pocket_input_sample(PocketInputState *state, PocketInputSample *out);

#endif
