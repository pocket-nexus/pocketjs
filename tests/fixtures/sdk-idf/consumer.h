#pragma once
#include <pocket/runtime.h>
#include <pocket/pocket_guest_quickjs.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define FIXTURE_WIDTH 32U
#define FIXTURE_HEIGHT 24U
#define FIXTURE_STRIDE (FIXTURE_WIDTH * 2U)
#define FIXTURE_STRIP_ROWS 4U

typedef struct {
  void *device;
  uint64_t next;
  unsigned fills, fallbacks, renders, waits, retires;
  unsigned fail_wait;
} fixture_renderer;

void fixture_renderer_init(fixture_renderer *renderer);
void fixture_renderer_destroy(fixture_renderer *renderer);
const pocket_renderer_v1 *fixture_renderer_table(void);
void fixture_run(void);
