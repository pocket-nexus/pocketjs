#include "pocket_runtime.h"

#include "pocket_ui_cabi.h"
#include "quickjs.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct JSRuntime {
  int alive;
};

struct JSContext {
  int alive;
};

enum Scenario {
  SCENARIO_SUCCESS,
  SCENARIO_BOOT_EVAL_FAILURE,
  SCENARIO_BOOT_FRAME_MISSING,
  SCENARIO_BOOT_JOB_FAILURE,
  SCENARIO_FRAME_JS_FAILURE,
  SCENARIO_FRAME_JOB_FAILURE,
};

enum {
  VALUE_OBJECT = 0x100,
  VALUE_FRAME_FUNCTION = 0x101,
  VALUE_HARNESS_FUNCTION = 0x102,
};

static struct JSRuntime stub_runtime;
static struct JSContext stub_context;
static enum Scenario scenario;
static int boot_job_calls;
static int frame_job_calls;
static int frame_started;
static int dispatcher_queued_job;
#if defined(POCKET_RUNTIME_STAGE_HOOKS)
static int stages[32];
static size_t stage_count;
#endif
static uint8_t framebuffer[4];
static JSCFunctionMagic *animation_completions;
static int animation_completions_magic;
static int animation_completions_delivered;

static void reset_stubs(enum Scenario next) {
  scenario = next;
  boot_job_calls = 0;
  frame_job_calls = 0;
  frame_started = 0;
  dispatcher_queued_job = 0;
#if defined(POCKET_RUNTIME_STAGE_HOOKS)
  stage_count = 0;
#endif
}

static int boot(enum Scenario next) {
  static const uint8_t pack[1] = {0};
  reset_stubs(next);
  return pocket_runtime_boot("bundle", 6, pack, sizeof(pack), 480, 272);
}

#if defined(POCKET_RUNTIME_STAGE_HOOKS)
void pocket_bench_stage(int stage) {
  if (stage_count >= sizeof(stages) / sizeof(stages[0])) {
    fputs("too many stage callbacks\n", stderr);
    exit(1);
  }
  stages[stage_count++] = stage;
}

static int expect_stages(const char *label, const int *expected, size_t count) {
  size_t index;
  if (stage_count != count) {
    fprintf(stderr, "%s: got %zu stages, expected %zu\n", label, stage_count,
            count);
    return 0;
  }
  for (index = 0; index < count; index += 1) {
    if (stages[index] != expected[index]) {
      fprintf(stderr, "%s: stage %zu is %d, expected %d\n", label, index,
              stages[index], expected[index]);
      return 0;
    }
  }
  return 1;
}

static int test_boot_sequences(void) {
  static const int success[] = {
      POCKET_BENCH_STAGE_EVAL,
      POCKET_BENCH_STAGE_IDLE,
      POCKET_BENCH_STAGE_JOBS,
      POCKET_BENCH_STAGE_IDLE,
  };
  static const int eval_failure[] = {
      POCKET_BENCH_STAGE_EVAL,
      POCKET_BENCH_STAGE_IDLE,
  };

  if (!boot(SCENARIO_SUCCESS) || !expect_stages("boot success", success, 4))
    return 0;
  pocket_runtime_shutdown();
  if (boot(SCENARIO_BOOT_EVAL_FAILURE) ||
      !expect_stages("boot eval failure", eval_failure, 2))
    return 0;
  if (boot(SCENARIO_BOOT_FRAME_MISSING) ||
      !expect_stages("boot frame missing", eval_failure, 2))
    return 0;
  if (boot(SCENARIO_BOOT_JOB_FAILURE) ||
      !expect_stages("boot job failure", success, 4))
    return 0;
  return 1;
}

static int test_frame_sequences(void) {
  static const int success[] = {
      POCKET_BENCH_STAGE_JS,
      POCKET_BENCH_STAGE_JOBS,
      POCKET_BENCH_STAGE_TICK,
      POCKET_BENCH_STAGE_IDLE,
  };
  static const int js_failure[] = {
      POCKET_BENCH_STAGE_JS,
      POCKET_BENCH_STAGE_IDLE,
  };
  static const int job_failure[] = {
      POCKET_BENCH_STAGE_JS,
      POCKET_BENCH_STAGE_JOBS,
      POCKET_BENCH_STAGE_IDLE,
  };
  PocketRuntimeInput input = {0};

  if (!boot(SCENARIO_SUCCESS))
    return 0;
  stage_count = 0;
  if (!pocket_runtime_tick(&input) ||
      !expect_stages("frame success", success, 4))
    return 0;
  pocket_runtime_shutdown();

  if (!boot(SCENARIO_FRAME_JS_FAILURE))
    return 0;
  stage_count = 0;
  if (pocket_runtime_tick(&input) ||
      !expect_stages("frame JS failure", js_failure, 2))
    return 0;
  pocket_runtime_shutdown();

  if (!boot(SCENARIO_FRAME_JOB_FAILURE))
    return 0;
  stage_count = 0;
  if (pocket_runtime_tick(&input) ||
      !expect_stages("frame job failure", job_failure, 3))
    return 0;
  pocket_runtime_shutdown();
  return 1;
}
#endif

#if defined(POCKET_RUNTIME_HARNESS)
static int test_dispatcher_contract(void) {
#if defined(POCKET_RUNTIME_STAGE_HOOKS)
  static const int frame[] = {
      POCKET_BENCH_STAGE_JS,
      POCKET_BENCH_STAGE_JOBS,
      POCKET_BENCH_STAGE_TICK,
      POCKET_BENCH_STAGE_IDLE,
  };
#endif
  PocketRuntimeInput input = {0};
  int32_t value = 0;

  if (!boot(SCENARIO_SUCCESS))
    return 0;
#if defined(POCKET_RUNTIME_STAGE_HOOKS)
  stage_count = 0;
#endif
  if (pocket_runtime_harness_call(7, 35, &value))
    return 0;
  if (pocket_runtime_harness_bind("missing"))
    return 0;
  if (!pocket_runtime_harness_bind("__pocketHarnessDispatch"))
    return 0;
  if (!pocket_runtime_harness_call(7, 35, &value) || value != 42)
    return 0;
#if defined(POCKET_RUNTIME_STAGE_HOOKS)
  if (!expect_stages("harness call", NULL, 0))
    return 0;
#endif
  if (!pocket_runtime_tick(&input))
    return 0;
#if defined(POCKET_RUNTIME_STAGE_HOOKS)
  if (!expect_stages("dispatcher jobs", frame, 4))
    return 0;
#endif
  pocket_runtime_shutdown();
  if (pocket_runtime_harness_call(7, 35, &value))
    return 0;
  return 1;
}
#endif

int main(void) {
  if (!boot(SCENARIO_SUCCESS) || !animation_completions) return 1;
  animation_completions(&stub_context, JS_UNDEFINED, 0, NULL, animation_completions_magic);
  if (!animation_completions_delivered) return 1;
  pocket_runtime_shutdown();
#if defined(POCKET_RUNTIME_STAGE_HOOKS)
  if (!test_boot_sequences() || !test_frame_sequences())
    return 1;
#else
  PocketRuntimeInput input = {0};
  if (!boot(SCENARIO_SUCCESS) || !pocket_runtime_tick(&input))
    return 1;
  pocket_runtime_shutdown();
#endif
#if defined(POCKET_RUNTIME_HARNESS)
  if (!test_dispatcher_contract())
    return 1;
#endif
  puts("quickjs-c harness: ok");
  return 0;
}

JSRuntime *JS_NewRuntime(void) {
  stub_runtime.alive = 1;
  return &stub_runtime;
}

void JS_FreeRuntime(JSRuntime *runtime) { runtime->alive = 0; }
void JS_SetMaxStackSize(JSRuntime *runtime, size_t size) {}

JSContext *JS_NewContext(JSRuntime *runtime) {
  stub_context.alive = 1;
  return &stub_context;
}

void JS_FreeContext(JSContext *context) { context->alive = 0; }
JSValue JS_GetGlobalObject(JSContext *context) { return VALUE_OBJECT; }
JSValue JS_GetException(JSContext *context) { return VALUE_OBJECT; }
int JS_HasException(JSContext *context) { return 0; }
int JS_IsException(JSValueConst value) { return value == JS_EXCEPTION; }
int JS_IsUndefined(JSValueConst value) { return value == JS_UNDEFINED; }
int JS_IsFunction(JSContext *context, JSValueConst value) {
  return value == VALUE_FRAME_FUNCTION || value == VALUE_HARNESS_FUNCTION;
}
void JS_FreeValue(JSContext *context, JSValue value) {}

const char *JS_ToCStringLen2(JSContext *context, size_t *length,
                             JSValueConst value, int cesu8) {
  static const char message[] = "stub exception";
  *length = sizeof(message) - 1;
  return message;
}

void JS_FreeCString(JSContext *context, const char *value) {}

int JS_ToInt32(JSContext *context, int32_t *out, JSValueConst value) {
  *out = (int32_t)value;
  return 0;
}

int JS_ToUint32(JSContext *context, uint32_t *out, JSValueConst value) {
  *out = (uint32_t)value;
  return 0;
}

int JS_ToFloat64(JSContext *context, double *out, JSValueConst value) {
  *out = (double)value;
  return 0;
}

JSValue JS_NewInt32(JSContext *context, int32_t value) { return value; }
JSValue JS_NewUint32(JSContext *context, uint32_t value) { return value; }
JSValue JS_NewFloat64(JSContext *context, double value) {
  return (JSValue)value;
}
JSValue JS_NewBool(JSContext *context, int value) { return value; }
JSValue JS_NewString(JSContext *context, const char *value) {
  return VALUE_OBJECT;
}
JSValue JS_NewStringLen(JSContext *context, const char *value, size_t length) {
  if (length == 8 && memcmp(value, "[[42,1]]", length) == 0) animation_completions_delivered = 1;
  return VALUE_OBJECT;
}
JSValue JS_NewObject(JSContext *context) { return VALUE_OBJECT; }
JSValue JS_NewArray(JSContext *context) { return VALUE_OBJECT; }

JSValue JS_NewArrayBuffer(JSContext *context, uint8_t *buffer, size_t length,
                          void (*free_func)(JSRuntime *runtime, void *opaque,
                                            void *pointer),
                          void *opaque, int shared) {
  return VALUE_OBJECT;
}

uint8_t *JS_GetArrayBuffer(JSContext *context, size_t *length,
                           JSValueConst value) {
  *length = sizeof(framebuffer);
  return framebuffer;
}

JSValue JS_GetTypedArrayBuffer(JSContext *context, JSValueConst value,
                               size_t *offset, size_t *length,
                               size_t *bytes_per_element) {
  *offset = 0;
  *length = sizeof(framebuffer);
  *bytes_per_element = 1;
  return VALUE_OBJECT;
}

JSValue JS_NewCFunctionMagic(JSContext *context, JSCFunctionMagic *function,
                             const char *name, int length, JSCFunctionEnum kind,
                             int magic) {
  if (strcmp(name, "takeAnimationCompletions") == 0) {
    animation_completions = function;
    animation_completions_magic = magic;
  }
  return VALUE_FRAME_FUNCTION;
}

int JS_SetPropertyStr(JSContext *context, JSValueConst object, const char *name,
                      JSValue value) {
  return 0;
}

int JS_SetPropertyUint32(JSContext *context, JSValueConst object,
                         uint32_t index, JSValue value) {
  return 0;
}

JSValue JS_GetPropertyStr(JSContext *context, JSValueConst object,
                          const char *name) {
  if (strcmp(name, "frame") == 0) {
    return scenario == SCENARIO_BOOT_FRAME_MISSING ? JS_UNDEFINED
                                                   : VALUE_FRAME_FUNCTION;
  }
  if (strcmp(name, "__pocketHarnessDispatch") == 0)
    return VALUE_HARNESS_FUNCTION;
  return VALUE_OBJECT;
}

JSValue JS_Eval(JSContext *context, const char *source, size_t length,
                const char *filename, int flags) {
  if (strcmp(filename, "app.js") == 0 &&
      scenario == SCENARIO_BOOT_EVAL_FAILURE) {
    return JS_EXCEPTION;
  }
  return VALUE_OBJECT;
}

JSValue JS_Call(JSContext *context, JSValueConst function,
                JSValueConst this_value, int argc, JSValueConst *argv) {
  if (function == VALUE_HARNESS_FUNCTION) {
    dispatcher_queued_job = 1;
    return argv[0] + argv[1];
  }
  frame_started = 1;
  return scenario == SCENARIO_FRAME_JS_FAILURE ? JS_EXCEPTION : VALUE_OBJECT;
}

int JS_ExecutePendingJob(JSRuntime *runtime, JSContext **context) {
  *context = &stub_context;
  if (!frame_started) {
    if (scenario == SCENARIO_BOOT_JOB_FAILURE && boot_job_calls == 0)
      return -1;
    return boot_job_calls++ == 0 ? 1 : 0;
  }
  if (scenario == SCENARIO_FRAME_JOB_FAILURE && frame_job_calls == 0)
    return -1;
  if (dispatcher_queued_job) {
    dispatcher_queued_job = 0;
    return 1;
  }
  return frame_job_calls++ == 0 ? 1 : 0;
}

JSValue JS_ThrowTypeError(JSContext *context, const char *format, ...) {
  return JS_EXCEPTION;
}
JSValue JS_ThrowRangeError(JSContext *context, const char *format, ...) {
  return JS_EXCEPTION;
}
JSValue JS_ThrowInternalError(JSContext *context, const char *format, ...) {
  return JS_EXCEPTION;
}

void ui_init(uint32_t raster_density) {}
void ui_shutdown(void) {}
void ui_set_viewport(float width, float height) {}
int32_t ui_create_node(uint32_t node_type) { return 2; }
void ui_destroy_node(int32_t id) {}
void ui_insert_before(int32_t parent, int32_t child, int32_t anchor) {}
void ui_remove_child(int32_t parent, int32_t child) {}
void ui_set_style(int32_t id, int32_t style_id) {}
void ui_set_prop(int32_t id, uint32_t prop, double value) {}
void ui_set_prop_batch(const uint8_t *bytes, size_t length) {}
void ui_set_text(int32_t id, const uint8_t *text, size_t length) {}
void ui_replace_text(int32_t id, const uint8_t *text, size_t length) {}
int32_t ui_upload_texture(const uint8_t *bytes, size_t length, uint32_t width,
                          uint32_t height, uint32_t pixel_storage) {
  return 0;
}
int32_t ui_upload_img_entry(const uint8_t *bytes, size_t length) { return 0; }
void ui_free_texture(int32_t handle) {}
void ui_set_image(int32_t id, int32_t texture) {}
void ui_set_sprite(int32_t id, int32_t atlas, uint32_t frames, uint32_t columns,
                   uint32_t step) {}
int32_t ui_animate(int32_t id, uint32_t prop, double to, uint32_t duration_ms,
                   uint32_t easing, uint32_t delay_ms) {
  return 1;
}
void ui_cancel_anim(int32_t animation_id) {}
const uint8_t *ui_take_animation_completions_json(size_t *length) {
  *length = 8;
  return (const uint8_t *)"[[42,1]]";
}
void ui_set_focus(int32_t id) {}
void ui_set_active(int32_t id, int32_t active) {}
int32_t ui_hit_test(float x, float y) { return 0; }
int32_t ui_hit_test_bounds(float x, float y) { return 0; }
void ui_set_cursor(int32_t texture, float hot_x, float hot_y, float width,
                   float height) {}
void ui_set_cursor_pos(float x, float y) {}
int32_t ui_load_styles(const uint8_t *bytes, size_t length) { return 1; }
int32_t ui_load_font_atlas(const uint8_t *bytes, size_t length) { return 1; }
float ui_measure_text(const uint8_t *text, size_t length, uint32_t font_slot) {
  return 0.0f;
}
void ui_tick(void) {}
void ui_debug_inspect(int32_t id) {}
int32_t ui_debug_rect_xy(void) { return 0; }
int32_t ui_debug_rect_wh(void) { return 0; }
void ui_debug_pause(int32_t paused) {}
void ui_debug_step(void) {}
const uint8_t *ui_render_incremental(void) { return framebuffer; }
uint32_t ui_framebuffer_width(void) { return 1; }
uint32_t ui_framebuffer_height(void) { return 1; }
uint32_t ui_framebuffer_stride(void) { return 4; }
size_t ui_framebuffer_len(void) { return sizeof(framebuffer); }
uint64_t ui_damage_attempts(void) { return 0; }
uint64_t ui_damage_failures(void) { return 0; }
uint64_t ui_damage_full_redraws(void) { return 0; }
uint32_t ui_damage_regions(void) { return 0; }
uint64_t ui_damage_pixels(void) { return 0; }
int32_t ui_damage_bounds(int32_t *out) { return 0; }
int32_t ui_gl_initialize(void) { return 1; }
void ui_gl_reset_resources(void) {}
void ui_gl_shutdown(void) {}
int32_t ui_gl_render(int32_t target_x, int32_t target_y, int32_t target_width,
                     int32_t target_height, int32_t window_width,
                     int32_t window_height) {
  return 1;
}
