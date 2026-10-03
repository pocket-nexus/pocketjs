#include "pocket_wii.h"

#include <string.h>

#include "pocket_core.h"
#include "qjs.h"
#include "drawlist.h"
#include "gx_font.h"
#include "gx_solid.h"
#include "gx_textured.h"

#define POCKET_WII_TARGET "wii-dev"
#define POCKET_WII_HOST_ABI 7

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

extern int32_t pocket_package_open(
  const uint8_t *bytes,
  size_t length,
  const uint8_t *target,
  size_t target_length,
  uint32_t host_abi,
  PocketGuestPackage *out
);
extern void pocket_wii_gx_texture_cache_clear(void);

static const uint8_t *active_package;
static int core_initialized;
static char last_error[512];

typedef struct {
  PocketWiiGXContext gx;
  const char *error;
} PocketWiiDrawContext;

static void set_error(const char *message) {
  size_t length = message == NULL ? 0 : strlen(message);
  if (length >= sizeof last_error) length = sizeof last_error - 1;
  if (length != 0) memcpy(last_error, message, length);
  last_error[length] = '\0';
}

static const char *admission_error(int32_t code) {
  switch (code) {
    case 1: return "package is truncated";
    case 2: return "package has an invalid magic value";
    case 3: return "package version is unsupported";
    case 4: return "package hash does not match its contents";
    case 5: return "package contains invalid UTF-8";
    case 6: return "package has no wii-dev guest variant";
    case 7: return "package HostOps ABI does not match expected ABI 7";
    case 8: return "package is missing its identity section";
    case 9: return "package is missing its build plan";
    case 10: return "package is missing JavaScript";
    case 11: return "package JavaScript is not NUL-terminated";
    case 12: return "package bytes and length must be valid";
    default: return "package admission failed";
  }
}

static const char *drawlist_error(PocketWiiDrawListResult result) {
  switch (result) {
    case POCKET_WII_DRAWLIST_INVALID_ARGUMENT: return "DrawList pointer is invalid";
    case POCKET_WII_DRAWLIST_TRUNCATED: return "DrawList operation is truncated";
    case POCKET_WII_DRAWLIST_MALFORMED: return "DrawList operation is malformed";
    case POCKET_WII_DRAWLIST_UNSUPPORTED_OP: return "DrawList contains an unsupported operation";
    case POCKET_WII_DRAWLIST_CALLBACK_FAILED: return "GX draw operation failed";
    default: return "DrawList validation failed";
  }
}

static bool draw_op(const uint32_t *op, size_t word_count, void *opaque) {
  PocketWiiDrawContext *context = opaque;
  bool ok;
  switch (op[0]) {
    case POCKET_WII_DRAW_RECT:
    case POCKET_WII_DRAW_GRAD_RECT:
    case POCKET_WII_DRAW_TRI:
    case POCKET_WII_DRAW_SCISSOR:
    case POCKET_WII_DRAW_SCISSOR_POP:
      ok = pocket_wii_gx_solid_op(&context->gx, op, word_count);
      if (!ok) {
        context->error = op[0] == POCKET_WII_DRAW_GRAD_RECT
          ? "GX gradient has an invalid direction"
          : "GX solid operation failed or has an invalid clip stack";
      }
      return ok;
    case POCKET_WII_DRAW_TEX_QUAD:
    case POCKET_WII_DRAW_TEX_TRI:
      ok = pocket_wii_gx_textured_op(&context->gx, op, word_count);
      if (!ok) context->error = "GX textured operation has an invalid texture or data";
      return ok;
    case POCKET_WII_DRAW_GLYPH_RUN:
      ok = pocket_wii_gx_font_op(&context->gx, op, word_count);
      if (!ok) context->error = "GX glyph run has an invalid font atlas or data";
      return ok;
    default:
      context->error = "DrawList contains an unsupported operation";
      return false;
  }
}

static void release_guest(void) {
  pocket_wii_gx_font_cache_clear();
  pocket_wii_gx_texture_cache_clear();
  qjs_shutdown();
  if (core_initialized) ui_shutdown();
  core_initialized = 0;
  active_package = NULL;
}

void pocket_wii_shutdown(void) {
  release_guest();
  last_error[0] = '\0';
}

int32_t pocket_wii_boot(const uint8_t *package_bytes, size_t package_length) {
  last_error[0] = '\0';
  if (active_package != NULL) {
    set_error("guest already booted; call pocket_wii_shutdown first");
    return 1;
  }

  static const uint8_t target[] = POCKET_WII_TARGET;
  PocketGuestPackage guest = {0};
  int32_t result = pocket_package_open(package_bytes, package_length,
    target, sizeof target - 1, POCKET_WII_HOST_ABI, &guest);
  if (result != 0) {
    set_error(admission_error(result));
    return 1;
  }

  ui_init(1);
  core_initialized = 1;
  ui_set_viewport(480.0f, 272.0f);
  ui_feed_pak(guest.pak, guest.pak_length);

  if (guest.javascript_length == 0 ||
      !qjs_boot((const char *)guest.javascript, guest.javascript_length - 1,
        guest.pak, guest.pak_length)) {
    const char *message = qjs_last_error();
    set_error(message != NULL && message[0] != '\0'
      ? message : "QuickJS guest boot failed");
    release_guest();
    return 1;
  }

  active_package = package_bytes;
  return 0;
}

int32_t pocket_wii_tick(uint32_t buttons, uint32_t analog) {
  last_error[0] = '\0';
  if (active_package == NULL || !core_initialized) {
    set_error("guest is not booted");
    return 1;
  }
  if (!qjs_frame(buttons, analog)) {
    const char *message = qjs_last_error();
    set_error(message != NULL && message[0] != '\0'
      ? message : "QuickJS guest frame failed");
    return 1;
  }
  ui_tick();
  return 0;
}

int32_t pocket_wii_draw(
  int32_t x,
  int32_t y,
  uint32_t width,
  uint32_t height
) {
  last_error[0] = '\0';
  if (active_package == NULL || !core_initialized) {
    set_error("guest is not booted");
    return 1;
  }
  if (width == 0 || height == 0) {
    set_error("draw destination width and height must be nonzero");
    return 1;
  }

  size_t word_count = ui_draw();
  const uint32_t *words = ui_draw_list_ptr();
  if (ui_draw_list_len() != word_count || (words == NULL && word_count != 0)) {
    set_error("core returned an invalid DrawList");
    return 1;
  }

  PocketWiiDrawListResult result = pocket_wii_drawlist_walk(
    words, word_count, NULL, NULL
  );
  if (result != POCKET_WII_DRAWLIST_OK) {
    set_error(drawlist_error(result));
    return 1;
  }

  PocketWiiDrawContext context = {0};
  if (!pocket_wii_gx_context_begin(&context.gx, x, y, width, height)) {
    set_error("could not begin PocketJS GX draw context");
    return 1;
  }
  result = pocket_wii_drawlist_walk(words, word_count, draw_op, &context);
  if (result != POCKET_WII_DRAWLIST_OK) {
    set_error(context.error != NULL ? context.error : drawlist_error(result));
    return 1;
  }
  return 0;
}

const char *pocket_wii_last_error(void) {
  return last_error;
}
