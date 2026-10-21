#ifndef POCKET_PICA_DRIVER_H
#define POCKET_PICA_DRIVER_H
#include <citro3d.h>
#include <pocket_runtime.h>
#ifdef __cplusplus
extern "C" {
#endif

typedef struct pocket_pica_renderer pocket_pica_renderer;
typedef struct pocket_pica_display pocket_pica_display;
/* A successful resolver pins this exact native allocation until release.
 * The source may not be rewritten while pinned. Null texture means no match. */
typedef struct {
  C3D_Tex *texture;
  float u_scale, v_scale;
  void *lease;
} pocket_pica_native_texture;
typedef int32_t (*pocket_pica_resolve_fn)(void *, int32_t,
                                          pocket_pica_native_texture *);
typedef void (*pocket_pica_release_fn)(void *, void *);
/* Called within the driver's native frame, before UI draws. Return true when
 * native content replaces the UI for this display. Right target can be null. */
typedef bool (*pocket_pica_scene_fn)(void *, uint32_t, C3D_RenderTarget *,
                                     C3D_RenderTarget *);

typedef bool (*pocket_pica_overlay_fn)(void *, uint32_t, pocket_draw_list *);

typedef struct {
  const void *shader;
  size_t shader_size;
  size_t texture_budget; /* Zero selects 16 MiB. Pending allocations are never
                            evicted. */
  void *context;
  pocket_pica_resolve_fn resolve;
  pocket_pica_release_fn release;
  pocket_pica_scene_fn scene;
  pocket_pica_overlay_fn overlay; /* Optional host-owned replacement list. */
} pocket_pica_config;

/* The application initializes citro3d and owns targets. It serializes all
 * citro3d calls with this instance and never opens another native frame while
 * a driver submission is pending. One instance owns a citro3d context. */
pocket_pica_renderer *
pocket_pica_renderer_create(const pocket_pica_config *config);
const pocket_renderer_v1 *pocket_pica_renderer_vtable(void);
void pocket_pica_renderer_destroy(pocket_pica_renderer *renderer);
/* Targets must be unlinked from citro3d automatic outputs. Physical targets
 * are rotated height x width RGBA8; each display handles its own screen swap.
 * Right target is permitted only for the primary display. */
pocket_pica_display *
pocket_pica_display_create(pocket_pica_renderer *, uint32_t role,
                           C3D_RenderTarget *target, C3D_RenderTarget *right,
                           uint32_t width, uint32_t height);
const pocket_display_output_v1 *pocket_pica_display_vtable(void);
void pocket_pica_display_destroy(pocket_pica_display *display);
/* Waits before invalidating caches; does not change display registration. */
void pocket_pica_renderer_reset(pocket_pica_renderer *renderer);
size_t pocket_pica_renderer_words(const pocket_pica_renderer *, uint32_t role);
uint32_t pocket_pica_renderer_vertices(const pocket_pica_renderer *renderer);
uint32_t pocket_pica_renderer_commands(const pocket_pica_renderer *renderer);
#ifdef __cplusplus
}
#endif
#endif
