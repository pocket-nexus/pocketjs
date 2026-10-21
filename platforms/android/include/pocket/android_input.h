#ifndef POCKET_ANDROID_INPUT_H
#define POCKET_ANDROID_INPUT_H
#include "pocket_drivers.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct pocket_android_input pocket_android_input;
typedef struct {
  size_t struct_size;
  uint32_t logical_width, logical_height;
  float relative_threshold;
  uint32_t classes;
} pocket_android_input_config;

pocket_android_input *pocket_android_input_create(const pocket_android_input_config *config);
/* Stop event producers and polling before destruction. No callback may destroy
 * this context. All other methods serialize their state with an instance mutex. */
void pocket_android_input_destroy(pocket_android_input *input);
/* A changed surface geometry cancels resident contacts before the next poll. */
void pocket_android_input_resize(pocket_android_input *input, int width, int height);
void pocket_android_input_key(pocket_android_input *input, int action, int key, int repeat);
/* Returns one when a new contact lifetime was accepted, zero otherwise. */
int pocket_android_input_touch(pocket_android_input *input, int action, int id, float x, float y);
void pocket_android_input_relative(pocket_android_input *input, float x, float y, int action, int buttons);
void pocket_android_input_cancel_touches(pocket_android_input *input);
const pocket_input_source_v1 *pocket_android_input_vtable(void);

#ifdef __cplusplus
}
#endif
#endif
