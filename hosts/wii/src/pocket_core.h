#ifndef POCKET_WII_CORE_H
#define POCKET_WII_CORE_H

#include <stddef.h>
#include <stdint.h>

void ui_init(uint32_t raster_density);
void ui_shutdown(void);
void ui_set_viewport(float width, float height);
uint32_t ui_feed_pak(const uint8_t *ptr, size_t len);

int32_t ui_create_node(uint32_t node_type);
void ui_destroy_node(int32_t id);
void ui_insert_before(int32_t parent, int32_t child, int32_t anchor);
void ui_remove_child(int32_t parent, int32_t child);
void ui_set_style(int32_t id, int32_t style_id);
void ui_set_prop(int32_t id, uint32_t prop, double value);
void ui_set_text(int32_t id, const uint8_t *ptr, size_t len);
void ui_replace_text(int32_t id, const uint8_t *ptr, size_t len);
int32_t ui_upload_texture(const uint8_t *ptr, size_t len, uint32_t width, uint32_t height, uint32_t psm);
int32_t ui_upload_img_entry(const uint8_t *ptr, size_t len);
int32_t ui_upload_tileset_tile(const uint8_t *ptr, size_t len, uint32_t index);
void ui_free_texture(int32_t handle);
void ui_set_image(int32_t id, int32_t texture);
void ui_set_sprite(int32_t id, int32_t atlas, uint32_t frames, uint32_t columns, uint32_t step);
int32_t ui_animate(int32_t id, uint32_t prop, double to, uint32_t duration_ms, uint32_t easing, uint32_t delay_ms);
void ui_cancel_anim(int32_t animation_id);
void ui_set_focus(int32_t id);
void ui_set_active(int32_t id, int32_t active);
int32_t ui_load_styles(const uint8_t *ptr, size_t len);
int32_t ui_load_font_atlas(const uint8_t *ptr, size_t len);
float ui_measure_text(const uint8_t *ptr, size_t len, uint32_t font_slot);
void ui_tick(void);
size_t ui_draw(void);
const uint32_t *ui_draw_list_ptr(void);
size_t ui_draw_list_len(void);
size_t ui_pak_find(const uint8_t *ptr, size_t len, const uint8_t *key, size_t key_len, const uint8_t **out);
size_t ui_pak_texture_count(void);
const uint8_t *ui_pak_texture_name(size_t index);
size_t ui_pak_texture_name_len(size_t index);
int32_t ui_pak_texture_handle(size_t index);
size_t ui_pak_sprite_count(void);
const uint8_t *ui_pak_sprite_name(size_t index);
size_t ui_pak_sprite_name_len(size_t index);
int32_t ui_pak_sprite_handle(size_t index);
uint32_t ui_pak_sprite_frames(size_t index);
uint32_t ui_pak_sprite_columns(size_t index);
uint32_t ui_pak_sprite_step(size_t index);

#endif
