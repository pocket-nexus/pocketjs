#include <stdio.h>
#include <string.h>

#ifdef GEKKO
#include <gccore.h>
#endif

#include "guest.h"
#include "pocket_core.h"
#include "qjs.h"

static int expect_rect(uint32_t width) {
  const uint32_t expected[] = {
    5, 0, ((uint32_t)272 << 16) | 480,
    1, 0, ((uint32_t)32 << 16) | width, 0xff563412,
    6,
  };
  size_t length = ui_draw();
  const uint32_t *actual = ui_draw_list_ptr();
  if (length != sizeof expected / sizeof expected[0] || ui_draw_list_len() != length || actual == NULL) goto mismatch;
  if (memcmp(actual, expected, sizeof expected) == 0) return 1;

mismatch:
  fprintf(stderr, "W14 DrawList mismatch (expected box width %u):", width);
  if (actual != NULL) {
    for (size_t i = 0; i < length; ++i) fprintf(stderr, " %08x", (unsigned)actual[i]);
  }
  fputc('\n', stderr);
  return 0;
}

int main(void) {
#ifdef GEKKO
  SYS_STDIO_Report(true);
#endif
  puts("W14 START");
  fflush(stdout);
  ui_init(1);
  ui_set_viewport(480.0f, 272.0f);
  if (ui_feed_pak(w14_fixture_pak, w14_fixture_pak_len) != 2 ||
      ui_pak_texture_count() != 1 || ui_pak_sprite_count() != 1) {
    fprintf(stderr, "W14 pak setup failed\n");
    return 1;
  }
  if (!qjs_boot((const char *)w14_guest_js, w14_guest_js_len,
      w14_fixture_pak, w14_fixture_pak_len)) {
    fprintf(stderr, "W14 guest boot failed: %s\n", qjs_last_error());
    return 2;
  }

  ui_tick();
  if (!expect_rect(24)) return 3;
  if (!qjs_frame(0, 0x8080)) {
    fprintf(stderr, "W14 guest frame failed: %s\n", qjs_last_error());
    return 4;
  }
  ui_tick();
  if (!expect_rect(40)) return 5;

  printf("W14 PASS host=wii-dev abi=7 viewport=480x272 initial=24 updated=40 image=probe sprite=pulse ops=21 batch=absent cursor=absent auxiliary=absent\n");
  qjs_shutdown();
  ui_shutdown();
  return 0;
}
