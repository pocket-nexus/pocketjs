#pragma once
#include "pocket_guest_quickjs.h"
#include <stdbool.h>
typedef struct pocket_guest_idf pocket_guest_idf;
typedef struct {
  size_t heap_limit, stack_limit;
  bool prefer_psram;
} pocket_guest_idf_config;
pocket_guest_idf *
pocket_guest_idf_create(const pocket_guest_idf_config *config);
const pocket_guest_v1 *pocket_guest_idf_vtable(void);
const char *pocket_guest_idf_error(const pocket_guest_idf *guest);
/* The realm, for a program that installs its own namespaces after the runtime
 * boots the guest; call only from the task that runs the runtime. */
JSContext *pocket_guest_idf_context(pocket_guest_idf *guest);
/* Thread-safe cancellation. Destroy only after the owner task has joined and
 * pocket_runtime_destroy has released its registered guest. */
void pocket_guest_idf_interrupt(pocket_guest_idf *guest);
void pocket_guest_idf_destroy(pocket_guest_idf *guest);
