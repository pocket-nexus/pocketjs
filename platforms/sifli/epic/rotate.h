#pragma once
#include "pocket/render_sifli_epic.h"

/* HAL rotation about source texel (0,0), with a uniform inverse scale in
 * units of 1024 and a signed 16.16 destination origin. */
typedef struct {
  int16_t angle;
  uint32_t scale;
  int32_t x_q16, y_q16;
} epic_rotation;

/* Pure geometry preflight; also used when executing the command. Accepts
 * a rotated, uniformly scaled rectangle within vertex rounding tolerance.
 * Does not accept reflection, shear or perspective. */
bool epic_rotation_from_quad(const pocket_epic_rect *src, const pocket_epic_point quad[4],
                             uint32_t limit, epic_rotation *rotation);
