#ifndef POCKET_WII_EXAMPLE_INPUT_MAP_H
#define POCKET_WII_EXAMPLE_INPUT_MAP_H

#include <stdint.h>

#include "pocket_wii.h"

static inline uint8_t pocket_wii_map_axis(
    uint8_t value, uint8_t min, uint8_t center, uint8_t max) {
  if (min >= center || center >= max) return 128;
  if (value <= min) return 0;
  if (value >= max) return 255;
  if (value < center)
    return (uint8_t)(128 - ((uint32_t)(center - value) * 128) /
                                 (center - min));
  return (uint8_t)(128 + ((uint32_t)(value - center) * 127) /
                               (max - center));
}

static inline uint32_t pocket_wii_map_stick(
    uint8_t x, uint8_t y,
    uint8_t min_x, uint8_t center_x, uint8_t max_x,
    uint8_t min_y, uint8_t center_y, uint8_t max_y) {
  return ((uint32_t)pocket_wii_map_axis(x, min_x, center_x, max_x) << 8) |
         pocket_wii_map_axis(y, min_y, center_y, max_y);
}

/* Include libogc's wpad.h and pad.h before this file in the Wii build. */
static inline uint32_t pocket_wii_map_buttons(
    uint32_t remote, uint32_t nunchuk, uint32_t classic, uint32_t gamecube) {
  uint32_t buttons = 0;

  if ((remote & WPAD_BUTTON_A) || (classic & WPAD_CLASSIC_BUTTON_A) ||
      (gamecube & PAD_BUTTON_A))
    buttons |= POCKET_WII_BTN_CROSS;
  if ((remote & WPAD_BUTTON_B) || (classic & WPAD_CLASSIC_BUTTON_B) ||
      (gamecube & PAD_BUTTON_B))
    buttons |= POCKET_WII_BTN_CIRCLE;
  if ((remote & WPAD_BUTTON_2) || (classic & WPAD_CLASSIC_BUTTON_Y) ||
      (gamecube & PAD_BUTTON_Y))
    buttons |= POCKET_WII_BTN_TRIANGLE;
  if ((remote & WPAD_BUTTON_1) || (classic & WPAD_CLASSIC_BUTTON_X) ||
      (gamecube & PAD_BUTTON_X))
    buttons |= POCKET_WII_BTN_SQUARE;

  if ((remote & WPAD_BUTTON_MINUS) || (classic & WPAD_CLASSIC_BUTTON_MINUS))
    buttons |= POCKET_WII_BTN_SELECT;
  if ((remote & WPAD_BUTTON_PLUS) || (classic & WPAD_CLASSIC_BUTTON_PLUS) ||
      (gamecube & PAD_BUTTON_START))
    buttons |= POCKET_WII_BTN_START;

  if ((remote & WPAD_BUTTON_UP) || (classic & WPAD_CLASSIC_BUTTON_UP) ||
      (gamecube & PAD_BUTTON_UP))
    buttons |= POCKET_WII_BTN_UP;
  if ((remote & WPAD_BUTTON_RIGHT) || (classic & WPAD_CLASSIC_BUTTON_RIGHT) ||
      (gamecube & PAD_BUTTON_RIGHT))
    buttons |= POCKET_WII_BTN_RIGHT;
  if ((remote & WPAD_BUTTON_DOWN) || (classic & WPAD_CLASSIC_BUTTON_DOWN) ||
      (gamecube & PAD_BUTTON_DOWN))
    buttons |= POCKET_WII_BTN_DOWN;
  if ((remote & WPAD_BUTTON_LEFT) || (classic & WPAD_CLASSIC_BUTTON_LEFT) ||
      (gamecube & PAD_BUTTON_LEFT))
    buttons |= POCKET_WII_BTN_LEFT;

  if ((nunchuk & WPAD_NUNCHUK_BUTTON_Z) ||
      (classic & (WPAD_CLASSIC_BUTTON_ZL | WPAD_CLASSIC_BUTTON_FULL_L)) ||
      (gamecube & PAD_TRIGGER_L))
    buttons |= POCKET_WII_BTN_LTRIGGER;
  if ((nunchuk & WPAD_NUNCHUK_BUTTON_C) ||
      (classic & (WPAD_CLASSIC_BUTTON_ZR | WPAD_CLASSIC_BUTTON_FULL_R)) ||
      (gamecube & PAD_TRIGGER_R))
    buttons |= POCKET_WII_BTN_RTRIGGER;

  return buttons;
}

#endif
