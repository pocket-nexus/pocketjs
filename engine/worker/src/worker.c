#include "pocket/worker.h"
#include <limits.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  uint32_t id;
  const pocket_worker_node *node;
  unsigned ready, closing, closed, ended, end_seen;
  int32_t end_status;
  uint64_t end_offset, gap_offset, gap_count;
} resource;
typedef struct {
  uint32_t id, handle, opcode;
  unsigned started, native_done, terminal, observed, cancel, after_end;
  int32_t status;
  size_t length, capacity, result_length;
  uint8_t payload[POCKET_WORKER_MAX_PAYLOAD];
  uint8_t result[POCKET_WORKER_MAX_PAYLOAD];
} request;
typedef struct {
  pocket_worker_fact fact;
  uint8_t bytes[POCKET_WORKER_MAX_PAYLOAD];
} event;
typedef struct {
  uint32_t id;
  uint64_t deadline, period;
} timer;
typedef struct {
  uint32_t id, snapshot, size, capacity, head, count, incoming, outgoing;
  uint32_t lengths[POCKET_WORKER_MAX_EVENTS];
  uint8_t *bytes;
} channel;
struct pocket_worker {
  pocket_worker_config config;
  unsigned shutting_down;
  resource resources[POCKET_WORKER_MAX_RESOURCES];
  request requests[POCKET_WORKER_MAX_REQUESTS];
  event events[POCKET_WORKER_MAX_EVENTS];
  size_t event_head, event_count;
  uint32_t observe_phase, observe_index;
  timer timers[POCKET_WORKER_MAX_TIMERS];
  channel channels[POCKET_WORKER_MAX_CHANNELS];
};
static atomic_uint next_id = ATOMIC_VAR_INIT(1);
static uint32_t allocate_id(void) {
  unsigned id = atomic_load_explicit(&next_id, memory_order_relaxed);
  while (id < INT_MAX) {
    if (atomic_compare_exchange_weak_explicit(
            &next_id, &id, id + 1, memory_order_relaxed, memory_order_relaxed))
      return id;
  }
  return 0;
}
static void lock(pocket_worker *w) {
  if (w->config.lock)
    w->config.lock(w->config.context);
}
static void unlock(pocket_worker *w) {
  if (w->config.unlock)
    w->config.unlock(w->config.context);
}
static void wake(pocket_worker *w) {
  if (w->config.wake)
    w->config.wake(w->config.context);
}
static resource *find_resource(pocket_worker *w, uint32_t id) {
  for (size_t i = 0; i < POCKET_WORKER_MAX_RESOURCES; i++)
    if (w->resources[i].id == id && id)
      return &w->resources[i];
  return NULL;
}
static request *find_request(pocket_worker *w, uint32_t id) {
  for (size_t i = 0; i < POCKET_WORKER_MAX_REQUESTS; i++)
    if (w->requests[i].id == id && id)
      return &w->requests[i];
  return NULL;
}
static void reclaim(request *r) {
  if (r->native_done && r->observed)
    memset(r, 0, sizeof *r);
}
static const pocket_worker_node *next_node(const pocket_worker_node *n) {
  return (const pocket_worker_node *)((const uint8_t *)n + n->struct_size);
}
pocket_worker *pocket_worker_create(const pocket_worker_config *c) {
  if (!c || c->struct_size < sizeof *c || !c->generation ||
      (c->node_count && !c->nodes) || !!c->lock != !!c->unlock)
    return NULL;
  const pocket_worker_node *n = c->nodes;
  for (size_t i = 0; i < c->node_count; i++, n = next_node(n)) {
    if (n->struct_size < sizeof *n || !n->name || !n->driver ||
        n->driver->struct_size < sizeof *n->driver || !n->driver->close)
      return NULL;
    const pocket_worker_node *previous = c->nodes;
    for (size_t j = 0; j < i; j++, previous = next_node(previous))
      if (!strcmp(n->name, previous->name))
        return NULL;
  }
  pocket_worker *w = calloc(1, sizeof *w);
  if (w)
    w->config = *c;
  return w;
}
uint32_t pocket_worker_generation(const pocket_worker *w) {
  return w ? w->config.generation : 0;
}
int32_t pocket_worker_open(pocket_worker *w, uint32_t kind, const char *name,
                           const uint8_t *data, size_t length) {
  if (!w || !name || (length && !data) || length > POCKET_WORKER_MAX_PAYLOAD)
    return POCKET_WORKER_INVALID;
  const pocket_worker_node *node = NULL;
  const pocket_worker_node *candidate = w->config.nodes;
  for (size_t i = 0; i < w->config.node_count;
       i++, candidate = next_node(candidate))
    if (candidate->kind == kind && !strcmp(candidate->name, name))
      node = candidate;
  if (!node || !node->driver->open)
    return POCKET_WORKER_UNSUPPORTED;
  lock(w);
  resource *r = NULL;
  if (!w->shutting_down)
    for (size_t i = 0; i < POCKET_WORKER_MAX_RESOURCES; i++)
      if (!w->resources[i].id) {
        r = &w->resources[i];
        break;
      }
  uint32_t id = r ? allocate_id() : 0;
  if (!id) {
    unlock(w);
    return POCKET_WORKER_BUSY;
  }
  r->id = id;
  r->node = node;
  unlock(w);
  int32_t status =
      node->driver->open(node->driver->context, w, id, data, length);
  lock(w);
  if (status != POCKET_WORKER_OK)
    memset(r, 0, sizeof *r);
  else
    r->ready = 1;
  unlock(w);
  wake(w);
  return status == POCKET_WORKER_OK ? (int32_t)id : status;
}
int32_t pocket_worker_submit(pocket_worker *w, uint32_t handle, uint32_t opcode,
                             const uint8_t *data, size_t length,
                             size_t capacity) {
  if (!w || (length && !data) || length > POCKET_WORKER_MAX_PAYLOAD ||
      capacity > POCKET_WORKER_MAX_PAYLOAD)
    return POCKET_WORKER_INVALID;
  lock(w);
  resource *r = find_resource(w, handle);
  request *q = NULL;
  if (!r || r->closing || w->shutting_down) {
    unlock(w);
    return POCKET_WORKER_INVALID;
  }
  if (!r->node->driver->start) {
    unlock(w);
    return POCKET_WORKER_UNSUPPORTED;
  }
  const pocket_worker_driver *driver = r->node->driver;
  unlock(w);
  if (driver->validate) {
    int32_t status = driver->validate(driver->context, w, handle, opcode, data,
                                      length, capacity);
    if (status != POCKET_WORKER_OK)
      return status;
  }
  lock(w);
  r = find_resource(w, handle);
  if (!r || r->closing || w->shutting_down) {
    unlock(w);
    return POCKET_WORKER_INVALID;
  }
  for (size_t i = 0; i < POCKET_WORKER_MAX_REQUESTS; i++)
    if (!w->requests[i].id) {
      q = &w->requests[i];
      break;
    }
  uint32_t id = q ? allocate_id() : 0;
  if (!id) {
    unlock(w);
    return POCKET_WORKER_BUSY;
  }
  q->id = id;
  q->handle = handle;
  q->opcode = opcode;
  q->length = length;
  q->capacity = capacity;
  if (length)
    memcpy(q->payload, data, length);
  unlock(w);
  wake(w);
  return (int32_t)id;
}
int32_t pocket_worker_complete(pocket_worker *w, uint32_t id, int32_t status,
                               const uint8_t *data, size_t length) {
  if (!w || (length && !data))
    return POCKET_WORKER_INVALID;
  lock(w);
  request *q = find_request(w, id);
  if (!q || !q->started || q->native_done) {
    unlock(w);
    return POCKET_WORKER_INVALID;
  }
  if (length > q->capacity) {
    length = 0;
    status = POCKET_WORKER_UNKNOWN;
  }
  q->native_done = 1;
  if (!q->terminal) {
    q->terminal = 1;
    q->status = status;
    q->result_length = length;
    if (length)
      memcpy(q->result, data, length);
  }
  reclaim(q);
  unlock(w);
  wake(w);
  return POCKET_WORKER_OK;
}
int32_t pocket_worker_finish(pocket_worker *w, uint32_t handle, uint32_t id,
                             int32_t status, uint64_t offset) {
  if (!w)
    return POCKET_WORKER_INVALID;
  lock(w);
  request *q = find_request(w, id);
  resource *r = find_resource(w, handle);
  if (!q || q->handle != handle || !q->started || q->native_done || !r ||
      r->ended) {
    unlock(w);
    return POCKET_WORKER_INVALID;
  }
  r->ended = 1;
  r->end_status = status;
  r->end_offset = offset;
  q->native_done = 1;
  if (!q->terminal) {
    q->terminal = 1;
    q->status = status;
    q->after_end = 1;
  }
  reclaim(q);
  unlock(w);
  wake(w);
  return POCKET_WORKER_OK;
}
int32_t pocket_worker_cancel(pocket_worker *w, uint32_t id) {
  if (!w)
    return POCKET_WORKER_INVALID;
  lock(w);
  request *q = find_request(w, id);
  if (!q || q->terminal) {
    unlock(w);
    return POCKET_WORKER_INVALID;
  }
  q->terminal = 1;
  q->status = q->started ? POCKET_WORKER_UNKNOWN : POCKET_WORKER_CANCELLED;
  if (q->started)
    q->cancel = 1;
  else
    q->native_done = 1;
  unlock(w);
  wake(w);
  return POCKET_WORKER_OK;
}
int32_t pocket_worker_close(pocket_worker *w, uint32_t handle) {
  if (!w)
    return POCKET_WORKER_INVALID;
  lock(w);
  resource *r = find_resource(w, handle);
  if (!r) {
    unlock(w);
    return POCKET_WORKER_INVALID;
  }
  r->closing = 1;
  for (size_t i = 0; i < POCKET_WORKER_MAX_REQUESTS; i++) {
    request *q = &w->requests[i];
    if (q->id && q->handle == handle && !q->terminal) {
      q->terminal = 1;
      q->status = q->started ? POCKET_WORKER_UNKNOWN : POCKET_WORKER_CANCELLED;
      if (q->started)
        q->cancel = 1;
      else
        q->native_done = 1;
    }
  }
  unlock(w);
  wake(w);
  return POCKET_WORKER_OK;
}
int32_t pocket_worker_write(pocket_worker *w, uint32_t handle,
                            const uint8_t *data, size_t length) {
  if (!w || (length && !data) || length > POCKET_WORKER_MAX_PAYLOAD)
    return POCKET_WORKER_INVALID;
  lock(w);
  resource *r = find_resource(w, handle);
  const pocket_worker_driver *d = r && !r->closing ? r->node->driver : NULL;
  unlock(w);
  if (!d || !d->write)
    return POCKET_WORKER_UNSUPPORTED;
  int32_t count = d->write(d->context, w, handle, data, length);
  return count >= 0 && (size_t)count > length ? POCKET_WORKER_INVALID : count;
}
int32_t pocket_worker_emit(pocket_worker *w, uint32_t handle, uint32_t kind,
                           int32_t status, uint64_t offset, const uint8_t *data,
                           size_t length) {
  if (!w || (length && !data) || length > POCKET_WORKER_MAX_PAYLOAD ||
      kind == POCKET_WORKER_END || kind == POCKET_WORKER_COMPLETE)
    return POCKET_WORKER_INVALID;
  lock(w);
  resource *r = find_resource(w, handle);
  if (!r || r->closing || r->ended) {
    unlock(w);
    return POCKET_WORKER_INVALID;
  }
  if (kind == POCKET_WORKER_DATA && r->gap_count) {
    unlock(w);
    return POCKET_WORKER_BUSY;
  }
  if (w->event_count == POCKET_WORKER_MAX_EVENTS) {
    unlock(w);
    return POCKET_WORKER_BUSY;
  }
  event *e =
      &w->events[(w->event_head + w->event_count) % POCKET_WORKER_MAX_EVENTS];
  e->fact = (pocket_worker_fact){sizeof e->fact,   kind,   handle,  0, status,
                                 (uint32_t)length, offset, e->bytes};
  if (length)
    memcpy(e->bytes, data, length);
  w->event_count++;
  unlock(w);
  wake(w);
  return POCKET_WORKER_OK;
}
int32_t pocket_worker_end(pocket_worker *w, uint32_t handle, int32_t status,
                          uint64_t offset) {
  if (!w)
    return POCKET_WORKER_INVALID;
  lock(w);
  resource *r = find_resource(w, handle);
  if (!r || r->ended || r->closed) {
    unlock(w);
    return POCKET_WORKER_INVALID;
  }
  r->ended = 1;
  r->end_status = status;
  r->end_offset = offset;
  unlock(w);
  wake(w);
  return POCKET_WORKER_OK;
}
int32_t pocket_worker_gap(pocket_worker *w, uint32_t handle, uint64_t offset,
                          uint64_t count) {
  if (!w || !count)
    return POCKET_WORKER_INVALID;
  lock(w);
  resource *r = find_resource(w, handle);
  if (!r || r->closing) {
    unlock(w);
    return POCKET_WORKER_INVALID;
  }
  if (!r->gap_count)
    r->gap_offset = offset;
  r->gap_count =
      UINT64_MAX - r->gap_count < count ? UINT64_MAX : r->gap_count + count;
  unlock(w);
  wake(w);
  return POCKET_WORKER_OK;
}
void pocket_worker_dispatch(pocket_worker *w) {
  if (!w)
    return;
  for (size_t i = 0; i < POCKET_WORKER_MAX_REQUESTS; i++) {
    lock(w);
    request *q = &w->requests[i];
    resource *r = find_resource(w, q->handle);
    const pocket_worker_driver *d = r ? r->node->driver : NULL;
    uint32_t id = q->id, handle = q->handle, opcode = q->opcode;
    size_t length = q->length, capacity = q->capacity;
    int cancel = id && q->cancel,
        start = id && !q->started && !q->terminal && r && !r->closing;
    q->cancel = 0;
    if (start)
      q->started = 1;
    unlock(w);
    if (cancel && d && d->cancel)
      d->cancel(d->context, w, handle, id);
    if (start && d) {
      int32_t s = d->start(d->context, w, handle, id, opcode, q->payload,
                           length, capacity);
      if (s != POCKET_WORKER_OK)
        pocket_worker_complete(w, id, s, NULL, 0);
    }
  }
  for (size_t i = 0; i < POCKET_WORKER_MAX_RESOURCES; i++) {
    lock(w);
    resource *r = &w->resources[i];
    uint32_t id = r->id;
    int close = id && r->closing && !r->closed;
    const pocket_worker_driver *d = close ? r->node->driver : NULL;
    unlock(w);
    if (d && d->close(d->context, w, id) == POCKET_WORKER_OK) {
      lock(w);
      r->closed = 1;
      for (size_t j = 0; j < POCKET_WORKER_MAX_REQUESTS; j++) {
        request *q = &w->requests[j];
        if (q->id && q->handle == id) {
          q->native_done = 1;
          reclaim(q);
        }
      }
      unlock(w);
      wake(w);
    }
  }
}
static int copy_fact(pocket_worker_fact *out, size_t *count, size_t capacity,
                     uint8_t *bytes, size_t *used, size_t size,
                     pocket_worker_fact fact, const uint8_t *source) {
  if (*count >= capacity || fact.length > size - *used)
    return 0;
  fact.struct_size = sizeof fact;
  fact.data = fact.length ? bytes + *used : NULL;
  if (fact.length)
    memcpy(bytes + *used, source, fact.length);
  *used += fact.length;
  out[(*count)++] = fact;
  return 1;
}
size_t pocket_worker_observe(pocket_worker *w, pocket_worker_fact *out,
                             size_t capacity, uint8_t *bytes, size_t size) {
  if (!w || (!out && capacity) || (!bytes && size))
    return 0;
  size_t count = 0, used = 0;
  uint64_t now =
      w->config.now_micros ? w->config.now_micros(w->config.context) : 0;
  lock(w);
  for (unsigned pass = 0; pass < 6; pass++) {
    switch ((w->observe_phase + pass) % 6) {
    case 0:
      for (size_t n = 0; n < POCKET_WORKER_MAX_RESOURCES; n++) {
        resource *r =
            &w->resources[(n + w->observe_index) % POCKET_WORKER_MAX_RESOURCES];
        if (r->id && r->ready &&
            copy_fact(out, &count, capacity, bytes, &used, size,
                      (pocket_worker_fact){.kind = POCKET_WORKER_READY,
                                           .handle = r->id},
                      NULL))
          r->ready = 0;
      }
      break;
    case 1:
      for (size_t n = 0; n < POCKET_WORKER_MAX_REQUESTS; n++) {
        request *q =
            &w->requests[(n + w->observe_index) % POCKET_WORKER_MAX_REQUESTS];
        resource *owner = find_resource(w, q->handle);
        if (q->id && q->terminal && !q->observed && owner && !owner->ready &&
            (!q->after_end || (owner && owner->end_seen)) &&
            copy_fact(
                out, &count, capacity, bytes, &used, size,
                (pocket_worker_fact){.kind = POCKET_WORKER_COMPLETE,
                                     .handle = q->handle,
                                     .request = q->id,
                                     .status = q->status,
                                     .length = (uint32_t)q->result_length},
                q->result)) {
          q->observed = 1;
          reclaim(q);
        }
      }
      break;
    case 2:
      while (w->event_count) {
        event *e = &w->events[w->event_head];
        resource *owner = find_resource(w, e->fact.handle);
        if (owner && owner->ready)
          break;
        if (!copy_fact(out, &count, capacity, bytes, &used, size, e->fact,
                       e->bytes))
          break;
        w->event_head = (w->event_head + 1) % POCKET_WORKER_MAX_EVENTS;
        w->event_count--;
      }
      break;
    case 3:
      /* Queued prefixes precede discontinuities and stream terminals. Data
       * admission stays closed while a discontinuity awaits observation. */
      if (!w->event_count)
        for (size_t n = 0; n < POCKET_WORKER_MAX_RESOURCES; n++) {
          resource *r = &w->resources[(n + w->observe_index) %
                                      POCKET_WORKER_MAX_RESOURCES];
          if (!r->id || r->ready)
            continue;
          if (r->gap_count &&
              copy_fact(
                  out, &count, capacity, bytes, &used, size,
                  (pocket_worker_fact){.kind = POCKET_WORKER_GAP,
                                       .handle = r->id,
                                       .offset = r->gap_offset,
                                       .status = POCKET_WORKER_UNKNOWN,
                                       .request = r->gap_count > UINT32_MAX
                                                      ? UINT32_MAX
                                                      : (uint32_t)r->gap_count},
                  NULL))
            r->gap_count = 0;
          if (r->ended && !r->end_seen && !r->gap_count &&
              copy_fact(out, &count, capacity, bytes, &used, size,
                        (pocket_worker_fact){.kind = POCKET_WORKER_END,
                                             .handle = r->id,
                                             .status = r->end_status,
                                             .offset = r->end_offset},
                        NULL))
            r->end_seen = 1;
          if (r->closed && !r->gap_count && (!r->ended || r->end_seen)) {
            int outstanding = 0;
            for (size_t j = 0; j < POCKET_WORKER_MAX_REQUESTS; j++)
              if (w->requests[j].id && w->requests[j].handle == r->id)
                outstanding = 1;
            if (!outstanding &&
                copy_fact(out, &count, capacity, bytes, &used, size,
                          (pocket_worker_fact){.kind = POCKET_WORKER_CLOSED,
                                               .handle = r->id},
                          NULL))
              memset(r, 0, sizeof *r);
          }
        }
      break;
    case 4:
      for (size_t n = 0; n < POCKET_WORKER_MAX_TIMERS; n++) {
        timer *t =
            &w->timers[(n + w->observe_index) % POCKET_WORKER_MAX_TIMERS];
        if (t->id && t->deadline <= now) {
          uint64_t missed = t->period ? (now - t->deadline) / t->period : 0;
          if (copy_fact(out, &count, capacity, bytes, &used, size,
                        (pocket_worker_fact){.kind = POCKET_WORKER_TIMER,
                                             .handle = t->id,
                                             .offset = t->deadline,
                                             .request = missed > UINT32_MAX
                                                            ? UINT32_MAX
                                                            : (uint32_t)missed},
                        NULL)) {
            if (t->period && missed < (UINT64_MAX - t->deadline) / t->period)
              t->deadline += (missed + 1) * t->period;
            else
              memset(t, 0, sizeof *t);
          }
        }
      }
      break;
    case 5:
      for (size_t n = 0; n < POCKET_WORKER_MAX_CHANNELS; n++) {
        channel *c =
            &w->channels[(n + w->observe_index) % POCKET_WORKER_MAX_CHANNELS];
        while (c->id && c->incoming && c->count) {
          uint32_t length = c->lengths[c->head];
          if (!copy_fact(out, &count, capacity, bytes, &used, size,
                         (pocket_worker_fact){.kind = POCKET_WORKER_CHANNEL,
                                              .handle = c->id,
                                              .length = length},
                         c->bytes + (size_t)c->head * c->size))
            break;
          c->head = (c->head + 1) % c->capacity;
          c->count--;
        }
      }
      break;
    }
  }
  w->observe_phase = (w->observe_phase + 1) % 6;
  w->observe_index++;
  unlock(w);
  return count;
}
int32_t pocket_worker_timer(pocket_worker *w, uint32_t id, uint64_t deadline,
                            uint64_t period) {
  if (!w || !id)
    return POCKET_WORKER_INVALID;
  lock(w);
  timer *slot = NULL;
  for (size_t i = 0; i < POCKET_WORKER_MAX_TIMERS; i++)
    if (w->timers[i].id == id) {
      slot = &w->timers[i];
      break;
    } else if (!w->timers[i].id && !slot)
      slot = &w->timers[i];
  if (!slot || w->shutting_down) {
    unlock(w);
    return POCKET_WORKER_BUSY;
  }
  *slot = deadline ? (timer){id, deadline, period} : (timer){0};
  unlock(w);
  wake(w);
  return POCKET_WORKER_OK;
}
uint64_t pocket_worker_deadline(pocket_worker *w) {
  if (!w)
    return UINT64_MAX;
  uint64_t next = UINT64_MAX;
  lock(w);
  for (size_t i = 0; i < POCKET_WORKER_MAX_TIMERS; i++)
    if (w->timers[i].id && w->timers[i].deadline < next)
      next = w->timers[i].deadline;
  for (size_t i = 0; i < POCKET_WORKER_MAX_RESOURCES; i++)
    if (w->resources[i].id && w->resources[i].closing &&
        !w->resources[i].closed) {
      uint64_t retry = w->config.now_micros
                           ? w->config.now_micros(w->config.context) + 1000
                           : 0;
      if (retry < next)
        next = retry;
    }
  unlock(w);
  return next;
}
int pocket_worker_pending(pocket_worker *w) {
  if (!w)
    return 0;
  int pending = 0;
  lock(w);
  pending = w->event_count != 0;
  for (size_t i = 0; i < POCKET_WORKER_MAX_RESOURCES; i++) {
    resource *r = &w->resources[i];
    if (r->id &&
        (r->ready || r->closed || r->gap_count || (r->ended && !r->end_seen)))
      pending = 1;
  }
  for (size_t i = 0; i < POCKET_WORKER_MAX_REQUESTS; i++) {
    request *q = &w->requests[i];
    if (q->id && ((!q->terminal && !q->started) ||
                  (q->terminal && !q->observed) || q->cancel))
      pending = 1;
  }
  for (size_t i = 0; i < POCKET_WORKER_MAX_CHANNELS; i++)
    if (w->channels[i].incoming && w->channels[i].count)
      pending = 1;
  unlock(w);
  return pending;
}
int32_t pocket_worker_channel(pocket_worker *w, uint32_t id, uint32_t snapshot,
                              uint32_t size, uint32_t capacity) {
  if (!w || !id || !size || size > POCKET_WORKER_MAX_PAYLOAD || !capacity ||
      capacity > POCKET_WORKER_MAX_EVENTS || snapshot > 1)
    return POCKET_WORKER_INVALID;
  lock(w);
  channel *c = NULL;
  for (size_t i = 0; i < POCKET_WORKER_MAX_CHANNELS; i++) {
    if (w->channels[i].id == id) {
      unlock(w);
      return POCKET_WORKER_INVALID;
    }
    if (!w->channels[i].id && !c)
      c = &w->channels[i];
  }
  if (!c) {
    unlock(w);
    return POCKET_WORKER_BUSY;
  }
  c->bytes = malloc((size_t)size * (snapshot ? 1 : capacity));
  if (!c->bytes) {
    unlock(w);
    return POCKET_WORKER_BUSY;
  }
  c->id = id;
  c->snapshot = snapshot;
  c->size = size;
  c->capacity = snapshot ? 1 : capacity;
  unlock(w);
  return POCKET_WORKER_OK;
}
static int32_t channel_write(pocket_worker *w, uint32_t id,
                             const uint8_t *bytes, size_t length,
                             int incoming) {
  if (!w || (length && !bytes))
    return POCKET_WORKER_INVALID;
  lock(w);
  if (w->shutting_down) {
    unlock(w);
    return POCKET_WORKER_INVALID;
  }
  channel *c = NULL;
  for (size_t i = 0; i < POCKET_WORKER_MAX_CHANNELS; i++)
    if (w->channels[i].id == id)
      c = &w->channels[i];
  if (!c || length > c->size || (incoming ? c->outgoing : c->incoming)) {
    unlock(w);
    return POCKET_WORKER_INVALID;
  }
  if (incoming)
    c->incoming = 1;
  else
    c->outgoing = 1;
  if (c->count == c->capacity && !c->snapshot) {
    unlock(w);
    return POCKET_WORKER_BUSY;
  }
  uint32_t at = (c->head + (c->snapshot ? 0 : c->count)) % c->capacity;
  if (length)
    memcpy(c->bytes + (size_t)at * c->size, bytes, length);
  c->lengths[at] = (uint32_t)length;
  if (!c->snapshot || !c->count)
    c->count++;
  unlock(w);
  wake(w);
  return POCKET_WORKER_OK;
}
int32_t pocket_worker_channel_direction(pocket_worker *w, uint32_t id,
                                        int incoming) {
  if (!w)
    return POCKET_WORKER_INVALID;
  lock(w);
  for (size_t i = 0; i < POCKET_WORKER_MAX_CHANNELS; i++)
    if (w->channels[i].id == id) {
      channel *c = &w->channels[i];
      if (c->incoming || c->outgoing) {
        unlock(w);
        return POCKET_WORKER_INVALID;
      }
      c->incoming = incoming != 0;
      c->outgoing = incoming == 0;
      unlock(w);
      return POCKET_WORKER_OK;
    }
  unlock(w);
  return POCKET_WORKER_INVALID;
}
int32_t pocket_worker_publish(pocket_worker *w, uint32_t id,
                              const uint8_t *bytes, size_t length) {
  return channel_write(w, id, bytes, length, 0);
}
int32_t pocket_worker_receive(pocket_worker *w, uint32_t id,
                              const uint8_t *bytes, size_t length) {
  return channel_write(w, id, bytes, length, 1);
}
int32_t pocket_worker_channel_take(pocket_worker *w, uint32_t id,
                                   uint8_t *bytes, size_t size) {
  if (!w || (!bytes && size))
    return POCKET_WORKER_INVALID;
  lock(w);
  channel *c = NULL;
  for (size_t i = 0; i < POCKET_WORKER_MAX_CHANNELS; i++)
    if (w->channels[i].id == id)
      c = &w->channels[i];
  if (!c || c->incoming) {
    unlock(w);
    return POCKET_WORKER_INVALID;
  }
  if (!c->count) {
    unlock(w);
    return POCKET_WORKER_BUSY;
  }
  uint32_t length = c->lengths[c->head];
  if (length > size) {
    unlock(w);
    return POCKET_WORKER_INVALID;
  }
  if (length)
    memcpy(bytes, c->bytes + (size_t)c->head * c->size, length);
  c->head = (c->head + 1) % c->capacity;
  c->count--;
  unlock(w);
  return (int32_t)length;
}
void pocket_worker_shutdown(pocket_worker *w) {
  if (!w)
    return;
  lock(w);
  w->shutting_down = 1;
  unlock(w);
  for (size_t i = 0; i < POCKET_WORKER_MAX_RESOURCES; i++)
    if (w->resources[i].id)
      pocket_worker_close(w, w->resources[i].id);
}
int32_t pocket_worker_destroy(pocket_worker *w) {
  if (!w)
    return POCKET_WORKER_OK;
  pocket_worker_shutdown(w);
  pocket_worker_dispatch(w);
  lock(w);
  for (size_t i = 0; i < POCKET_WORKER_MAX_RESOURCES; i++)
    if (w->resources[i].id && !w->resources[i].closed) {
      unlock(w);
      return POCKET_WORKER_BUSY;
    }
  unlock(w);
  for (size_t i = 0; i < POCKET_WORKER_MAX_CHANNELS; i++)
    free(w->channels[i].bytes);
  free(w);
  return POCKET_WORKER_OK;
}
