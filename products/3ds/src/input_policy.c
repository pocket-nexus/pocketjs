/* Product navigation policy over the platform's unreserved HID facts. */
#include "input_policy.h"
#include "input.h"
#include <3ds.h>
#include <pocket_drivers.h>

#define RUNTIME_RELOAD_KEYS (KEY_L | KEY_R | KEY_X)
#define RUNTIME_DEVMENU_KEYS (KEY_L | KEY_R | KEY_SELECT)
#define RUNTIME_EXIT_KEYS (KEY_L | KEY_R | KEY_START)
static bool devmenu_input_latched;

void input_init(void) { pocket_3ds_hid_init(); }
void input_shutdown(void) { pocket_3ds_hid_shutdown(); }
int32_t input_analog(void) { return pocket_3ds_hid_analog(); }
int32_t input_right_analog(void) { return pocket_3ds_hid_right_analog(); }
size_t input_touch(uint32_t *packed) { return pocket_3ds_hid_touch(packed); }

int32_t input_buttons(void) {
  uint32_t buttons = (uint32_t)pocket_3ds_hid_buttons();
  const uint32_t chords[] = {
    POCKET_BUTTON_LTRIGGER | POCKET_BUTTON_RTRIGGER | POCKET_BUTTON_TRIANGLE,
    POCKET_BUTTON_LTRIGGER | POCKET_BUTTON_RTRIGGER | POCKET_BUTTON_SELECT,
    POCKET_BUTTON_LTRIGGER | POCKET_BUTTON_RTRIGGER | POCKET_BUTTON_START,
  };
  /* Preserve the product's ordered chord suppression when several are held. */
  for (size_t i = 0; i < sizeof chords / sizeof chords[0]; i++)
    if ((buttons & chords[i]) == chords[i]) buttons &= ~chords[i];
  return (int32_t)buttons;
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

bool input_offload_exit_requested(void) {
  const uint32_t keys = KEY_L | KEY_R | KEY_START;
  return (hidKeysHeld() & keys) == keys;
}
