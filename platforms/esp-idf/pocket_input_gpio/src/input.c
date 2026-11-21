#include "pocket/input_gpio.h"
#include "esp_timer.h"
#include <stdlib.h>
#include <string.h>
struct pocket_input_gpio {
  pocket_gpio_button gpio[32]; pocket_adc_button adc[16];
  size_t gpio_count, adc_count; uint32_t debounce, stable, candidate;
  int64_t since; esp_err_t error;
};
pocket_input_gpio *pocket_input_gpio_create(const pocket_input_gpio_config *c) {
  if (!c || c->struct_size < sizeof(*c) || c->gpio_count > 32 || c->adc_count > 16 ||
      (!c->gpio_count && !c->adc_count) || (c->gpio_count && !c->gpio) || (c->adc_count && !c->adc)) return NULL;
  for (size_t i=0;i<c->gpio_count;i++) if (!GPIO_IS_VALID_GPIO(c->gpio[i].pin) || !c->gpio[i].buttons) return NULL;
  for (size_t i=0;i<c->adc_count;i++) if (!c->adc[i].unit || c->adc[i].channel < 0 || c->adc[i].minimum < 0 || c->adc[i].maximum < c->adc[i].minimum || !c->adc[i].buttons) return NULL;
  pocket_input_gpio *d=calloc(1,sizeof(*d)); if (!d) return NULL;
  if (c->gpio_count) memcpy(d->gpio,c->gpio,c->gpio_count*sizeof(*c->gpio));
  if (c->adc_count) memcpy(d->adc,c->adc,c->adc_count*sizeof(*c->adc));
  d->gpio_count=c->gpio_count; d->adc_count=c->adc_count; d->debounce=c->debounce_us; return d;
}
static uint32_t classes(void *context) { (void)context; return POCKET_INPUT_CLASS_BUTTONS; }
static int32_t poll(void *context,pocket_input_frame_builder *builder) {
  pocket_input_gpio *d=context;
  if (!d || !builder || builder->struct_size < sizeof(*builder) || !builder->append) return POCKET_STATUS_INVALID;
  uint32_t buttons=0; d->error=ESP_OK;
  for (size_t i=0;i<d->gpio_count;i++) if ((gpio_get_level(d->gpio[i].pin)!=0) != d->gpio[i].active_low) buttons|=d->gpio[i].buttons;
  for (size_t i=0;i<d->adc_count;i++) {
    int raw=0; const pocket_adc_button *b=&d->adc[i]; esp_err_t e=adc_oneshot_read(b->unit,b->channel,&raw);
    if (e!=ESP_OK) d->error=e;
    else if (raw>=b->minimum && raw<=b->maximum) buttons|=b->buttons;
  }
  int64_t now=esp_timer_get_time();
  if (buttons!=d->candidate) { d->candidate=buttons; d->since=now; }
  uint32_t stable=d->stable;
  if (now>=d->since && (uint64_t)(now-d->since)>=d->debounce) stable=buttons;
  pocket_input_frame frame={.struct_size=sizeof(frame),.buttons=stable};
  int32_t result=builder->append(builder->context,&frame);
  if (result==POCKET_STATUS_OK) d->stable=stable;
  return result;
}
static const pocket_input_source_v1 VTABLE={.struct_size=sizeof(VTABLE),.classes=classes,.poll=poll};
const pocket_input_source_v1 *pocket_input_gpio_vtable(void) { return &VTABLE; }
esp_err_t pocket_input_gpio_last_error(const pocket_input_gpio *d) { return d ? d->error : ESP_ERR_INVALID_ARG; }
void pocket_input_gpio_destroy(pocket_input_gpio *d) { free(d); }
