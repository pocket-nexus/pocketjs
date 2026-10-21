#ifndef POCKET_3DS_INPUT_SOURCE_H
#define POCKET_3DS_INPUT_SOURCE_H
#include <pocket_runtime.h>
typedef struct {
  uint32_t buttons;
  pocket_axis_sample axes[4];
  pocket_contact contacts[8];
  size_t contact_count;
} pocket_3ds_input_source;
/* Program policy supplies held facts; Runtime derives edges and hit tests. */
void pocket_3ds_input_source_set(pocket_3ds_input_source *, uint32_t buttons,
  uint32_t analog, const uint32_t *touches, size_t count, uint32_t right);
const pocket_input_source_v1 *pocket_3ds_input_source_vtable(void);
#endif
