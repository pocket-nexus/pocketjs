#define _POSIX_C_SOURCE 200809L
#include "package_source.h"
#include "input_source.h"
#include <unistd.h>
#include <assert.h>
#include <string.h>
static int32_t append(void *context, const pocket_input_frame *frame) {
  (void)context;
  assert(frame->buttons == POCKET_BUTTON_CIRCLE);
  assert(frame->axis_count == 4);
  assert(frame->axes[0].value == 128 && frame->axes[3].value == 255);
  assert(frame->contact_count == 1 && frame->contacts[0].surface == 1);
  assert(frame->contacts[0].x == 319 && frame->contacts[0].y == 239);
  return 0;
}
int main(int argc, char **argv) {
  assert(argc == 2);
  FILE *file = fopen(argv[1], "wb"); assert(file);
  assert(fwrite("pocket", 1, 6, file) == 6); fclose(file);
  pocket_3ds_file_source source = {0};
  assert(pocket_3ds_file_source_open(&source, argv[1]) == 0);
  assert(pocket_3ds_file_source_open(&source, argv[1]) == POCKET_STATUS_INVALID);
  const pocket_package_source_v1 *api = pocket_3ds_file_source_vtable();
  size_t length = 0, count = 999; uint8_t bytes[8] = {0};
  assert(api->all == NULL && api->length(&source, &length) == 0 && length == 6);
  assert(api->range(&source, 2, bytes, 8, &count) == 0 && count == 4);
  assert(!memcmp(bytes, "cket", 4));
  assert(api->range(&source, 6, bytes, 8, &count) == 0 && count == 0);
  assert(api->range(&source, 7, bytes, 8, &count) == POCKET_STATUS_INVALID);
  assert(api->range(&source, 0, NULL, 1, &count) == POCKET_STATUS_INVALID);
  assert(api->range(&source, 0, NULL, 0, &count) == 0 && count == 0);
  pocket_3ds_file_source_close(&source);
  assert(pocket_3ds_file_source_open(&source, argv[1]) == 0);
  assert(truncate(argv[1], 2) == 0);
  assert(api->range(&source, 0, bytes, sizeof bytes, &count) == POCKET_STATUS_FAILED);
  pocket_3ds_file_source_close(&source);
  assert(api->length(&source, &length) == POCKET_STATUS_INVALID);
  pocket_3ds_file_source_close(&source);
  pocket_3ds_input_source input = {0}; uint32_t touch = 319 | (239 << 9);
  pocket_3ds_input_source_set(&input, POCKET_BUTTON_CIRCLE, 0x8080, &touch, 1, 0x00ff);
  pocket_input_frame_builder builder = {sizeof builder, NULL, append};
  assert(pocket_3ds_input_source_vtable()->poll(&input, &builder) == 0);
  puts("3DS file source: range, EOF, truncation, reopen and input facts passed");
  return 0;
}
