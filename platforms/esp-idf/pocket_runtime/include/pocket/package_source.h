#pragma once
#include "pocket_runtime.h"
typedef struct {
  const uint8_t *data;
  size_t size;
} pocket_memory_package;
const pocket_package_source_v1 *pocket_memory_package_vtable(void);
