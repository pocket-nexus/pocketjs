#include "rotate.h"
#include <math.h>

bool epic_rotation_from_quad(const pocket_epic_rect *src, const pocket_epic_point q[4],
                             uint32_t limit, epic_rotation *out) {
  if (!src || !q || !out || src->w == 0 || src->h == 0 ||
      src->w > limit || src->h > limit || src->w + src->h > limit)
    return false;
  float cx = 0, cy = 0;
  int32_t min_x = q[0].x, max_x = q[0].x, min_y = q[0].y, max_y = q[0].y;
  for (unsigned i = 0; i < 4; ++i) {
    if (q[i].x < -16384 || q[i].x > 16383 || q[i].y < -16384 || q[i].y > 16383)
      return false;
    cx += q[i].x * 0.25f;
    cy += q[i].y * 0.25f;
    if (q[i].x < min_x) min_x = q[i].x;
    if (q[i].x > max_x) max_x = q[i].x;
    if (q[i].y < min_y) min_y = q[i].y;
    if (q[i].y > max_y) max_y = q[i].y;
  }
  if ((uint32_t)(max_x - min_x) > limit || (uint32_t)(max_y - min_y) > limit)
    return false;

  /* Least-squares similarity fit to all four rounded DrawList vertices.
   * Weighting by source dimensions keeps a thin hand's long axis accurate. */
  float w = (float)src->w, h = (float)src->h;
  float ex = (q[3].x - q[0].x + q[2].x - q[1].x) * 0.5f;
  float ey = (q[3].y - q[0].y + q[2].y - q[1].y) * 0.5f;
  float fx = (q[1].x - q[0].x + q[2].x - q[3].x) * 0.5f;
  float fy = (q[1].y - q[0].y + q[2].y - q[3].y) * 0.5f;
  if (ex * fy - ey * fx <= 0) return false;
  float a = (ex * w + fy * h) / (w * w + h * h);
  float b = (ey * w - fx * h) / (w * w + h * h);
  float length = sqrtf(a * a + b * b);
  if (!(length >= 0.03125f && length <= 32.0f)) return false;
  int angle = (int)lroundf(atan2f(b, a) * (1800.0f / 3.14159265358979323846f));
  if (angle < 0) angle += 3600;
  if (angle >= 3600) angle -= 3600;
  uint32_t scale = (uint32_t)lroundf(1024.0f / length);
  float radians = angle * (3.14159265358979323846f / 1800.0f);
  a = cosf(radians) * (1024.0f / scale);
  b = sinf(radians) * (1024.0f / scale);
  for (unsigned i = 0; i < 4; ++i) {
    float x = (i >= 2 ? 0.5f : -0.5f) * w;
    float y = (i == 1 || i == 2 ? 0.5f : -0.5f) * h;
    /* Reject transforms whose actual quantized HAL parameters move any
     * supplied vertex by more than one physical pixel in either axis. */
    if (fabsf(cx + a * x - b * y - q[i].x) > 1.0f ||
        fabsf(cy + b * x + a * y - q[i].y) > 1.0f)
      return false;
  }
  out->angle = (int16_t)angle;
  out->scale = scale;
  /* DrawList vertices bound texel edges. HAL rotates texel centers. */
  out->x_q16 = (int32_t)lroundf((cx - a * (w - 1) * 0.5f + b * (h - 1) * 0.5f - 0.5f) * 65536.0f);
  out->y_q16 = (int32_t)lroundf((cy - b * (w - 1) * 0.5f - a * (h - 1) * 0.5f - 0.5f) * 65536.0f);
  return true;
}
