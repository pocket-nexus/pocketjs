#include <stdint.h>
#include <stdio.h>

#ifdef GEKKO
#include <gccore.h>
#endif

#include "fixtures.h"

typedef struct {
  const uint8_t *javascript;
  size_t javascript_length;
  const uint8_t *pak;
  size_t pak_length;
  const uint8_t *plan;
  size_t plan_length;
  uint64_t package_hash;
  uint64_t variant_hash;
} PocketGuestPackage;

extern int32_t pocket_package_open(
  const uint8_t *bytes,
  size_t length,
  const uint8_t *target,
  size_t target_length,
  uint32_t host_abi,
  PocketGuestPackage *out
);

static int admit(const uint8_t *bytes, size_t length, PocketGuestPackage *out) {
  static const uint8_t target[] = "wii-dev";
  return pocket_package_open(bytes, length, target, sizeof target - 1, 7, out);
}

int main(void) {
#ifdef GEKKO
  SYS_STDIO_Report(true);
#endif
  PocketGuestPackage guest = {0};
  int result = admit(valid_pocket, valid_pocket_len, &guest);
  if (result != 0 || guest.javascript == NULL || guest.javascript_length < 2
      || guest.javascript[guest.javascript_length - 1] != 0 || guest.pak_length == 0
      || guest.plan_length == 0 || guest.package_hash == 0 || guest.variant_hash == 0) {
    printf("W13A FAIL valid result=%d js=%lu pak=%lu plan=%lu\n", result,
      (unsigned long)guest.javascript_length, (unsigned long)guest.pak_length,
      (unsigned long)guest.plan_length);
    return 1;
  }
  if (admit(wrong_target_pocket, wrong_target_pocket_len, &guest) != 6) {
    puts("W13A FAIL wrong target was admitted");
    return 2;
  }
  if (admit(wrong_abi_pocket, wrong_abi_pocket_len, &guest) != 7) {
    puts("W13A FAIL wrong ABI was admitted");
    return 3;
  }
  puts("W13A PASS valid package admitted; wrong target=6 wrong ABI=7");
  return 0;
}
