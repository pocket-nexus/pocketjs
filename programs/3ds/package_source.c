#include "package_source.h"
#include <limits.h>

int pocket_3ds_file_source_open(pocket_3ds_file_source *source, const char *path) {
  if (!source || !path || source->file) return POCKET_STATUS_INVALID;
  *source = (pocket_3ds_file_source){0};
  FILE *file = fopen(path, "rb");
  if (!file) return POCKET_STATUS_FAILED;
  if (fseek(file, 0, SEEK_END)) { fclose(file); return POCKET_STATUS_FAILED; }
  long length = ftell(file);
  if (length < 0 || fseek(file, 0, SEEK_SET)) {
    fclose(file); return POCKET_STATUS_FAILED;
  }
  source->file = file;
  source->length = (size_t)length;
  return POCKET_STATUS_OK;
}
void pocket_3ds_file_source_close(pocket_3ds_file_source *source) {
  if (!source) return;
  if (source->file) fclose(source->file);
  *source = (pocket_3ds_file_source){0};
}
static int32_t length(void *context, size_t *out) {
  pocket_3ds_file_source *source = context;
  if (!source || !source->file || !out) return POCKET_STATUS_INVALID;
  *out = source->length;
  return POCKET_STATUS_OK;
}
static int32_t range(void *context, size_t offset, uint8_t *bytes,
                     size_t capacity, size_t *read) {
  pocket_3ds_file_source *source = context;
  if (!source || !source->file || !read || (capacity && !bytes))
    return POCKET_STATUS_INVALID;
  *read = 0;
  if (offset > source->length || offset > LONG_MAX) return POCKET_STATUS_INVALID;
  /* Detect a file truncated or extended after open before serving cached data. */
  if (fseek(source->file, 0, SEEK_END) || ftell(source->file) != (long)source->length)
    return POCKET_STATUS_FAILED;
  size_t wanted = source->length - offset;
  if (wanted > capacity) wanted = capacity;
  if (!wanted) return POCKET_STATUS_OK;
  if (fseek(source->file, (long)offset, SEEK_SET)) return POCKET_STATUS_FAILED;
  size_t actual = fread(bytes, 1, wanted, source->file);
  if (actual != wanted || ferror(source->file)) return POCKET_STATUS_FAILED;
  *read = actual;
  return POCKET_STATUS_OK;
}
const pocket_package_source_v1 *pocket_3ds_file_source_vtable(void) {
  static const pocket_package_source_v1 api = {sizeof api, length, NULL, range};
  return &api;
}
