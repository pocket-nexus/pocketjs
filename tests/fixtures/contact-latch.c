#include "../../hosts/shared/contact_latch.h"
#include <assert.h>
#include <stdio.h>
static unsigned hits;
static int hit(float x, float y) { hits++; return (int)(x + y); }
static PocketRuntimeContactsInput sample(PocketContactLatch *state) {
  PocketRuntimeContactsInput frame = {0};
  pocket_contacts_sample(state, &frame, 720, 1600, 360, 800, hit);
  assert(frame.contact_count <= 8);
  for (unsigned i = 0; i < frame.contact_count; i++) for (unsigned j = i + 1; j < frame.contact_count; j++)
    assert(frame.contacts[i].id != frame.contacts[j].id);
  return frame;
}
static int event(PocketContactLatch *s, PocketTouchPhase phase, int id, float x) {
  return pocket_contact_event(s, phase, id, x, 200, 720, 1600);
}
static void emit(PocketContactLatch *s) {
  PocketRuntimeContactsInput f = sample(s);
  printf("{\"packed\":[");
  for (unsigned i = 0; i < f.contact_count; i++) printf("%s%u", i ? "," : "", pocket_runtime_pack_contact(&f.contacts[i]));
  for (unsigned i = 0; i < f.cancelled_count; i++) printf("%s%u", f.contact_count || i ? "," : "", pocket_runtime_pack_cancel(f.cancelled[i]));
  printf("],\"hits\":[");
  for (unsigned i = 0; i < f.contact_count; i++) printf("%s%d", i ? "," : "", f.contacts[i].hit);
  printf("]}\n");
}
int main(int argc, char **argv) {
  (void)argv;
  if (argc > 1) {
    PocketContactLatch state = {0};
    char command; int id; float x;
    while (scanf(" %c %d %f", &command, &id, &x) == 3) {
      if (command == 'f') emit(&state);
      else if (command == 'x') pocket_contacts_cancel(&state);
      else event(&state, command == 'd' ? POCKET_TOUCH_DOWN : command == 'u' ? POCKET_TOUCH_UP :
        command == 'c' ? POCKET_TOUCH_CANCEL : POCKET_TOUCH_MOVE, id, x);
    }
    return 0;
  }
  PocketContactLatch s = {0};
  assert(event(&s, POCKET_TOUCH_DOWN, 19, 100));
  PocketRuntimeContactsInput first = sample(&s);
  assert(first.contact_count == 1 && first.contacts[0].x == 50 && first.contacts[0].y == 100);
  const int old_id = first.contacts[0].id;
  event(&s, POCKET_TOUCH_UP, 19, 100);
  assert(event(&s, POCKET_TOUCH_DOWN, 19, 300)); // same platform ID, before another frame
  PocketRuntimeContactsInput next = sample(&s);
  assert(next.contact_count == 1 && next.contacts[0].id != old_id && next.contacts[0].x == 150);
  const int new_id = next.contacts[0].id, captured_hit = next.contacts[0].hit;
  const unsigned previous_hits = hits;
  event(&s, POCKET_TOUCH_MOVE, 19, 400); next = sample(&s);
  assert(next.contact_count == 1 && next.contacts[0].id == new_id && next.contacts[0].x == 200);
  assert(next.contacts[0].hit == captured_hit && hits == previous_hits);
  event(&s, POCKET_TOUCH_UP, 19, 400); assert(sample(&s).contact_count == 0);

  // A MOVE before the first sample must not change the DOWN hit identity.
  assert(event(&s, POCKET_TOUCH_DOWN, 0, 100)); event(&s, POCKET_TOUCH_MOVE, 0, 400);
  next = sample(&s); assert(next.contacts[0].x == 200 && next.contacts[0].hit == 150);
  pocket_contacts_cancel(&s); sample(&s);
  assert(event(&s, POCKET_TOUCH_DOWN, 0, 100)); pocket_contact_hit(&s, 0, 999);
  event(&s, POCKET_TOUCH_MOVE, 0, 400); next = sample(&s); assert(next.contacts[0].hit == 999);
  pocket_contacts_cancel(&s); sample(&s);

  // Ordinary sub-frame taps latch once; cancellation never latches a press.
  assert(event(&s, POCKET_TOUCH_DOWN, 0, 100)); event(&s, POCKET_TOUCH_CANCEL, 0, 100);
  assert(sample(&s).contact_count == 0); assert(sample(&s).contact_count == 0);
  assert(event(&s, POCKET_TOUCH_DOWN, 0, 100)); event(&s, POCKET_TOUCH_UP, 0, 100);
  assert(sample(&s).contact_count == 1); assert(sample(&s).contact_count == 0);
  assert(event(&s, POCKET_TOUCH_DOWN, 0, 100)); assert(sample(&s).contact_count == 1);
  event(&s, POCKET_TOUCH_CANCEL, 0, 100); assert(sample(&s).contact_count == 0);

  // Two lifetimes of one platform ID can coexist until the old tap is sampled.
  assert(event(&s, POCKET_TOUCH_DOWN, 0, 100)); event(&s, POCKET_TOUCH_UP, 0, 100);
  assert(event(&s, POCKET_TOUCH_DOWN, 0, 200)); next = sample(&s);
  assert(next.contact_count == 2);
  event(&s, POCKET_TOUCH_MOVE, 0, 300); next = sample(&s);
  assert(next.contact_count == 1 && next.contacts[0].x == 150);
  pocket_contacts_cancel(&s); assert(sample(&s).contact_count == 0);

  // A sampled release makes room even when all eight slots were occupied.
  for (int id = 0; id < 8; id++) assert(event(&s, POCKET_TOUCH_DOWN, id, 100));
  first = sample(&s); assert(first.contact_count == 8);
  assert(!event(&s, POCKET_TOUCH_DOWN, 99, 100));
  event(&s, POCKET_TOUCH_UP, 0, 100); assert(event(&s, POCKET_TOUCH_DOWN, 0, 200));
  next = sample(&s); assert(next.contact_count == 8 && next.contacts[7].id != first.contacts[0].id);
  for (unsigned i = 1; i < 8; i++) assert(next.contacts[i - 1].id == first.contacts[i].id);
  pocket_contacts_cancel(&s); assert(sample(&s).contact_count == 0);

  // Cancellation on pause also drops contacts that have never been sampled.
  assert(event(&s, POCKET_TOUCH_DOWN, 0, 100)); assert(event(&s, POCKET_TOUCH_DOWN, 1, 100));
  pocket_contacts_cancel(&s); assert(sample(&s).contact_count == 0);
  assert(!event(&s, POCKET_TOUCH_DOWN, 0, -1)); assert(!event(&s, POCKET_TOUCH_DOWN, 0, NAN));
  event(&s, POCKET_TOUCH_MOVE, 0, 100); assert(sample(&s).contact_count == 0);

  // ID wrap and many cancelled events cannot alias a still-published ID.
  assert(event(&s, POCKET_TOUCH_DOWN, 0, 100)); first = sample(&s);
  pocket_contacts_cancel(&s);
  for (int n = 0; n < 600; n++) { assert(event(&s, POCKET_TOUCH_DOWN, 0, 100)); event(&s, POCKET_TOUCH_CANCEL, 0, 100); }
  assert(event(&s, POCKET_TOUCH_DOWN, 0, 100)); next = sample(&s);
  assert(next.contact_count == 1 && next.contacts[0].id != first.contacts[0].id);
  return 0;
}
