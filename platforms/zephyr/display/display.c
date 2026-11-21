#include "pocket/zephyr.h"
#include <zephyr/drivers/display.h>
#include <zephyr/kernel.h>
#include <string.h>
struct pocket_zephyr_display {
  const struct device *device;
  uint8_t *pixels;
  size_t capacity, stride;
  uint32_t width, height, rows, role, format;
  uint64_t next, token, generation;
  bool acquired, pending, frame_storage;
  pocket_rect region;
  pocket_surface surface;
};
pocket_zephyr_display *pocket_zephyr_display_create(const pocket_zephyr_display_config *c) {
  if (!c || c->struct_size < sizeof(*c) || !c->device || !device_is_ready(c->device) || c->role > 1 || !c->strip_rows) return NULL;
  struct display_capabilities caps;
  display_get_capabilities(c->device, &caps);
  uint32_t bpp, format;
  if (caps.current_pixel_format == PIXEL_FORMAT_RGB_565) { bpp=2; format=POCKET_PIXEL_FORMAT_RGB565; }
  else if (caps.current_pixel_format == PIXEL_FORMAT_ARGB_8888) { bpp=4; format=POCKET_PIXEL_FORMAT_ARGB8888; }
  else return NULL;
  if ((caps.screen_info & SCREEN_INFO_DOUBLE_BUFFER) && c->strip_rows != caps.y_resolution) return NULL;
  if (!caps.x_resolution || !caps.y_resolution || c->strip_rows > caps.y_resolution ||
      caps.x_resolution > SIZE_MAX / bpp / c->strip_rows) return NULL;
  size_t capacity=(size_t)caps.x_resolution*bpp*c->strip_rows;
  if (capacity > c->frame_buffer_budget || capacity > UINT32_MAX) return NULL;
  pocket_zephyr_display *d=pocket_host_alloc(sizeof(*d), _Alignof(pocket_zephyr_display));
  if (!d) return NULL;
  memset(d,0,sizeof(*d));
  d->pixels=pocket_host_alloc(capacity, 4);
  if (!d->pixels) { pocket_host_free(d,sizeof(*d),_Alignof(pocket_zephyr_display)); return NULL; }
  memset(d->pixels,0,capacity);
  d->device=c->device; d->capacity=capacity; d->stride=(size_t)caps.x_resolution*bpp;
  d->width=caps.x_resolution; d->height=caps.y_resolution; d->rows=c->strip_rows;
  d->frame_storage=!(caps.screen_info & SCREEN_INFO_DOUBLE_BUFFER);
  d->role=c->role; d->format=format; d->generation=1;
  return d;
}
static int32_t descriptor(void *context, pocket_display_descriptor *out) {
  pocket_zephyr_display *d=context;
  if (!d || !out || out->struct_size<sizeof(*out)) return POCKET_STATUS_INVALID;
  *out=(pocket_display_descriptor){.struct_size=sizeof(*out),.role=d->role,.width=d->width,.height=d->height,
    .pixel_format=d->format,.stride_bytes=d->stride,.target_kind=POCKET_TARGET_CPU_VISIBLE,
    .flags=d->frame_storage ? POCKET_DISPLAY_FRAME_STORAGE|POCKET_DISPLAY_PARTIAL_REFRESH : 0,
    .refresh_width=d->width,.refresh_height=1,.window_x_alignment=d->width,.window_y_alignment=1};
  return POCKET_STATUS_OK;
}
static int32_t acquire(void *context, const pocket_rect *r, pocket_target *out) {
  pocket_zephyr_display *d=context;
  if (!d || !r || r->struct_size<sizeof(*r) || !out || out->struct_size<sizeof(*out) ||
      r->x || r->width!=d->width || !r->height || r->height>d->rows || r->height>d->height ||
      r->y>d->height-r->height) return POCKET_STATUS_INVALID;
  if (!d->frame_storage && (r->y || r->height!=d->height)) return POCKET_STATUS_INVALID;
  if (d->pending) return POCKET_STATUS_FAILED;
  d->region=*r; d->acquired=true;
  d->surface=(pocket_surface){.struct_size=sizeof(d->surface),.pixels=d->pixels,
    .byte_length=d->stride*r->height,.region=&d->region,.stride_bytes=d->stride,.pixel_format=d->format};
  *out=(pocket_target){.struct_size=sizeof(*out),.kind=POCKET_TARGET_CPU_VISIBLE,
    .region=&d->region,.pixel_format=d->format,.surface=&d->surface};
  return POCKET_STATUS_OK;
}
static void byte_order(pocket_zephyr_display *d, uint8_t *pixels, size_t size) {
#if __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
  size_t bpp=d->format==POCKET_PIXEL_FORMAT_RGB565?2:4;
  for(size_t i=0;i<size;i+=bpp) for(size_t j=0;j<bpp/2;j++) {
    uint8_t value=pixels[i+j];pixels[i+j]=pixels[i+bpp-1-j];pixels[i+bpp-1-j]=value;
  }
#else
  (void)d;(void)pixels;(void)size;
#endif
}
static int32_t flush(void *context, const pocket_rect *regions, size_t count, uint64_t *token) {
  pocket_zephyr_display *d=context;
  if (!d || !regions || !count || !token || !d->acquired || d->pending || d->next==UINT64_MAX) return POCKET_STATUS_INVALID;
  if (!d->frame_storage && (count!=1 || regions->y || regions->height!=d->height)) return POCKET_STATUS_INVALID;
  const pocket_rect *r=regions; uint32_t end=d->region.y;
  /* Validate the complete batch before the first device write. */
  for (size_t i=0;i<count;i++) {
    if (r->struct_size<sizeof(*r) || r->struct_size%_Alignof(pocket_rect) || r->x || r->width!=d->width ||
        !r->height || r->y<end || r->height>d->region.height || r->y-d->region.y>d->region.height-r->height) return POCKET_STATUS_INVALID;
    end=r->y+r->height; r=(const pocket_rect *)((const uint8_t *)r+r->struct_size);
  }
  d->acquired=false; r=regions;
  for (size_t i=0;i<count;i++) {
    struct display_buffer_descriptor buffer={.buf_size=d->stride*r->height,.width=r->width,.height=r->height,.pitch=d->width,.frame_incomplete=(i+1<count)};
    uint8_t *pixels=d->pixels+d->stride*(r->y-d->region.y);
    byte_order(d,pixels,buffer.buf_size);
    int result=display_write(d->device,0,r->y,&buffer,pixels);
    byte_order(d,pixels,buffer.buf_size);
    if (result) {
      pocket_zephyr_display_invalidate(d); return POCKET_STATUS_FAILED;
    }
    r=(const pocket_rect *)((const uint8_t *)r+r->struct_size);
  }
  *token=d->token=++d->next; d->pending=true;
  return POCKET_STATUS_OK;
}
static int32_t wait_display(void *context, uint64_t token) {
  pocket_zephyr_display *d=context;
  if (!d || !d->pending || token!=d->token) return POCKET_STATUS_INVALID;
  /* display_write has returned: the subsystem has released every buffer. */
  d->pending=false; return POCKET_STATUS_OK;
}
static int32_t identity(void *context, pocket_buffer_identity *out) {
  pocket_zephyr_display *d=context;
  if (!d || !out || out->struct_size<sizeof(*out)) return POCKET_STATUS_INVALID;
  *out=(pocket_buffer_identity){.struct_size=sizeof(*out),.buffer=1,.generation=d->generation}; return POCKET_STATUS_OK;
}
static const pocket_display_output_v1 DISPLAY={.struct_size=sizeof(DISPLAY),.descriptor=descriptor,.acquire=acquire,.flush=flush,.wait=wait_display,.frame_identity=identity};
const pocket_display_output_v1 *pocket_zephyr_display_vtable(void) { return &DISPLAY; }
size_t pocket_zephyr_display_buffer_bytes(const pocket_zephyr_display *d) { return d?d->capacity:0; }
void pocket_zephyr_display_invalidate(pocket_zephyr_display *d) { if (d) { if(d->generation==UINT64_MAX) k_panic(); d->generation++; } }
void pocket_zephyr_display_destroy(pocket_zephyr_display *d) {
  if (!d) return;
  pocket_host_free(d->pixels,d->capacity,4); pocket_host_free(d,sizeof(*d),_Alignof(pocket_zephyr_display));
}
