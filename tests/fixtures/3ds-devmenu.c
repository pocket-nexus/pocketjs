#include <assert.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "devmenu.h"

void devmenu_snapshot(DevmenuSnapshot *out) {
  memset(out, 0, sizeof *out);
  out->paired = true;
  out->linked = true;
  strcpy(out->ip, "192.168.8.102");
  strcpy(out->phase, "booted");
  strcpy(out->device, "0378379ee5fb5a94");
  out->host_abi = 12;
  out->generation = 3;
  out->running_hash = 0xe01adc15327d4203ULL;
  out->links = 2;
  out->pushes = 1;
  out->screenshots = 4;
}

int main(void) {
  size_t length = 99;
  assert(devmenu_init());
  assert(devmenu_draw_list(&length) == NULL);
  assert(length == 0);

  devmenu_toggle();
  const uint32_t *words = devmenu_draw_list(&length);
  assert(words != NULL);
  assert(length > 4 && length < 12288 && length % 4 == 0);
  bool full_background = false;
  for (size_t index = 0; index < length; index += 4) {
    assert(words[index] == 1);
    uint32_t x = words[index + 1] & 0xffffu;
    uint32_t y = words[index + 1] >> 16;
    uint32_t width = words[index + 2] & 0xffffu;
    uint32_t height = words[index + 2] >> 16;
    assert(width > 0 && height > 0);
    assert(x + width <= 320);
    assert(y + height <= 240);
    if (x == 0 && y == 0 && width == 320 && height == 240) full_background = true;
  }
  assert(full_background);

  devmenu_set_notice("SHOT QUEUED");
  assert(devmenu_draw_list(&length) == words);
  assert(length > 4);
  devmenu_hide();
  assert(devmenu_draw_list(&length) == NULL);
  assert(length == 0);
  devmenu_shutdown();
  return 0;
}
