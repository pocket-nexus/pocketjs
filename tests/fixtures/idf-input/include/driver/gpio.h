#pragma once
typedef int gpio_num_t;
#define GPIO_IS_VALID_GPIO(pin) ((pin)>=0 && (pin)<40)
int gpio_get_level(gpio_num_t);
