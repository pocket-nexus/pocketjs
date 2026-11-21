#pragma once
#include "driver/gpio.h"
#include "esp_adc/adc_oneshot.h"
#include "pocket_drivers.h"
#include <stdbool.h>
typedef struct pocket_input_gpio pocket_input_gpio;
typedef struct { gpio_num_t pin; uint32_t buttons; bool active_low; } pocket_gpio_button;
typedef struct { adc_oneshot_unit_handle_t unit; adc_channel_t channel; int minimum, maximum; uint32_t buttons; } pocket_adc_button;
typedef struct {
  size_t struct_size;
  const pocket_gpio_button *gpio; size_t gpio_count;
  const pocket_adc_button *adc; size_t adc_count;
  uint32_t debounce_us;
} pocket_input_gpio_config;
/* Product code configures GPIO direction/pulls and ADC attenuation/bit width.
 * This driver copies mappings and never deletes GPIO/ADC resources. Each ADC
 * window maps its inclusive raw interval to buttons; a failed read releases
 * those buttons. Poll/destroy are serialized with the runtime. */
pocket_input_gpio *pocket_input_gpio_create(const pocket_input_gpio_config *);
const pocket_input_source_v1 *pocket_input_gpio_vtable(void);
esp_err_t pocket_input_gpio_last_error(const pocket_input_gpio *);
void pocket_input_gpio_destroy(pocket_input_gpio *);
