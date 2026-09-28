#ifndef POCKETJS_3DS_CORE_H
#define POCKETJS_3DS_CORE_H

/*
 * C ABI of hosts/3ds/core (the `pocketjs-3ds-core` staticlib): PocketJS's
 * retained UI core — tree, style, layout, text, animation and DrawList
 * emission — for the libctru host.
 *
 * Every pointer returned here borrows core-owned storage. It stays valid
 * until the next call that can move it (a texture upload or free, a font
 * atlas load, ui_draw, ui_init, ui_shutdown), so the host re-reads pointers
 * every frame rather than caching them across frames.
 */

#include <stddef.h>
#include <stdint.h>

/* Verified target variant borrowed from a caller-owned `.pocket` buffer. */
typedef struct {
  const uint8_t *javascript;
  size_t javascript_length;
  const uint8_t *pak;
  size_t pak_length;
  const uint8_t *plan;
  size_t plan_length;
  uint64_t package_hash;
  uint64_t variant_hash;
} PocketGuestPackage;

/* 0 = admitted. The package footer, target, host ABI, identity, plan and
 * NUL-terminated JS section are all checked before success. */
int32_t pocket_package_open(
  const uint8_t *bytes,
  size_t length,
  const uint8_t *target,
  size_t target_length,
  uint32_t host_abi,
  PocketGuestPackage *out
);

void ui_init(uint32_t raster_density);
void ui_shutdown(void);
void ui_set_viewport(float width, float height);
uint32_t ui_viewport_width(void);
uint32_t ui_viewport_height(void);
int32_t ui_create_auxiliary_surface(float width, float height);
int32_t ui_auxiliary_surface_root(void);
uint32_t ui_auxiliary_viewport_width(void);
uint32_t ui_auxiliary_viewport_height(void);
uint8_t *ui_alloc(size_t length);
void ui_free(uint8_t *bytes, size_t length);

/* HostOps (framework/src/host.ts; op codes in contracts/spec/spec.ts OP). */
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
int32_t ui_upload_tileset_tile(const uint8_t *bytes, size_t length, uint32_t index);
void ui_free_texture(int32_t handle);
int32_t ui_register_external_texture(uint32_t width, uint32_t height);
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
int32_t ui_hit_test_bounds(float x, float y);
int32_t ui_hit_test_auxiliary(float x, float y);
int32_t ui_hit_test_bounds_auxiliary(float x, float y);
size_t ui_touch_hits_auxiliary(
  const uint32_t *packed,
  size_t length,
  int32_t *out,
  size_t out_length
);
void ui_set_cursor(int32_t texture, float hot_x, float hot_y, float width, float height);
void ui_set_cursor_pos(float x, float y);
int32_t ui_load_styles(const uint8_t *bytes, size_t length);
int32_t ui_load_font_atlas(const uint8_t *bytes, size_t length);
float ui_measure_text(const uint8_t *text, size_t length, uint32_t font_slot);

/* Fixed-step frame. The core steps at exactly 1/60 s per ui_tick regardless
 * of the host's present cadence (contracts/spec/spec.ts FIXED_DT). */
void ui_tick(void);

/*
 * DrawList handoff. Unlike engine/ui-cabi, whose GLES backends consume the
 * list inside the Rust crate, the PICA200 backend is C (citro3d is mostly
 * `static inline`), so the word stream itself crosses the ABI. Format:
 * contracts/spec/spec.ts "DRAWLIST op format".
 *
 * ui_draw builds the frame's list and returns its length in words; the two
 * accessors report what it built. Call it exactly once per presented frame —
 * the build is not idempotent (it advances the DevTools highlight glide).
 */
size_t ui_draw(void);
const uint32_t *ui_draw_list_ptr(void);
size_t ui_draw_list_len(void);
uint64_t ui_draw_hash(void);
size_t ui_draw_auxiliary(void);
const uint32_t *ui_draw_auxiliary_list_ptr(void);
size_t ui_draw_auxiliary_list_len(void);

/*
 * Texture and font registries: how the C backend resolves a DrawList handle
 * to pixels. A handle's slot is `handle & ui_texture_slot_mask()`; the bits
 * above it are the generation, so a cached GPU texture is only valid while
 * its recorded `handle` still equals the value in the DrawList word, and its
 * recorded `revision` still equals the slot's (bytes can be overwritten in
 * place behind one live handle).
 */
typedef struct {
  const uint8_t *pixels;
  size_t pixels_length;
  /* 1024-byte CLUT (256 x uint32 ABGR), non-null exactly when psm is PSM_T8. */
  const uint8_t *palette;
  size_t palette_length;
  uint32_t width;
  uint32_t height;
  /* contracts/spec/spec.ts PSM. */
  uint32_t pixel_storage;
  /* Bilinear sampling hint (IMG FLAG_LINEAR); nearest otherwise. */
  uint32_t linear;
  int32_t handle;
  uint64_t revision;
} PocketTexture;

size_t ui_texture_slot_count(void);
uint32_t ui_texture_slot_mask(void);
int32_t ui_texture_at(uint32_t slot, PocketTexture *out);

/*
 * A registered font atlas. `coverage` holds glyph_count blocks of
 * coverage_height rows of coverage_width alpha bytes, top row first; glyph
 * `gid` starts at gid * coverage_height * coverage_width. Cells are drawn at
 * the LOGICAL size — coverage dimensions are those times the atlas density.
 * `coverage` doubles as the cache identity: loading a new atlas into a slot
 * replaces the allocation.
 */
typedef struct {
  const uint8_t *coverage;
  size_t coverage_length;
  uint32_t cell_width;
  uint32_t cell_height;
  uint32_t coverage_width;
  uint32_t coverage_height;
  uint32_t glyph_count;
} PocketFontAtlas;

size_t ui_font_slot_count(void);
int32_t ui_font_atlas(uint32_t slot, PocketFontAtlas *out);

/*
 * Asset pack. ui_feed_pak walks the app's .pak and feeds styles.bin, font
 * atlases, images and sprite atlases straight to the core before any JS runs
 * — zero QuickJS-heap transit. The `ui:img.*` / `ui:sprite.*` name tables it
 * records are what the host publishes as `ui.__textures` / `ui.__sprites`.
 * Names are NOT NUL-terminated; use them with their length.
 */
uint32_t ui_feed_pak(const uint8_t *bytes, size_t length);
size_t ui_pak_find(
  const uint8_t *bytes,
  size_t length,
  const uint8_t *key,
  size_t key_length,
  const uint8_t **out
);
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

/* DevTools (spec ops 18..22, docs/DEVTOOLS.md). All default-off. */
void ui_debug_inspect(int32_t id);
int32_t ui_debug_rect_xy(void);
int32_t ui_debug_rect_wh(void);
void ui_debug_pause(int32_t paused);
void ui_debug_step(void);

#endif
