#ifndef POCKET_LINK_HTTP_H
#define POCKET_LINK_HTTP_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
/* The system Link owner calls every function in this interface. Cross-task
 * callers use the worker provider mailbox; this module does not lock Link. */
#include "pocket/worker_protocol.h"
#define LINK_HTTP_SLOTS 2
/* One block fills one worker event slot. Facts carry the protocol's kinds
 * (POCKET_WORKER_HEADERS, POCKET_WORKER_DATA, POCKET_WORKER_END) and
 * statuses, so the worker provider passes them to pocket_worker_emit and
 * pocket_worker_finish unchanged. */
#define LINK_HTTP_CHUNK POCKET_WORKER_MAX_PAYLOAD
#define LINK_HTTP_WINDOW (8 * LINK_HTTP_CHUNK)
typedef struct {
  uint32_t kind;
  int32_t status;
  uint64_t offset;
  const uint8_t *bytes;
  size_t length;
} LinkHttpFact;
/* Pure descriptor validation; callable before transport admission. */
bool link_http_validate(const uint8_t *descriptor, size_t length);
/* descriptor: JSON {url,method?,headers?,body?:UTF8
 * string,timeoutMs?,maxBytes?}. start reserves a fixed receive window, header
 * and terminal before sending. */
int32_t link_http_start(const uint8_t *descriptor, size_t length);
bool link_http_peek(uint32_t id, LinkHttpFact *fact);
void link_http_consume(uint32_t id);
void link_http_close(uint32_t id);
/* Integration hooks for the system-owned Link transport. */
bool link_http_ctrl(const char *type, uint32_t id, const char *json,
                    size_t length);
bool link_http_data(uint32_t id, const uint8_t *bytes, size_t length);
void link_http_pump(void);
void link_http_disconnected(void);
void link_http_reset(void);
#endif
