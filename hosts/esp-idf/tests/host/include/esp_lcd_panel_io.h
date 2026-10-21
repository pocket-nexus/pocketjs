#pragma once
#include "esp_err.h"
#include <stddef.h>
typedef void *esp_lcd_panel_io_handle_t;
esp_err_t esp_lcd_panel_io_tx_param(esp_lcd_panel_io_handle_t,int,const void *,size_t);
