#pragma once
#include <stdint.h>
typedef int BaseType_t;
typedef uint32_t TickType_t;
#define pdFALSE 0
#define pdTRUE 1
#define pdPASS 1
typedef unsigned UBaseType_t;
#define portMAX_DELAY ((TickType_t)0xffffffffU)
#define configMAX_PRIORITIES 25
#define pdMS_TO_TICKS(ms) ((TickType_t)(ms))
