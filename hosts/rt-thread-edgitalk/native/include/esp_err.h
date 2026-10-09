/*
 * Origin: PocketJS_for_Edgi-Talk/.../applications/pocketjs/include/esp_err.h
 * ESP-IDF error codes shim for compiling hosts/esp-idf components on RT-Thread.
 */
#pragma once

#include <stdint.h>

typedef int32_t esp_err_t;

#define ESP_OK                   ((esp_err_t)0)
#define ESP_FAIL                 ((esp_err_t)-1)
#define ESP_ERR_NO_MEM           ((esp_err_t)-2)
#define ESP_ERR_INVALID_ARG      ((esp_err_t)-3)
#define ESP_ERR_INVALID_STATE    ((esp_err_t)-4)
#define ESP_ERR_INVALID_RESPONSE ((esp_err_t)-5)
#define ESP_ERR_NOT_FOUND        ((esp_err_t)-6)
#define ESP_ERR_INVALID_SIZE     ((esp_err_t)-7)
#define ESP_ERR_INVALID_CRC      ((esp_err_t)-8)
#define ESP_ERR_INVALID_VERSION  ((esp_err_t)-9)
