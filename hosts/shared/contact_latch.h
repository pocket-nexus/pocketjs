#ifndef POCKET_CONTACT_LATCH_H
#define POCKET_CONTACT_LATCH_H
#include <math.h>
#include <string.h>
#include "../../engine/quickjs-c/pocket_runtime.h"
#include "../blackberry-classic/pocket_input.h"

/* Platform pointer IDs identify event streams, not guest contact lifetimes.
 * A released stream can coexist with a new stream using the same platform ID.
 * The caller serializes events/sampling and supplies the native bounds hit. */
typedef struct {
  int used, platform_id, id, ending, sampled;
  float x, y;
  int hit;
} PocketLatchedContact;
typedef struct {
  PocketLatchedContact contacts[POCKET_RUNTIME_MAX_CONTACTS];
  unsigned next_id, previous_count;
  int previous[POCKET_RUNTIME_MAX_CONTACTS];
} PocketContactLatch;

static inline int pocket_contact_id_used(const PocketContactLatch *state, int id) {
  for (unsigned i = 0; i < POCKET_RUNTIME_MAX_CONTACTS; i++)
    if (state->contacts[i].used && state->contacts[i].id == id) return 1;
  for (unsigned i = 0; i < state->previous_count; i++) if (state->previous[i] == id) return 1;
  return 0;
}
/* Return 1 only when a new contact is admitted. At capacity, reclaim a sampled
 * release; never evict a held finger or an unsampled ordinary tap. */
static inline int pocket_contact_event(PocketContactLatch *state, PocketTouchPhase phase, int platform_id,
    float x, float y, int width, int height) {
  PocketLatchedContact *contact = NULL;
  for (unsigned i = 0; i < POCKET_RUNTIME_MAX_CONTACTS; i++) {
    PocketLatchedContact *c = &state->contacts[i];
    if (c->used && !c->ending && c->platform_id == platform_id) { contact = c; break; }
  }
  if (phase == POCKET_TOUCH_CANCEL) {
    if (contact) memset(contact, 0, sizeof *contact);
    return 0;
  }
  if (!isfinite(x) || !isfinite(y)) return 0;
  if (phase == POCKET_TOUCH_DOWN) {
    if (contact || x < 0 || y < 0 || x >= width || y >= height) return 0;
    for (unsigned i = 0; i < POCKET_RUNTIME_MAX_CONTACTS; i++) {
      PocketLatchedContact *c = &state->contacts[i];
      if (!c->used || (c->ending && c->sampled)) { contact = c; break; }
    }
    if (!contact) return 0;
    memset(contact, 0, sizeof *contact);
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
/* Cancellation has no tap latch. Previously delivered contacts disappear in
 * the next snapshot; a contact cancelled before sampling is never delivered. */
static inline void pocket_contacts_cancel(PocketContactLatch *state) {
  memset(state->contacts, 0, sizeof state->contacts);
}
static inline void pocket_contacts_sample(PocketContactLatch *state, PocketRuntimeContactsInput *frame,
    int width, int height, int logical_width, int logical_height, int (*hit_test)(float, float)) {
  frame->contact_count = 0;
  for (unsigned i = 0; i < POCKET_RUNTIME_MAX_CONTACTS; i++) {
    PocketLatchedContact *contact = &state->contacts[i];
    if (!contact->used) continue;
    if (contact->ending && contact->sampled) { memset(contact, 0, sizeof *contact); continue; }
    int x = (int)(contact->x * logical_width / width), y = (int)(contact->y * logical_height / height);
    if (!contact->sampled) contact->hit = hit_test((float)x, (float)y);
    PocketRuntimeContact *out = &frame->contacts[frame->contact_count++];
    out->id = contact->id; out->x = x; out->y = y; out->hit = contact->hit;
    contact->sampled = 1;
  }
  state->previous_count = frame->contact_count;
  for (unsigned i = 0; i < frame->contact_count; i++) state->previous[i] = frame->contacts[i].id;
}
#endif
