#include "pocketjs/guest_quickjs.h"
#include "pocketjs/render_rgb565.h"
#include "pocketjs/ui_qjs.h"
#include "pocket_runtime.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

extern long pocketjs_test_fail_after;
extern long pocketjs_test_heap_fail_after;

static void test_runtime_allocator_hooks(void) {
  assert(pocket_host_alloc(0, 8) == NULL);
  assert(pocket_host_alloc(16, 3) == NULL);
  unsigned char *original = pocket_host_alloc(17, 64);
  assert(original != NULL && (uintptr_t)original % 64 == 0);
  for (size_t i = 0; i < 17; ++i)
    original[i] = (unsigned char)i;
  pocketjs_test_heap_fail_after = 0;
  assert(pocket_host_realloc(original, 17, 64, 33) == NULL);
  pocketjs_test_heap_fail_after = -1;
  for (size_t i = 0; i < 17; ++i)
    assert(original[i] == i);
  unsigned char *grown = pocket_host_realloc(original, 17, 64, 33);
  assert(grown != NULL && (uintptr_t)grown % 64 == 0);
  for (size_t i = 0; i < 17; ++i)
    assert(grown[i] == i);
  unsigned char *shrunk = pocket_host_realloc(grown, 33, 64, 7);
  assert(shrunk != NULL && (uintptr_t)shrunk % 64 == 0);
  for (size_t i = 0; i < 7; ++i)
    assert(shrunk[i] == i);
  pocket_host_free(shrunk, 7, 64);
}

static void eval(JSContext *ctx, const char *source) {
  JSValue result =
      JS_Eval(ctx, source, strlen(source), "test", JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(result)) {
    JSValue exception = JS_GetException(ctx);
    const char *text = JS_ToCString(ctx, exception);
    fprintf(stderr, "test JS failed: %s\n", text ? text : "<exception>");
    abort();
  }
  JS_FreeValue(ctx, result);
}

static pocketjs_guest_t *guest_new(void) {
  pocketjs_guest_config_t config;
  pocketjs_guest_config_defaults(&config);
  pocketjs_guest_t *guest = NULL;
  assert(pocketjs_guest_create(&config, &guest) == ESP_OK);
  return guest;
}

static void test_promises(void) {
  pocketjs_guest_t *guest = guest_new();
  const char *source =
      "let a, n=0; globalThis.frame=()=>{if(n++===0) a=Promise.reject('A');"
      "else if(n===2){Promise.reject('B'); a.catch(()=>{});}}";
  assert(pocketjs_guest_eval(guest, source, strlen(source), "promises") ==
         ESP_OK);
  pocketjs_guest_frame_t frame = {.struct_size = sizeof(frame)};
  assert(pocketjs_guest_frame(guest, &frame) == ESP_FAIL);
  assert(pocketjs_guest_frame(guest, &frame) == ESP_FAIL);
  assert(pocketjs_guest_frame(guest, &frame) == ESP_OK);
  pocketjs_guest_destroy(guest);
}

static pocketjs_ui_core_t *core_new(void) {
  pocketjs_ui_core_config_t config;
  pocketjs_ui_core_config_defaults(&config);
  pocketjs_ui_core_t *core = NULL;
  config.raster_density = 256;
  assert(pocketjs_ui_core_create(&config, &core) == ESP_ERR_INVALID_ARG);
  assert(core == NULL);
  config.raster_density = 1;
  assert(pocketjs_ui_core_create(&config, &core) == ESP_OK);
  return core;
}

static void test_rejection_reporting_reentrancy(void) {
  pocketjs_guest_t *guest = guest_new();
  const char *source = "let p, n=0; globalThis.frame=()=>{if(n++===0)"
                       "p=Promise.reject({toString(){p.catch(()=>{});return "
                       "'handled while reporting'}})};";
  assert(pocketjs_guest_eval(guest, source, strlen(source), "reentrant") ==
         ESP_OK);
  pocketjs_guest_frame_t frame = {.struct_size = sizeof(frame)};
  assert(pocketjs_guest_frame(guest, &frame) == ESP_FAIL);
  assert(pocketjs_guest_frame(guest, &frame) == ESP_OK);
  pocketjs_guest_destroy(guest);
}

static void test_binding(const unsigned char *pak, size_t pak_size) {
  pocketjs_guest_t *guest = guest_new();
  pocketjs_ui_core_t *core = core_new();
  pocketjs_ui_qjs_config_t config = {
      .struct_size = sizeof(config), .target_id = "idf-smoke", .host_abi = 1};
  pocketjs_ui_qjs_t *binding = NULL, *second = NULL;
  assert(pocketjs_ui_qjs_create(guest, core, &config, &binding) == ESP_OK);
  assert(pocketjs_ui_qjs_create(guest, core, &config, &second) == ESP_OK);
  assert(pocketjs_ui_qjs_feed_pak(binding, pak, pak_size) == ESP_OK);
  assert(pocketjs_ui_qjs_mount(binding) == ESP_OK);
  assert(pocketjs_ui_qjs_mount(second) == ESP_ERR_INVALID_STATE);
  JSContext *ctx = pocketjs_guest_quickjs_context(guest);
  int foreign_module = 123;
  JS_SetContextOpaque(ctx, &foreign_module);
  eval(ctx,
       "globalThis.node=ui.createNode(0); if(typeof node!=='number') throw "
       "Error('closure');"
       "if(!__pak.immutable) throw Error('pak mutable');"
       "const original=new Uint8Array(__pak)[0]; new Uint8Array(__pak)[0]=0;"
       "const copy=new Uint8Array(__pak).slice(); copy[0]=0;"
       "if(new Uint8Array(__pak)[0]!==original) throw Error('pak changed');"
       "let threw=0; for(const f of [()=>ui.createNode(Symbol()),"
       "()=>ui.setProp(node,0,{valueOf(){throw Error('convert')}}),"
       "()=>ui.loadStyles(Symbol()),()=>ui.loadFontAtlas(Symbol()),"
       "()=>ui.uploadImgEntry(),()=>ui.wrapText('test',Symbol(),10)])"
       "{try{f()}catch(e){threw++}} if(threw!==6) throw Error('conversion "
       "exceptions: '+threw);");
  assert(JS_GetContextOpaque(ctx) == &foreign_module);
  pocketjs_ui_frame_view_t a = {.struct_size = sizeof(a)},
                           b = {.struct_size = sizeof(b)};
  assert(pocketjs_ui_core_draw(core, &a) == ESP_OK);
  assert(pocketjs_ui_core_draw(core, &b) == ESP_OK);
  assert(a.epoch != b.epoch);
  pocketjs_rgb565_renderer_config_t rc;
  pocketjs_rgb565_renderer_config_defaults(&rc);
  pocketjs_rgb565_renderer_t *renderer = NULL;
  pocketjs_rgb565_target_t *target = NULL;
  assert(pocketjs_rgb565_renderer_create(&rc, &renderer) == ESP_OK);
  assert(pocketjs_rgb565_target_create(&target) == ESP_OK);
  pocketjs_rgb565_damage_plan_t damage = {.struct_size = sizeof(damage)};
  assert(pocketjs_rgb565_prepare(renderer, target, &a, &damage) ==
         ESP_ERR_INVALID_STATE);
  assert(pocketjs_rgb565_prepare(renderer, target, &b, &damage) == ESP_OK);
  assert(pocketjs_ui_core_draw(core, &a) == ESP_OK);
  assert(pocketjs_rgb565_commit(renderer, target, &b) == ESP_ERR_INVALID_STATE);
  pocketjs_rgb565_target_destroy(target);
  pocketjs_rgb565_renderer_destroy(renderer);
  pocketjs_guest_destroy(guest);
  pocketjs_ui_qjs_destroy(second);
  pocketjs_ui_qjs_destroy(binding);
  pocketjs_ui_core_destroy(core);
}

static void test_atomic_assets(const unsigned char *good, size_t good_size,
                               const unsigned char *bad, size_t bad_size) {
  for (int fault = -1; fault < 9; ++fault) {
    pocketjs_guest_t *guest = guest_new();
    pocketjs_ui_core_t *core = core_new();
    const unsigned char pixel[] = {1, 2, 3, 255};
    int32_t existing = pocketjs_ui_core_upload_texture(core, pixel, 4, 1, 1, 3);
    assert(existing == 0);
    pocketjs_ui_qjs_config_t config = {
        .struct_size = sizeof(config), .target_id = "idf-smoke", .host_abi = 1};
    pocketjs_ui_qjs_t *binding = NULL;
    assert(pocketjs_ui_qjs_create(guest, core, &config, &binding) == ESP_OK);
    pocketjs_ui_frame_view_t before = {.struct_size = sizeof(before)},
                             after = {.struct_size = sizeof(after)};
    assert(pocketjs_ui_core_draw(core, &before) == ESP_OK);
    if (fault >= 0)
      pocketjs_test_fail_after = fault;
    esp_err_t result = pocketjs_ui_qjs_feed_pak(
        binding, fault < 0 ? bad : good, fault < 0 ? bad_size : good_size);
    pocketjs_test_fail_after = -1;
    if (fault < 0)
      assert(result != ESP_OK);
    if (result != ESP_OK) {
      assert(pocketjs_ui_core_draw(core, &after) == ESP_OK);
      assert(before.raster_revision == after.raster_revision);
      pocketjs_ui_texture_view_t view = {.struct_size = sizeof(view)};
      assert(pocketjs_ui_core_texture(core, existing, &view) == ESP_OK);
      assert(!memcmp(view.pixels, pixel, 4));
      assert(pocketjs_ui_core_texture(core, 1, &view) != ESP_OK);
      assert(pocketjs_ui_qjs_feed_pak(binding, good, good_size) == ESP_OK);
    }
    assert(pocketjs_ui_qjs_mount(binding) == ESP_OK);
    eval(pocketjs_guest_quickjs_context(guest),
         "if(ui.__textures['transaction-test']!==1) throw Error('leaked "
         "handle');");
    pocketjs_guest_destroy(guest);
    pocketjs_ui_qjs_destroy(binding);
    pocketjs_ui_core_destroy(core);
  }
}

static unsigned char *read_file(const char *path, size_t *size) {
  FILE *file = fopen(path, "rb");
  assert(file);
  assert(fseek(file, 0, SEEK_END) == 0);
  long end = ftell(file);
  assert(end > 0);
  *size = (size_t)end;
  rewind(file);
  unsigned char *data = malloc(*size);
  assert(data && fread(data, 1, *size, file) == *size);
  fclose(file);
  return data;
}

int main(int argc, char **argv) {
  assert(argc == 3);
  test_runtime_allocator_hooks();
  size_t good_size, bad_size;
  unsigned char *good = read_file(argv[1], &good_size),
                *bad = read_file(argv[2], &bad_size);
  test_promises();
  test_rejection_reporting_reentrancy();
  test_atomic_assets(good, good_size, bad, bad_size);
  test_binding(good, good_size);
  free(good);
  free(bad);
  puts("IDF host runtime regressions passed");
  return 0;
}
