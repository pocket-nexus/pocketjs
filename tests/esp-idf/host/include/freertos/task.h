#pragma once
#include "freertos/FreeRTOS.h"
TickType_t xTaskGetTickCount(void);
typedef struct pocket_test_task *TaskHandle_t;
#define tskNO_AFFINITY 0x7fffffff
BaseType_t xTaskCreatePinnedToCore(void (*)(void *),const char *,uint32_t,void *,UBaseType_t,TaskHandle_t *,BaseType_t);
void vTaskDelete(TaskHandle_t);
UBaseType_t uxTaskPriorityGet(TaskHandle_t);
