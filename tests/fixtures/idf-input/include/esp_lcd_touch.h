#pragma once
#include "esp_err.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
typedef void *esp_lcd_touch_handle_t;
esp_err_t esp_lcd_touch_read_data(esp_lcd_touch_handle_t);
bool esp_lcd_touch_get_coordinates(esp_lcd_touch_handle_t,uint16_t *,uint16_t *,uint16_t *,uint8_t *,uint8_t);
