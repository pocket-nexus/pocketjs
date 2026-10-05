#include <stdio.h>
#include <string.h>

#ifdef GEKKO
#include <gccore.h>
#endif

#include "pocket_wii.h"
#include "pocket_core.h"
#include "w15a-packages.h"

static int expect_error(
  const uint8_t *package_bytes,
  size_t package_length,
  const char *expected
) {
  if (pocket_wii_boot(package_bytes, package_length) == 0) {
    fprintf(stderr, "W15B expected boot failure containing: %s\n", expected);
    return 0;
  }
  const char *error = pocket_wii_last_error();
  if (error == NULL || strstr(error, expected) == NULL) {
    fprintf(stderr, "W15B wrong boot error, expected '%s', got '%s'\n",
      expected, error == NULL ? "(null)" : error);
    return 0;
  }
  return 1;
}

int main(void) {
#ifdef GEKKO
  SYS_STDIO_Report(true);
#endif
  puts("W15B START");
  fflush(stdout);

  pocket_wii_shutdown();
  pocket_wii_shutdown();

  if (!expect_error(w15a_wrong_target_pocket, w15a_wrong_target_pocket_len,
      "no wii-dev guest variant")) return 1;
  if (!expect_error(w15a_wrong_abi_pocket, w15a_wrong_abi_pocket_len,
      "expected ABI 7")) return 2;
  if (!expect_error(w15a_bad_js_pocket, w15a_bad_js_pocket_len,
      "W15A intentional boot failure")) return 3;
  if (strcmp(pocket_wii_last_error(), "Error: W15A intentional boot failure") != 0) {
    fprintf(stderr, "W15B lost the QuickJS boot exception: %s\n", pocket_wii_last_error());
    return 3;
  }

  pocket_wii_shutdown();
  pocket_wii_shutdown();

  if (pocket_wii_boot(w15a_valid_pocket, w15a_valid_pocket_len) != 0) {
    fprintf(stderr, "W15B valid package failed after failed boot: %s\n", pocket_wii_last_error());
    return 4;
  }
  if (pocket_wii_last_error()[0] != '\0') {
    fprintf(stderr, "W15B successful boot retained error: %s\n", pocket_wii_last_error());
    return 5;
  }
  if (!expect_error(w15a_valid_pocket, w15a_valid_pocket_len,
      "guest already booted")) return 6;

  pocket_wii_shutdown();
  pocket_wii_shutdown();

  if (pocket_wii_boot(w15a_valid_pocket, w15a_valid_pocket_len) != 0) {
    fprintf(stderr, "W15B second boot failed after shutdown: %s\n", pocket_wii_last_error());
    return 7;
  }
  if (pocket_wii_last_error()[0] != '\0') {
    fprintf(stderr, "W15B second boot retained error: %s\n", pocket_wii_last_error());
    return 8;
  }
  pocket_wii_shutdown();

  puts("W15B PASS failed boot cleanup, repeated shutdown, and reboot after shutdown");

  if (pocket_wii_boot(w16_frame_pocket, w16_frame_pocket_len) != 0) {
    fprintf(stderr, "W16 guest boot failed: %s\n", pocket_wii_last_error());
    return 9;
  }
  if (pocket_wii_tick(0x4000, 0x1234) != 0) {
    fprintf(stderr, "W16 tick failed: %s\n", pocket_wii_last_error());
    return 10;
  }
  if (pocket_wii_last_error()[0] != '\0') {
    fprintf(stderr, "W16 successful tick retained error: %s\n", pocket_wii_last_error());
    return 11;
  }
  {
    const uint32_t expected[] = {
      1, 0, ((uint32_t)32 << 16) | 40, 0xff563412,
    };
    size_t length = ui_draw();
    const uint32_t *actual = ui_draw_list_ptr();
    if (length != sizeof expected / sizeof expected[0] ||
        ui_draw_list_len() != length || actual == NULL ||
        memcmp(actual, expected, sizeof expected) != 0) {
      fprintf(stderr, "W16 frame did not update native DrawList state\n");
      if (actual != NULL) {
        for (size_t i = 0; i < length; ++i) fprintf(stderr, " %08x", (unsigned)actual[i]);
        fputc('\n', stderr);
      }
      return 12;
    }
  }
  if (pocket_wii_tick(0x8000, 0x4321) == 0) {
    fprintf(stderr, "W16 expected guest frame failure\n");
    return 13;
  }
  if (strstr(pocket_wii_last_error(), "W16 intentional frame failure") == NULL) {
    fprintf(stderr, "W16 wrong frame error: %s\n", pocket_wii_last_error());
    return 14;
  }
  pocket_wii_shutdown();
  puts("W16 PASS fixed-step input, native DrawList mutation, retained guest exception");
  return 0;
}
