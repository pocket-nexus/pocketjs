/*
 * Origin: PocketJS_for_Edgi-Talk/.../applications/pocketjs/include/esp_log.h
 * Map ESP_LOGx to rt_kprintf on RT-Thread.
 */
#pragma once

#include <rtthread.h>

#define ESP_LOGE(tag, format, ...) rt_kprintf("[%s] " format "\n", tag, ##__VA_ARGS__)
#define ESP_LOGW(tag, format, ...) rt_kprintf("[%s] " format "\n", tag, ##__VA_ARGS__)
#define ESP_LOGI(tag, format, ...) rt_kprintf("[%s] " format "\n", tag, ##__VA_ARGS__)
