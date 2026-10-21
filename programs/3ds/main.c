/* Minimal file PackageSource + Runtime + generated QuickJS + PICA program. */
#include <3ds.h>
#include <citro3d.h>
#include <pocket_guest_quickjs.h>
#include <pocket_pica_driver.h>
#include "pocket_profile.h"
#include "package_source.h"
#include "input.h"
#include "input_source.h"
#include "vshader_shbin.h"
#include <stdio.h>
#include <string.h>

unsigned int __stacksize__ = 1024 * 1024;
static const size_t heap_limit = 64u * 1024u * 1024u;

int main(int argc, char **argv) {
  int result = 1;
  char failure[256] = "3DS graphics initialization failed";
  bool graphics = false, romfs = false, hid = false;
  pocket_3ds_file_source file = {0};
  pocket_3ds_input_source input = {0};
  pocket_runtime *runtime = NULL;
  pocket_guest_quickjs *guest = NULL;
  JSRuntime *js_runtime = NULL;
  JSContext *js_context = NULL;
  pocket_pica_renderer *renderer = NULL;
  C3D_RenderTarget *top = NULL, *bottom = NULL;
  const char *path = argc > 1 ? argv[1] : "romfs:/app.pocket";

  gfxInitDefault();
  osSetSpeedupEnable(true);
  if (!C3D_Init(C3D_DEFAULT_CMDBUF_SIZE)) goto done;
  graphics = true;
  snprintf(failure, sizeof failure, "Cannot open %s. Pass a .pocket path or pack this runtime with an application.", path);
  if (!strncmp(path, "romfs:", 6)) {
    if (R_FAILED(romfsInit())) goto done;
    romfs = true;
  }
  if (pocket_3ds_file_source_open(&file, path)) goto done;
  snprintf(failure, sizeof failure, "3DS Runtime initialization failed");
  top = C3D_RenderTargetCreate(240, 400, GPU_RB_RGBA8, GPU_RB_DEPTH24_STENCIL8);
  bottom = C3D_RenderTargetCreate(240, 320, GPU_RB_RGBA8, GPU_RB_DEPTH24_STENCIL8);
  if (!top || !bottom) goto done;
  const pocket_pica_config gpu = {.shader=vshader_shbin, .shader_size=vshader_shbin_size};
  renderer = pocket_pica_renderer_create(&gpu);
  if (!renderer) goto done;
  pocket_pica_display *primary = pocket_pica_display_create(renderer,
    POCKET_DISPLAY_ROLE_PRIMARY, top, NULL, 400, 240);
  pocket_pica_display *auxiliary = pocket_pica_display_create(renderer,
    POCKET_DISPLAY_ROLE_AUXILIARY, bottom, NULL, 320, 240);
  if (!primary || !auxiliary) goto done;

  pocket_runtime_config config = {.struct_size=sizeof config,
    .host_abi=pocket_profile.host_abi, .tick_hz=pocket_profile.tick_hz,
    .heap_limit=heap_limit, .frame_buffer_budget=400u*240u*4u+320u*240u*4u,
    .profile_json=pocket_profile.profile_json,
    .profile_json_length=pocket_profile.profile_json_length};
  memcpy(config.profile_hash, pocket_profile.profile_hash, sizeof config.profile_hash);
  runtime = pocket_runtime_create(&config);
  if (!runtime) goto done;
  js_runtime = JS_NewRuntime();
  if (!js_runtime) goto done;
  JS_SetMaxStackSize(js_runtime, 384u * 1024u);
  JS_SetMemoryLimit(js_runtime, heap_limit);
  js_context = JS_NewContext(js_runtime);
  if (!js_context) goto done;
  guest = pocket_guest_quickjs_attach(js_context, POCKET_QJS_CANONICAL);
  if (!guest) goto done;
  pocket_3ds_input_source_set(&input, 0, 0x8080, NULL, 0, 0x8080);
  pocket_renderer_id renderer_id = pocket_runtime_add_renderer(runtime,
    pocket_pica_renderer_vtable(), renderer);
  if (renderer_id == POCKET_RENDERER_INVALID ||
      pocket_runtime_add_display(runtime, pocket_pica_display_vtable(), primary, renderer_id) ||
      pocket_runtime_add_display(runtime, pocket_pica_display_vtable(), auxiliary, renderer_id) ||
      pocket_runtime_set_package_source(runtime, pocket_3ds_file_source_vtable(), &file) ||
      pocket_runtime_set_guest(runtime, pocket_guest_quickjs_vtable(), guest) ||
      pocket_runtime_add_input_source(runtime, pocket_3ds_input_source_vtable(), &input)) goto done;
  pocket_3ds_hid_init();
  hid = true;
  snprintf(failure, sizeof failure, "Package admission or guest boot failed");
  if (pocket_runtime_boot(runtime)) goto done;
  while (aptMainLoop()) {
    hidScanInput();
    /* Exit belongs to this program; the input mechanism does not reserve keys. */
    const uint32_t exit_keys = KEY_L | KEY_R | KEY_START;
    if ((hidKeysHeld() & exit_keys) == exit_keys) break;
    uint32_t touch;
    uint32_t buttons = pocket_3ds_hid_buttons();
    size_t count = pocket_3ds_hid_touch(&touch);
    pocket_3ds_input_source_set(&input, buttons, pocket_3ds_hid_analog(),
      &touch, count, pocket_3ds_hid_right_analog());
    if (pocket_runtime_tick(runtime)) { snprintf(failure, sizeof failure, "Runtime frame failed"); goto done; }
    gspWaitForVBlank();
  }
  result = 0;
done:
  if (result && guest && pocket_guest_quickjs_error(guest)[0])
    snprintf(failure, sizeof failure, "%s", pocket_guest_quickjs_error(guest));
  /* Runtime ends all GPU access and guest callbacks before these contexts die. */
  pocket_runtime_destroy(runtime);
  pocket_guest_quickjs_destroy(guest);
  if (js_context) JS_FreeContext(js_context);
  if (js_runtime) JS_FreeRuntime(js_runtime);
  pocket_pica_renderer_destroy(renderer); /* also destroys its display wrappers */
  if (bottom) C3D_RenderTargetDelete(bottom);
  if (top) C3D_RenderTargetDelete(top);
  pocket_3ds_file_source_close(&file);
  if (hid) pocket_3ds_hid_shutdown();
  if (romfs) romfsExit();
  if (graphics) C3D_Fini();
  if (result) {
    consoleInit(GFX_BOTTOM, NULL);
    printf("PocketJS\n\n%s\n\nSTART: exit\n", failure);
    while (aptMainLoop()) {
      hidScanInput();
      if (hidKeysDown() & KEY_START) break;
      gspWaitForVBlank();
    }
  }
  gfxExit();
  return result;
}
