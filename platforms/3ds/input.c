/*
 * 3DS keys and circle pad onto the frame contract's two arguments.
 *
 * The button bitmask is the PSP's (contracts/spec/spec.ts BTN) on every host,
 * so the mapping here is positional: A/B/X/Y sit where CIRCLE/CROSS/TRIANGLE/
 * SQUARE sit, which keeps CIRCLE as confirm exactly as the PSP host and the
 * launcher expect.
 *
 * The touchscreen belongs to the BOTTOM auxiliary output (320x240). Its
 * contact is delivered through input.touch.auxiliary and never appears in
 * the primary input.touch snapshot.
 */

#include "input.h"
#include <pocket_drivers.h>

#include <3ds.h>
#include <stddef.h>

/* Full-deflection reading of the circle pad on both console revisions. */
#define CIRCLE_PAD_RANGE 156
static bool extra_input;

void pocket_3ds_hid_init(void) {
#ifndef POCKETJS_CAPTURE
  bool supported = false;
  if (R_SUCCEEDED(APT_CheckNew3DS(&supported)) && supported)
    extra_input = R_SUCCEEDED(irrstInit());
#endif
}

void pocket_3ds_hid_shutdown(void) {
  if (extra_input) irrstExit();
  extra_input = false;
}

static const struct {
  uint32_t key;
  int32_t button;
} KEY_MAP[] = {
  { KEY_A, POCKET_BUTTON_CIRCLE },
  { KEY_B, POCKET_BUTTON_CROSS },
  { KEY_X, POCKET_BUTTON_TRIANGLE },
  { KEY_Y, POCKET_BUTTON_SQUARE },
  { KEY_L, POCKET_BUTTON_LTRIGGER },
  { KEY_R, POCKET_BUTTON_RTRIGGER },
  { KEY_ZL, POCKET_BUTTON_ZL },
  { KEY_ZR, POCKET_BUTTON_ZR },
  { KEY_START, POCKET_BUTTON_START },
  { KEY_SELECT, POCKET_BUTTON_SELECT },
  { KEY_DUP, POCKET_BUTTON_UP },
  { KEY_DDOWN, POCKET_BUTTON_DOWN },
  { KEY_DLEFT, POCKET_BUTTON_LEFT },
  { KEY_DRIGHT, POCKET_BUTTON_RIGHT },
};

int32_t pocket_3ds_hid_buttons(void) {
  uint32_t held = hidKeysHeld();
  /* Shared-memory scan only; service initialization happens before UI boot. */
  if (extra_input) { irrstScanInput(); held |= irrstKeysHeld(); }
  int32_t buttons = 0;
  for (size_t index = 0; index < sizeof KEY_MAP / sizeof KEY_MAP[0]; index += 1) {
    if (held & KEY_MAP[index].key) buttons |= KEY_MAP[index].button;
  }
  return buttons;
}

/* One axis to the PSP nub's 0..255 with 128 the centre. */
static int32_t axis(int value) {
  int scaled = 128 + (value * 127) / CIRCLE_PAD_RANGE;
  if (scaled < 0) scaled = 0;
  if (scaled > 255) scaled = 255;
  return scaled;
}

int32_t pocket_3ds_hid_analog(void) {
  circlePosition pad;
  hidCircleRead(&pad);
  /* The circle pad reads dy positive UP; the contract's Y is positive DOWN. */
  return (axis(pad.dx) << 8) | axis(-pad.dy);
}

int32_t pocket_3ds_hid_right_analog(void) {
  if (!extra_input) return 0x8080;
  circlePosition stick; irrstCstickRead(&stick);
  return (axis(stick.dx) << 8) | axis(-stick.dy);
}

size_t pocket_3ds_hid_touch(uint32_t *packed) {
  if (packed == NULL || (hidKeysHeld() & KEY_TOUCH) == 0) return 0;
  touchPosition touch;
  hidTouchRead(&touch);
  /* touch.ts legacy lane: x:9, y:9, id:8. The resistive panel has one
   * contact, so id 0 remains stable until KEY_TOUCH lifts. */
  *packed = ((uint32_t)touch.py << 9) | (uint32_t)touch.px;
  return 1;
}
