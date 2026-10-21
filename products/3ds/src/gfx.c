/* Host composition: product textures and stage content stay outside PICA. */
#include "gfx.h"
#include "agent.h"
#include "camera.h"
#include "devmenu.h"
#include "media.h"
#include "stage.h"
#include "vshader_shbin.h"
#include <pocket_pica_driver.h>
static pocket_pica_renderer *renderer;
static pocket_pica_display *primary, *auxiliary;
/* The main thread updates native textures before the canonical tick and only
 * destroys them after it returns. The runtime drains and retires every frame
 * before returning, so this lease borrows that serialized frame interval. */
static int32_t native_texture(void *context, int32_t handle,
                              pocket_pica_native_texture *out) {
  (void)context;
  out->texture = NULL;
#ifdef POCKETJS_MEDIA
  out->texture = media_texture(handle);
#endif
  if (!out->texture)
    out->texture = camera_texture(handle);
  out->u_scale = out->v_scale = 1;
  out->lease = NULL;
  return 0;
}
static void release_native(void *context, void *lease) {
  (void)context;
  (void)lease;
}
static bool scene(void *context, uint32_t role, C3D_RenderTarget *target,
                  C3D_RenderTarget *right) {
  (void)context;
  C3D_RenderTargetClear(target, C3D_CLEAR_ALL, 0x000000ff, 0);
  if (role == POCKET_DISPLAY_ROLE_PRIMARY && agent_enabled()) {
    if (right)
      C3D_RenderTargetClear(right, C3D_CLEAR_ALL, 0x000000ff, 0);
    stage_render(target, right);
    return true;
  }
  return false;
}
static bool overlay(void *context, uint32_t role, pocket_draw_list *out) {
  (void)context;
#ifndef POCKETJS_CAPTURE
  if (role == POCKET_DISPLAY_ROLE_AUXILIARY && devmenu_visible()) {
    out->words = devmenu_draw_list(&out->word_count);
    return true;
  }
#else
  (void)role;
  (void)out;
#endif
  return false;
}
bool gfx_init(uint32_t width, uint32_t height) {
  (void)width;
  (void)height;
  pocket_pica_config config = {.shader = vshader_shbin,
                               .shader_size = vshader_shbin_size,
                               .resolve = native_texture,
                               .release = release_native,
                               .scene = scene,
                               .overlay = overlay};
  renderer = pocket_pica_renderer_create(&config);
  return renderer != NULL;
}
bool gfx_bind_targets(C3D_RenderTarget *top, C3D_RenderTarget *bottom,
                      C3D_RenderTarget *right, uint32_t width, uint32_t height,
                      uint32_t aw, uint32_t ah) {
  primary = pocket_pica_display_create(renderer, POCKET_DISPLAY_ROLE_PRIMARY,
                                       top, right, width, height);
  auxiliary = pocket_pica_display_create(
      renderer, POCKET_DISPLAY_ROLE_AUXILIARY, bottom, NULL, aw, ah);
  return primary && auxiliary;
}
bool gfx_register(pocket_runtime *runtime) {
  pocket_renderer_id id = pocket_runtime_add_renderer(
      runtime, pocket_pica_renderer_vtable(), renderer);
  return id != POCKET_RENDERER_INVALID &&
         !pocket_runtime_add_display(runtime, pocket_pica_display_vtable(),
                                     primary, id) &&
         !pocket_runtime_add_display(runtime, pocket_pica_display_vtable(),
                                     auxiliary, id);
}
void gfx_reset_resources(void) { pocket_pica_renderer_reset(renderer); }
void gfx_shutdown(void) {
  pocket_pica_renderer_destroy(renderer);
  renderer = NULL;
  primary = auxiliary = NULL;
}
uint32_t gfx_dropped_vertices(void) {
  return 0;
} /* Overflow now fails the whole submission. */
uint32_t gfx_frame_commands(void) {
  return pocket_pica_renderer_commands(renderer);
}
uint32_t gfx_frame_vertices(void) {
  return pocket_pica_renderer_vertices(renderer);
}
size_t gfx_frame_words(uint32_t role) {
  return pocket_pica_renderer_words(renderer, role);
}
