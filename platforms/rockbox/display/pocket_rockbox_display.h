#ifndef POCKET_ROCKBOX_DISPLAY_H
#define POCKET_ROCKBOX_DISPLAY_H

#include "plugin.h"

/* Synchronous LCD copies. The caller supplies framebuffer-bounded damage
 * rectangles as x, y, width, height and keeps pixels valid for this call. */
static inline unsigned long pocket_rockbox_blit_rgb565(
    const struct plugin_api *api, const fb_data *pixels, int stride,
    const int *rects, int count)
{
    unsigned long copied = 0;
    for (int i = 0; i < count; i++) {
        const int *r = rects + i * 4;
        api->lcd_bitmap_part(pixels, r[0], r[1], stride, r[0], r[1], r[2], r[3]);
        api->lcd_update_rect(r[0], r[1], r[2], r[3]);
        copied += (unsigned long)(r[2] * r[3]);
    }
    return copied;
}

#endif
