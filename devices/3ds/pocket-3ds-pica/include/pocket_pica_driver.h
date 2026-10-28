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

/* A host list drawn in the display's frame: the app-switch transition over
 * the guest's list, or the development menu in its place. Words are in
 * 1/subpixels of a logical pixel; 1 keeps the display's logical size. */
typedef struct {
  pocket_draw_list list;
  uint32_t subpixels;
  bool replace; /* Drawn instead of the guest's list, not over it. */
} pocket_pica_overlay;
typedef bool (*pocket_pica_overlay_fn)(void *, uint32_t, pocket_pica_overlay *);

typedef struct {
  const void *shader;
  size_t shader_size;
  size_t texture_budget; /* Zero selects 16 MiB. Pending allocations are never
                            evicted. */
  void *context;
  pocket_pica_resolve_fn resolve;
  pocket_pica_release_fn release;
  pocket_pica_scene_fn scene;
  pocket_pica_overlay_fn overlay; /* Optional host overlay or replacement. */
  /* DEFERRED with queued flushes: a frame's flush ends its citro3d frame and
   * the GPU draws it while the guest's next turn runs; the next present's
   * completion waits for the GPU, then transfers and swaps each screen.
   * False keeps every frame terminal before present returns. */
  bool deferred;
} pocket_pica_config;

/* The application initializes citro3d and owns targets. It serializes all
 * citro3d calls with this instance and never opens another native frame while
 * a driver submission is pending. One instance owns a citro3d context. With
 * `deferred`, a submission stays pending from one present to the next: the
 * application completes the runtime's presentation before its own citro3d
 * work or before reading a target. */
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
/* The host overlays alone on cleared targets, outside any runtime frame: the
 * app-switch transition while no guest runs. Requires no pending submission;
 * the caller serializes it with every other citro3d use. False when the GPU
 * still owns the previous frame. */
bool pocket_pica_renderer_present_overlays(pocket_pica_renderer *renderer);
/* Microseconds of the last submit per display, and of the last GPU idle wait. */
void pocket_pica_renderer_timing(uint32_t *submit_primary, uint32_t *submit_auxiliary,
                                 uint32_t *gpu_idle_us);
/* Microseconds the last display_flush spent in each screen's display transfer. */
void pocket_pica_renderer_transfer_timing(uint32_t *primary_us, uint32_t *auxiliary_us);
size_t pocket_pica_renderer_words(const pocket_pica_renderer *, uint32_t role);
/* True while a deferred frame's GPU work or transfers are outstanding. */
bool pocket_pica_renderer_in_flight(const pocket_pica_renderer *renderer);
uint32_t pocket_pica_renderer_vertices(const pocket_pica_renderer *renderer);
uint32_t pocket_pica_renderer_commands(const pocket_pica_renderer *renderer);
#ifdef __cplusplus
}
#endif
#endif
