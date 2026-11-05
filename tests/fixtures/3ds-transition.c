#include <assert.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

#include "transition.h"

#define DRAW_RECT 1u
#define DRAW_TRI 7u
#define DOT_WORDS (8u * 7u)

static int32_t word_x(uint32_t word) {
  return (int16_t)(word & 0xffffu);
}

static int32_t word_y(uint32_t word) {
  return (int16_t)(word >> 16);
}

static uint32_t alpha(uint32_t color) {
  return color >> 24;
}

/* The scrim's alpha in a list, 0 when it has none. */
static uint32_t scrim(const uint32_t *words, size_t length, uint32_t width, uint32_t height) {
  if (length < 4 || words[0] != DRAW_RECT) return 0;
  assert(word_x(words[1]) == 0 && word_y(words[1]) == 0);
  assert((words[2] & 0xffffu) == width * TRANSITION_SUBPIXELS);
  assert((words[2] >> 16) == height * TRANSITION_SUBPIXELS);
  assert((words[3] & 0xffffffu) == 0);
  return alpha(words[3]);
}

static uint32_t scrim_at(uint64_t now) {
  const uint32_t *words = NULL;
  size_t length = transition_list(false, now, 400, 240, &words);
  return scrim(words, length, 400, 240);
}

/* The dot whose colour is brightest in a touch-screen list. */
static int brightest(const uint32_t *words, size_t length) {
  size_t first = words[0] == DRAW_RECT ? 4 : 0;
  assert(length == first + 8 * DOT_WORDS);
  int best = -1;
  uint32_t best_alpha = 0;
  for (int dot = 0; dot < 8; dot += 1) {
    uint32_t value = alpha(words[first + (size_t)dot * DOT_WORDS + 4]);
    if (best < 0 || value > best_alpha) {
      best = dot;
      best_alpha = value;
    }
  }
  return best;
}

int main(void) {
  const uint32_t *words = NULL;

  /* Idle: nothing to draw, nothing covered. */
  assert(transition_phase() == TRANSITION_IDLE);
  assert(transition_list(true, 1000, 320, 240, &words) == 0);
  assert(!transition_covered(1000));

  /* Leaving: the scrim rises over TRANSITION_LEAVE_MS and covers at its end. */
  transition_leave(1000);
  assert(transition_phase() == TRANSITION_LEAVING);
  assert(!transition_covered(1000 + TRANSITION_LEAVE_MS - 1));
  assert(transition_covered(1000 + TRANSITION_LEAVE_MS));
  uint32_t early = scrim_at(1010);
  uint32_t middle = scrim_at(1075);
  assert(early > 0 && early < middle && middle < 255);
  assert(scrim_at(1000 + TRANSITION_LEAVE_MS) == 255);
  /* A second request while leaving keeps the clock. */
  transition_leave(1100);
  assert(scrim_at(1075) == middle);

  /* The top screen has the scrim alone; the touch screen adds eight dots. */
  size_t top = transition_list(false, 1075, 400, 240, &words);
  assert(top == 4);
  size_t touch = transition_list(true, 1075, 320, 240, &words);
  assert(touch == 4 + 8 * DOT_WORDS);

  /* Loading: opaque, the indicator at full strength and turning clockwise. */
  transition_load(1150);
  assert(transition_phase() == TRANSITION_LOADING);
  assert(transition_covered(1150));
  assert(scrim_at(1500) == 255);
  touch = transition_list(true, 1000 + 1800, 320, 240, &words);
  assert(touch == 4 + 8 * DOT_WORDS);
  assert(brightest(words, touch) == 0);
  touch = transition_list(true, 1000 + 1800 + 225, 320, 240, &words);
  assert(brightest(words, touch) == 2);

  /* Every dot is the same octagon around a pixel centre, inside the screen. */
  for (int dot = 0; dot < 8; dot += 1) {
    const uint32_t *at = words + 4 + (size_t)dot * DOT_WORDS;
    int32_t cx = word_x(at[1]);
    int32_t cy = word_y(at[1]);
    assert(cx % (int32_t)TRANSITION_SUBPIXELS == (int32_t)TRANSITION_SUBPIXELS / 2);
    assert(cy % (int32_t)TRANSITION_SUBPIXELS == (int32_t)TRANSITION_SUBPIXELS / 2);
    assert(cx > 0 && cx < 320 * (int32_t)TRANSITION_SUBPIXELS);
    assert(cy > 0 && cy < 240 * (int32_t)TRANSITION_SUBPIXELS);
    for (int side = 0; side < 8; side += 1) {
      const uint32_t *tri = at + side * 7;
      const uint32_t *first = words + 4 + side * 7;
      assert(tri[0] == DRAW_TRI);
      assert(tri[1] == at[1]);
      assert(word_x(tri[2]) - cx == word_x(first[2]) - word_x(first[1]));
      assert(word_y(tri[2]) - cy == word_y(first[2]) - word_y(first[1]));
      assert(word_x(tri[3]) - cx == word_x(first[3]) - word_x(first[1]));
      assert(word_y(tri[3]) - cy == word_y(first[3]) - word_y(first[1]));
    }
  }

  /* Arriving: each presented frame counts at most TRANSITION_STEP_MAX_MS, so
   * a 500 ms first frame moves the fade by one step. */
  transition_arrive(3000);
  assert(transition_phase() == TRANSITION_ARRIVING);
  assert(!transition_covered(3000));
  uint32_t before = scrim_at(3000);
  assert(before == 255);
  transition_advance(3500);
  uint32_t after_slow = scrim_at(3500);
  /* 33 of 250 ms: (1 - 0.132)^2 of 255. */
  assert(after_slow >= 191 && after_slow <= 193);
  uint64_t now = 3500;
  uint32_t previous = after_slow;
  int frames = 0;
  while (transition_phase() == TRANSITION_ARRIVING) {
    now += 16;
    transition_advance(now);
    uint32_t level = scrim_at(now);
    assert(level <= previous);
    previous = level;
    frames += 1;
    assert(frames < 100);
  }
  assert(frames == (int)((TRANSITION_ARRIVE_MS - TRANSITION_STEP_MAX_MS + 15) / 16));
  assert(transition_list(true, now, 320, 240, &words) == 0);

  /* Leaving mid-arrival: the scrim rises from where it stood. */
  transition_leave(5000);
  transition_load(5150);
  transition_arrive(5200);
  for (uint64_t at = 5216; at <= 5296; at += 16) transition_advance(at);
  uint32_t standing = scrim_at(5296);
  assert(standing > 0 && standing < 255);
  transition_leave(5300);
  assert(transition_phase() == TRANSITION_LEAVING);
  uint32_t risen = scrim_at(5300);
  assert(abs((int)risen - (int)standing) <= 4);
  assert(transition_covered(5300 + TRANSITION_LEAVE_MS));
  return 0;
}
