#include "gx_font.h"

size_t ui_font_slot_count(void) { return 0; }
int32_t ui_font_atlas(uint32_t slot, PocketWiiFontAtlas *out) {
  (void)slot;
  (void)out;
  return 0;
}

int main(void) {
  PocketWiiGXContext empty = {0};
  const uint32_t op[] = {3, 0, 0xffffffffu};
  if (pocket_wii_gx_font_op(&empty, op, 3)) return 1;
  pocket_wii_gx_font_cache_clear();
  return 0;
}
