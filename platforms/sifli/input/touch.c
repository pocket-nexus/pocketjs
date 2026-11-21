/* One contact from the RT-Thread touch device. The device's rx_indicate
 * counts queued messages; poll drains them and reports the latest contact in
 * logical pixels. Poll, cancel and destroy run on the thread that runs the
 * runtime. */
#include <rtdevice.h>
#include <rtthread.h>

#include "drv_touch.h"
#include "pocket/sifli.h"

struct pocket_sifli_touch {
  rt_device_t device;
  uint32_t scale, logical_width, logical_height;
  volatile uint32_t pending;
  bool active, cancelled;
  float x, y;
};

/* rx_indicate carries no context; one touch device feeds the runtime. */
static pocket_sifli_touch *g_touch;

static rt_err_t received(rt_device_t device, rt_size_t size) {
  (void)device;
  (void)size;
  pocket_sifli_touch *d = g_touch;
  if (d != NULL && d->pending != UINT32_MAX)
    ++d->pending;
  return RT_EOK;
}

pocket_sifli_touch *pocket_sifli_touch_create(const pocket_sifli_touch_config *c) {
  if (c == NULL || c->struct_size < sizeof(*c) || c->scale == 0U || c->logical_width == 0U ||
      c->logical_height == 0U || g_touch != NULL)
    return NULL;
  pocket_sifli_touch *d = rt_calloc(1, sizeof(*d));
  if (d == NULL)
    return NULL;
  d->scale = c->scale;
  d->logical_width = c->logical_width;
  d->logical_height = c->logical_height;
  d->device = rt_device_find(c->device != NULL ? c->device : "touch");
  if (d->device == RT_NULL || rt_device_open(d->device, RT_DEVICE_FLAG_RDONLY) != RT_EOK) {
    rt_free(d);
    return NULL;
  }
  g_touch = d;
  rt_device_set_rx_indicate(d->device, received);
  return d;
}

static void drain(pocket_sifli_touch *d) {
  while (d->pending > 0U) {
    struct touch_message message;
    const rt_base_t level = rt_hw_interrupt_disable();
    --d->pending;
    rt_hw_interrupt_enable(level);
    if (rt_device_read(d->device, 0, &message, 1) != 1)
      continue;
    const uint32_t x = message.x / d->scale;
    const uint32_t y = message.y / d->scale;
    d->x = (float)(x < d->logical_width ? x : d->logical_width - 1U);
    d->y = (float)(y < d->logical_height ? y : d->logical_height - 1U);
    d->active = message.event == TOUCH_EVENT_DOWN || message.event == TOUCH_EVENT_MOVE;
  }
}

static uint32_t classes(void *context) {
  (void)context;
  return POCKET_INPUT_CLASS_CONTACT;
}

static int32_t poll(void *context, pocket_input_frame_builder *builder) {
  pocket_sifli_touch *d = context;
  if (d == NULL || builder == NULL || builder->struct_size < sizeof(*builder) ||
      builder->append == NULL)
    return POCKET_STATUS_INVALID;
  drain(d);
  pocket_contact contact = {.struct_size = sizeof(contact), .surface = 0, .id = 0,
                            .x = d->x, .y = d->y};
  pocket_cancelled_contact cancelled = {.struct_size = sizeof(cancelled), .surface = 0, .id = 0};
  /* A cancellation reports alone; a contact begun after it follows next poll. */
  const bool touching = d->active && !d->cancelled;
  pocket_input_frame frame = {.struct_size = sizeof(frame),
                              .contacts = touching ? &contact : NULL,
                              .contact_count = touching ? 1U : 0U,
                              .cancelled = d->cancelled ? &cancelled : NULL,
                              .cancelled_count = d->cancelled ? 1U : 0U};
  const int32_t result = builder->append(builder->context, &frame);
  if (result == POCKET_STATUS_OK)
    d->cancelled = false;
  return result;
}

static const pocket_input_source_v1 VTABLE = {
    .struct_size = sizeof(VTABLE), .classes = classes, .poll = poll};

const pocket_input_source_v1 *pocket_sifli_touch_vtable(void) { return &VTABLE; }

void pocket_sifli_touch_cancel(pocket_sifli_touch *d) {
  if (d == NULL)
    return;
  drain(d);
  if (d->active)
    d->cancelled = true;
  /* A contact held through the cancel reports again at its next message. */
  d->active = false;
}

void pocket_sifli_touch_destroy(pocket_sifli_touch *d) {
  if (d == NULL)
    return;
  rt_device_set_rx_indicate(d->device, RT_NULL);
  rt_device_close(d->device);
  g_touch = NULL;
  rt_free(d);
}
