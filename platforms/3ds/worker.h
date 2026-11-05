#ifndef POCKET_3DS_WORKER_H
#define POCKET_3DS_WORKER_H
#include "pocket/worker.h"
#include "quickjs.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
/* Source is borrowed until stop joins the owner task. */
bool pocket_3ds_worker_start(const uint8_t *source, size_t length,
                             int32_t (*mount)(JSContext *));
void pocket_3ds_worker_stop(void);
/* System Link owner services the bounded command/response mailbox. */
void pocket_3ds_worker_service(void);
const char *pocket_3ds_worker_error(void);
/* The resource core for pocket_worker_ui_attach. It lives from a successful
 * start until stop; detach every UI bridge before stop, including after a
 * worker fault. */
pocket_worker *pocket_3ds_worker_core(void);
#endif
