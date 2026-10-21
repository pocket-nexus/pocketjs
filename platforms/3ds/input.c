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

#include <3ds.h>
#include <stddef.h>

/* contracts/spec/spec.ts BTN. */
#define BTN_SELECT 0x0001
#define BTN_START 0x0008
#define BTN_UP 0x0010
#define BTN_RIGHT 0x0020
#define BTN_DOWN 0x0040
#define BTN_LEFT 0x0080
#define BTN_LTRIGGER 0x0100
#define BTN_RTRIGGER 0x0200
#define BTN_ZL 0x0400
#define BTN_ZR 0x0800
#define BTN_TRIANGLE 0x1000
#define BTN_CIRCLE 0x2000
#define BTN_CROSS 0x4000
#define BTN_SQUARE 0x8000

/* Full-deflection reading of the circle pad on both console revisions. */
#define CIRCLE_PAD_RANGE 156
#define RUNTIME_RELOAD_KEYS (KEY_L | KEY_R | KEY_X)
#define RUNTIME_DEVMENU_KEYS (KEY_L | KEY_R | KEY_SELECT)
#define RUNTIME_EXIT_KEYS (KEY_L | KEY_R | KEY_START)

static bool devmenu_input_latched;
static bool extra_input;

void input_init(void) {
#ifndef POCKETJS_CAPTURE
  bool supported = false;
  if (R_SUCCEEDED(APT_CheckNew3DS(&supported)) && supported)
    extra_input = R_SUCCEEDED(irrstInit());
#endif
}

void input_shutdown(void) {
  if (extra_input) irrstExit();
  extra_input = false;
}

static const struct {
  uint32_t key;
  int32_t button;
} KEY_MAP[] = {
  { KEY_A, BTN_CIRCLE },
  { KEY_B, BTN_CROSS },
  { KEY_X, BTN_TRIANGLE },
  { KEY_Y, BTN_SQUARE },
  { KEY_L, BTN_LTRIGGER },
  { KEY_R, BTN_RTRIGGER },
  { KEY_ZL, BTN_ZL },
  { KEY_ZR, BTN_ZR },
  { KEY_START, BTN_START },
  { KEY_SELECT, BTN_SELECT },
  { KEY_DUP, BTN_UP },
  { KEY_DDOWN, BTN_DOWN },
  { KEY_DLEFT, BTN_LEFT },
  { KEY_DRIGHT, BTN_RIGHT },
};

int32_t input_buttons(void) {
  uint32_t held = hidKeysHeld();
  /* Shared-memory scan only; service initialization happens before UI boot. */
  if (extra_input) { irrstScanInput(); held |= irrstKeysHeld(); }
  if ((held & RUNTIME_RELOAD_KEYS) == RUNTIME_RELOAD_KEYS) {
    held &= ~RUNTIME_RELOAD_KEYS;
  }
  if ((held & RUNTIME_DEVMENU_KEYS) == RUNTIME_DEVMENU_KEYS) {
    held &= ~RUNTIME_DEVMENU_KEYS;
  }
  if ((held & RUNTIME_EXIT_KEYS) == RUNTIME_EXIT_KEYS) {
    held &= ~RUNTIME_EXIT_KEYS;
  }
  int32_t buttons = 0;
  for (size_t index = 0; index < sizeof KEY_MAP / sizeof KEY_MAP[0]; index += 1) {
    if (held & KEY_MAP[index].key) buttons |= KEY_MAP[index].button;
  }
  return buttons;
}

bool input_reload_requested(void) {
  uint32_t held = hidKeysHeld();
  uint32_t down = hidKeysDown();
  return (held & RUNTIME_RELOAD_KEYS) == RUNTIME_RELOAD_KEYS &&
         (down & RUNTIME_RELOAD_KEYS) != 0;
}

bool input_devmenu_toggle_requested(void) {
  uint32_t held = hidKeysHeld();
  uint32_t down = hidKeysDown();
  return (held & RUNTIME_DEVMENU_KEYS) == RUNTIME_DEVMENU_KEYS &&
         (down & RUNTIME_DEVMENU_KEYS) != 0;
}

bool input_exit_requested(void) {
  uint32_t held = hidKeysHeld();
  uint32_t down = hidKeysDown();
  return (held & RUNTIME_EXIT_KEYS) == RUNTIME_EXIT_KEYS &&
         (down & RUNTIME_EXIT_KEYS) != 0;
}

bool input_devmenu_close_requested(void) {
  return (hidKeysDown() & (KEY_B | KEY_START)) != 0;
}

bool input_devmenu_screenshot_requested(void) {
  return (hidKeysDown() & KEY_X) != 0;
}

bool input_devmenu_blocks_guest(bool menu_visible) {
  if (menu_visible) {
    devmenu_input_latched = true;
    return true;
  }
  if (!devmenu_input_latched) return false;
  if (hidKeysHeld() != 0) return true;
  devmenu_input_latched = false;
  return false;
}

/* One axis to the PSP nub's 0..255 with 128 the centre. */
static int32_t axis(int value) {
  int scaled = 128 + (value * 127) / CIRCLE_PAD_RANGE;
  if (scaled < 0) scaled = 0;
  if (scaled > 255) scaled = 255;
  return scaled;
}

int32_t input_analog(void) {
  circlePosition pad;
  hidCircleRead(&pad);
  /* The circle pad reads dy positive UP; the contract's Y is positive DOWN. */
  return (axis(pad.dx) << 8) | axis(-pad.dy);
}

int32_t input_right_analog(void) {
  if (!extra_input) return 0x8080;
  circlePosition stick; irrstCstickRead(&stick);
  return (axis(stick.dx) << 8) | axis(-stick.dy);
}

size_t input_touch(uint32_t *packed) {
  if (packed == NULL || (hidKeysHeld() & KEY_TOUCH) == 0) return 0;
  touchPosition touch;
  hidTouchRead(&touch);
  /* touch.ts legacy lane: x:9, y:9, id:8. The resistive panel has one
   * contact, so id 0 remains stable until KEY_TOUCH lifts. */
  *packed = ((uint32_t)touch.py << 9) | (uint32_t)touch.px;
  return 1;
}

bool input_offload_exit_requested(void) {
  const uint32_t keys = KEY_L | KEY_R | KEY_START;
  return (hidKeysHeld() & keys) == keys;
}
