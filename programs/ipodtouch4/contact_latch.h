#ifndef POCKET_CONTACT_LATCH_H
#define POCKET_CONTACT_LATCH_H
#include <math.h>
#include <string.h>
#include "pocket_runtime.h"
typedef enum { POCKET_TOUCH_DOWN, POCKET_TOUCH_MOVE, POCKET_TOUCH_UP, POCKET_TOUCH_CANCEL } PocketTouchPhase;
#define POCKET_MAX_CONTACTS 8
typedef struct {
  pocket_input_frame frame;
  pocket_contact contacts[POCKET_MAX_CONTACTS];
  pocket_cancelled_contact cancelled[POCKET_MAX_CONTACTS];
} PocketContactSnapshot;

/* Platform pointer IDs identify event streams, not guest contact lifetimes.
 * A released stream can coexist with a new stream using the same platform ID.
 * The caller serializes events and sampling. Runtime owns bounds hits. */
typedef struct {
  int used, platform_id, id, ending, sampled;
  float x, y;
} PocketLatchedContact;
typedef struct {
  PocketLatchedContact contacts[POCKET_MAX_CONTACTS];
  unsigned next_id, previous_count;
  int previous[POCKET_MAX_CONTACTS];
  unsigned cancelled_count;
  int cancelled[POCKET_MAX_CONTACTS];
} PocketContactLatch;

static inline int pocket_contact_id_used(const PocketContactLatch *state, int id) {
  for (unsigned i = 0; i < POCKET_MAX_CONTACTS; i++)
    if (state->contacts[i].used && state->contacts[i].id == id) return 1;
  for (unsigned i = 0; i < state->previous_count; i++) if (state->previous[i] == id) return 1;
  return 0;
}
/* Keep resident entries in DOWN order, independent of reusable storage. */
static inline void pocket_contact_remove(PocketContactLatch *state, PocketLatchedContact *contact) {
  unsigned index = (unsigned)(contact - state->contacts);
  memmove(contact, contact + 1, (POCKET_MAX_CONTACTS - index - 1) * sizeof *contact);
  memset(&state->contacts[POCKET_MAX_CONTACTS - 1], 0, sizeof *contact);
}
static inline void pocket_contact_cancel(PocketContactLatch *state, PocketLatchedContact *contact) {
  if (contact->sampled && state->cancelled_count < POCKET_MAX_CONTACTS)
    state->cancelled[state->cancelled_count++] = contact->id;
  pocket_contact_remove(state, contact);
}
/* Return 1 only when a new contact is admitted. At capacity, reclaim a sampled
 * release; never evict a held finger or an unsampled ordinary tap. */
static inline int pocket_contact_event(PocketContactLatch *state, PocketTouchPhase phase, int platform_id,
    float x, float y, int width, int height) {
  PocketLatchedContact *contact = NULL;
  for (unsigned i = 0; i < POCKET_MAX_CONTACTS; i++) {
    PocketLatchedContact *c = &state->contacts[i];
    if (c->used && !c->ending && c->platform_id == platform_id) { contact = c; break; }
  }
  if (phase == POCKET_TOUCH_CANCEL) {
    if (contact) pocket_contact_cancel(state, contact);
    return 0;
  }
  if (!isfinite(x) || !isfinite(y)) return 0;
  if (phase == POCKET_TOUCH_DOWN) {
    if (contact || x < 0 || y < 0 || x >= width || y >= height) return 0;
    for (unsigned i = 0; i < POCKET_MAX_CONTACTS; i++) {
      PocketLatchedContact *c = &state->contacts[i];
      if (!c->used || (c->ending && c->sampled)) { contact = c; break; }
    }
    if (!contact) return 0;
    if (contact->used) pocket_contact_remove(state, contact);
    // Append after all earlier DOWNs, including an unsampled short tap.
    for (unsigned i = 0; i < POCKET_MAX_CONTACTS; i++)
      if (!state->contacts[i].used) { contact = &state->contacts[i]; break; }
    // At most 16 IDs are reserved by the resident and previous-frame sets.
    int id;
    do { id = (int)(state->next_id++ & 255); } while (pocket_contact_id_used(state, id));
    contact->used = 1; contact->platform_id = platform_id; contact->id = id;
    contact->x = x; contact->y = y;
    return 1;
  }
  if (contact) {
    contact->x = x; contact->y = y;
    if (phase == POCKET_TOUCH_UP) contact->ending = 1;
  }
  return 0;
}
/* Cancellation has no tap latch. Published IDs carry a terminal cancellation
 * alongside the next active snapshot; unsampled contacts are discarded. */
static inline void pocket_contacts_cancel(PocketContactLatch *state) {
  while (state->contacts[0].used) pocket_contact_cancel(state, &state->contacts[0]);
}
static inline void pocket_contacts_sample(PocketContactLatch *state, PocketContactSnapshot *snapshot,
    int width, int height, int logical_width, int logical_height) {
  memset(snapshot, 0, sizeof *snapshot);
  pocket_input_frame *frame = &snapshot->frame;
  frame->struct_size = sizeof *frame;
  frame->contacts = snapshot->contacts;
  frame->cancelled = snapshot->cancelled;
  frame->cancelled_count = state->cancelled_count;
  for (unsigned i = 0; i < state->cancelled_count; i++)
    snapshot->cancelled[i] = (pocket_cancelled_contact){sizeof(pocket_cancelled_contact), 0, (uint32_t)state->cancelled[i]};
  state->cancelled_count = 0;
  for (unsigned i = 0; i < POCKET_MAX_CONTACTS; i++) {
    PocketLatchedContact *contact = &state->contacts[i];
    if (!contact->used) continue;
    if (contact->ending && contact->sampled) { pocket_contact_remove(state, contact); i--; continue; }
    pocket_contact *out = &snapshot->contacts[frame->contact_count++];
    *out = (pocket_contact){sizeof *out, 0, (uint32_t)contact->id,
      contact->x * logical_width / width, contact->y * logical_height / height, 0};
    contact->sampled = 1;
  }
  state->previous_count = (unsigned)frame->contact_count;
  for (unsigned i = 0; i < frame->contact_count; i++) state->previous[i] = snapshot->contacts[i].id;
}
#endif
