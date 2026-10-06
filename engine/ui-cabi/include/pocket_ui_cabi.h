#ifndef POCKETJS_UI_CABI_H
#define POCKETJS_UI_CABI_H

#include <stddef.h>
#include <stdint.h>

/* One `.pocket` variant admitted for a runtime that serves every game.
 * Pointers borrow the caller's package buffer; javascript_length includes
 * the QuickJS NUL. view_* and raster_density come from the variant's plan. */
typedef struct {
  const uint8_t *javascript;
  size_t javascript_length;
  const uint8_t *pak;
  size_t pak_length;
  const uint8_t *plan;
  size_t plan_length;
  uint64_t package_hash;
  uint32_t view_width;
  uint32_t view_height;
  uint32_t raster_density;
  uint32_t features; /* POCKET_UI_PACKAGE_* */
} PocketUiPackage;

#define POCKET_UI_PACKAGE_PHYSICS 1u    /* features["ui.physics"] */
#define POCKET_UI_PACKAGE_OFFLOAD 2u    /* features["io.offload"] */
#define POCKET_UI_PACKAGE_COMPANIONS 4u /* companions is not empty */

/* 0 = admitted: footer hash, exact target and host ABI, identity, plan and
 * NUL-terminated JS. 1-11 package errors, 12 bad arguments, 13 plan JSON,
 * 14 plan viewport. */
int32_t pocket_ui_package_open(
  const uint8_t *bytes,
  size_t length,
  const uint8_t *target,
  size_t target_length,
  uint32_t host_abi,
  PocketUiPackage *out
);

void ui_init(uint32_t raster_density);
void ui_shutdown(void);
void ui_set_viewport(float width, float height);
int32_t ui_create_node(uint32_t node_type);
void ui_destroy_node(int32_t id);
void ui_insert_before(int32_t parent, int32_t child, int32_t anchor);
void ui_remove_child(int32_t parent, int32_t child);
void ui_set_style(int32_t id, int32_t style_id);
void ui_set_prop(int32_t id, uint32_t prop, double value);
void ui_set_prop_batch(const uint8_t *bytes, size_t length);
void ui_set_text(int32_t id, const uint8_t *text, size_t length);
void ui_replace_text(int32_t id, const uint8_t *text, size_t length);
int32_t ui_upload_texture(
  const uint8_t *bytes,
  size_t length,
  uint32_t width,
  uint32_t height,
  uint32_t pixel_storage
);
int32_t ui_upload_img_entry(const uint8_t *bytes, size_t length);
void ui_free_texture(int32_t handle);
void ui_set_image(int32_t id, int32_t texture);
void ui_set_sprite(
  int32_t id,
  int32_t atlas,
  uint32_t frames,
  uint32_t columns,
  uint32_t step
);
int32_t ui_animate(
  int32_t id,
  uint32_t prop,
  double to,
  uint32_t duration_ms,
  uint32_t easing,
  uint32_t delay_ms
);
void ui_cancel_anim(int32_t animation_id);
/* JSON bytes are borrowed until the next drain on the UI thread. */
const uint8_t *ui_take_animation_completions_json(size_t *length);
/* 2D bodies (spec ops 52..56, ui.physics): packed little-endian Float64
 * records in, handles and query results out; drained events stay valid until
 * the next drain. */
int32_t ui_physics_create(uint32_t kind, const uint8_t *bytes, size_t length);
void ui_physics_apply(const uint8_t *bytes, size_t length);
void ui_physics_destroy(int32_t handle);
const uint8_t *ui_physics_take_events(size_t *length);
double ui_physics_query(uint32_t query, int32_t handle, double a, double b, double c, double d);
void ui_set_focus(int32_t id);
void ui_set_active(int32_t id, int32_t active);
int32_t ui_hit_test(float x, float y);
int32_t ui_hit_test_bounds(float x, float y);
void ui_set_cursor(int32_t texture, float hot_x, float hot_y, float width, float height);
void ui_set_cursor_pos(float x, float y);
int32_t ui_load_styles(const uint8_t *bytes, size_t length);
int32_t ui_load_font_atlas(const uint8_t *bytes, size_t length);
float ui_measure_text(const uint8_t *text, size_t length, uint32_t font_slot);
void ui_tick(void);
void ui_debug_inspect(int32_t id);
int32_t ui_debug_rect_xy(void);
int32_t ui_debug_rect_wh(void);
void ui_debug_pause(int32_t paused);
void ui_debug_step(void);
const uint8_t *ui_render_incremental(void);
uint32_t ui_framebuffer_width(void);
uint32_t ui_framebuffer_height(void);
uint32_t ui_framebuffer_stride(void);
size_t ui_framebuffer_len(void);

/*
 * Incremental-raster statistics. Without these a per-frame damage-planning
 * failure — which silently draws a complete frame — is indistinguishable from
 * the machine being slow.
 */
uint64_t ui_damage_attempts(void);
uint64_t ui_damage_failures(void);
uint64_t ui_damage_full_redraws(void);
uint32_t ui_damage_regions(void);
uint64_t ui_damage_pixels(void);
int32_t ui_damage_bounds(int32_t *out);

/*
 * Hardware DrawList path. The core walks its own DrawList straight into the
 * OpenGL ES 1.1 fixed-function pipeline instead of rasterizing to a
 * framebuffer, so the CPU never touches a pixel. Callers must have a current
 * context; these return zero on any GL failure so the host can fall back to
 * the software rasterizer above.
 */
int32_t ui_gl_initialize(void);
/* Composite retained UI over an application-owned color/depth scene. */
int32_t ui_gl_render_over(int32_t target_x, int32_t target_y, int32_t target_width,
    int32_t target_height, int32_t window_width, int32_t window_height);
void ui_gl_reset_resources(void);
void ui_gl_shutdown(void);
int32_t ui_gl_render(
  int32_t target_x,
  int32_t target_y,
  int32_t target_width,
  int32_t target_height,
  int32_t window_width,
  int32_t window_height
);

#endif
