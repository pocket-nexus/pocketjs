/* Host regression for the same preflight used by the device executor.
 * See the platform README for the standalone compiler command. */
#include "../epic/rotate.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

static void rectangle(pocket_epic_point q[4], unsigned w, unsigned h, float degrees,
                      float scale, float cx, float cy) {
  float angle = degrees * (3.14159265358979323846f / 180.0f);
  float a = cosf(angle) * scale, b = sinf(angle) * scale;
  for (unsigned i = 0; i < 4; ++i) {
    float x = (i >= 2 ? 0.5f : -0.5f) * w;
    float y = (i == 1 || i == 2 ? 0.5f : -0.5f) * h;
    q[i] = (pocket_epic_point){(int32_t)lroundf(cx + a * x - b * y),
                              (int32_t)lroundf(cy + b * x + a * y)};
  }
}

int main(void) {
  epic_rotation rotation;
  unsigned cases = 0;
  const pocket_epic_rect sources[] = {{0, 0, 8, 128}, {5, 7, 4, 256}, {0, 0, 32, 24}};
  for (unsigned shape = 0; shape < 3; ++shape) {
    for (unsigned angle = 0; angle < 3600; angle += 7) {
      pocket_epic_point quad[4];
      rectangle(quad, sources[shape].w, sources[shape].h, angle * 0.1f, 1, 233.25f, 233.5f);
      assert(epic_rotation_from_quad(&sources[shape], quad, 505, &rotation));
      /* Long-axis orientation must survive integer rounding of thin hands. */
      int delta = rotation.angle - (int)angle;
      if (delta > 1800) delta -= 3600;
      if (delta < -1800) delta += 3600;
      assert(abs(delta) <= 20);
      ++cases;
    }
  }
  pocket_epic_rect src = {0, 0, 16, 16};
  pocket_epic_point quad[4];
  rectangle(quad, 16, 16, 90, 1, 64, 64);
  assert(epic_rotation_from_quad(&src, quad, 505, &rotation));
  assert(rotation.angle == 900 && rotation.scale == 1024);
  assert(rotation.x_q16 == 71 * 65536 && rotation.y_q16 == 56 * 65536);
  rectangle(quad, 16, 16, 37, 2, 0, -3);
  assert(epic_rotation_from_quad(&src, quad, 505, &rotation));
  for (unsigned angle = 0; angle < 3600; angle += 13) {
    for (unsigned step = 0; step < 3; ++step) {
      const float scales[] = {0.5f, 1.28f, 2.0f};
      rectangle(quad, 16, 16, angle * 0.1f, scales[step], 8.25f, -3.5f);
      assert(epic_rotation_from_quad(&src, quad, 505, &rotation));
      ++cases;
    }
  }
  rectangle(quad, 16, 16, 0, 1, 64, 64);
  quad[2].x += 8; quad[3].x += 8; /* nonuniform scaling */
  assert(!epic_rotation_from_quad(&src, quad, 505, &rotation));
  rectangle(quad, 16, 16, 0, 1, 64, 64);
  quad[2].x += 8; /* perspective */
  assert(!epic_rotation_from_quad(&src, quad, 505, &rotation));
  quad[1].x += 8; /* shear */
  assert(!epic_rotation_from_quad(&src, quad, 505, &rotation));
  rectangle(quad, 16, 16, 0, 1, 64, 64);
  for (unsigned i = 0; i < 4; ++i) quad[i].x = 128 - quad[i].x;
  assert(!epic_rotation_from_quad(&src, quad, 505, &rotation));
  rectangle(quad, 16, 16, 0, 1, 64, 64);
  quad[0].x = INT32_MIN;
  assert(!epic_rotation_from_quad(&src, quad, 505, &rotation));
  src.w = 0;
  assert(!epic_rotation_from_quad(&src, quad, 505, &rotation));
  src.w = 506;
  assert(!epic_rotation_from_quad(&src, quad, 505, &rotation));
  printf("rotation geometry: %u rounded rectangles + rejection/phase cases passed\n", cases);
  return 0;
}
