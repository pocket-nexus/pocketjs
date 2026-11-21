#pragma once
#include "pocket_runtime.h"
#include <stdbool.h>
typedef struct {
  uint8_t *pixels;
  bool pending;
  uint64_t token;
  pocket_rect region;
  pocket_surface surface;
} sample_buffer;
typedef struct {
  uint32_t width, height, rows, count, active;
  size_t capacity;
  uint64_t next, hash;
  uint32_t flushes, waits;
  sample_buffer buffers[2];
} sample_display;
int32_t sample_display_init(sample_display *, uint32_t width, uint32_t height,
                            uint32_t rows, uint32_t count);
void sample_display_destroy(sample_display *);
const pocket_display_output_v1 *sample_display_vtable(void);
const pocket_input_source_v1 *sample_input_vtable(void);
