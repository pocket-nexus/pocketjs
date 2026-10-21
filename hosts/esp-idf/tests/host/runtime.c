#include "pocket/guest_idf.h"
#include "pocket/package_source.h"
#include "pocketjs_package_host.h"
#include "sample_io.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
extern long pocketjs_test_heap_fail_after;
static void allocator(void) {
  assert(!pocket_host_alloc(0, 8));
  assert(!pocket_host_alloc(16, 3));
  uint8_t *p = pocket_host_alloc(17, 64);
  assert(p && (uintptr_t)p % 64 == 0);
  for (size_t i = 0; i < 17; i++)
    p[i] = (uint8_t)i;
  pocketjs_test_heap_fail_after = 0;
  assert(!pocket_host_realloc(p, 17, 64, 33));
  pocketjs_test_heap_fail_after = -1;
  uint8_t *q = pocket_host_realloc(p, 17, 64, 33);
  assert(q && (uintptr_t)q % 64 == 0);
  for (size_t i = 0; i < 17; i++)
    assert(q[i] == i);
  pocket_host_free(q, 33, 64);
}
typedef struct {
  pocket_guest_idf *guest;
  const char *extra;
  unsigned evaluations;
} test_guest;
static int32_t initialize(void *p, pocket_runtime *r,
                          const pocket_guest_environment *e) {
  return pocket_guest_idf_vtable()->initialize(((test_guest *)p)->guest, r, e);
}
static int32_t evaluate(void *p, pocket_runtime *r, const uint8_t *code,
                        size_t size) {
  test_guest *g = p;
  g->evaluations++;
  int32_t status = pocket_guest_idf_vtable()->evaluate(g->guest, r, code, size);
  if (status == 0 && g->extra)
    status = pocket_guest_idf_vtable()->evaluate(
        g->guest, r, (const uint8_t *)g->extra, strlen(g->extra));
  return status;
}
static int32_t frame(void *p, const pocket_guest_frame *f) {
  return pocket_guest_idf_vtable()->frame(((test_guest *)p)->guest, f);
}
static int32_t collect(void *p) {
  return pocket_guest_idf_vtable()->collect(((test_guest *)p)->guest);
}
static void shutdown(void *p) {
  pocket_guest_idf_vtable()->shutdown(((test_guest *)p)->guest);
}
static const pocket_guest_v1 GUEST = {sizeof(GUEST), evaluate, frame,
                                      collect,       shutdown, initialize};
static void scenario(const char *extra, bool invalid, int32_t first,
                     int32_t second) {
  const pocketjs_package_host_contract_t *host =
      &pocketjs_package_host_contract;
  sample_display display;
  assert(sample_display_init(&display, host->physical_width,
                             host->physical_height, 16, 2) == 0);
  pocket_runtime_config config = {
      .struct_size = sizeof(config),
      .host_abi = host->host_abi,
      .tick_hz = host->tick_hz,
      .heap_limit = 8 * 1024 * 1024,
      .frame_buffer_budget = display.capacity * display.count,
      .profile_json = pocketjs_package_host_profile_json,
      .profile_json_length = pocketjs_package_host_profile_json_length};
  memcpy(config.profile_hash, pocketjs_package_host_runtime_profile_hash, 32);
  pocket_runtime *runtime = pocket_runtime_create(&config);
  assert(runtime);
  const pocket_guest_idf_config gc = {8 * 1024 * 1024, 512 * 1024, true};
  test_guest guest = {pocket_guest_idf_create(&gc), extra, 0};
  assert(guest.guest);
  pocket_memory_package source = {pocketjs_package_host.data,
                                  invalid ? 10 : pocketjs_package_host.size};
  assert(pocket_runtime_set_guest(runtime, &GUEST, &guest) == 0);
  assert(pocket_runtime_set_package_source(
             runtime, pocket_memory_package_vtable(), &source) == 0);
  assert(pocket_runtime_add_input_source(runtime, sample_input_vtable(),
                                         NULL) == 0);
  assert(pocket_runtime_add_display(runtime, sample_display_vtable(), &display,
                                    POCKET_RENDERER_SOFTWARE) == 0);
  int32_t boot = pocket_runtime_boot(runtime);
  if (invalid) {
    assert(boot != 0);
    assert(guest.evaluations == 0);
  } else {
    if (boot)
      fprintf(stderr, "boot=%d %s\n", boot,
              pocket_guest_idf_error(guest.guest));
    assert(boot == 0);
    assert(guest.evaluations == 1);
    assert(pocket_runtime_tick(runtime) == first);
    assert(pocket_runtime_tick(runtime) == second);
    assert(display.flushes == display.waits);
    if (first == 0)
      assert(display.flushes > 0 && display.hash);
  }
  pocket_runtime_destroy(runtime);
  pocket_guest_idf_destroy(guest.guest);
  sample_display_destroy(&display);
}
int main(void) {
  allocator();
  scenario("if(!__pak.immutable)throw Error('mutable pak');const byte=new "
           "Uint8Array(__pak)[0];new Uint8Array(__pak)[0]^=255;const copy=new "
           "Uint8Array(__pak).slice();copy[0]^=255;if(new "
           "Uint8Array(__pak)[0]!==byte)throw Error('changed pak');const "
           "old=frame;let count=0;frame=(...args)=>{count++;old(...args)}",
           false, 0, 0);
  scenario(NULL, true, 0, 0);
  scenario("let "
           "p,n=0;frame=()=>{if(n++===0)p=Promise.reject({toString(){p.catch(()"
           "=>{});return 'reentrant rejection'}})}",
           false, POCKET_STATUS_FAILED, POCKET_STATUS_INVALID);
  scenario("let n=0;frame=()=>{if(n++===0)throw Error('frame failure')}", false,
           POCKET_STATUS_FAILED, POCKET_STATUS_INVALID);
  puts("IDF canonical runtime, admission, immutable package and rejection "
       "regressions passed");
  return 0;
}
