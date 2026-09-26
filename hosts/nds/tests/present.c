/* cc -std=c11 -Wall -Wextra -Werror -Ihosts/nds/include \
 *   hosts/nds/tests/present.c -o <ignored-output>/nds-present-test */
#include <assert.h>
#include <stdio.h>
#include "pocket_nds_present.h"

static uint16_t source[POCKET_NDS_WIDTH * POCKET_NDS_HEIGHT];
static uint16_t pages[2][POCKET_NDS_WIDTH * POCKET_NDS_HEIGHT];

static void verify_page(unsigned int page) {
    for (unsigned int index = 0; index < POCKET_NDS_WIDTH * POCKET_NDS_HEIGHT; ++index) {
        /* Independent reference conversion, including discarded green bit. */
        unsigned int r = source[index] / 2048;
        unsigned int g = (source[index] / 64) % 32;
        unsigned int b = source[index] % 32;
        assert(pages[page][index] == (0x8000 | r | (g << 5) | (b << 10)));
    }
}

int main(void) {
    for (unsigned int pixel = 0; pixel <= UINT16_MAX; ++pixel) {
        unsigned int r = pixel / 2048;
        unsigned int g = (pixel / 64) % 32;
        unsigned int b = pixel % 32;
        assert(pocket_nds_rgb555((uint16_t)pixel) == (0x8000 | r | (g << 5) | (b << 10)));
    }
    PocketNdsPending pending[2];
    for (unsigned int page = 0; page < 2; ++page) {
        pocket_nds_pending_init(&pending[page]);
        assert(pocket_nds_pending_copy(&pending[page], source, pages[page]) ==
            POCKET_NDS_WIDTH * POCKET_NDS_HEIGHT);
        verify_page(page);
        assert(pocket_nds_pending_copy(&pending[page], source, pages[page]) == 0);
    }

    /* Separate rectangles, overlapping spans, display edges, repeated changes
     * while one page is not presented, and every RGB565 source word. */
    unsigned int page = 0;
    for (unsigned int frame = 0; frame < 512; ++frame) {
        unsigned int y = (frame * 31) % POCKET_NDS_HEIGHT;
        unsigned int x = (frame * 17) % POCKET_NDS_WIDTH;
        PocketNdsDamageRect rect = {x, y, POCKET_NDS_WIDTH, y + 1};
        for (unsigned int column = x; column < POCKET_NDS_WIDTH; ++column) {
            source[y * POCKET_NDS_WIDTH + column] = (uint16_t)(frame * 128 + column);
        }
        for (unsigned int target = 0; target < 2; ++target) {
            pocket_nds_pending_add(&pending[target], rect);
        }
        /* Defer some presentations: dirty spans must survive idle periods. */
        if (frame % 3 == 0) continue;
        unsigned int copied = pocket_nds_pending_copy(&pending[page], source, pages[page]);
        assert(copied > 0 && copied < POCKET_NDS_WIDTH * POCKET_NDS_HEIGHT);
        verify_page(page);
        assert(pocket_nds_pending_copy(&pending[page], source, pages[page]) == 0);
        page ^= 1;
    }
    for (unsigned int page = 0; page < 2; ++page) {
        pocket_nds_pending_copy(&pending[page], source, pages[page]);
        verify_page(page);
    }
    assert(!pocket_nds_deadline_reached(100, 102));
    assert(pocket_nds_deadline_reached(102, 102));
    assert(pocket_nds_deadline_reached(105, 102));
    assert(!pocket_nds_deadline_reached(UINT32_MAX, 1));
    assert(pocket_nds_deadline_reached(1, UINT32_MAX));
    puts("PASS: alternating VRAM damage, deferred/idle presentation, RGB565 conversion, wrapping deadlines");
    return 0;
}
