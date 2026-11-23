#pragma once
#include "freertos/FreeRTOS.h"
typedef struct pocket_test_queue *QueueHandle_t;
QueueHandle_t xQueueCreate(UBaseType_t,UBaseType_t);
BaseType_t xQueueSend(QueueHandle_t,const void *,TickType_t);
BaseType_t xQueueReceive(QueueHandle_t,void *,TickType_t);
void vQueueDelete(QueueHandle_t);
