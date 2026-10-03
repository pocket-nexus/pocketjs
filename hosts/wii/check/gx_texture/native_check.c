#include "mock_gx.h"

#include <assert.h>
#include <stddef.h>
#include <stdlib.h>

unsigned mock_gx_init_count;
unsigned mock_gx_lod_count;
unsigned mock_gx_draw_done_count;
unsigned mock_gx_invalidate_count;
unsigned mock_flush_count;
unsigned mock_free_count;
void *mock_flush_pointer;
u32 mock_flush_length;
void *mock_free_pointers[32];
unsigned mock_free_orders[32];
unsigned mock_event_order;
unsigned mock_last_draw_done_order;
unsigned mock_last_flush_order;
unsigned mock_last_invalidate_order;
unsigned mock_last_init_order;

static _Alignas(32) uint8_t mock_image_heap[4096];
static size_t mock_image_heap_used;

void *mock_memalign(size_t alignment, size_t size) {
  assert(alignment == 32);
  size_t start = (mock_image_heap_used + alignment - 1) & ~(alignment - 1);
  assert(start <= sizeof mock_image_heap && size <= sizeof mock_image_heap - start);
  void *result = mock_image_heap + start;
  mock_image_heap_used = start + size;
  return result;
}

void mock_free(void *pointer) {
  assert(mock_free_count < sizeof mock_free_pointers / sizeof mock_free_pointers[0]);
  mock_free_pointers[mock_free_count] = pointer;
  mock_free_orders[mock_free_count] = ++mock_event_order;
  mock_free_count++;
  uintptr_t address = (uintptr_t)pointer;
  uintptr_t begin = (uintptr_t)mock_image_heap;
  if (address < begin || address >= begin + sizeof mock_image_heap) free(pointer);
}

void GX_InitTexObj(GXTexObj *obj, void *image, u16 width, u16 height,
                   u8 format, u8 wrap_s, u8 wrap_t, u8 mipmap) {
  assert(obj != NULL && image != NULL);
  obj->image = image;
  obj->width = width;
  obj->height = height;
  obj->format = format;
  obj->wrap_s = wrap_s;
  obj->wrap_t = wrap_t;
  obj->mipmap = mipmap;
  mock_gx_init_count++;
  mock_last_init_order = ++mock_event_order;
}

void GX_InitTexObjLOD(GXTexObj *obj, u8 min_filter, u8 mag_filter,
                      f32 min_lod, f32 max_lod, f32 lod_bias,
                      u8 bias_clamp, u8 edge_lod, u8 max_aniso) {
  assert(obj != NULL);
  assert(min_lod == 0.0f && max_lod == 0.0f && lod_bias == 0.0f);
  assert(bias_clamp == GX_FALSE && edge_lod == GX_FALSE && max_aniso == GX_ANISO_1);
  obj->min_filter = min_filter;
  obj->mag_filter = mag_filter;
  mock_gx_lod_count++;
  mock_event_order++;
}

void GX_DrawDone(void) {
  mock_gx_draw_done_count++;
  mock_last_draw_done_order = ++mock_event_order;
}

void GX_InvalidateTexAll(void) {
  mock_gx_invalidate_count++;
  mock_last_invalidate_order = ++mock_event_order;
}

void DCFlushRange(void *start, u32 length) {
  assert(start != NULL);
  assert(((uintptr_t)start & 31u) == 0);
  mock_flush_pointer = start;
  mock_flush_length = length;
  mock_flush_count++;
  mock_last_flush_order = ++mock_event_order;
}
