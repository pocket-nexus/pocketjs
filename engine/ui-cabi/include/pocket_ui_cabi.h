#ifndef POCKETJS_UI_CABI_H
#define POCKETJS_UI_CABI_H

#include <stddef.h>
#include <stdint.h>

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
