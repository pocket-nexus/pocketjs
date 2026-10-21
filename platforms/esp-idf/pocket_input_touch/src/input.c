#include "pocket/input_touch.h"
#include <math.h>
#include <stdbool.h>
#include <stdlib.h>
struct pocket_input_touch { pocket_input_touch_config config; bool active; esp_err_t error; };
pocket_input_touch *pocket_input_touch_create(const pocket_input_touch_config *c) {
  if (!c || c->struct_size < sizeof(*c) || !c->touch || c->surface > 1 ||
      !isfinite(c->scale_x) || !isfinite(c->scale_y) || c->scale_x <= 0 || c->scale_y <= 0 ||
      c->scale_x > 65535 || c->scale_y > 65535) return NULL;
  pocket_input_touch *d = calloc(1, sizeof(*d)); if (d) d->config = *c; return d;
}
static uint32_t classes(void *context) { (void)context; return POCKET_INPUT_CLASS_CONTACT; }
static int32_t poll(void *context, pocket_input_frame_builder *builder) {
  pocket_input_touch *d = context;
  if (!d || !builder || builder->struct_size < sizeof(*builder) || !builder->append) return POCKET_STATUS_INVALID;
  d->error = esp_lcd_touch_read_data(d->config.touch);
  uint16_t x = 0, y = 0; uint8_t count = 0;
  bool active = d->error == ESP_OK && esp_lcd_touch_get_coordinates(d->config.touch, &x, &y, NULL, &count, 1) && count;
  pocket_contact contact = {.struct_size=sizeof(contact), .surface=d->config.surface, .id=0,
    .x=(float)x*d->config.scale_x, .y=(float)y*d->config.scale_y};
  pocket_cancelled_contact cancelled = {.struct_size=sizeof(cancelled), .surface=d->config.surface, .id=0};
  pocket_input_frame frame = {.struct_size=sizeof(frame), .contacts=active ? &contact : NULL, .contact_count=active ? 1 : 0,
    .cancelled=d->error != ESP_OK && d->active ? &cancelled : NULL, .cancelled_count=d->error != ESP_OK && d->active ? 1 : 0};
  int32_t result = builder->append(builder->context, &frame);
  if (result == POCKET_STATUS_OK) d->active = active;
  return result;
}
static const pocket_input_source_v1 VTABLE = {.struct_size=sizeof(VTABLE), .classes=classes, .poll=poll};
const pocket_input_source_v1 *pocket_input_touch_vtable(void) { return &VTABLE; }
esp_err_t pocket_input_touch_last_error(const pocket_input_touch *d) { return d ? d->error : ESP_ERR_INVALID_ARG; }
void pocket_input_touch_destroy(pocket_input_touch *d) { free(d); }
