#include "../../../hosts/3ds/src/offload.h"
#include <3ds.h>
#include <assert.h>
#include <stdio.h>
#include <string.h>
bool soc_ensure(char *error, size_t size) { (void)error; (void)size; return true; }
int main(void) {
  assert(offload_start());
  uint64_t deadline = osGetTime() + 10000; unsigned phase = 0; int first_session = 0;
  while (osGetTime() < deadline && phase < 5) {
    offload_frame(); int session = offload_session();
    if (phase == 0 && session > 0) {
      first_session = session;
      const char *request = "{\"v\":1,\"id\":1,\"method\":\"test.image\",\"payload\":\"{}\",\"response\":\"image\"}";
      if (offload_submit(request, strlen(request))) phase = 1;
    }
    if (phase == 3 && session > first_session) {
      const char *request = "{\"v\":1,\"id\":1,\"method\":\"test.text\",\"payload\":\"{}\"}";
      if (offload_submit(request, strlen(request))) phase = 4;
    }
    char record[4097]; size_t length = offload_take(record); record[length] = 0;
    if (length && phase == 1) {
      unsigned id, token, w, h;
      assert(sscanf(record, "{\"id\":%u,\"image\":{\"token\":%u,\"width\":%u,\"height\":%u}}", &id, &token, &w, &h) == 4);
      assert(id == 1 && w == 256 && h == 256);
      const uint8_t *pixels = offload_image(token, &w, &h); assert(pixels);
      for (unsigned n = 0; n < 256 * 256 * 2; n++) assert(pixels[n] == (n & 255));
      assert(pixels[-3] == 2); /* native IMG envelope uses linear filtering */
      offload_release_image(token); assert(!offload_image(token, &w, &h));
      offload_reset(); assert(offload_session() == 0); phase = 3;
    } else if (length && phase == 4) { assert(strstr(record, "network-ok")); phase = 5; }
    svcSleepThread(1000000);
  }
  offload_stop(); assert(phase == 5);
  puts("native socket image transfer and realm-reset reconnect passed");
}
