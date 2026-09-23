/* Input sampling policy shared by the BlackBerry QNX and Android hosts. */
#include "pocket_input.h"

#include "pocket_spec.h"

#include <string.h>

void pocket_input_init(PocketInputState *state, float relative_threshold)
{
  memset(state, 0, sizeof(*state));
  state->relative_threshold = relative_threshold > 0.0f ? relative_threshold : 1.0f;
  state->touch_id = -1;
}

void pocket_input_button(PocketInputState *state, uint32_t button, int down, int repeat)
{
  if (button == 0) return;
  if (down) {
    state->held_keys |= button;
    if (!repeat) state->pressed |= button;
  } else {
    state->held_keys &= ~button;
  }
}

void pocket_input_pulse(PocketInputState *state, uint32_t button)
{
  state->pressed |= button;
}

void pocket_input_relative(PocketInputState *state, float delta_x, float delta_y)
{
  const float threshold = state->relative_threshold;
  state->relative_x += delta_x;
  state->relative_y += delta_y;
  if (state->relative_x <= -threshold) {
    state->pressed |= POCKET_BTN_LEFT;
    state->relative_x = 0.0f;
  } else if (state->relative_x >= threshold) {
    state->pressed |= POCKET_BTN_RIGHT;
    state->relative_x = 0.0f;
  }
  if (state->relative_y <= -threshold) {
    state->pressed |= POCKET_BTN_UP;
    state->relative_y = 0.0f;
  } else if (state->relative_y >= threshold) {
    state->pressed |= POCKET_BTN_DOWN;
    state->relative_y = 0.0f;
  }
}

void pocket_input_primary(PocketInputState *state, int down)
{
  if (down && !state->primary_down) {
    state->held_primary = POCKET_BTN_CIRCLE;
    state->pressed |= POCKET_BTN_CIRCLE;
  } else if (!down && state->primary_down) {
    state->held_primary = 0;
  }
  state->primary_down = down != 0;
}

void pocket_input_touch(
  PocketInputState *state,
  PocketTouchPhase phase,
  int id,
  float x,
  float y
)
{
  switch (phase) {
    case POCKET_TOUCH_DOWN:
      /* The first contact is tracked; a second finger never becomes input.
       * The same id going down again before the release was sampled simply
       * continues the contact. */
      if (state->touch_id < 0 || state->touch_id == id) {
        state->touch_id = id;
        state->touch_down = 1;
        state->touch_latched = 1;
        state->touch_x = x;
        state->touch_y = y;
      }
      break;
    case POCKET_TOUCH_MOVE:
      if (state->touch_id == id) {
        state->touch_x = x;
        state->touch_y = y;
      }
      break;
    case POCKET_TOUCH_UP:
      /* Only the down edge latches: a release is reported at the next sample
       * and never re-arms a down frame. */
      if (state->touch_id == id) {
        state->touch_x = x;
        state->touch_y = y;
        state->touch_down = 0;
      }
      break;
    case POCKET_TOUCH_CANCEL:
      state->touch_id = -1;
      state->touch_down = 0;
      state->touch_latched = 0;
      break;
  }
}

void pocket_input_sample(PocketInputState *state, PocketInputSample *out)
{
  out->buttons = state->held_keys | state->held_primary | state->pressed;
  out->touch_down = state->touch_down || state->touch_latched;
  out->touch_x = state->touch_x;
  out->touch_y = state->touch_y;
  state->pressed = 0;
  state->touch_latched = 0;
  if (!state->touch_down) state->touch_id = -1;
}
