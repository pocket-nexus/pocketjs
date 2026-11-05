/* The app-switch overlay (transition.h). */

#include "transition.h"

#include <math.h>

#define DRAW_RECT 1u
#define DRAW_TRI 7u
#define ABGR(r, g, b, a) \
  ((uint32_t)(r) | ((uint32_t)(g) << 8) | ((uint32_t)(b) << 16) | ((uint32_t)(a) << 24))

/* The indicator: eight dots on a ring at the touch screen's centre, with a
 * brightness crest that goes round clockwise once per TURN_MS. Each dot is
 * an octagon of triangles around a pixel centre, so all eight cover the
 * same pixels: a 5 x 5 disc. */
#define DOTS 8u
#define DOT_SIDES 8u
#define RING_RADIUS 10.0f
#define DOT_RADIUS 2.5f
#define DOT_GREY 0xebu
#define TURN_MS 900u
#define TAU 6.28318531f

#define LIST_CAPACITY (4u + DOTS * DOT_SIDES * 7u)

static TransitionPhase phase = TRANSITION_IDLE;
/* The indicator's clock: the first leaving or loading moment of a switch. */
static uint64_t origin;
/* When the current phase began. */
static uint64_t started;
/* Arriving's clock, in presented-frame steps. */
static uint32_t arrived_ms;
static uint64_t last_advance;
static uint32_t list[LIST_CAPACITY];

static float clamp01(float value) {
  return value < 0.0f ? 0.0f : value > 1.0f ? 1.0f : value;
}

static uint32_t packed(int32_t x, int32_t y) {
  return ((uint32_t)x & 0xffffu) | (((uint32_t)y & 0xffffu) << 16);
}

static uint32_t byte_of(float level) {
  return (uint32_t)(clamp01(level) * 255.0f + 0.5f);
}

TransitionPhase transition_phase(void) {
  return phase;
}

void transition_leave(uint64_t now) {
  if (phase == TRANSITION_IDLE) {
    phase = TRANSITION_LEAVING;
    origin = now;
    started = now;
  } else if (phase == TRANSITION_ARRIVING) {
    /* Leaving again mid-fade: the scrim rises from where it is, with the
     * leaving curve's progress at that opacity. */
    float arrived = clamp01((float)arrived_ms / (float)TRANSITION_ARRIVE_MS);
    float scrim = (1.0f - arrived) * (1.0f - arrived);
    float progress = 1.0f - sqrtf(1.0f - scrim);
    phase = TRANSITION_LEAVING;
    started = now - (uint64_t)(progress * (float)TRANSITION_LEAVE_MS);
  }
}

bool transition_covered(uint64_t now) {
  if (phase == TRANSITION_LEAVING) return now - started >= TRANSITION_LEAVE_MS;
  return phase == TRANSITION_LOADING;
}

void transition_load(uint64_t now) {
  if (phase != TRANSITION_LEAVING && phase != TRANSITION_LOADING) origin = now;
  phase = TRANSITION_LOADING;
  started = now;
}

void transition_arrive(uint64_t now) {
  if (phase != TRANSITION_LOADING) return;
  phase = TRANSITION_ARRIVING;
  started = now;
  arrived_ms = 0;
  last_advance = now;
}

void transition_advance(uint64_t now) {
  if (phase != TRANSITION_ARRIVING) return;
  uint64_t step = now - last_advance;
  if (step > TRANSITION_STEP_MAX_MS) step = TRANSITION_STEP_MAX_MS;
  last_advance = now;
  arrived_ms += (uint32_t)step;
  if (arrived_ms >= TRANSITION_ARRIVE_MS) phase = TRANSITION_IDLE;
}

/* The scrim's and the indicator's opacity at `now`. */
static void levels(uint64_t now, float *scrim, float *indicator) {
  float rise = clamp01((float)(now - origin) / (float)TRANSITION_LEAVE_MS);
  *scrim = 0.0f;
  *indicator = 0.0f;
  if (phase == TRANSITION_LEAVING) {
    float left = 1.0f - clamp01((float)(now - started) / (float)TRANSITION_LEAVE_MS);
    *scrim = 1.0f - left * left;
    *indicator = rise;
  } else if (phase == TRANSITION_LOADING) {
    *scrim = 1.0f;
    *indicator = rise;
  } else if (phase == TRANSITION_ARRIVING) {
    float arrived = clamp01((float)arrived_ms / (float)TRANSITION_ARRIVE_MS);
    *scrim = (1.0f - arrived) * (1.0f - arrived);
    *indicator = rise * clamp01(1.0f - 2.0f * arrived);
  }
}

static size_t indicator_into(size_t count, uint64_t now, uint32_t width, uint32_t height, float opacity) {
  const float unit = (float)TRANSITION_SUBPIXELS;
  float cx = (float)(width / 2u);
  float cy = (float)(height / 2u);
  float turn = (float)((now - origin) % TURN_MS) / (float)TURN_MS;
  for (uint32_t dot = 0; dot < DOTS; dot += 1) {
    float at = (float)dot / (float)DOTS;
    /* How far the crest has gone past this dot, 0 at the crest. */
    float behind = turn - at;
    if (behind < 0.0f) behind += 1.0f;
    float glow = 0.25f + 0.75f * (1.0f - behind) * (1.0f - behind);
    uint32_t color = ABGR(DOT_GREY, DOT_GREY, DOT_GREY, byte_of(glow * opacity));
    /* Dot 0 sits at twelve o'clock; screen y grows downward, so a growing
     * angle goes clockwise. */
    float angle = at * TAU - TAU / 4.0f;
    float x = (roundf(cx + cosf(angle) * RING_RADIUS) + 0.5f) * unit;
    float y = (roundf(cy + sinf(angle) * RING_RADIUS) + 0.5f) * unit;
    uint32_t centre = packed((int32_t)lroundf(x), (int32_t)lroundf(y));
    for (uint32_t side = 0; side < DOT_SIDES; side += 1) {
      float a0 = ((float)side + 0.5f) * TAU / (float)DOT_SIDES;
      float a1 = ((float)side + 1.5f) * TAU / (float)DOT_SIDES;
      list[count++] = DRAW_TRI;
      list[count++] = centre;
      list[count++] = packed(
        (int32_t)lroundf(x + cosf(a0) * DOT_RADIUS * unit),
        (int32_t)lroundf(y + sinf(a0) * DOT_RADIUS * unit)
      );
      list[count++] = packed(
        (int32_t)lroundf(x + cosf(a1) * DOT_RADIUS * unit),
        (int32_t)lroundf(y + sinf(a1) * DOT_RADIUS * unit)
      );
      list[count++] = color;
      list[count++] = color;
      list[count++] = color;
    }
  }
  return count;
}

size_t transition_list(bool touch_screen, uint64_t now, uint32_t width, uint32_t height, const uint32_t **words) {
  *words = list;
  float scrim = 0.0f;
  float indicator = 0.0f;
  levels(now, &scrim, &indicator);
  size_t count = 0;
  if (byte_of(scrim) > 0) {
    list[count++] = DRAW_RECT;
    list[count++] = packed(0, 0);
    list[count++] = packed((int32_t)(width * TRANSITION_SUBPIXELS), (int32_t)(height * TRANSITION_SUBPIXELS));
    list[count++] = ABGR(0, 0, 0, byte_of(scrim));
  }
  if (touch_screen && byte_of(indicator) > 0) count = indicator_into(count, now, width, height, indicator);
  return count;
}
