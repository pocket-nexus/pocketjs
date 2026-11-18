#include <assert.h>
#include <stdio.h>
#include <3ds.h>
#include <pocket_drivers.h>
#include "input.h"
static uint32_t held, extra;
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
void hidCircleRead(circlePosition *out) { *out=left; }
void irrstCstickRead(circlePosition *out) { *out=right; }
void hidTouchRead(touchPosition *out) { *out=touch; }
int main(void) {
  pocket_3ds_hid_init();
  assert(initialized == 0 && pocket_3ds_hid_right_analog() == 0x8080);
  pocket_3ds_hid_shutdown(); supported=true; pocket_3ds_hid_init();
  assert(initialized == 1);
  /* Every held key reaches the program: the driver reserves no chord. */
  held=KEY_L|KEY_R|KEY_X|KEY_A;
  assert(pocket_3ds_hid_buttons() == (POCKET_BUTTON_LTRIGGER|POCKET_BUTTON_RTRIGGER|POCKET_BUTTON_TRIANGLE|POCKET_BUTTON_CIRCLE));
  held=KEY_L|KEY_R|KEY_SELECT|KEY_START;
  assert(pocket_3ds_hid_buttons() == (POCKET_BUTTON_LTRIGGER|POCKET_BUTTON_RTRIGGER|POCKET_BUTTON_SELECT|POCKET_BUTTON_START));
  held=0; extra=KEY_ZL|KEY_ZR;
  assert(pocket_3ds_hid_buttons() == (POCKET_BUTTON_ZL|POCKET_BUTTON_ZR));
  left=(circlePosition){156,156}; right=(circlePosition){-156,-156};
  assert(pocket_3ds_hid_analog() == 0xff01 && pocket_3ds_hid_right_analog() == 0x01ff);
  left=(circlePosition){256,-256}; assert(pocket_3ds_hid_analog() == 0xffff);
  held=KEY_TOUCH; touch=(touchPosition){319,239}; uint32_t packed=0;
  assert(pocket_3ds_hid_touch(&packed) == 1 && packed == ((239u<<9)|319u));
  assert(pocket_3ds_hid_touch(NULL) == 0); held=0; assert(pocket_3ds_hid_touch(&packed) == 0);
  pocket_3ds_hid_shutdown(); assert(stopped == 1 && pocket_3ds_hid_right_analog() == 0x8080);
  puts("unreserved HID facts passed");
}
