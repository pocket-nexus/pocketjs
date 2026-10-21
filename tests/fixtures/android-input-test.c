#include "pocket/android_input.h"
#include "pocket_spec.h"
#include <assert.h>
#include <math.h>
#include <limits.h>
#include <stdio.h>

typedef struct {
  pocket_android_input *input;
  pocket_input_frame frame;
  pocket_contact contact;
  pocket_cancelled_contact cancelled;
  int fail, reenter, calls;
} Sink;
static int32_t append(void *context, const pocket_input_frame *frame) {
  Sink *sink = context;
  sink->calls++;
  sink->frame = *frame;
  if (frame->contact_count) sink->contact = *frame->contacts;
  if (frame->cancelled_count) sink->cancelled = *frame->cancelled;
  if (sink->reenter) {
    pocket_input_frame_builder nested = {sizeof(nested), sink, append};
    assert(pocket_android_input_vtable()->poll(sink->input, &nested) == POCKET_STATUS_FAILED);
    pocket_android_input_key(sink->input, 0, 20, 0);
    sink->reenter = 0;
  }
  return sink->fail ? POCKET_STATUS_FAILED : POCKET_STATUS_OK;
}
static int32_t sample(Sink *sink) {
  pocket_input_frame_builder builder = {sizeof(builder), sink, append};
  return pocket_android_input_vtable()->poll(sink->input, &builder);
}
int main(int argc, char **argv) {
  (void)argv;
  pocket_android_input_config config = {sizeof(config), 360, 640, .35f,
    POCKET_INPUT_CLASS_BUTTONS | POCKET_INPUT_CLASS_CONTACT};
  Sink a = {.input = pocket_android_input_create(&config)}, b = {.input = pocket_android_input_create(&config)};
  assert(a.input && b.input);
  assert(pocket_android_input_vtable()->classes(a.input) == config.classes);
  config.struct_size--;
  assert(!pocket_android_input_create(&config));
  config.struct_size++;
  config.relative_threshold = NAN;
  assert(!pocket_android_input_create(&config));
  pocket_input_frame_builder invalid = {sizeof(invalid)-1, &a, append};
  assert(pocket_android_input_vtable()->poll(a.input, &invalid) == POCKET_STATUS_INVALID);
  pocket_android_input_key(a.input, 0, 19, 0);
  pocket_android_input_key(a.input, 1, 19, 0);
  assert(sample(&a) == POCKET_STATUS_OK && a.frame.buttons == POCKET_BTN_UP);
  assert(sample(&b) == POCKET_STATUS_OK && b.frame.buttons == 0);
  assert(sample(&a) == POCKET_STATUS_OK && a.frame.buttons == 0);
  pocket_android_input_resize(a.input, 720, 1280);
  assert(!pocket_android_input_touch(a.input, 0, 7, NAN, 0));
  assert(!pocket_android_input_touch(a.input, 0, 7, 900, 0));
  assert(pocket_android_input_touch(a.input, 0, 7, 180, 320) == 1);
  pocket_android_input_touch(a.input, 1, 7, 180, 320);
  a.fail = 1;
  assert(sample(&a) == POCKET_STATUS_FAILED);
  assert(a.frame.contact_count == 1 && a.contact.id == 0 && a.contact.x == 90 && a.contact.y == 160);
  pocket_android_input_key(a.input, 0, 21, 0);
  a.fail = 0;
  assert(sample(&a) == POCKET_STATUS_OK && a.frame.contact_count == 1 && a.frame.buttons == 0);
  assert(sample(&a) == POCKET_STATUS_OK && a.frame.contact_count == 0 && a.frame.buttons == POCKET_BTN_LEFT);
  pocket_android_input_key(a.input, 1, 21, 0);
  assert(pocket_android_input_touch(a.input, 0, 255, 0, 0) == 1);
  assert(sample(&a) == POCKET_STATUS_OK && a.frame.contact_count == 1);
  pocket_android_input_touch(a.input, 2, 255, 1e30f, 1e30f);
  assert(sample(&a) == POCKET_STATUS_OK && a.contact.x == 359 && a.contact.y == 639);
  pocket_android_input_cancel_touches(a.input);
  a.fail = 1;
  assert(sample(&a) == POCKET_STATUS_FAILED && a.frame.cancelled_count == 1 && a.cancelled.id == 1);
  a.fail = 0;
  assert(sample(&a) == POCKET_STATUS_OK && a.frame.cancelled_count == 1);
  assert(sample(&a) == POCKET_STATUS_OK && a.frame.cancelled_count == 0);
  a.reenter = 1;
  assert(sample(&a) == POCKET_STATUS_OK && a.frame.buttons == 0);
  assert(sample(&a) == POCKET_STATUS_OK && a.frame.buttons == POCKET_BTN_DOWN);
  pocket_android_input_resize(b.input, INT_MAX, INT_MAX);
  assert(pocket_android_input_touch(b.input, 0, 9, 1000000000.f, 1000000000.f) == 1);
  assert(sample(&b) == POCKET_STATUS_OK && b.frame.contact_count == 1);
  pocket_android_input_touch(b.input, 2, 9, 1e30f, 1e30f);
  assert(sample(&b) == POCKET_STATUS_OK && b.contact.x == 359 && b.contact.y == 639);
  pocket_android_input_resize(b.input, 1, 1);
  assert(sample(&b) == POCKET_STATUS_OK && b.frame.contact_count == 0 && b.frame.cancelled_count == 1);
  assert(sample(&b) == POCKET_STATUS_OK && b.frame.cancelled_count == 0);
  pocket_android_input_destroy(a.input);
  pocket_android_input_destroy(b.input);
  // Negative control exercises the runner's signal-aware failure detection.
  if (argc > 1) assert(!"intentional negative control");
  puts("android input: instances, retries, cancellation, reentry passed");
}
