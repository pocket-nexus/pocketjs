#ifndef POCKETJS_NDS_PRESENT_H
#define POCKETJS_NDS_PRESENT_H

#include "pocket_nds.h"

/* Each VRAM page may lag the retained RGB565 framebuffer by several updates.
 * Accumulate changed spans on BOTH pages, then clear only the page copied.
 * Per-row spans bound the metadata and never lose damage when pages alternate. */
typedef struct {
    uint16_t x0[POCKET_NDS_HEIGHT];
    uint16_t x1[POCKET_NDS_HEIGHT];
} PocketNdsPending;

static inline void pocket_nds_pending_init(PocketNdsPending *pending) {
    for (unsigned int y = 0; y < POCKET_NDS_HEIGHT; ++y) {
        pending->x0[y] = 0;
        pending->x1[y] = POCKET_NDS_WIDTH;
    }
}

static inline void pocket_nds_pending_add(PocketNdsPending *pending, PocketNdsDamageRect rect) {
    for (unsigned int y = rect.y0; y < rect.y1; ++y) {
        if (rect.x0 < pending->x0[y]) pending->x0[y] = rect.x0;
        if (rect.x1 > pending->x1[y]) pending->x1[y] = rect.x1;
    }
}

static inline uint16_t pocket_nds_rgb555(uint16_t pixel) {
    /* Core R5:G6:B5 becomes DS opaque B5:G5:R5. */
    return 0x8000 | ((pixel >> 11) & 31) | ((pixel >> 1) & 0x3e0) | ((pixel & 31) << 10);
}

static inline uint32_t pocket_nds_pending_copy(PocketNdsPending *pending,
    const uint16_t *source, volatile uint16_t *destination) {
    uint32_t copied = 0;
    for (unsigned int y = 0; y < POCKET_NDS_HEIGHT; ++y) {
        unsigned int x0 = pending->x0[y], x1 = pending->x1[y];
        if (x0 >= x1) continue;
        unsigned int offset = y * POCKET_NDS_WIDTH;
        for (unsigned int x = x0; x < x1; ++x) {
            destination[offset + x] = pocket_nds_rgb555(source[offset + x]);
        }
        copied += x1 - x0;
        pending->x0[y] = POCKET_NDS_WIDTH;
        pending->x1[y] = 0;
    }
    return copied;
}

/* Wrapping subtraction keeps deadlines valid across the u32 IRQ count wrap. */
static inline int pocket_nds_deadline_reached(uint32_t now, uint32_t deadline) {
    return (int32_t)(now - deadline) >= 0;
}

#endif
