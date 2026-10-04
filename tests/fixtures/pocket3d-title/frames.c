/* Prints the FNV-1a 64 hash of the Nintendo 3DS frame the C header draws at
 * each tick named on the command line, one "tick hash" pair per line. */
#include <stdio.h>
#include <stdlib.h>

#include "pocket3d_title.h"

int main(int argc, char **argv) {
  const size_t length = 400 * 240 * 3;
  unsigned char *pixels = malloc(length);
  int i;
  if (!pixels) return 1;
  for (i = 1; i < argc; i++) {
    const unsigned tick = (unsigned)strtoul(argv[i], NULL, 10);
    unsigned long long hash = 0xcbf29ce484222325ull;
    size_t k;
    if (!pocket3d_title_draw(pixels, length, 400, 240, 240, tick, 1)) return 1;
    for (k = 0; k < length; k++) hash = (hash ^ pixels[k]) * 0x100000001b3ull;
    printf("%u 0x%016llx\n", tick, hash);
  }
  /* a buffer one byte short is refused */
  if (pocket3d_title_draw(pixels, length - 1, 400, 240, 240, 60, 1)) return 1;
  /* the second screen is the ground alone: plum, stored blue green red */
  if (!pocket3d_title_draw(pixels, 320 * 240 * 3, 320, 240, 240, 60, 0)) return 1;
  for (i = 0; i < 320 * 240; i++) {
    if (pixels[i * 3] != 0x26 || pixels[i * 3 + 1] != 0x12 || pixels[i * 3 + 2] != 0x17) return 1;
  }
  free(pixels);
  return 0;
}
