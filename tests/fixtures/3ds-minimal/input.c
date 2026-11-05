#include <assert.h>
#include <stdio.h>
#include <3ds.h>
#include <pocket_drivers.h>
#include "input.h"
#include "input_policy.h"
static uint32_t held, down, extra;
static circlePosition left, right;
static touchPosition touch;
static bool supported;
static unsigned initialized, stopped;
int APT_CheckNew3DS(bool *out) { *out = supported; return 0; }
int irrstInit(void) { initialized++; return 0; }
void irrstExit(void) { stopped++; }
void irrstScanInput(void) {}
uint32_t irrstKeysHeld(void) { return extra; }
uint32_t hidKeysHeld(void) { return held; }
uint32_t hidKeysDown(void) { return down; }
void hidCircleRead(circlePosition *out) { *out=left; }
void irrstCstickRead(circlePosition *out) { *out=right; }
void hidTouchRead(touchPosition *out) { *out=touch; }
int main(void) {
  pocket_3ds_hid_init();
  assert(initialized == 0 && pocket_3ds_hid_right_analog() == 0x8080);
  pocket_3ds_hid_shutdown(); supported=true; input_init();
  assert(initialized == 1);
  held=KEY_L|KEY_R|KEY_X|KEY_A; down=KEY_X;
  assert(pocket_3ds_hid_buttons() == (POCKET_BUTTON_LTRIGGER|POCKET_BUTTON_RTRIGGER|POCKET_BUTTON_TRIANGLE|POCKET_BUTTON_CIRCLE));
  assert(input_buttons() == POCKET_BUTTON_CIRCLE);
  assert(input_reload_requested() && !input_exit_requested());
  down=0; assert(!input_reload_requested());
  held=KEY_L|KEY_R|KEY_SELECT|KEY_START|KEY_X; down=KEY_SELECT;
  assert(input_devmenu_toggle_requested());
  assert(input_buttons() == (POCKET_BUTTON_SELECT|POCKET_BUTTON_START));
  held=KEY_L|KEY_R|KEY_START; down=KEY_START;
  assert(input_exit_requested() && input_offload_exit_requested());
  assert(input_buttons() == 0);
  assert(input_devmenu_blocks_guest(true));
  held=KEY_B; assert(input_devmenu_blocks_guest(false));
  held=0; assert(!input_devmenu_blocks_guest(false));
  held=KEY_A; assert(!input_devmenu_blocks_guest(false));
  down=KEY_B; assert(input_devmenu_close_requested());
  down=KEY_X; assert(input_devmenu_screenshot_requested());
  held=0; extra=KEY_ZL|KEY_ZR;
  assert(pocket_3ds_hid_buttons() == (POCKET_BUTTON_ZL|POCKET_BUTTON_ZR));
  left=(circlePosition){156,156}; right=(circlePosition){-156,-156};
  assert(input_analog() == 0xff01 && input_right_analog() == 0x01ff);
  left=(circlePosition){256,-256}; assert(input_analog() == 0xffff);
  held=KEY_TOUCH; touch=(touchPosition){319,239}; uint32_t packed=0;
  assert(input_touch(&packed) == 1 && packed == ((239u<<9)|319u));
  assert(input_touch(NULL) == 0); held=0; assert(input_touch(&packed) == 0);
  input_shutdown(); assert(stopped == 1 && input_right_analog() == 0x8080);
  puts("unreserved HID facts and product chord policy passed");
}
