#ifndef POCKET_RELAY_FRAME_H
#define POCKET_RELAY_FRAME_H
/* Relay L1 frame layer for C hosts: the 48-byte fixed header of the R5 draft
 * (§3.3) and the bounded admission queue of §3.9. The single source of truth
 * for every value here is contracts/spec/relay.ts; tests/relay-frame-c.test.ts
 * compares these macros against tests/fixtures/relay/constants.json and feeds
 * the shared byte vectors through relay_frame_decode.
 *
 * Scope: header fields, the length identity, negotiated limits, the CANCEL
 * stream rule (§3.6: header stream 0), and a UTF-8 check over the metadata
 * region. This layer does not parse JSON. Metadata
 * bytes reach the caller as a view into the caller's record, so JSON
 * structure and semantics (root object, duplicate keys, number grammar,
 * surrogate escapes) and the §3.6 envelope rules (op/status/final,
 * BAD_ENVELOPE) stay with the layer above.
 *
 * C11 and the C standard library only: no POSIX extension is used here or in
 * the test harness. Every wire integer is read byte by byte, little-endian,
 * so the code holds on a big-endian host and needs no aligned access. Header
 * lengths widen to uint64_t before they are summed or compared, so a forged
 * u32 cannot wrap into a passing value.
 */
#include <stdatomic.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

/* --- 3.3 fixed frame header ---------------------------------------------- */

#define RELAY_FRAME_MAJOR 1
#define RELAY_FRAME_MINOR 0
/* Fixed header including the 4-byte length prefix. */
#define RELAY_FRAME_HEADER_BYTES 48u
/* frameBytes == 44 + metaBytes + dataBytes; it does not count the prefix. */
#define RELAY_FRAME_HEADER_BODY_BYTES 44u
#define RELAY_FRAME_LENGTH_PREFIX_BYTES 4u

/* Byte offsets of the fixed header, mirroring RELAY_HEADER in relay.ts. */
#define RELAY_OFF_FRAME_BYTES 0u
#define RELAY_OFF_MAGIC 4u
#define RELAY_OFF_MAJOR 8u
#define RELAY_OFF_MINOR 9u
#define RELAY_OFF_TYPE 10u
#define RELAY_OFF_FLAGS 11u
#define RELAY_OFF_HEADER_BYTES 12u
#define RELAY_OFF_CODEC 14u
#define RELAY_OFF_SESSION 16u
#define RELAY_OFF_SEQ 24u
#define RELAY_OFF_STREAM 28u
#define RELAY_OFF_CORRELATION 32u
#define RELAY_OFF_META_BYTES 36u
#define RELAY_OFF_DATA_BYTES 40u
#define RELAY_OFF_RESERVED 44u

/* The five message types occupy header `type`. [R5-P06] */
#define RELAY_TYPE_REQUEST 1u
#define RELAY_TYPE_RESPONSE 2u
#define RELAY_TYPE_PUSH 3u
#define RELAY_TYPE_CANCEL 4u
#define RELAY_TYPE_INVALIDATE 5u

/* codec 0 carries no data; the rest name the encoding of the data region. */
#define RELAY_CODEC_NONE 0u

/* Decoder ceilings applied when the caller passes no limits. [R5-P07] */
#define RELAY_DEFAULT_MAX_WIRE_BYTES 65536u
#define RELAY_DEFAULT_MAX_META_BYTES 2048u

/* Frame-layer rejection codes. The names match RELAY_FRAME_ERROR in
 * relay.ts one for one, minus BAD_ENVELOPE, which the layer above returns
 * after it parses metadata. */
typedef enum {
  RELAY_FRAME_OK = 0,
  RELAY_FRAME_SHORT_HEADER,
  RELAY_FRAME_BAD_PREFIX,
  RELAY_FRAME_BAD_MAGIC,
  RELAY_FRAME_BAD_VERSION,
  RELAY_FRAME_BAD_TYPE,
  RELAY_FRAME_BAD_FLAGS,
  RELAY_FRAME_BAD_HEADER_SIZE,
  RELAY_FRAME_BAD_RESERVED,
  RELAY_FRAME_BAD_LENGTH,
  RELAY_FRAME_TRUNCATED,
  RELAY_FRAME_WIRE_TOO_LARGE,
  RELAY_FRAME_META_TOO_LARGE,
  RELAY_FRAME_BAD_CODEC,
  RELAY_FRAME_BAD_SESSION,
  RELAY_FRAME_BAD_SEQ,
  RELAY_FRAME_BAD_CORRELATION,
  RELAY_FRAME_BAD_METADATA
} RelayFrameStatus;

/* Decoded header plus views into the caller's record. The two pointers stay
 * valid only as long as that record does; copy before the buffer is reused. */
typedef struct {
  uint8_t type;
  uint16_t codec;
  uint64_t session;
  uint32_t seq;
  uint32_t stream;
  uint32_t correlation;
  const unsigned char *metadata;
  uint32_t metadata_bytes;
  const unsigned char *data;
  uint32_t data_bytes;
} RelayFrame;

/* Receiver guarantees for one attachment. A zero cap means the caller
 * applies no cap at this layer, matching an omitted option in the TS codec;
 * relay_frame_limits_default() returns the R5 ceilings instead. */
typedef struct {
  uint32_t max_wire_bytes;
  uint32_t max_meta_bytes;
  /* Negotiated codec set. NULL selects the v1 codecs defined by the
   * specification; a non-NULL list of length 0 rejects every codec. */
  const uint16_t *codecs;
  size_t codec_count;
  uint64_t session;
  bool session_pinned;
} RelayFrameLimits;

RelayFrameLimits relay_frame_limits_default(void);

/* Validates `record` and fills `out` on success. `length` is the number of
 * bytes the caller holds; a complete record is exactly frameBytes + 4 long.
 * `limits` may be NULL, which applies relay_frame_limits_default(). */
RelayFrameStatus relay_frame_decode(const unsigned char *record, size_t length,
                                    const RelayFrameLimits *limits, RelayFrame *out);

/* Reads the declared wire length from a prefix of at least 4 bytes without
 * trusting the rest of the record: the reassembly path checks the length
 * against its buffer before any payload byte accumulates. Returns 0 when
 * fewer than 4 bytes are available or the prefix is below the fixed header. */
uint64_t relay_frame_declared_wire_bytes(const unsigned char *prefix, size_t length);

/* Stable name of a status, e.g. "BAD_MAGIC"; RELAY_FRAME_OK gives "OK". */
const char *relay_frame_status_name(RelayFrameStatus status);

/* --- 3.9 bounded admission queue ----------------------------------------- */

/* Control attachment budget: every frame fits 4096 B including the 48 B
 * header, with 8 frames and 32768 B of window per direction. A host with a
 * smaller budget overrides these before including the header. [R5-P09] */
#ifndef RELAY_FRAME_QUEUE_BYTES
#define RELAY_FRAME_QUEUE_BYTES 4096
#endif
#ifndef RELAY_FRAME_QUEUE_SLOTS
#define RELAY_FRAME_QUEUE_SLOTS 8
#endif
#ifndef RELAY_FRAME_QUEUE_WINDOW_BYTES
#define RELAY_FRAME_QUEUE_WINDOW_BYTES 32768
#endif

typedef struct {
  uint32_t generation, length;
  unsigned char bytes[RELAY_FRAME_QUEUE_BYTES];
} RelayFrameRecord;

/* Single producer, single consumer, the shape of OffloadQueue in
 * offload_queue.h. Two counters are kept apart, as §3.9 requires: slot
 * occupancy frees when the consumer pops, while window bytes stay charged
 * until the consumer releases them. Reading or parsing a frame refunds
 * nothing. A published slot is immutable until its consumer releases it. */
typedef struct {
  _Atomic uint32_t read, write;
  _Atomic uint32_t admitted_bytes, released_bytes;
  RelayFrameRecord slots[RELAY_FRAME_QUEUE_SLOTS];
} RelayFrameQueue;

/* Window bytes charged to the producer and not yet released. */
static inline uint32_t relay_frame_queue_queued_bytes(const RelayFrameQueue *q) {
  uint32_t admitted = atomic_load_explicit(&q->admitted_bytes, memory_order_relaxed);
  uint32_t released = atomic_load_explicit(&q->released_bytes, memory_order_relaxed);
  return admitted - released;
}

/* Enqueues one complete record. Returns false when the record does not fit
 * the slot, the slots are full, or queued + length would exceed the byte
 * window: a full queue is a busy answer to the caller, never a dropped or
 * overwritten frame. The admission test counts the incoming frame, so a
 * backlog that already fills the window cannot be extended. */
static inline bool relay_frame_queue_push(RelayFrameQueue *q, const unsigned char *record,
                                          uint32_t length, uint32_t generation) {
  uint32_t w = atomic_load_explicit(&q->write, memory_order_relaxed);
  uint32_t r = atomic_load_explicit(&q->read, memory_order_acquire);
  if (length < RELAY_FRAME_HEADER_BYTES || length > (uint32_t)RELAY_FRAME_QUEUE_BYTES) return false;
  if (w - r >= (uint32_t)RELAY_FRAME_QUEUE_SLOTS) return false;
  uint32_t admitted = atomic_load_explicit(&q->admitted_bytes, memory_order_relaxed);
  uint32_t released = atomic_load_explicit(&q->released_bytes, memory_order_acquire);
  if ((uint64_t)(admitted - released) + length > (uint64_t)RELAY_FRAME_QUEUE_WINDOW_BYTES) return false;
  RelayFrameRecord *s = &q->slots[w % (uint32_t)RELAY_FRAME_QUEUE_SLOTS];
  s->length = length;
  s->generation = generation;
  memcpy(s->bytes, record, length);
  atomic_store_explicit(&q->admitted_bytes, admitted + length, memory_order_relaxed);
  atomic_store_explicit(&q->write, w + 1, memory_order_release);
  return true;
}

/* Hands the oldest record to the consumer and frees its slot. The bytes stay
 * charged to the window until relay_frame_queue_release. */
static inline bool relay_frame_queue_pop(RelayFrameQueue *q, RelayFrameRecord *out) {
  uint32_t r = atomic_load_explicit(&q->read, memory_order_relaxed);
  uint32_t w = atomic_load_explicit(&q->write, memory_order_acquire);
  if (r == w) return false;
  const RelayFrameRecord *s = &q->slots[r % (uint32_t)RELAY_FRAME_QUEUE_SLOTS];
  out->generation = s->generation;
  out->length = s->length;
  memcpy(out->bytes, s->bytes, s->length);
  atomic_store_explicit(&q->read, r + 1, memory_order_release);
  return true;
}

/* Returns window bytes once the consumer has moved the frame into reserved
 * storage. Credit is released here, not when the frame was read. */
static inline void relay_frame_queue_release(RelayFrameQueue *q, uint32_t length) {
  uint32_t released = atomic_load_explicit(&q->released_bytes, memory_order_relaxed);
  atomic_store_explicit(&q->released_bytes, released + length, memory_order_release);
}

typedef enum {
  RELAY_ADMIT_ACCEPTED = 0,
  /* The record is valid but the queue has no room: the caller keeps a
   * bounded amount of unsent work rather than growing a retry queue. */
  RELAY_ADMIT_BUSY,
  /* The record failed validation and was never enqueued. */
  RELAY_ADMIT_REJECTED
} RelayAdmitResult;

/* Validates a record against `limits` and enqueues it only if it passes, so
 * work is admitted before it is done. `status` receives the decode status
 * (RELAY_FRAME_OK when the record is valid, including the busy case) and may
 * be NULL. `frame` receives the decoded views and may be NULL; on
 * RELAY_ADMIT_ACCEPTED its pointers address the caller's record, not the
 * queued copy. */
RelayAdmitResult relay_frame_admit(RelayFrameQueue *q, const unsigned char *record, size_t length,
                                   const RelayFrameLimits *limits, RelayFrameStatus *status,
                                   RelayFrame *frame);

#endif
