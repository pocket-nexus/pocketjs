/* The console's side of the pack delivery (hosts/3ds/src/packs_delivery.c) as
 * a program for a computer: one control line in, the answer's line out.
 * tests/pocket3d-delivery.test.ts builds and runs it.
 *   console <directory> <line> */
#include "packs_delivery.h"
#include <stdio.h>

int main(int argc, char **argv) {
  char reply[512];
  bool changed = false;
  if (argc != 3 || !p3d_delivery(argv[2], argv[1], reply, sizeof reply, &changed))
    return 2;
  printf("%s\n%s\n", reply, changed ? "changed" : "same");
  return 0;
}
