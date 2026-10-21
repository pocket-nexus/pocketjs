#pragma once
#include <zephyr/device.h>
#include <stdint.h>
#define SCREEN_INFO_DOUBLE_BUFFER 8
#define PIXEL_FORMAT_RGB_565 16
#define PIXEL_FORMAT_ARGB_8888 8
struct display_capabilities { uint16_t x_resolution,y_resolution; uint32_t supported_pixel_formats,screen_info,current_pixel_format,current_orientation; };
struct display_buffer_descriptor { uint32_t buf_size; uint16_t width,height,pitch; bool frame_incomplete; };
void display_get_capabilities(const struct device *,struct display_capabilities *);
int display_write(const struct device *,uint16_t,uint16_t,const struct display_buffer_descriptor *,const void *);
