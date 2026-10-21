#include "pocket/package_source.h"
#include <string.h>
static int32_t length(void *context, size_t *out) {
  pocket_memory_package *source = context;
  if (!source || !out || (!source->data && source->size))
    return POCKET_STATUS_INVALID;
  *out = source->size;
  return POCKET_STATUS_OK;
}
static int32_t bytes(void *context, const uint8_t **out, size_t *size) {
  if (!out || !size)
    return POCKET_STATUS_INVALID;
  int32_t status = length(context, size);
  if (status != POCKET_STATUS_OK)
    return status;
  *out = ((pocket_memory_package *)context)->data;
  return POCKET_STATUS_OK;
}
static int32_t read_range(void *context, size_t offset, uint8_t *out,
                          size_t capacity, size_t *size) {
  pocket_memory_package *source = context;
  if (!source || !size || offset > source->size || (!out && capacity) ||
      (!source->data && source->size))
    return POCKET_STATUS_INVALID;
  *size = source->size - offset;
  if (*size > capacity)
    *size = capacity;
  if (*size)
    memcpy(out, source->data + offset, *size);
  return POCKET_STATUS_OK;
}
static const pocket_package_source_v1 VTABLE = {sizeof(VTABLE), length, bytes,
                                                read_range};
const pocket_package_source_v1 *pocket_memory_package_vtable(void) {
  return &VTABLE;
}
