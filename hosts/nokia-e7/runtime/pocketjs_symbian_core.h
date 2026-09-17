#ifndef POCKETJS_SYMBIAN_CORE_H
#define POCKETJS_SYMBIAN_CORE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

void ui_init(uint32_t raster_density);
void ui_shutdown(void);
void ui_set_viewport(float width, float height);
uint32_t ui_viewport_width(void);
uint32_t ui_viewport_height(void);

int32_t ui_create_node(uint32_t node_type);
void ui_destroy_node(int32_t id);
void ui_insert_before(int32_t parent, int32_t child, int32_t anchor);
void ui_remove_child(int32_t parent, int32_t child);
void ui_set_style(int32_t id, int32_t style_id);
void ui_set_prop(int32_t id, uint32_t prop, double value);
void ui_set_prop_batch(const uint8_t *data, size_t len);
void ui_set_text(int32_t id, const uint8_t *text, size_t len);
void ui_replace_text(int32_t id, const uint8_t *text, size_t len);

int32_t ui_upload_texture(
    const uint8_t *data,
    size_t len,
    uint32_t width,
    uint32_t height,
    uint32_t psm
);
int32_t ui_upload_img_entry(const uint8_t *data, size_t len);
int32_t ui_upload_tileset_tile(
    const uint8_t *data,
    size_t len,
    uint32_t index
);
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
void ui_set_focus(int32_t id);
void ui_set_active(int32_t id, int32_t active);
int32_t ui_hit_test(float x, float y);
void ui_set_cursor(
    int32_t texture,
    float hot_x,
    float hot_y,
    float width,
    float height
);
void ui_set_cursor_pos(float x, float y);

int32_t ui_load_styles(const uint8_t *data, size_t len);
int32_t ui_load_font_atlas(const uint8_t *data, size_t len);
float ui_measure_text(const uint8_t *text, size_t len, uint32_t font_slot);

void ui_debug_inspect(int32_t id);
int32_t ui_debug_rect_xy(void);
int32_t ui_debug_rect_wh(void);
void ui_debug_pause(int32_t on);
void ui_debug_step(void);

void ui_tick(void);
int32_t ui_gl_initialize(void);
void ui_gl_reset_resources(void);
void ui_gl_shutdown(void);
/* Optional synchronous render-stage callback on the render thread. Stages:
 * 0 begin, 1 scene, 2 resources, 3 geometry, 4 upload, 5 submission complete.
 * The final two arguments report batch and vertex counts. NULL disables it.
 * The callback must not re-enter the UI or issue GL commands. */
void ui_gl_set_trace(void (*callback)(uint32_t, uint32_t, uint32_t));
int32_t ui_gl_render(
    int32_t target_x,
    int32_t target_y,
    int32_t target_width,
    int32_t target_height,
    int32_t window_width,
    int32_t window_height
);
int32_t ui_gl_render_over(
    int32_t target_x,
    int32_t target_y,
    int32_t target_width,
    int32_t target_height,
    int32_t window_width,
    int32_t window_height
);
const uint8_t *ui_render_incremental(void);
uint32_t ui_framebuffer_width(void);
uint32_t ui_framebuffer_height(void);
uint32_t ui_framebuffer_stride(void);
size_t ui_framebuffer_len(void);

#ifdef __cplusplus
}
#endif

#endif
