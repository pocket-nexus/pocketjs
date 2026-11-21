/* Board keys sampled at poll. A key reports its buttons while its level is
 * active; a changed button set reaches the runtime after it held for the
 * debounce interval. */
#include <rtdevice.h>
#include <rtthread.h>
#include <string.h>

#include "pocket/sifli.h"

#define MAX_KEYS 16u

struct pocket_sifli_keys {
  pocket_sifli_key keys[MAX_KEYS];
  size_t count;
  rt_tick_t debounce, since;
  uint32_t candidate, stable;
};

pocket_sifli_keys *pocket_sifli_keys_create(const pocket_sifli_keys_config *c) {
  if (c == NULL || c->struct_size < sizeof(*c) || c->keys == NULL || c->key_count == 0U ||
      c->key_count > MAX_KEYS)
    return NULL;
  for (size_t i = 0; i < c->key_count; i++) {
    if (c->keys[i].buttons == 0U)
      return NULL;
  }
  pocket_sifli_keys *d = rt_calloc(1, sizeof(*d));
  if (d == NULL)
    return NULL;
  memcpy(d->keys, c->keys, c->key_count * sizeof(c->keys[0]));
  d->count = c->key_count;
  d->debounce = rt_tick_from_millisecond((rt_int32_t)c->debounce_ms);
  d->since = rt_tick_get();
  return d;
}

static uint32_t classes(void *context) {
  (void)context;
  return POCKET_INPUT_CLASS_BUTTONS;
}

static int32_t poll(void *context, pocket_input_frame_builder *builder) {
  pocket_sifli_keys *d = context;
  if (d == NULL || builder == NULL || builder->struct_size < sizeof(*builder) ||
      builder->append == NULL)
    return POCKET_STATUS_INVALID;
  uint32_t buttons = 0;
  for (size_t i = 0; i < d->count; i++) {
    const bool high = rt_pin_read(d->keys[i].pin) != PIN_LOW;
    if (high == d->keys[i].active_high)
      buttons |= d->keys[i].buttons;
  }
  const rt_tick_t now = rt_tick_get();
  if (buttons != d->candidate) {
    d->candidate = buttons;
    d->since = now;
  }
  uint32_t stable = d->stable;
  if ((rt_tick_t)(now - d->since) >= d->debounce)
    stable = buttons;
  pocket_input_frame frame = {.struct_size = sizeof(frame), .buttons = stable};
  const int32_t result = builder->append(builder->context, &frame);
  if (result == POCKET_STATUS_OK)
    d->stable = stable;
  return result;
}

static const pocket_input_source_v1 VTABLE = {
    .struct_size = sizeof(VTABLE), .classes = classes, .poll = poll};

const pocket_input_source_v1 *pocket_sifli_keys_vtable(void) { return &VTABLE; }

uint32_t pocket_sifli_keys_state(const pocket_sifli_keys *d) { return d != NULL ? d->stable : 0U; }

void pocket_sifli_keys_destroy(pocket_sifli_keys *d) { rt_free(d); }
