#pragma once
#include "pocket/sifli.h"

/* Repaints framebuffers 0/1. Requires at least 128x128 and native rotation. */
int pocket_sifli_epic_test_rotation(pocket_sifli_epic *, uint16_t *, uint16_t *,
                                  uint32_t, uint32_t);
