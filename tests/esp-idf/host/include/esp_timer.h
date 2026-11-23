#pragma once
#include "esp_err.h"
#include <stdint.h>
typedef struct pocket_test_timer *esp_timer_handle_t;
typedef struct { void (*callback)(void *); void *arg; const char *name; } esp_timer_create_args_t;
int64_t esp_timer_get_time(void);
esp_err_t esp_timer_create(const esp_timer_create_args_t *,esp_timer_handle_t *);
esp_err_t esp_timer_start_once(esp_timer_handle_t,uint64_t);
esp_err_t esp_timer_delete(esp_timer_handle_t);
