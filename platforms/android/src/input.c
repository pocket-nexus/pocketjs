#include "pocket/android_input.h"
#include "pocket/compat/input.h"
#include "pocket/compat/contact_latch.h"
#include "pocket_spec.h"
#include <math.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>

struct pocket_android_input {
  pthread_mutex_t mutex;
  PocketInputState buttons;
  PocketContactLatch latch;
  uint32_t classes, logical_width, logical_height;
  int width, height, polling, pending;
  pocket_input_frame frame;
  pocket_contact contacts[POCKET_RUNTIME_MAX_CONTACTS];
  pocket_cancelled_contact cancelled[POCKET_RUNTIME_MAX_CONTACTS];
};

static uint32_t button_for_key(int key) {
  switch (key) {
    case 19: return POCKET_BTN_UP;
    case 20: return POCKET_BTN_DOWN;
    case 21: return POCKET_BTN_LEFT;
    case 22: return POCKET_BTN_RIGHT;
    case 23: case 66: case 160: return POCKET_BTN_CIRCLE;
    case 62: return POCKET_BTN_START;
    case 82: return POCKET_BTN_TRIANGLE;
    default: return 0;
  }
}

pocket_android_input *pocket_android_input_create(const pocket_android_input_config *config) {
  if (!config || config->struct_size < sizeof(*config) || !config->logical_width || !config->logical_height ||
      config->logical_width > 1024 || config->logical_height > 1024 ||
      !isfinite(config->relative_threshold) || config->relative_threshold <= 0 ||
      (config->classes & ~(POCKET_INPUT_CLASS_BUTTONS | POCKET_INPUT_CLASS_CONTACT))) return NULL;
  pocket_android_input *input = calloc(1, sizeof(*input));
  if (!input) return NULL;
  if (pthread_mutex_init(&input->mutex, NULL)) { free(input); return NULL; }
  input->logical_width = input->width = config->logical_width;
  input->logical_height = input->height = config->logical_height;
  input->classes = config->classes;
  pocket_input_init(&input->buttons, config->relative_threshold);
  return input;
}
void pocket_android_input_destroy(pocket_android_input *input) {
  if (!input) return;
  pthread_mutex_destroy(&input->mutex);
  free(input);
}
void pocket_android_input_resize(pocket_android_input *input, int width, int height) {
  if (!input) return;
  pthread_mutex_lock(&input->mutex);
  width = width > 0 ? width : 1;
  height = height > 0 ? height : 1;
  if (width != input->width || height != input->height) pocket_contacts_cancel(&input->latch);
  input->width = width;
  input->height = height;
  pthread_mutex_unlock(&input->mutex);
}
void pocket_android_input_key(pocket_android_input *input, int action, int key, int repeat) {
  if (!input || !(input->classes & POCKET_INPUT_CLASS_BUTTONS) || (action != 0 && action != 1)) return;
  pthread_mutex_lock(&input->mutex);
  pocket_input_button(&input->buttons, button_for_key(key), action == 0, repeat != 0);
  pthread_mutex_unlock(&input->mutex);
}
int pocket_android_input_touch(pocket_android_input *input, int action, int id, float x, float y) {
  if (!input || !(input->classes & POCKET_INPUT_CLASS_CONTACT)) return 0;
  PocketTouchPhase phase = action == 0 || action == 5 ? POCKET_TOUCH_DOWN :
    action == 1 || action == 6 ? POCKET_TOUCH_UP : action == 3 ? POCKET_TOUCH_CANCEL : POCKET_TOUCH_MOVE;
  pthread_mutex_lock(&input->mutex);
  if (phase != POCKET_TOUCH_DOWN && isfinite(x) && isfinite(y)) {
    x = fmaxf(0, fminf(x, (float)(input->width - 1)));
    y = fmaxf(0, fminf(y, (float)(input->height - 1)));
  }
  int accepted = pocket_contact_event(&input->latch, phase, id, x, y, input->width, input->height);
  pthread_mutex_unlock(&input->mutex);
  return accepted;
}
void pocket_android_input_relative(pocket_android_input *input, float x, float y, int action, int buttons) {
  if (!input || !(input->classes & POCKET_INPUT_CLASS_BUTTONS) || !isfinite(x) || !isfinite(y)) return;
  int primary = (buttons & 1) || action == 0;
  if (action == 1 || action == 3) primary = 0;
  pthread_mutex_lock(&input->mutex);
  pocket_input_relative(&input->buttons, x, y);
  pocket_input_primary(&input->buttons, primary);
  pthread_mutex_unlock(&input->mutex);
}
void pocket_android_input_cancel_touches(pocket_android_input *input) {
  if (!input) return;
  pthread_mutex_lock(&input->mutex);
  pocket_contacts_cancel(&input->latch);
  pthread_mutex_unlock(&input->mutex);
}
static uint32_t classes(void *context) {
  return context ? ((pocket_android_input *)context)->classes : 0;
}
static int32_t poll(void *context, pocket_input_frame_builder *builder) {
  pocket_android_input *input = context;
  if (!input || !builder || builder->struct_size < sizeof(*builder) || !builder->append) return POCKET_STATUS_INVALID;
  pthread_mutex_lock(&input->mutex);
  if (input->polling) { pthread_mutex_unlock(&input->mutex); return POCKET_STATUS_FAILED; }
  input->polling = 1;
  if (!input->pending) {
    PocketInputSample buttons;
    PocketRuntimeContactsInput contacts = {0};
    pocket_input_sample(&input->buttons, &buttons);
    pocket_contacts_sample(&input->latch, &contacts, input->width, input->height,
      input->logical_width, input->logical_height, NULL);
    input->frame = (pocket_input_frame){.struct_size = sizeof(input->frame), .buttons = buttons.buttons,
      .contacts = input->contacts, .contact_count = contacts.contact_count,
      .cancelled = input->cancelled, .cancelled_count = contacts.cancelled_count};
    for (unsigned i = 0; i < contacts.contact_count; i++) {
      // Float surface coordinates can round to the exclusive upper bound.
      int x = contacts.contacts[i].x, y = contacts.contacts[i].y;
      if (x < 0) x = 0;
      if (y < 0) y = 0;
      if ((uint32_t)x >= input->logical_width) x = (int)input->logical_width - 1;
      if ((uint32_t)y >= input->logical_height) y = (int)input->logical_height - 1;
      input->contacts[i] = (pocket_contact){.struct_size = sizeof(pocket_contact), .surface = 0,
        .id = (uint32_t)contacts.contacts[i].id, .x = x, .y = y};
    }
    for (unsigned i = 0; i < contacts.cancelled_count; i++) {
      input->cancelled[i] = (pocket_cancelled_contact){.struct_size = sizeof(pocket_cancelled_contact),
        .surface = 0, .id = (uint32_t)contacts.cancelled[i]};
    }
    input->pending = 1;
  }
  pthread_mutex_unlock(&input->mutex);
  /* The callback may deliver new events or recursively poll. It must not run
   * under the input lock. Failed append retains the complete borrowed snapshot. */
  int32_t result = builder->append(builder->context, &input->frame);
  pthread_mutex_lock(&input->mutex);
  if (result == POCKET_STATUS_OK) input->pending = 0;
  input->polling = 0;
  pthread_mutex_unlock(&input->mutex);
  return result;
}
static const pocket_input_source_v1 VTABLE = {sizeof(VTABLE), classes, poll};
const pocket_input_source_v1 *pocket_android_input_vtable(void) { return &VTABLE; }
