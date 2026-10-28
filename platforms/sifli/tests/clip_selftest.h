#pragma once
#include "pocket/sifli.h"

/* Diagnostic only. Call after epic_create, with no work in flight. The two
 * buffers must be framebuffers[0] and [1], at least 40x40, in DMA memory.
 * Repaints both buffers. Returns 0 on pixel equality, -1 on error. */
int pocket_sifli_epic_test_clip(pocket_sifli_epic *epic, uint16_t *full,
                               uint16_t *clipped, uint32_t width, uint32_t height);
