#include "pocketjs/ui_qjs.h"
#include "pocketjs/pak_format.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "esp_log.h"
#include "pocketjs/guest_quickjs.h"

#define MAX_REGISTRATIONS 128U
#define TARGET_ID_BYTES 16U

typedef struct {
  char *name;
  int32_t handle;
} texture_registration_t;

typedef struct {
  char *name;
  int32_t handle;
  uint32_t frames;
  uint32_t columns;
  uint32_t step;
} sprite_registration_t;

struct pocketjs_ui_qjs {
  pocketjs_guest_t *guest;
  pocketjs_ui_core_t *core;
  char *target_id;
  uint32_t host_abi;
  uint32_t tick_hz;
  uint32_t logical_width;
  uint32_t logical_height;
  const uint8_t *pak;
  size_t pak_size;
  texture_registration_t *textures;
  size_t texture_count;
  sprite_registration_t *sprites;
  size_t sprite_count;
  bool mounted;
};

static bool range_valid(size_t offset, size_t length, size_t total) {
  return offset <= total && length <= total - offset;
}

static bool read_u16(const uint8_t *bytes, size_t size, size_t offset,
                     uint16_t *out) {
  if (out == NULL || !range_valid(offset, 2U, size)) {
    return false;
  }
  *out = (uint16_t)bytes[offset] | ((uint16_t)bytes[offset + 1U] << 8U);
  return true;
}

static bool read_u32(const uint8_t *bytes, size_t size, size_t offset,
                     uint32_t *out) {
  if (out == NULL || !range_valid(offset, 4U, size)) {
    return false;
  }
  *out = (uint32_t)bytes[offset] | ((uint32_t)bytes[offset + 1U] << 8U) |
         ((uint32_t)bytes[offset + 2U] << 16U) |
         ((uint32_t)bytes[offset + 3U] << 24U);
  return true;
}

static char *copy_name(const uint8_t *name, size_t size) {
  char *copy = malloc(size + 1U);
  if (copy != NULL) {
    memcpy(copy, name, size);
    copy[size] = '\0';
  }
  return copy;
}

esp_err_t pocketjs_ui_qjs_create(pocketjs_guest_t *guest,
                                 pocketjs_ui_core_t *core,
                                 const pocketjs_ui_qjs_config_t *config,
                                 pocketjs_ui_qjs_t **out_binding) {
  if (guest == NULL || core == NULL || config == NULL || out_binding == NULL ||
      config->struct_size < sizeof(*config) || config->target_id == NULL ||
      config->host_abi == 0U ||
      strnlen(config->target_id, TARGET_ID_BYTES) == 0U ||
      strnlen(config->target_id, TARGET_ID_BYTES) >= TARGET_ID_BYTES) {
    return ESP_ERR_INVALID_ARG;
  }
  *out_binding = NULL;
  pocketjs_ui_core_config_t core_config = {.struct_size = sizeof(core_config)};
  if (pocketjs_ui_core_get_config(core, &core_config) != ESP_OK) {
    return ESP_ERR_INVALID_ARG;
  }
  pocketjs_ui_qjs_t *binding = calloc(1, sizeof(*binding));
  if (binding == NULL) {
    return ESP_ERR_NO_MEM;
  }
  binding->target_id = strdup(config->target_id);
  if (binding->target_id == NULL) {
    free(binding);
    return ESP_ERR_NO_MEM;
  }
  binding->guest = guest;
  binding->core = core;
  binding->host_abi = config->host_abi;
  binding->tick_hz = core_config.tick_hz;
  binding->logical_width = core_config.logical_width;
  binding->logical_height = core_config.logical_height;
  *out_binding = binding;
  return ESP_OK;
}

static void free_registrations(pocketjs_ui_qjs_t *binding) {
  for (size_t i = 0; i < binding->texture_count; ++i)
    free(binding->textures[i].name);
  for (size_t i = 0; i < binding->sprite_count; ++i)
    free(binding->sprites[i].name);
  free(binding->textures);
  free(binding->sprites);
}

typedef struct {
  const uint8_t *name;
  size_t name_size;
  const uint8_t *data;
  size_t size;
  uint32_t kind;
} pak_entry_t;

esp_err_t pocketjs_ui_qjs_feed_pak(pocketjs_ui_qjs_t *binding, const void *pak,
                                   size_t pak_size) {
  if (binding == NULL || pak == NULL || pak_size < PAK_HEADER_SIZE ||
      binding->mounted || binding->pak != NULL)
    return ESP_ERR_INVALID_ARG;
  const uint8_t *bytes = pak;
  uint32_t magic, count, directory, names;
  uint16_t version;
  if (!read_u32(bytes, pak_size, 0, &magic) || magic != PAK_MAGIC ||
      !read_u16(bytes, pak_size, 4, &version) || version != PAK_VERSION ||
      !read_u32(bytes, pak_size, 8, &count) || count > 4096U ||
      !read_u32(bytes, pak_size, 12, &directory) ||
      !read_u32(bytes, pak_size, 16, &names) ||
      !range_valid(directory, (size_t)count * PAK_ENTRY_SIZE, pak_size))
    return ESP_ERR_INVALID_RESPONSE;
  pak_entry_t *entries = calloc(count ? count : 1U, sizeof(*entries));
  pocketjs_ui_asset_t *assets = calloc(count ? count : 1U, sizeof(*assets));
  int32_t *handles = calloc(count ? count : 1U, sizeof(*handles));
  pocketjs_ui_qjs_t staged = {0};
  esp_err_t result = ESP_ERR_INVALID_RESPONSE;
  if (!entries || !assets || !handles) {
    result = ESP_ERR_NO_MEM;
    goto done;
  }
  size_t texture_count = 0, sprite_count = 0, asset_count = 0;
  for (uint32_t i = 0; i < count; ++i) {
    const size_t offset = directory + (size_t)i * PAK_ENTRY_SIZE;
    uint32_t data_offset, size, name_offset;
    uint16_t name_size;
    if (!read_u32(bytes, pak_size, offset + 4U, &data_offset) ||
        !read_u32(bytes, pak_size, offset + 8U, &size) ||
        !read_u32(bytes, pak_size, offset + 12U, &name_offset) ||
        !read_u16(bytes, pak_size, offset + 16U, &name_size) ||
        (size_t)names + name_offset < names ||
        !range_valid((size_t)names + name_offset, name_size, pak_size) ||
        !range_valid(data_offset, size, pak_size) || name_size == 0U)
      goto done;
    pak_entry_t *entry = &entries[i];
    *entry = (pak_entry_t){.name = bytes + names + name_offset,
                           .name_size = name_size,
                           .data = bytes + data_offset,
                           .size = size};
    for (size_t n = 0; n < name_size; ++n)
      if (entry->name[n] == 0U || entry->name[n] > 127U)
        goto done;
    for (uint32_t j = 0; j < i; ++j)
      if (entries[j].name_size == name_size &&
          !memcmp(entries[j].name, entry->name, name_size))
        goto done;
    if (name_size == 9U && !memcmp(entry->name, "ui:styles", 9U))
      entry->kind = POCKETJS_UI_ASSET_STYLES;
    else if (name_size > 8U && !memcmp(entry->name, "ui:font.", 8U))
      entry->kind = POCKETJS_UI_ASSET_FONT;
    else if (name_size > 7U && !memcmp(entry->name, "ui:img.", 7U)) {
      entry->kind = POCKETJS_UI_ASSET_IMAGE;
      ++texture_count;
    } else if (name_size > 10U && !memcmp(entry->name, "ui:sprite.", 10U)) {
      entry->kind = POCKETJS_UI_ASSET_SPRITE;
      ++sprite_count;
    }
    if (entry->kind)
      assets[asset_count++] =
          (pocketjs_ui_asset_t){.struct_size = sizeof(*assets),
                                .kind = entry->kind,
                                .data = entry->data,
                                .size = entry->size};
  }
  if (texture_count > MAX_REGISTRATIONS || sprite_count > MAX_REGISTRATIONS) {
    result = ESP_ERR_NO_MEM;
    goto done;
  }
  staged.textures =
      calloc(texture_count ? texture_count : 1U, sizeof(*staged.textures));
  staged.sprites =
      calloc(sprite_count ? sprite_count : 1U, sizeof(*staged.sprites));
  if (!staged.textures || !staged.sprites) {
    result = ESP_ERR_NO_MEM;
    goto done;
  }
  for (uint32_t i = 0; i < count; ++i) {
    pak_entry_t *entry = &entries[i];
    if (entry->kind == POCKETJS_UI_ASSET_IMAGE) {
      char *name = copy_name(entry->name + 7U, entry->name_size - 7U);
      if (!name) {
        result = ESP_ERR_NO_MEM;
        goto done;
      }
      staged.textures[staged.texture_count++].name = name;
    } else if (entry->kind == POCKETJS_UI_ASSET_SPRITE) {
      uint16_t frames, columns, step;
      if (entry->size < 16U ||
          !read_u16(entry->data, entry->size, 6, &frames) ||
          !read_u16(entry->data, entry->size, 8, &columns) ||
          !read_u16(entry->data, entry->size, 10, &step))
        goto done;
      char *name = copy_name(entry->name + 10U, entry->name_size - 10U);
      if (!name) {
        result = ESP_ERR_NO_MEM;
        goto done;
      }
      staged.sprites[staged.sprite_count++] = (sprite_registration_t){
          .name = name, .frames = frames, .columns = columns, .step = step};
    }
  }
  result =
      pocketjs_ui_core_load_assets(binding->core, assets, asset_count, handles);
  if (result != ESP_OK)
    goto done;
  /* All allocations preceded the atomic native commit. */
  size_t texture = 0, sprite = 0;
  for (size_t i = 0; i < asset_count; ++i) {
    if (assets[i].kind == POCKETJS_UI_ASSET_IMAGE)
      staged.textures[texture++].handle = handles[i];
    if (assets[i].kind == POCKETJS_UI_ASSET_SPRITE)
      staged.sprites[sprite++].handle = handles[i];
  }
  binding->textures = staged.textures;
  binding->texture_count = staged.texture_count;
  binding->sprites = staged.sprites;
  binding->sprite_count = staged.sprite_count;
  binding->pak = bytes;
  binding->pak_size = pak_size;
  staged = (pocketjs_ui_qjs_t){0};
done:
  free_registrations(&staged);
  free(entries);
  free(assets);
  free(handles);
  return result;
}

static bool arg_i32(JSContext *ctx, int argc, JSValueConst *argv, int index,
                    int32_t *value) {
  *value = 0;
  return index >= argc || JS_ToInt32(ctx, value, argv[index]) == 0;
}
static bool arg_u32(JSContext *ctx, int argc, JSValueConst *argv, int index,
                    uint32_t *value) {
  *value = 0;
  return index >= argc || JS_ToUint32(ctx, value, argv[index]) == 0;
}
static bool arg_f64(JSContext *ctx, int argc, JSValueConst *argv, int index,
                    double *value) {
  *value = 0;
  return index >= argc || JS_ToFloat64(ctx, value, argv[index]) == 0;
}
#define UI_CORE(ctx) (((pocketjs_ui_qjs_t *)opaque)->core)

static JSValue js_create_node(JSContext *ctx, JSValueConst this_value, int argc,
                              JSValueConst *argv, int magic, void *opaque) {
  uint32_t a_u320;
  if (!arg_u32(ctx, argc, argv, 0, &a_u320))
    return JS_EXCEPTION;
  (void)this_value;
  (void)magic;
  return JS_NewInt32(ctx, pocketjs_ui_core_create_node(UI_CORE(ctx), a_u320));
}

static JSValue js_destroy_node(JSContext *ctx, JSValueConst this_value,
                               int argc, JSValueConst *argv, int magic,
                               void *opaque) {
  int32_t a_i320;
  if (!arg_i32(ctx, argc, argv, 0, &a_i320))
    return JS_EXCEPTION;
  (void)this_value;
  (void)magic;
  pocketjs_ui_core_destroy_node(UI_CORE(ctx), a_i320);
  return JS_UNDEFINED;
}

static JSValue js_insert_before(JSContext *ctx, JSValueConst this_value,
                                int argc, JSValueConst *argv, int magic,
                                void *opaque) {
  int32_t a_i320;
  int32_t a_i321;
  int32_t a_i322;
  if (!arg_i32(ctx, argc, argv, 0, &a_i320) ||
      !arg_i32(ctx, argc, argv, 1, &a_i321) ||
      !arg_i32(ctx, argc, argv, 2, &a_i322))
    return JS_EXCEPTION;
  (void)this_value;
  (void)magic;
  pocketjs_ui_core_insert_before(UI_CORE(ctx), a_i320, a_i321, a_i322);
  return JS_UNDEFINED;
}

static JSValue js_remove_child(JSContext *ctx, JSValueConst this_value,
                               int argc, JSValueConst *argv, int magic,
                               void *opaque) {
  int32_t a_i320;
  int32_t a_i321;
  if (!arg_i32(ctx, argc, argv, 0, &a_i320) ||
      !arg_i32(ctx, argc, argv, 1, &a_i321))
    return JS_EXCEPTION;
  (void)this_value;
  (void)magic;
  pocketjs_ui_core_remove_child(UI_CORE(ctx), a_i320, a_i321);
  return JS_UNDEFINED;
}

static JSValue js_set_style(JSContext *ctx, JSValueConst this_value, int argc,
                            JSValueConst *argv, int magic, void *opaque) {
  int32_t a_i320;
  int32_t a_i321;
  if (!arg_i32(ctx, argc, argv, 0, &a_i320) ||
      !arg_i32(ctx, argc, argv, 1, &a_i321))
    return JS_EXCEPTION;
  (void)this_value;
  (void)magic;
  pocketjs_ui_core_set_style(UI_CORE(ctx), a_i320, a_i321);
  return JS_UNDEFINED;
}

static JSValue js_set_prop(JSContext *ctx, JSValueConst this_value, int argc,
                           JSValueConst *argv, int magic, void *opaque) {
  int32_t a_i320;
  uint32_t a_u321;
  double a_f642;
  if (!arg_i32(ctx, argc, argv, 0, &a_i320) ||
      !arg_u32(ctx, argc, argv, 1, &a_u321) ||
      !arg_f64(ctx, argc, argv, 2, &a_f642))
    return JS_EXCEPTION;
  (void)this_value;
  (void)magic;
  pocketjs_ui_core_set_prop(UI_CORE(ctx), a_i320, a_u321, a_f642);
  return JS_UNDEFINED;
}

static JSValue set_text(JSContext *ctx, int argc, JSValueConst *argv,
                        bool replace, void *opaque) {
  int32_t a_i320;
  if (!arg_i32(ctx, argc, argv, 0, &a_i320))
    return JS_EXCEPTION;
  if (argc < 2)
    return JS_ThrowTypeError(ctx, "text op requires id and value");
  size_t size = 0;
  const char *text = JS_ToCStringLen(ctx, &size, argv[1]);
  if (text == NULL)
    return JS_EXCEPTION;
  const esp_err_t result =
      replace ? pocketjs_ui_core_replace_text(UI_CORE(ctx), a_i320, text, size)
              : pocketjs_ui_core_set_text(UI_CORE(ctx), a_i320, text, size);
  JS_FreeCString(ctx, text);
  return result == ESP_OK ? JS_UNDEFINED
                          : JS_ThrowInternalError(ctx, "invalid UTF-8 text");
}

static JSValue js_set_text(JSContext *ctx, JSValueConst this_value, int argc,
                           JSValueConst *argv, int magic, void *opaque) {
  (void)this_value;
  (void)magic;
  return set_text(ctx, argc, argv, false, opaque);
}

static JSValue js_replace_text(JSContext *ctx, JSValueConst this_value,
                               int argc, JSValueConst *argv, int magic,
                               void *opaque) {
  (void)this_value;
  (void)magic;
  return set_text(ctx, argc, argv, true, opaque);
}

static JSValue js_upload_texture(JSContext *ctx, JSValueConst this_value,
                                 int argc, JSValueConst *argv, int magic,
                                 void *opaque) {
  uint32_t a_u321;
  uint32_t a_u322;
  uint32_t a_u323;
  if (!arg_u32(ctx, argc, argv, 1, &a_u321) ||
      !arg_u32(ctx, argc, argv, 2, &a_u322) ||
      !arg_u32(ctx, argc, argv, 3, &a_u323))
    return JS_EXCEPTION;
  (void)this_value;
  (void)magic;
  if (argc < 4)
    return JS_ThrowTypeError(
        ctx, "uploadTexture requires pixels, width, height, psm");
  size_t size = 0;
  const uint8_t *bytes = JS_GetUint8Array(ctx, &size, argv[0]);
  if (bytes == NULL)
    return JS_EXCEPTION;
  return JS_NewInt32(ctx,
                     pocketjs_ui_core_upload_texture(UI_CORE(ctx), bytes, size,
                                                     a_u321, a_u322, a_u323));
}

static JSValue js_set_image(JSContext *ctx, JSValueConst this_value, int argc,
                            JSValueConst *argv, int magic, void *opaque) {
  int32_t a_i320;
  int32_t a_i321;
  if (!arg_i32(ctx, argc, argv, 0, &a_i320) ||
      !arg_i32(ctx, argc, argv, 1, &a_i321))
    return JS_EXCEPTION;
  (void)this_value;
  (void)magic;
  pocketjs_ui_core_set_image(UI_CORE(ctx), a_i320, a_i321);
  return JS_UNDEFINED;
}

static JSValue js_set_sprite(JSContext *ctx, JSValueConst this_value, int argc,
                             JSValueConst *argv, int magic, void *opaque) {
  int32_t a_i320;
  int32_t a_i321;
  uint32_t a_u322;
  uint32_t a_u323;
  uint32_t a_u324;
  if (!arg_i32(ctx, argc, argv, 0, &a_i320) ||
      !arg_i32(ctx, argc, argv, 1, &a_i321) ||
      !arg_u32(ctx, argc, argv, 2, &a_u322) ||
      !arg_u32(ctx, argc, argv, 3, &a_u323) ||
      !arg_u32(ctx, argc, argv, 4, &a_u324))
    return JS_EXCEPTION;
  (void)this_value;
  (void)magic;
  pocketjs_ui_core_set_sprite(UI_CORE(ctx), a_i320, a_i321, a_u322, a_u323,
                              a_u324);
  return JS_UNDEFINED;
}

static JSValue js_animate(JSContext *ctx, JSValueConst this_value, int argc,
                          JSValueConst *argv, int magic, void *opaque) {
  int32_t a_i320;
  uint32_t a_u321;
  double a_f642;
  uint32_t a_u323;
  uint32_t a_u324;
  uint32_t a_u325;
  if (!arg_i32(ctx, argc, argv, 0, &a_i320) ||
      !arg_u32(ctx, argc, argv, 1, &a_u321) ||
      !arg_f64(ctx, argc, argv, 2, &a_f642) ||
      !arg_u32(ctx, argc, argv, 3, &a_u323) ||
      !arg_u32(ctx, argc, argv, 4, &a_u324) ||
      !arg_u32(ctx, argc, argv, 5, &a_u325))
    return JS_EXCEPTION;
  (void)this_value;
  (void)magic;
  return JS_NewInt32(ctx,
                     pocketjs_ui_core_animate(UI_CORE(ctx), a_i320, a_u321,
                                              a_f642, a_u323, a_u324, a_u325));
}

static JSValue js_cancel_anim(JSContext *ctx, JSValueConst this_value, int argc,
                              JSValueConst *argv, int magic, void *opaque) {
  int32_t a_i320;
  if (!arg_i32(ctx, argc, argv, 0, &a_i320))
    return JS_EXCEPTION;
  (void)this_value;
  (void)magic;
  pocketjs_ui_core_cancel_animation(UI_CORE(ctx), a_i320);
  return JS_UNDEFINED;
}

static JSValue js_set_focus(JSContext *ctx, JSValueConst this_value, int argc,
                            JSValueConst *argv, int magic, void *opaque) {
  int32_t a_i320;
  if (!arg_i32(ctx, argc, argv, 0, &a_i320))
    return JS_EXCEPTION;
  (void)this_value;
  (void)magic;
  pocketjs_ui_core_set_focus(UI_CORE(ctx), a_i320);
  return JS_UNDEFINED;
}

static JSValue js_set_active(JSContext *ctx, JSValueConst this_value, int argc,
                             JSValueConst *argv, int magic, void *opaque) {
  int32_t a_i320;
  int32_t a_i321;
  if (!arg_i32(ctx, argc, argv, 0, &a_i320) ||
      !arg_i32(ctx, argc, argv, 1, &a_i321))
    return JS_EXCEPTION;
  (void)this_value;
  (void)magic;
  pocketjs_ui_core_set_active(UI_CORE(ctx), a_i320, a_i321 != 0);
  return JS_UNDEFINED;
}

static JSValue js_hit_test(JSContext *ctx, JSValueConst this_value, int argc,
                           JSValueConst *argv, int magic, void *opaque) {
  double a_f640;
  double a_f641;
  if (!arg_f64(ctx, argc, argv, 0, &a_f640) ||
      !arg_f64(ctx, argc, argv, 1, &a_f641))
    return JS_EXCEPTION;
  (void)this_value;
  (void)magic;
  return JS_NewInt32(ctx, pocketjs_ui_core_hit_test(UI_CORE(ctx), (float)a_f640,
                                                    (float)a_f641));
}

static JSValue js_hit_test_bounds(JSContext *ctx, JSValueConst this_value,
                                  int argc, JSValueConst *argv, int magic,
                                  void *opaque) {
  double a_f640;
  double a_f641;
  if (!arg_f64(ctx, argc, argv, 0, &a_f640) ||
      !arg_f64(ctx, argc, argv, 1, &a_f641))
    return JS_EXCEPTION;
  (void)this_value;
  (void)magic;
  return JS_NewInt32(ctx, pocketjs_ui_core_hit_test_bounds(
                              UI_CORE(ctx), (float)a_f640, (float)a_f641));
}

static JSValue js_set_cursor(JSContext *ctx, JSValueConst this_value, int argc,
                             JSValueConst *argv, int magic, void *opaque) {
  int32_t a_i320;
  double a_f641;
  double a_f642;
  double a_f643;
  double a_f644;
  if (!arg_i32(ctx, argc, argv, 0, &a_i320) ||
      !arg_f64(ctx, argc, argv, 1, &a_f641) ||
      !arg_f64(ctx, argc, argv, 2, &a_f642) ||
      !arg_f64(ctx, argc, argv, 3, &a_f643) ||
      !arg_f64(ctx, argc, argv, 4, &a_f644))
    return JS_EXCEPTION;
  (void)this_value;
  (void)magic;
  pocketjs_ui_core_set_cursor(UI_CORE(ctx), a_i320, (float)a_f641,
                              (float)a_f642, (float)a_f643, (float)a_f644);
  return JS_UNDEFINED;
}

static JSValue js_set_cursor_pos(JSContext *ctx, JSValueConst this_value,
                                 int argc, JSValueConst *argv, int magic,
                                 void *opaque) {
  double a_f640;
  double a_f641;
  if (!arg_f64(ctx, argc, argv, 0, &a_f640) ||
      !arg_f64(ctx, argc, argv, 1, &a_f641))
    return JS_EXCEPTION;
  (void)this_value;
  (void)magic;
  pocketjs_ui_core_set_cursor_position(UI_CORE(ctx), (float)a_f640,
                                       (float)a_f641);
  return JS_UNDEFINED;
}

static JSValue js_load_styles(JSContext *ctx, JSValueConst this_value, int argc,
                              JSValueConst *argv, int magic, void *opaque) {
  (void)this_value;
  (void)magic;
  if (argc < 1)
    return JS_ThrowTypeError(ctx, "loadStyles requires bytes");
  size_t size = 0;
  const uint8_t *bytes = JS_GetUint8Array(ctx, &size, argv[0]);
  if (!bytes)
    return JS_EXCEPTION;
  return JS_NewBool(
      ctx, pocketjs_ui_core_load_styles(UI_CORE(ctx), bytes, size) == ESP_OK);
}

static JSValue js_load_font(JSContext *ctx, JSValueConst this_value, int argc,
                            JSValueConst *argv, int magic, void *opaque) {
  (void)this_value;
  (void)magic;
  if (argc < 1)
    return JS_ThrowTypeError(ctx, "loadFontAtlas requires bytes");
  size_t size = 0;
  const uint8_t *bytes = JS_GetUint8Array(ctx, &size, argv[0]);
  if (!bytes)
    return JS_EXCEPTION;
  return JS_NewBool(ctx, pocketjs_ui_core_load_font_atlas(UI_CORE(ctx), bytes,
                                                          size) == ESP_OK);
}

static JSValue js_measure_text(JSContext *ctx, JSValueConst this_value,
                               int argc, JSValueConst *argv, int magic,
                               void *opaque) {
  uint32_t a_u321;
  if (!arg_u32(ctx, argc, argv, 1, &a_u321))
    return JS_EXCEPTION;
  (void)this_value;
  (void)magic;
  if (argc < 1)
    return JS_NewFloat64(ctx, 0.0);
  size_t size = 0;
  const char *text = JS_ToCStringLen(ctx, &size, argv[0]);
  if (text == NULL)
    return JS_EXCEPTION;
  const float width =
      pocketjs_ui_core_measure_text(UI_CORE(ctx), text, size, a_u321);
  JS_FreeCString(ctx, text);
  return JS_NewFloat64(ctx, width);
}

static JSValue js_wrap_text(JSContext *ctx, JSValueConst this_value, int argc,
                            JSValueConst *argv, int magic, void *opaque) {
  uint32_t a_u321;
  double a_f642;
  if (!arg_u32(ctx, argc, argv, 1, &a_u321) ||
      !arg_f64(ctx, argc, argv, 2, &a_f642))
    return JS_EXCEPTION;
  (void)this_value;
  (void)magic;
  if (argc < 3)
    return JS_NewArray(ctx);
  size_t size = 0;
  const char *text = JS_ToCStringLen(ctx, &size, argv[0]);
  if (text == NULL)
    return JS_EXCEPTION;
  const size_t count = pocketjs_ui_core_wrap_text(
      UI_CORE(ctx), text, size, a_u321, (float)a_f642, NULL, 0);
  if (count > SIZE_MAX / sizeof(uint32_t)) {
    JS_FreeCString(ctx, text);
    return JS_ThrowOutOfMemory(ctx);
  }
  uint32_t *breaks =
      count == 0 ? NULL : js_malloc(ctx, count * sizeof(*breaks));
  if (count != 0 && breaks == NULL) {
    JS_FreeCString(ctx, text);
    return JS_ThrowOutOfMemory(ctx);
  }
  pocketjs_ui_core_wrap_text(UI_CORE(ctx), text, size, a_u321, (float)a_f642,
                             breaks, count);
  JS_FreeCString(ctx, text);
  JSValue array = JS_NewArray(ctx);
  if (JS_IsException(array)) {
    js_free(ctx, breaks);
    return array;
  }
  for (size_t index = 0; index < count; ++index) {
    if (JS_SetPropertyUint32(ctx, array, (uint32_t)index,
                             JS_NewUint32(ctx, breaks[index])) < 0) {
      JS_FreeValue(ctx, array);
      js_free(ctx, breaks);
      return JS_EXCEPTION;
    }
  }
  js_free(ctx, breaks);
  return array;
}

static JSValue js_free_texture(JSContext *ctx, JSValueConst this_value,
                               int argc, JSValueConst *argv, int magic,
                               void *opaque) {
  int32_t a_i320;
  if (!arg_i32(ctx, argc, argv, 0, &a_i320))
    return JS_EXCEPTION;
  (void)this_value;
  (void)magic;
  pocketjs_ui_core_free_texture(UI_CORE(ctx), a_i320);
  return JS_UNDEFINED;
}

static JSValue js_upload_img_entry(JSContext *ctx, JSValueConst this_value,
                                   int argc, JSValueConst *argv, int magic,
                                   void *opaque) {
  (void)this_value;
  (void)magic;
  if (argc < 1)
    return JS_ThrowTypeError(ctx, "uploadImgEntry requires bytes");
  size_t size = 0;
  const uint8_t *bytes =
      argc > 0 ? JS_GetUint8Array(ctx, &size, argv[0]) : NULL;
  return bytes != NULL ? JS_NewInt32(ctx, pocketjs_ui_core_upload_img_entry(
                                              UI_CORE(ctx), bytes, size))
                       : JS_EXCEPTION;
}

static void set_function(JSContext *ctx, JSValue object, const char *name,
                         JSCClosure *fn, int arity,
                         pocketjs_ui_qjs_t *binding) {
  JS_SetPropertyStr(ctx, object, name,
                    JS_NewCClosure(ctx, fn, name, NULL, arity, 0, binding));
}

static esp_err_t install_ui(JSContext *ctx, void *user_data) {
  pocketjs_ui_qjs_t *binding = user_data;
  JSValue global = JS_GetGlobalObject(ctx);
  JSValue ui = JS_NewObject(ctx);
  JSValue pak = JS_UNDEFINED;
  JSAtom ui_atom = JS_NewAtom(ctx, "ui");
  JSAtom pak_atom = JS_NewAtom(ctx, "__pak");
  esp_err_t result = ESP_FAIL;
  if (JS_IsException(global) || JS_IsException(ui) || ui_atom == JS_ATOM_NULL ||
      pak_atom == JS_ATOM_NULL)
    goto done;
  if (JS_HasProperty(ctx, global, ui_atom) != 0 ||
      JS_HasProperty(ctx, global, pak_atom) != 0) {
    result = ESP_ERR_INVALID_STATE;
    goto done;
  }
  set_function(ctx, ui, "createNode", js_create_node, 1, binding);
  set_function(ctx, ui, "destroyNode", js_destroy_node, 1, binding);
  set_function(ctx, ui, "insertBefore", js_insert_before, 3, binding);
  set_function(ctx, ui, "removeChild", js_remove_child, 2, binding);
  set_function(ctx, ui, "setStyle", js_set_style, 2, binding);
  set_function(ctx, ui, "setProp", js_set_prop, 3, binding);
  set_function(ctx, ui, "setText", js_set_text, 2, binding);
  set_function(ctx, ui, "replaceText", js_replace_text, 2, binding);
  set_function(ctx, ui, "uploadTexture", js_upload_texture, 4, binding);
  set_function(ctx, ui, "setImage", js_set_image, 2, binding);
  set_function(ctx, ui, "setSprite", js_set_sprite, 5, binding);
  set_function(ctx, ui, "animate", js_animate, 6, binding);
  set_function(ctx, ui, "cancelAnim", js_cancel_anim, 1, binding);
  set_function(ctx, ui, "setFocus", js_set_focus, 1, binding);
  set_function(ctx, ui, "setActive", js_set_active, 2, binding);
  set_function(ctx, ui, "hitTest", js_hit_test, 2, binding);
  set_function(ctx, ui, "hitTestBounds", js_hit_test_bounds, 2, binding);
  set_function(ctx, ui, "setCursor", js_set_cursor, 5, binding);
  set_function(ctx, ui, "setCursorPos", js_set_cursor_pos, 2, binding);
  set_function(ctx, ui, "loadStyles", js_load_styles, 1, binding);
  set_function(ctx, ui, "loadFontAtlas", js_load_font, 1, binding);
  set_function(ctx, ui, "measureText", js_measure_text, 2, binding);
  set_function(ctx, ui, "wrapText", js_wrap_text, 3, binding);
  set_function(ctx, ui, "freeTexture", js_free_texture, 1, binding);
  set_function(ctx, ui, "uploadImgEntry", js_upload_img_entry, 1, binding);

  JSValue viewport = JS_NewObject(ctx);
  JS_SetPropertyStr(ctx, viewport, "w",
                    JS_NewUint32(ctx, binding->logical_width));
  JS_SetPropertyStr(ctx, viewport, "h",
                    JS_NewUint32(ctx, binding->logical_height));
  JS_SetPropertyStr(ctx, ui, "__viewport", viewport);
  JS_SetPropertyStr(ctx, ui, "__host", JS_NewString(ctx, binding->target_id));
  JS_SetPropertyStr(ctx, ui, "__hostAbi", JS_NewUint32(ctx, binding->host_abi));
  JS_SetPropertyStr(ctx, ui, "__tickHz", JS_NewUint32(ctx, binding->tick_hz));

  JSValue textures = JS_NewObjectProto(ctx, JS_NULL);
  for (size_t index = 0; index < binding->texture_count; ++index) {
    JS_SetPropertyStr(ctx, textures, binding->textures[index].name,
                      JS_NewInt32(ctx, binding->textures[index].handle));
  }
  JS_SetPropertyStr(ctx, ui, "__textures", textures);
  JSValue sprites = JS_NewObjectProto(ctx, JS_NULL);
  for (size_t index = 0; index < binding->sprite_count; ++index) {
    const sprite_registration_t *sprite = &binding->sprites[index];
    JSValue record = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, record, "handle", JS_NewInt32(ctx, sprite->handle));
    JS_SetPropertyStr(ctx, record, "frames", JS_NewUint32(ctx, sprite->frames));
    JS_SetPropertyStr(ctx, record, "cols", JS_NewUint32(ctx, sprite->columns));
    JS_SetPropertyStr(ctx, record, "step", JS_NewUint32(ctx, sprite->step));
    JS_SetPropertyStr(ctx, sprites, sprite->name, record);
  }
  JS_SetPropertyStr(ctx, ui, "__sprites", sprites);
  JSValue surfaces = JS_NewObject(ctx);
  JS_SetPropertyStr(ctx, ui, "__surfaces", surfaces);

  if (binding->pak != NULL) {
    pak = JS_NewArrayBuffer(ctx, (uint8_t *)binding->pak, binding->pak_size,
                            NULL, NULL, false);
    if (JS_IsException(pak) || JS_SetImmutableArrayBuffer(pak, true) < 0) {
      result = ESP_ERR_NO_MEM;
      goto done;
    }
  }
  if (JS_HasException(ctx))
    goto done;
  int installed =
      JS_DefinePropertyValue(ctx, global, ui_atom, ui, JS_PROP_C_W_E);
  ui = JS_UNDEFINED; /* DefinePropertyValue consumes the value on both paths. */
  if (installed < 0)
    goto done;
  if (!JS_IsUndefined(pak)) {
    installed =
        JS_DefinePropertyValue(ctx, global, pak_atom, pak, JS_PROP_C_W_E);
    pak = JS_UNDEFINED;
    if (installed < 0) {
      JS_DeleteProperty(ctx, global, ui_atom, 0);
      goto done;
    }
  }
  result = ESP_OK;
done:
  JS_FreeAtom(ctx, ui_atom);
  JS_FreeAtom(ctx, pak_atom);
  JS_FreeValue(ctx, ui);
  JS_FreeValue(ctx, pak);
  JS_FreeValue(ctx, global);
  return result;
}

esp_err_t pocketjs_ui_qjs_mount(pocketjs_ui_qjs_t *binding) {
  if (binding == NULL || binding->mounted) {
    return ESP_ERR_INVALID_STATE;
  }
  const esp_err_t result = pocketjs_guest_quickjs_install_once(
      binding->guest, "pocketjs.ui", install_ui, binding);
  if (result == ESP_OK)
    binding->mounted = true;
  return result;
}

static uint32_t pack_analog(int16_t value) {
  return (uint32_t)((int32_t)value + 32896) / 257U;
}

esp_err_t pocketjs_ui_turn(pocketjs_ui_qjs_t *binding,
                           const pocketjs_ui_input_t *input,
                           pocketjs_ui_frame_view_t *out_frame) {
  if (binding == NULL || !binding->mounted || out_frame == NULL ||
      out_frame->struct_size < sizeof(*out_frame) ||
      (input != NULL &&
       (input->struct_size < sizeof(*input) ||
        input->touch_count > POCKETJS_UI_MAX_TOUCHES ||
        (input->touch_count != 0U && input->touches == NULL)))) {
    return ESP_ERR_INVALID_ARG;
  }
  const pocketjs_ui_input_t empty = {.struct_size = sizeof(empty)};
  if (input == NULL)
    input = &empty;
  uint32_t touches[POCKETJS_UI_MAX_TOUCHES] = {0};
  int32_t hits[POCKETJS_UI_MAX_TOUCHES] = {0};
  for (size_t index = 0; index < input->touch_count; ++index) {
    if (input->touches[index].x > 511U || input->touches[index].y > 511U) {
      return ESP_ERR_INVALID_ARG;
    }
    touches[index] = ((uint32_t)input->touches[index].id << 18U) |
                     ((uint32_t)input->touches[index].y << 9U) |
                     input->touches[index].x;
  }
  const size_t hit_count =
      pocketjs_ui_core_touch_hits(binding->core, touches, input->touch_count,
                                  hits, POCKETJS_UI_MAX_TOUCHES);
  if (hit_count != input->touch_count)
    return ESP_FAIL;
  const pocketjs_guest_frame_t frame = {
      .struct_size = sizeof(frame),
      .buttons = input->buttons,
      .analog =
          (pack_analog(input->analog_x) << 8U) | pack_analog(input->analog_y),
      .touches = touches,
      .touch_hits = hits,
      .touch_count = input->touch_count,
  };
  esp_err_t result = pocketjs_guest_frame(binding->guest, &frame);
  if (result != ESP_OK)
    return result;
  pocketjs_ui_core_tick(binding->core);
  return pocketjs_ui_core_draw(binding->core, out_frame);
}

uint32_t pocketjs_ui_qjs_tick_hz(const pocketjs_ui_qjs_t *binding) {
  return binding != NULL && binding->mounted ? binding->tick_hz : 0U;
}

void pocketjs_ui_qjs_interrupt(pocketjs_ui_qjs_t *binding) {
  if (binding != NULL)
    pocketjs_guest_interrupt(binding->guest);
}

void pocketjs_ui_qjs_destroy(pocketjs_ui_qjs_t *binding) {
  if (binding == NULL)
    return;
  free_registrations(binding);
  free(binding->target_id);
  free(binding);
}
