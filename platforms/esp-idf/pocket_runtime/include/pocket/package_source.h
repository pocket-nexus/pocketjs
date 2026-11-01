#pragma once
#include "pocket_runtime.h"
/* The program verified the package's FNV-1a64 footer and variant hashes of
 * these exact bytes (pocket_idf_package_open does): the runtime admits them
 * without a hash pass of its own. */
#define POCKET_MEMORY_PACKAGE_VERIFIED 1U
/* A whole .pocket in memory. The runtime reads it in place, so data stays
 * valid and unchanged until the runtime is destroyed. flags is 0 or
 * POCKET_MEMORY_PACKAGE_VERIFIED. */
typedef struct {
  const uint8_t *data;
  size_t size;
  uint32_t flags;
} pocket_memory_package;
const pocket_package_source_v1 *pocket_memory_package_vtable(void);
