/* Behavioural test for engine/runtime/compat/input.c, compiled and
 * run by tests/pocket-input.test.ts with the host compiler. Every scenario is
 * one host event sequence followed by the frame samples the guest would see. */
#include "../../engine/runtime/include/pocket/compat/input.h"
#include "../../contracts/generated/pocket_spec.h"

#include <stdio.h>
#include <stdlib.h>

static int failures;

static void expect(int condition, const char *label)
{
  if (condition) return;
  failures += 1;
  fprintf(stderr, "FAIL %s\n", label);
}

static PocketInputSample sample(PocketInputState *state)
{
  PocketInputSample out;
  pocket_input_sample(state, &out);
  return out;
}

static void keyboard_edges(void)
{
  PocketInputState s;
  pocket_input_init(&s, 1.0f);
  pocket_input_button(&s, POCKET_BTN_CIRCLE, 1, 0);
  expect(sample(&s).buttons == POCKET_BTN_CIRCLE, "key down is pressed and held on the first sample");
  pocket_input_button(&s, POCKET_BTN_CIRCLE, 1, 1); /* platform auto-repeat */
  expect(sample(&s).buttons == POCKET_BTN_CIRCLE, "a held key stays held across samples");
  pocket_input_button(&s, POCKET_BTN_CIRCLE, 0, 0);
  expect(sample(&s).buttons == 0, "key up releases the button");
  pocket_input_button(&s, 0, 1, 0);
  expect(sample(&s).buttons == 0, "an unmapped key (0) is ignored");
  pocket_input_pulse(&s, POCKET_BTN_CIRCLE);
  expect(sample(&s).buttons == POCKET_BTN_CIRCLE, "a pulse presses for one sample");
  expect(sample(&s).buttons == 0, "a pulse does not hold");
}

static void relative_axis(void)
{
  PocketInputState s;
  pocket_input_init(&s, 1.0f); /* integer displacements: a pulse per event */
  pocket_input_relative(&s, 3.0f, 0.0f);
  expect(sample(&s).buttons == POCKET_BTN_RIGHT, "positive x displacement pulses RIGHT once");
  expect(sample(&s).buttons == 0, "a relative pulse does not hold");
  pocket_input_relative(&s, -1.0f, 0.0f);
  expect(sample(&s).buttons == POCKET_BTN_LEFT, "the remainder of a large move does not flip the next pulse");
  pocket_input_relative(&s, 0.0f, -1.0f);
  pocket_input_relative(&s, 0.0f, 2.0f);
  expect(sample(&s).buttons == (POCKET_BTN_UP | POCKET_BTN_DOWN), "each event is its own pulse");

  pocket_input_init(&s, 0.35f); /* fractional deltas accumulate */
  pocket_input_relative(&s, 0.2f, 0.0f);
  expect(sample(&s).buttons == 0, "sub-threshold motion does not pulse");
  pocket_input_relative(&s, 0.2f, 0.0f);
  expect(sample(&s).buttons == POCKET_BTN_RIGHT, "accumulated motion pulses once");
  pocket_input_relative(&s, 0.2f, 0.0f);
  expect(sample(&s).buttons == 0, "a pulse resets the axis");
  pocket_input_relative(&s, -0.2f, 0.3f);
  pocket_input_relative(&s, 0.0f, 0.1f);
  expect(sample(&s).buttons == POCKET_BTN_DOWN, "opposite motion cancels; the other axis pulses DOWN");
}

static void primary_button(void)
{
  PocketInputState s;
  pocket_input_init(&s, 1.0f);
  pocket_input_primary(&s, 1);
  expect(sample(&s).buttons == POCKET_BTN_CIRCLE, "primary down presses CIRCLE");
  pocket_input_primary(&s, 1);
  expect(sample(&s).buttons == POCKET_BTN_CIRCLE, "primary level holds CIRCLE without a second edge");
  pocket_input_primary(&s, 0);
  expect(sample(&s).buttons == 0, "primary up releases CIRCLE");
  pocket_input_button(&s, POCKET_BTN_CIRCLE, 1, 0);
  sample(&s);
  pocket_input_primary(&s, 1);
  pocket_input_primary(&s, 0);
  expect(sample(&s).buttons == POCKET_BTN_CIRCLE, "a click cannot release a key that holds the same bit");
}

static void touch_contact(void)
{
  PocketInputState s;
  PocketInputSample out;
  pocket_input_init(&s, 1.0f);

  /* A tap that goes down and up between two samples is still one press. */
  pocket_input_touch(&s, POCKET_TOUCH_DOWN, 0, 10.0f, 20.0f);
  pocket_input_touch(&s, POCKET_TOUCH_UP, 0, 11.0f, 21.0f);
  out = sample(&s);
  expect(out.touch_down == 1 && out.touch_x == 11.0f && out.touch_y == 21.0f, "tap between samples reports one down sample");
  expect(sample(&s).touch_down == 0, "the sample after a tap is up");

  /* A long press: the release is reported at the very next sample. */
  pocket_input_touch(&s, POCKET_TOUCH_DOWN, 0, 1.0f, 1.0f);
  expect(sample(&s).touch_down == 1, "contact down");
  pocket_input_touch(&s, POCKET_TOUCH_MOVE, 0, 2.0f, 3.0f);
  out = sample(&s);
  expect(out.touch_down == 1 && out.touch_x == 2.0f && out.touch_y == 3.0f, "move updates the held contact");
  pocket_input_touch(&s, POCKET_TOUCH_UP, 0, 2.0f, 3.0f);
  expect(sample(&s).touch_down == 0, "release is reported immediately, not one frame later");

  /* A second finger never becomes input. */
  pocket_input_touch(&s, POCKET_TOUCH_DOWN, 0, 5.0f, 5.0f);
  sample(&s);
  pocket_input_touch(&s, POCKET_TOUCH_DOWN, 1, 50.0f, 50.0f);
  pocket_input_touch(&s, POCKET_TOUCH_MOVE, 1, 60.0f, 60.0f);
  out = sample(&s);
  expect(out.touch_down == 1 && out.touch_x == 5.0f, "a second contact does not move the tracked one");
  pocket_input_touch(&s, POCKET_TOUCH_UP, 1, 60.0f, 60.0f);
  expect(sample(&s).touch_down == 1, "a second contact's release does not lift the tracked one");
  pocket_input_touch(&s, POCKET_TOUCH_UP, 0, 5.0f, 5.0f);
  expect(sample(&s).touch_down == 0, "the tracked contact's release lifts");
  pocket_input_touch(&s, POCKET_TOUCH_MOVE, 1, 70.0f, 70.0f);
  expect(sample(&s).touch_down == 0, "a stray move from an untracked contact is not a press");

  /* Cancel drops everything, and the next contact is tracked again. */
  pocket_input_touch(&s, POCKET_TOUCH_DOWN, 0, 1.0f, 1.0f);
  pocket_input_touch(&s, POCKET_TOUCH_CANCEL, 0, 0.0f, 0.0f);
  expect(sample(&s).touch_down == 0, "cancel clears the latch");
  pocket_input_touch(&s, POCKET_TOUCH_DOWN, 0, 9.0f, 9.0f);
  expect(sample(&s).touch_down == 1, "a new contact after cancel is tracked");
}

int main(void)
{
  keyboard_edges();
  relative_axis();
  primary_button();
  touch_contact();
  if (failures != 0) {
    fprintf(stderr, "%d pocket_input expectation(s) failed\n", failures);
    return EXIT_FAILURE;
  }
  return EXIT_SUCCESS;
}
