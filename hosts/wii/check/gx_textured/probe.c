#include "gx_textured.h"
#include "texture_source.h"

typedef bool (*TexturedOp)(PocketWiiGXContext *, const uint32_t *, size_t);
static TexturedOp volatile retain_textured_op = pocket_wii_gx_textured_op;

size_t ui_texture_slot_count(void) { return 1; }
uint32_t ui_texture_slot_mask(void) { return 0x000fffffu; }
int32_t ui_texture_at(uint32_t slot, PocketWiiTextureSource *out) {
  (void)slot;
  (void)out;
  return 0;
}

int main(void) {
  return retain_textured_op == 0;
}
