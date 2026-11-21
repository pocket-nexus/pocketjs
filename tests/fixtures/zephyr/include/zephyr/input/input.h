#pragma once
#include <zephyr/device.h>
#include <stdint.h>
struct input_event { const struct device *dev; uint8_t sync,type; uint16_t code; int32_t value; };
#define INPUT_CALLBACK_DEFINE(dev,fn,arg) void fixture_input_event(struct input_event *e) { fn(e,arg); }
void fixture_input_event(struct input_event *);
