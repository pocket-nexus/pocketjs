/* Generated from engine/runtime-cabi/src/compat/idf/ui.rs. Do not edit. */
#pragma once
#include "pocketjs/ui_core.h"
int32_t pocketjs_native_ui_animate(pocketjs_ui_core_t * core, int32_t id, uint32_t prop, double to, uint32_t duration, uint32_t easing, uint32_t delay);
void pocketjs_native_ui_cancel_animation(pocketjs_ui_core_t * core, int32_t animation);
int32_t pocketjs_native_ui_create(const pocketjs_ui_core_config_t * config, pocketjs_ui_core_t * * out_core);
int32_t pocketjs_native_ui_create_node(pocketjs_ui_core_t * core, uint32_t kind);
void pocketjs_native_ui_destroy(pocketjs_ui_core_t * core);
void pocketjs_native_ui_destroy_node(pocketjs_ui_core_t * core, int32_t id);
int32_t pocketjs_native_ui_draw(pocketjs_ui_core_t * core, pocketjs_ui_frame_view_t * out);
int32_t pocketjs_native_ui_font(pocketjs_ui_core_t * core, uint32_t slot, pocketjs_ui_font_view_t * out);
int32_t pocketjs_native_ui_frame_validate(const pocketjs_ui_frame_view_t * frame);
void pocketjs_native_ui_free_texture(pocketjs_ui_core_t * core, int32_t texture);
int32_t pocketjs_native_ui_get_config(const pocketjs_ui_core_t * core, pocketjs_ui_core_config_t * output);
int32_t pocketjs_native_ui_hit_test(pocketjs_ui_core_t * core, float x, float y);
int32_t pocketjs_native_ui_hit_test_bounds(pocketjs_ui_core_t * core, float x, float y);
void pocketjs_native_ui_insert_before(pocketjs_ui_core_t * core, int32_t parent, int32_t child, int32_t anchor);
int32_t pocketjs_native_ui_load_assets(pocketjs_ui_core_t * core, const pocketjs_ui_asset_t * assets, size_t count, int32_t * handles);
int32_t pocketjs_native_ui_load_font(pocketjs_ui_core_t * core, const uint8_t * data, size_t size);
int32_t pocketjs_native_ui_load_styles(pocketjs_ui_core_t * core, const uint8_t * data, size_t size);
float pocketjs_native_ui_measure_text(pocketjs_ui_core_t * core, const uint8_t * data, size_t size, uint32_t slot);
void pocketjs_native_ui_remove_child(pocketjs_ui_core_t * core, int32_t parent, int32_t child);
int32_t pocketjs_native_ui_replace_text(pocketjs_ui_core_t * core, int32_t id, const uint8_t * data, size_t size);
void pocketjs_native_ui_set_active(pocketjs_ui_core_t * core, int32_t id, int32_t active);
void pocketjs_native_ui_set_cursor(pocketjs_ui_core_t * core, int32_t texture, float hot_x, float hot_y, float width, float height);
void pocketjs_native_ui_set_cursor_position(pocketjs_ui_core_t * core, float x, float y);
void pocketjs_native_ui_set_focus(pocketjs_ui_core_t * core, int32_t id);
void pocketjs_native_ui_set_image(pocketjs_ui_core_t * core, int32_t id, int32_t texture);
void pocketjs_native_ui_set_prop(pocketjs_ui_core_t * core, int32_t id, uint32_t prop, double value);
void pocketjs_native_ui_set_sprite(pocketjs_ui_core_t * core, int32_t id, int32_t atlas, uint32_t frames, uint32_t columns, uint32_t step);
void pocketjs_native_ui_set_style(pocketjs_ui_core_t * core, int32_t id, int32_t style);
int32_t pocketjs_native_ui_set_text(pocketjs_ui_core_t * core, int32_t id, const uint8_t * data, size_t size);
int32_t pocketjs_native_ui_texture(pocketjs_ui_core_t * core, int32_t handle, pocketjs_ui_texture_view_t * out);
void pocketjs_native_ui_tick(pocketjs_ui_core_t * core);
size_t pocketjs_native_ui_touch_hits(pocketjs_ui_core_t * core, const uint32_t * touches, size_t touch_count, int32_t * output, size_t output_capacity);
int32_t pocketjs_native_ui_upload_img_entry(pocketjs_ui_core_t * core, const uint8_t * data, size_t size);
int32_t pocketjs_native_ui_upload_texture(pocketjs_ui_core_t * core, const uint8_t * data, size_t size, uint32_t width, uint32_t height, uint32_t psm);
size_t pocketjs_native_ui_wrap_text(pocketjs_ui_core_t * core, const uint8_t * data, size_t size, uint32_t slot, float max_width, uint32_t * output, size_t capacity);
