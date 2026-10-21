#pragma once
#include "esp_err.h"
typedef void *adc_oneshot_unit_handle_t;
typedef int adc_channel_t;
esp_err_t adc_oneshot_read(adc_oneshot_unit_handle_t,adc_channel_t,int *);
