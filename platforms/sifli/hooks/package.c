/* A package linked into flash or RAM, read in place. */
#include <string.h>

#include "pocket/sifli.h"

static int32_t length(void *context, size_t *out) {
  const pocket_sifli_package *source = context;
  if (source == NULL || out == NULL || (source->data == NULL && source->size != 0))
    return POCKET_STATUS_INVALID;
  *out = source->size;
  return POCKET_STATUS_OK;
}

static int32_t bytes(void *context, const uint8_t **out, size_t *size) {
  if (out == NULL || size == NULL)
    return POCKET_STATUS_INVALID;
  const int32_t status = length(context, size);
  if (status != POCKET_STATUS_OK)
    return status;
  *out = ((const pocket_sifli_package *)context)->data;
  return POCKET_STATUS_OK;
}

static int32_t read_range(void *context, size_t offset, uint8_t *out, size_t capacity,
                          size_t *size) {
  const pocket_sifli_package *source = context;
  if (source == NULL || size == NULL || offset > source->size || (out == NULL && capacity) ||
      (source->data == NULL && source->size != 0))
    return POCKET_STATUS_INVALID;
  *size = source->size - offset;
  if (*size > capacity)
    *size = capacity;
  if (*size != 0)
    memcpy(out, source->data + offset, *size);
  return POCKET_STATUS_OK;
}

static const pocket_package_source_v1 VTABLE = {sizeof(VTABLE), length, bytes, read_range};

const pocket_package_source_v1 *pocket_sifli_package_vtable(void) { return &VTABLE; }
