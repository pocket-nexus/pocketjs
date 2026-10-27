#ifndef POCKET_3DS_WORKER_H
#define POCKET_3DS_WORKER_H
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
int32_t pocket_3ds_worker_mount_ui(JSContext *);
int32_t pocket_3ds_worker_latch_ui(JSContext *);
#endif
