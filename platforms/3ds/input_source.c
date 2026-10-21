#include <stdbool.h>
#include "input_source.h"
void pocket_3ds_input_source_set(pocket_3ds_input_source *input,
  uint32_t buttons, uint32_t analog, const uint32_t *touches,
  size_t count, uint32_t right) {
  input->buttons = buttons;
  uint32_t sticks[2] = {analog, right};
  for (unsigned i = 0; i < 4; i++)
    input->axes[i] = (pocket_axis_sample){sizeof input->axes[i], i,
      (float)((sticks[i / 2] >> ((i & 1) ? 0 : 8)) & 255)};
  input->contact_count = touches ? (count < 8 ? count : 8) : 0;
  for (size_t i = 0; i < input->contact_count; i++) {
    uint32_t word = touches[i];
    bool wide = (word >> 31) != 0;
    input->contacts[i] = (pocket_contact){sizeof input->contacts[i], 1,
      (word >> (wide ? 20 : 18)) & 255,
      (float)(word & (wide ? 1023 : 511)),
      (float)((word >> (wide ? 10 : 9)) & (wide ? 1023 : 511)),
      (word >> 30) & 1};
  }
}
static uint32_t classes(void *context) {
  (void)context;
  return POCKET_INPUT_CLASS_BUTTONS | POCKET_INPUT_CLASS_AXIS_ABSOLUTE |
    POCKET_INPUT_CLASS_CONTACT;
}
static int32_t poll(void *context, pocket_input_frame_builder *builder) {
  pocket_3ds_input_source *input = context;
  pocket_input_frame frame = {.struct_size=sizeof frame,
    .buttons=input->buttons, .axes=input->axes, .axis_count=4,
    .contacts=input->contacts, .contact_count=input->contact_count};
  return builder->append(builder->context, &frame);
}
const pocket_input_source_v1 *pocket_3ds_input_source_vtable(void) {
  static const pocket_input_source_v1 api = {sizeof api, classes, poll};
  return &api;
}
