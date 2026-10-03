#include <assert.h>
#include <stdint.h>
#include <stdio.h>

/* libogc held-mask values, stubbed so the real mapper builds on a host. */
#define WPAD_BUTTON_2 UINT32_C(0x0001)
#define WPAD_BUTTON_1 UINT32_C(0x0002)
#define WPAD_BUTTON_B UINT32_C(0x0004)
#define WPAD_BUTTON_A UINT32_C(0x0008)
#define WPAD_BUTTON_MINUS UINT32_C(0x0010)
#define WPAD_BUTTON_LEFT UINT32_C(0x0100)
#define WPAD_BUTTON_RIGHT UINT32_C(0x0200)
#define WPAD_BUTTON_DOWN UINT32_C(0x0400)
#define WPAD_BUTTON_UP UINT32_C(0x0800)
#define WPAD_BUTTON_PLUS UINT32_C(0x1000)
#define WPAD_NUNCHUK_BUTTON_Z (UINT32_C(0x0001) << 16)
#define WPAD_NUNCHUK_BUTTON_C (UINT32_C(0x0002) << 16)
#define WPAD_CLASSIC_BUTTON_UP (UINT32_C(0x0001) << 16)
#define WPAD_CLASSIC_BUTTON_LEFT (UINT32_C(0x0002) << 16)
#define WPAD_CLASSIC_BUTTON_ZR (UINT32_C(0x0004) << 16)
#define WPAD_CLASSIC_BUTTON_X (UINT32_C(0x0008) << 16)
#define WPAD_CLASSIC_BUTTON_A (UINT32_C(0x0010) << 16)
#define WPAD_CLASSIC_BUTTON_Y (UINT32_C(0x0020) << 16)
#define WPAD_CLASSIC_BUTTON_B (UINT32_C(0x0040) << 16)
#define WPAD_CLASSIC_BUTTON_ZL (UINT32_C(0x0080) << 16)
#define WPAD_CLASSIC_BUTTON_FULL_R (UINT32_C(0x0200) << 16)
#define WPAD_CLASSIC_BUTTON_PLUS (UINT32_C(0x0400) << 16)
#define WPAD_CLASSIC_BUTTON_MINUS (UINT32_C(0x1000) << 16)
#define WPAD_CLASSIC_BUTTON_FULL_L (UINT32_C(0x2000) << 16)
#define WPAD_CLASSIC_BUTTON_DOWN (UINT32_C(0x4000) << 16)
#define WPAD_CLASSIC_BUTTON_RIGHT (UINT32_C(0x8000) << 16)
#define PAD_BUTTON_LEFT UINT32_C(0x0001)
#define PAD_BUTTON_RIGHT UINT32_C(0x0002)
#define PAD_BUTTON_DOWN UINT32_C(0x0004)
#define PAD_BUTTON_UP UINT32_C(0x0008)
#define PAD_TRIGGER_R UINT32_C(0x0020)
#define PAD_TRIGGER_L UINT32_C(0x0040)
#define PAD_BUTTON_A UINT32_C(0x0100)
#define PAD_BUTTON_B UINT32_C(0x0200)
#define PAD_BUTTON_X UINT32_C(0x0400)
#define PAD_BUTTON_Y UINT32_C(0x0800)
#define PAD_BUTTON_START UINT32_C(0x1000)

#include "input_map.h"

int main(void) {
  assert(pocket_wii_map_buttons(WPAD_BUTTON_A, 0, 0, 0) == UINT32_C(0x4000));
  assert(pocket_wii_map_buttons(WPAD_BUTTON_B, 0, 0, 0) == UINT32_C(0x2000));
  assert(pocket_wii_map_buttons(WPAD_BUTTON_UP, 0, 0, 0) == UINT32_C(0x0010));
  assert(pocket_wii_map_buttons(WPAD_BUTTON_RIGHT, 0, 0, 0) == UINT32_C(0x0020));
  assert(pocket_wii_map_buttons(WPAD_BUTTON_DOWN, 0, 0, 0) == UINT32_C(0x0040));
  assert(pocket_wii_map_buttons(WPAD_BUTTON_LEFT, 0, 0, 0) == UINT32_C(0x0080));
  assert(pocket_wii_map_buttons(WPAD_BUTTON_2 | WPAD_BUTTON_1 | WPAD_BUTTON_PLUS |
                                WPAD_BUTTON_MINUS, 0, 0, 0) == UINT32_C(0x9009));
  assert(pocket_wii_map_buttons(0, WPAD_NUNCHUK_BUTTON_Z | WPAD_NUNCHUK_BUTTON_C, 0, 0) ==
         (POCKET_WII_BTN_LTRIGGER | POCKET_WII_BTN_RTRIGGER));
  assert(pocket_wii_map_buttons(0, 0, WPAD_CLASSIC_BUTTON_A | WPAD_CLASSIC_BUTTON_B |
                                WPAD_CLASSIC_BUTTON_LEFT | WPAD_CLASSIC_BUTTON_ZL |
                                WPAD_CLASSIC_BUTTON_PLUS, 0) == UINT32_C(0x6188));
  assert(pocket_wii_map_buttons(0, 0, 0, PAD_BUTTON_A | PAD_BUTTON_B | PAD_BUTTON_UP |
                                   PAD_BUTTON_START | PAD_TRIGGER_L | PAD_TRIGGER_R) ==
         UINT32_C(0x6318));
  assert(pocket_wii_map_stick(120, 130, 0, 120, 240, 0, 130, 250) ==
         POCKET_WII_ANALOG_CENTER);
  assert(pocket_wii_map_stick(0, 130, 0, 120, 240, 0, 130, 250) ==
         UINT32_C(0x0080));
  assert(pocket_wii_map_stick(240, 130, 0, 120, 240, 0, 130, 250) ==
         UINT32_C(0xff80));
  assert(pocket_wii_map_stick(120, 0, 0, 120, 240, 0, 130, 250) ==
         UINT32_C(0x8000));
  assert(pocket_wii_map_stick(120, 250, 0, 120, 240, 0, 130, 250) ==
         UINT32_C(0x80ff));
  assert(pocket_wii_map_stick(0, 0, 0, 120, 240, 0, 130, 250) == 0);
  assert(pocket_wii_map_stick(240, 250, 0, 120, 240, 0, 130, 250) ==
         UINT32_C(0xffff));
  puts("W23a/W23b PASS: button mapping and calibrated Nunchuk axis center/extremes");
  return 0;
}
