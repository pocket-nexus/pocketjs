#ifndef POCKET_WORKER_H
#define POCKET_WORKER_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif

/* All byte descriptors use little endian integers, without native pointers.
 * I2C open: [version=1,address7]; submit opcode 1:
 * [version=1,steps:u8,timeout_ms:u16,
 * (op:u8,register:u8,length:u16,data...)...]. op 1 reads length bytes, op 2
 * writes length bytes following the step header. Reads concatenate into the
 * completion payload. Each script is indivisible. UART open:
 * [version=1,data_bits:u8,stop_bits:u8,parity:u8,baud:u32, flow_control:u8];
 * parity 0/1/2 = none/odd/even; flow 0/1 = none/RTS-CTS. HTTP descriptors are
 * UTF-8 JSON; method/url/headers/body are host validated.
 */
#include "pocket/worker_protocol.h"

typedef struct pocket_worker pocket_worker;
typedef struct {
  uint32_t struct_size, kind, handle, request;
  int32_t status;
  uint32_t length;
  uint64_t offset;
  const uint8_t *data;
} pocket_worker_fact;
typedef struct {
  uint32_t struct_size, generation, sequence;
  uint64_t now_micros;
  /* UTC is absent unless wall_generation is nonzero. */
  uint64_t utc_micros;
  uint32_t wall_generation, wall_error_micros;
  const char *wall_source;
} pocket_worker_context;
typedef struct {
  uint32_t struct_size;
  void *context;
  /* open/start/write/close run on the owner task, outside the core lock.
   * start borrows payload until complete; copy it if a driver retains it.
   * complete is legal during start. close returns BUSY until all native
   * accesses cease; only OK permits reclamation. No callback may reenter JS. */
  int32_t (*open)(void *, pocket_worker *, uint32_t, const uint8_t *, size_t);
  int32_t (*start)(void *, pocket_worker *, uint32_t, uint32_t, uint32_t,
                   const uint8_t *, size_t, size_t);
  int32_t (*write)(void *, pocket_worker *, uint32_t, const uint8_t *, size_t);
  void (*cancel)(void *, pocket_worker *, uint32_t, uint32_t);
  int32_t (*close)(void *, pocket_worker *, uint32_t);
  /* Pure synchronous admission check; no I/O or retained byte pointers. */
  int32_t (*validate)(void *, pocket_worker *, uint32_t, uint32_t,
                      const uint8_t *, size_t, size_t);
} pocket_worker_driver;
typedef struct {
  uint32_t struct_size, kind;
  const char *name;
  const pocket_worker_driver *driver;
} pocket_worker_node;
typedef struct {
  uint32_t struct_size, generation;
  const pocket_worker_node *nodes;
  size_t node_count;
  void *context;
  /* Required as a pair for producers on other tasks. ISR producers must use
   * platform ISR-safe staging; these callbacks are task-context operations. */
  void (*lock)(void *);
  void (*unlock)(void *);
  void (*wake)(void *);
  uint64_t (*now_micros)(void *);
} pocket_worker_config;

pocket_worker *pocket_worker_create(const pocket_worker_config *);
/* Stops admission and schedules cancellation/close without freeing storage. */
void pocket_worker_shutdown(pocket_worker *);
/* Returns BUSY without freeing while native users remain. */
int32_t pocket_worker_destroy(pocket_worker *);
int32_t pocket_worker_open(pocket_worker *, uint32_t, const char *,
                           const uint8_t *, size_t);
int32_t pocket_worker_submit(pocket_worker *, uint32_t, uint32_t,
                             const uint8_t *, size_t, size_t);
int32_t pocket_worker_cancel(pocket_worker *, uint32_t);
int32_t pocket_worker_close(pocket_worker *, uint32_t);
int32_t pocket_worker_write(pocket_worker *, uint32_t, const uint8_t *, size_t);
/* Producers call these from task context. Stale IDs are rejected. Accepted
 * requests retain their terminal slot through native completion + observation.
 */
int32_t pocket_worker_complete(pocket_worker *, uint32_t, int32_t,
                               const uint8_t *, size_t);
/* Atomically finishes a streaming request. Observation preserves
 * queued HEADERS/DATA, then END, then COMPLETE, even across clipped turns. */
int32_t pocket_worker_finish(pocket_worker *, uint32_t, uint32_t, int32_t,
                             uint64_t);
int32_t pocket_worker_emit(pocket_worker *, uint32_t, uint32_t, int32_t,
                           uint64_t, const uint8_t *, size_t);
int32_t pocket_worker_end(pocket_worker *, uint32_t, int32_t, uint64_t);
int32_t pocket_worker_gap(pocket_worker *, uint32_t, uint64_t, uint64_t);
/* Run ready driver work outside JS; callers then latch facts once per turn. */
void pocket_worker_dispatch(pocket_worker *);
size_t pocket_worker_observe(pocket_worker *, pocket_worker_fact *, size_t,
                             uint8_t *, size_t);
int32_t pocket_worker_timer(pocket_worker *, uint32_t, uint64_t, uint64_t);
uint64_t pocket_worker_deadline(pocket_worker *);
int pocket_worker_pending(pocket_worker *);
uint32_t pocket_worker_generation(const pocket_worker *);

/* Declared channels have bounded records. snapshot=1 keeps the newest record;
 * ring channels reject new records when full. Both copies occur under lock. */
int32_t pocket_worker_channel(pocket_worker *, uint32_t, uint32_t, uint32_t,
                              uint32_t);
int32_t pocket_worker_channel_direction(pocket_worker *, uint32_t, int);
int32_t pocket_worker_publish(pocket_worker *, uint32_t, const uint8_t *,
                              size_t);
/* Host ingress: a declared channel becomes an inbox channel on first receive;
 * application publish to that channel is then rejected. */
int32_t pocket_worker_receive(pocket_worker *, uint32_t, const uint8_t *,
                              size_t);
int32_t pocket_worker_channel_take(pocket_worker *, uint32_t, uint8_t *,
                                   size_t);

#ifdef __cplusplus
}
#endif
#endif
