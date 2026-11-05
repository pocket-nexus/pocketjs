/* A ring of RGB565 framebuffers presented through the RT-Thread LCD device.
 *
 * Targets are device-owned: EPIC renders into framebuffers[N - 1] for handle
 * N and the CPU never writes them. Each framebuffer is its own buffer
 * identity, so damage history follows the pixels it retains. Flush starts
 * one draw_rect_async of the whole framebuffer; its tx_complete makes that
 * framebuffer the scanned one. A frame takes the most recently presented
 * framebuffer that is neither scanned nor presenting: two framebuffers
 * alternate, and the coordinator keeps one damage history for each. A third
 * serves while a timed-out present still holds one. */
#include <rtdevice.h>
#include <rtthread.h>
#include <string.h>

#include "pocket/sifli.h"

#define MAX_FRAMEBUFFERS 4u
#define NONE UINT32_MAX

struct pocket_sifli_display {
  uint16_t *framebuffers[MAX_FRAMEBUFFERS];
  uint32_t count, width, height;
  rt_int32_t timeout;
  rt_device_t lcd;
  struct rt_semaphore done;
  uint64_t generations[MAX_FRAMEBUFFERS];
  uint64_t presented[MAX_FRAMEBUFFERS]; /* present order; 0 = never */
  uint64_t order, next_token, presenting_token;
  uint32_t scanned, presenting, active;
  pocket_rect region;
};

/* tx_complete carries no context; one display drives the LCD. */
static pocket_sifli_display *g_display;

static rt_err_t presented(rt_device_t device, void *buffer) {
  (void)device;
  (void)buffer;
  pocket_sifli_display *d = g_display;
  return d != NULL ? rt_sem_release(&d->done) : RT_EOK;
}

/* Finish the outstanding present within `ticks`; false while it is still
 * pending. */
static bool settle(pocket_sifli_display *d, rt_int32_t ticks) {
  if (d->presenting == NONE)
    return true;
  if (rt_sem_take(&d->done, ticks) != RT_EOK)
    return false;
  d->scanned = d->presenting;
  d->presenting = NONE;
  return true;
}

static uint32_t choose(const pocket_sifli_display *d) {
  uint32_t best = NONE;
  for (uint32_t i = 0; i < d->count; i++) {
    if (i == d->scanned || i == d->presenting)
      continue;
    if (best == NONE || d->presented[i] > d->presented[best])
      best = i;
  }
  return best;
}

/* Select the framebuffer of the frame that starts. */
static int32_t select_buffer(pocket_sifli_display *d) {
  if (d->active != NONE)
    return POCKET_STATUS_OK;
  (void)settle(d, RT_WAITING_NO);
  uint32_t index = choose(d);
  if (index == NONE && settle(d, d->timeout))
    index = choose(d);
  if (index == NONE)
    return POCKET_STATUS_FAILED;
  d->active = index;
  return POCKET_STATUS_OK;
}

static bool open_lcd(pocket_sifli_display *d, const pocket_sifli_display_config *c) {
  struct rt_device_graphic_info info;
  uint16_t format = RTGRAPHIC_PIXEL_FORMAT_RGB565;
  uint8_t brightness = c->brightness;
  d->lcd = rt_device_find(c->device != NULL ? c->device : "lcd");
  if (d->lcd == RT_NULL || rt_device_open(d->lcd, RT_DEVICE_OFLAG_RDWR) != RT_EOK) {
    rt_kprintf("[PocketJS] display: LCD device open failed\n");
    d->lcd = RT_NULL;
    return false;
  }
  if (rt_device_control(d->lcd, RTGRAPHIC_CTRL_GET_INFO, &info) != RT_EOK ||
      info.width != d->width || info.height != d->height) {
    rt_kprintf("[PocketJS] display: LCD is %ux%u, the profile needs %ux%u\n",
               (unsigned)info.width, (unsigned)info.height, (unsigned)d->width,
               (unsigned)d->height);
    return false;
  }
  if (rt_device_control(d->lcd, RTGRAPHIC_CTRL_SET_BUF_FORMAT, &format) != RT_EOK) {
    rt_kprintf("[PocketJS] display: LCD rejected the RGB565 format\n");
    return false;
  }
  rt_graphix_ops(d->lcd)->set_window(0, 0, (int)d->width - 1, (int)d->height - 1);
  rt_device_set_tx_complete(d->lcd, presented);
  if (brightness != 0U)
    (void)rt_device_control(d->lcd, RTGRAPHIC_CTRL_SET_BRIGHTNESS, &brightness);
  return true;
}

pocket_sifli_display *pocket_sifli_display_create(const pocket_sifli_display_config *c) {
  if (c == NULL || c->struct_size < sizeof(*c) || c->framebuffers == NULL ||
      c->framebuffer_count < 2U || c->framebuffer_count > MAX_FRAMEBUFFERS || c->width == 0U ||
      c->height == 0U || c->width > INT16_MAX || c->height > INT16_MAX ||
      c->wait_timeout_ms == 0U || g_display != NULL)
    return NULL;
  for (uint32_t i = 0; i < c->framebuffer_count; i++) {
    const uintptr_t start = (uintptr_t)c->framebuffers[i];
    if (start == 0U || (start & 63U) != 0U)
      return NULL;
#ifdef POCKETJS_MPU_OVERRIDE
    /* The override marks PSRAM2 non-cacheable for EPIC and the LCD. */
    if (start < 0x62000000U || start + (size_t)c->width * c->height * 2U > 0x63000000U)
      return NULL;
#endif
  }
  pocket_sifli_display *d = rt_calloc(1, sizeof(*d));
  if (d == NULL)
    return NULL;
  memcpy(d->framebuffers, c->framebuffers, c->framebuffer_count * sizeof(c->framebuffers[0]));
  d->count = c->framebuffer_count;
  d->width = c->width;
  d->height = c->height;
  d->timeout = rt_tick_from_millisecond((rt_int32_t)c->wait_timeout_ms);
  d->scanned = d->presenting = d->active = NONE;
  for (uint32_t i = 0; i < MAX_FRAMEBUFFERS; i++)
    d->generations[i] = 1;
  if (rt_sem_init(&d->done, "pocket_lcd", 0, RT_IPC_FLAG_FIFO) != RT_EOK) {
    rt_free(d);
    return NULL;
  }
  g_display = d;
  if (!open_lcd(d, c)) {
    pocket_sifli_display_destroy(d);
    return NULL;
  }
  return d;
}

void pocket_sifli_display_invalidate(pocket_sifli_display *d) {
  if (d == NULL)
    return;
  (void)settle(d, RT_WAITING_FOREVER);
  for (uint32_t i = 0; i < d->count; i++)
    d->generations[i]++;
  d->active = NONE;
}

void pocket_sifli_display_destroy(pocket_sifli_display *d) {
  if (d == NULL)
    return;
  (void)settle(d, RT_WAITING_FOREVER);
  if (d->lcd != RT_NULL) {
    rt_device_set_tx_complete(d->lcd, RT_NULL);
    rt_device_close(d->lcd);
  }
  g_display = NULL;
  rt_sem_detach(&d->done);
  rt_free(d);
}

static int32_t descriptor(void *context, pocket_display_descriptor *out) {
  pocket_sifli_display *d = context;
  if (d == NULL || out == NULL || out->struct_size < sizeof(*out))
    return POCKET_STATUS_INVALID;
  *out = (pocket_display_descriptor){
      .struct_size = sizeof(*out),
      .role = POCKET_DISPLAY_ROLE_PRIMARY,
      .width = d->width,
      .height = d->height,
      .pixel_format = POCKET_PIXEL_FORMAT_RGB565,
      .stride_bytes = (size_t)d->width * 2U,
      .target_kind = POCKET_TARGET_DEVICE_OWNED,
      .flags = POCKET_DISPLAY_FRAME_STORAGE | POCKET_DISPLAY_PARTIAL_REFRESH |
               POCKET_DISPLAY_DOUBLE_BUFFERED,
      .refresh_width = 1,
      .refresh_height = 1,
      .window_x_alignment = 1,
      .window_y_alignment = 1,
      .vsync_source = POCKET_VSYNC_NONE};
  return POCKET_STATUS_OK;
}

static int32_t identity(void *context, pocket_buffer_identity *out) {
  pocket_sifli_display *d = context;
  if (d == NULL || out == NULL || out->struct_size < sizeof(*out))
    return POCKET_STATUS_INVALID;
  d->active = NONE;
  const int32_t status = select_buffer(d);
  if (status != POCKET_STATUS_OK)
    return status;
  *out = (pocket_buffer_identity){.struct_size = sizeof(*out),
                                  .buffer = d->active + 1U,
                                  .generation = d->generations[d->active]};
  return POCKET_STATUS_OK;
}

static int32_t acquire(void *context, const pocket_rect *region, pocket_target *out) {
  pocket_sifli_display *d = context;
  if (d == NULL || region == NULL || region->struct_size < sizeof(*region) || out == NULL ||
      out->struct_size < sizeof(*out) || region->width == 0U || region->height == 0U ||
      region->x > d->width - region->width || region->y > d->height - region->height ||
      region->width > d->width || region->height > d->height)
    return POCKET_STATUS_INVALID;
  const int32_t status = select_buffer(d);
  if (status != POCKET_STATUS_OK)
    return status;
  d->region = (pocket_rect){.struct_size = sizeof(d->region),
                            .x = region->x,
                            .y = region->y,
                            .width = region->width,
                            .height = region->height};
  *out = (pocket_target){.struct_size = sizeof(*out),
                         .kind = POCKET_TARGET_DEVICE_OWNED,
                         .region = &d->region,
                         .pixel_format = POCKET_PIXEL_FORMAT_RGB565,
                         .device_handle = d->active + 1U};
  return POCKET_STATUS_OK;
}

static int32_t flush(void *context, const pocket_rect *regions, size_t count, uint64_t *token) {
  pocket_sifli_display *d = context;
  if (d == NULL || regions == NULL || count == 0U || token == NULL || d->active == NONE ||
      d->next_token == UINT64_MAX)
    return POCKET_STATUS_INVALID;
  const pocket_rect *r = regions;
  for (size_t i = 0; i < count; i++) {
    if (r->struct_size < sizeof(*r) || r->struct_size % _Alignof(pocket_rect) != 0U ||
        r->width > d->width || r->height > d->height || r->x > d->width - r->width ||
        r->y > d->height - r->height)
      return POCKET_STATUS_INVALID;
    r = (const pocket_rect *)((const uint8_t *)r + r->struct_size);
  }
  /* One present at a time: a timed-out one lands first. */
  if (!settle(d, d->timeout)) {
    rt_kprintf("[PocketJS] display: present of framebuffer %u did not complete\n",
               (unsigned)d->presenting);
    d->generations[d->active]++;
    d->active = NONE;
    return POCKET_STATUS_FAILED;
  }
  /* The whole framebuffer scans out; damage only bounded the repaint. */
  rt_graphix_ops(d->lcd)->draw_rect_async((const char *)d->framebuffers[d->active], 0, 0,
                                          (int)d->width - 1, (int)d->height - 1);
  d->presenting = d->active;
  d->presented[d->active] = ++d->order;
  d->presenting_token = *token = ++d->next_token;
  d->active = NONE;
  return POCKET_STATUS_OK;
}

static int32_t wait_display(void *context, uint64_t token) {
  pocket_sifli_display *d = context;
  if (d == NULL || d->presenting == NONE || token != d->presenting_token)
    return POCKET_STATUS_INVALID;
  if (!settle(d, d->timeout)) {
    rt_kprintf("[PocketJS] display: present of framebuffer %u did not complete\n",
               (unsigned)d->presenting);
    return POCKET_STATUS_FAILED;
  }
  return POCKET_STATUS_OK;
}

static const pocket_display_output_v1 DISPLAY = {.struct_size = sizeof(DISPLAY),
                                                 .descriptor = descriptor,
                                                 .acquire = acquire,
                                                 .flush = flush,
                                                 .wait = wait_display,
                                                 .frame_identity = identity};

const pocket_display_output_v1 *pocket_sifli_display_vtable(void) { return &DISPLAY; }
