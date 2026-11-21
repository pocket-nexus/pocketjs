#pragma once
#include "esp_lcd_touch.h"
#include "pocket_drivers.h"
typedef struct pocket_input_touch pocket_input_touch;
typedef struct {
  size_t struct_size;
  esp_lcd_touch_handle_t touch;
  uint32_t surface;
  float scale_x, scale_y;
} pocket_input_touch_config;
/* Single contact: esp_lcd_touch's coordinate API has no persistent contact IDs.
 * The product owns/configures touch and rotation; coordinates are scaled into
 * logical pixels. Read failures cancel an active contact before the next sample.
 * Poll/destroy must be serialized with the runtime. */
pocket_input_touch *pocket_input_touch_create(const pocket_input_touch_config *);
const pocket_input_source_v1 *pocket_input_touch_vtable(void);
esp_err_t pocket_input_touch_last_error(const pocket_input_touch *);
void pocket_input_touch_destroy(pocket_input_touch *);
