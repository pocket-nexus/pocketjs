#include "pocket_input.h"
#include "pocket_runtime.h"
#include "pocket_spec.h"

#include <bps/bps.h>
#include <bps/event.h>
#include <bps/navigator.h>
#include <bps/screen.h>
#include <EGL/egl.h>
#include <GLES2/gl2.h>
#include <screen/screen.h>
#include <sys/keycodes.h>

#include <errno.h>
#include <limits.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#ifndef POCKET_BUILD_ID
#error "POCKET_BUILD_ID must identify the concrete BlackBerry QNX build"
#endif

/* The logical viewport comes from the resolved build plan (build.sh); the
 * defaults match the private blackberry-qnx-dev profile. */
#ifndef POCKET_LOGICAL_WIDTH
#define POCKET_LOGICAL_WIDTH 360
#endif
#ifndef POCKET_LOGICAL_HEIGHT
#define POCKET_LOGICAL_HEIGHT 360
#endif
#define DEFAULT_SURFACE_WIDTH 720
#define DEFAULT_SURFACE_HEIGHT 720

#define STATUS_PATH "data/pocketjs-qnx.status"

typedef struct {
  unsigned char *bytes;
  size_t length;
} Asset;

static screen_context_t screen_context;
static screen_window_t screen_window;
static EGLDisplay egl_display = EGL_NO_DISPLAY;
static EGLSurface egl_surface = EGL_NO_SURFACE;
static EGLContext egl_context = EGL_NO_CONTEXT;

static int surface_width = DEFAULT_SURFACE_WIDTH;
static int surface_height = DEFAULT_SURFACE_HEIGHT;
static int app_active = 1;
static int app_shutdown;
static int runtime_ready;
static PocketInputState input;

static unsigned long frame_count;
static unsigned long touch_event_count;
static unsigned long keyboard_event_count;
static unsigned long trackpad_event_count;
static unsigned long trackpad_click_count;
static int last_trackpad_dx;
static int last_trackpad_dy;
static int last_trackpad_x;
static int last_trackpad_y;
static int last_trackpad_buttons;
static int last_key_sym;
static int last_key_scan;
static int last_key_flags;
static unsigned long last_action_sequence;
static char status_stage[32] = "starting";
static char status_detail[256] = "host entry";
static int status_dirty = 1;
static char executable_directory[PATH_MAX];

static void set_error(const char *message)
{
  snprintf(status_detail, sizeof(status_detail), "%s", message == NULL ? "unknown error" : message);
  snprintf(status_stage, sizeof(status_stage), "%s", "error");
  status_dirty = 1;
  fprintf(stderr, "PocketJS Classic: %s\n", status_detail);
}

static void set_status(const char *stage, const char *detail)
{
  snprintf(status_stage, sizeof(status_stage), "%s", stage == NULL ? "unknown" : stage);
  snprintf(status_detail, sizeof(status_detail), "%s", detail == NULL ? "" : detail);
  status_dirty = 1;
  fprintf(stderr, "PocketJS Classic: %s: %s\n", status_stage, status_detail);
}

static void write_status(void)
{
  FILE *file;
  const char *action_name;
  if (!status_dirty) return;
  file = fopen(STATUS_PATH, "wb");
  if (file == NULL) {
    fprintf(stderr, "PocketJS Classic: cannot write %s: %s\n", STATUS_PATH, strerror(errno));
    return;
  }
  action_name = runtime_ready ? pocket_legacy_runtime_action_name() : "";
  fprintf(file, "schema=1\n");
  fprintf(file, "build_id=%s\n", POCKET_BUILD_ID);
  fprintf(file, "stage=%s\n", status_stage);
  fprintf(file, "detail=%s\n", status_detail);
  fprintf(file, "surface=%dx%d\n", surface_width, surface_height);
  fprintf(file, "logical=%dx%d\n", POCKET_LOGICAL_WIDTH, POCKET_LOGICAL_HEIGHT);
  fprintf(file, "frames=%lu\n", frame_count);
  fprintf(file, "touch_events=%lu\n", touch_event_count);
  fprintf(file, "keyboard_events=%lu\n", keyboard_event_count);
  fprintf(file, "trackpad_events=%lu\n", trackpad_event_count);
  fprintf(file, "trackpad_clicks=%lu\n", trackpad_click_count);
  fprintf(file, "trackpad_displacement=%d,%d\n", last_trackpad_dx, last_trackpad_dy);
  fprintf(file, "trackpad_position=%d,%d\n", last_trackpad_x, last_trackpad_y);
  fprintf(file, "trackpad_buttons=%d\n", last_trackpad_buttons);
  fprintf(file, "key_sym=%d\n", last_key_sym);
  fprintf(file, "key_scan=%d\n", last_key_scan);
  fprintf(file, "key_flags=%d\n", last_key_flags);
  fprintf(file, "action_sequence=%lu\n", runtime_ready ? pocket_legacy_runtime_action_sequence() : 0UL);
  fprintf(file, "action_name=%s\n", action_name == NULL ? "" : action_name);
  fprintf(file, "action_value=%d\n", runtime_ready ? pocket_legacy_runtime_action_value() : 0);
  fclose(file);
  status_dirty = 0;
}

static int integer_environment(const char *name, int fallback)
{
  const char *text = getenv(name);
  char *end = NULL;
  long value;
  if (text == NULL || text[0] == '\0') return fallback;
  value = strtol(text, &end, 10);
  if (end == text || *end != '\0' || value <= 0 || value > INT_MAX) return fallback;
  return (int)value;
}

static void initialize_executable_directory(const char *argv0)
{
  const char *slash;
  size_t length;
  executable_directory[0] = '\0';
  if (argv0 == NULL) return;
  slash = strrchr(argv0, '/');
  if (slash == NULL) return;
  length = (size_t)(slash - argv0);
  if (length == 0 || length >= sizeof(executable_directory)) return;
  memcpy(executable_directory, argv0, length);
  executable_directory[length] = '\0';
}

static int read_file(const char *path, Asset *asset)
{
  FILE *file;
  long end;
  unsigned char *bytes;
  size_t length;
  file = fopen(path, "rb");
  if (file == NULL) return 0;
  if (fseek(file, 0, SEEK_END) != 0) {
    fclose(file);
    return 0;
  }
  end = ftell(file);
  if (end <= 0 || end > 64L * 1024L * 1024L || fseek(file, 0, SEEK_SET) != 0) {
    fclose(file);
    return 0;
  }
  length = (size_t)end;
  bytes = (unsigned char *)malloc(length);
  if (bytes == NULL) {
    fclose(file);
    return 0;
  }
  if (fread(bytes, 1, length, file) != length) {
    free(bytes);
    fclose(file);
    return 0;
  }
  fclose(file);
  asset->bytes = bytes;
  asset->length = length;
  return 1;
}

static int read_asset(const char *name, Asset *asset)
{
  char path[PATH_MAX];
  const char *fallbacks[2];
  size_t index;
  asset->bytes = NULL;
  asset->length = 0;
  if (executable_directory[0] != '\0') {
    if (snprintf(path, sizeof(path), "%s/%s", executable_directory, name) < (int)sizeof(path) &&
        read_file(path, asset)) return 1;
  }
  fallbacks[0] = "app/native";
  fallbacks[1] = ".";
  for (index = 0; index < sizeof(fallbacks) / sizeof(fallbacks[0]); index += 1) {
    if (snprintf(path, sizeof(path), "%s/%s", fallbacks[index], name) >= (int)sizeof(path)) continue;
    if (read_file(path, asset)) return 1;
  }
  return 0;
}

static void destroy_graphics(void)
{
  if (egl_display != EGL_NO_DISPLAY) {
    eglMakeCurrent(egl_display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    if (egl_surface != EGL_NO_SURFACE) eglDestroySurface(egl_display, egl_surface);
    if (egl_context != EGL_NO_CONTEXT) eglDestroyContext(egl_display, egl_context);
    eglTerminate(egl_display);
  }
  egl_surface = EGL_NO_SURFACE;
  egl_context = EGL_NO_CONTEXT;
  egl_display = EGL_NO_DISPLAY;
  if (screen_window != NULL) screen_destroy_window(screen_window);
  if (screen_context != NULL) screen_destroy_context(screen_context);
  screen_window = NULL;
  screen_context = NULL;
  eglReleaseThread();
}

static int initialize_graphics(void)
{
  EGLConfig config;
  EGLint config_count = 0;
  EGLint config_attributes[] = {
    EGL_RED_SIZE, 8,
    EGL_GREEN_SIZE, 8,
    EGL_BLUE_SIZE, 8,
    EGL_SURFACE_TYPE, EGL_WINDOW_BIT,
    EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
    EGL_NONE
  };
  EGLint context_attributes[] = {EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE};
  int format = SCREEN_FORMAT_RGBX8888;
  int usage = SCREEN_USAGE_OPENGL_ES2;
  int size[2];
  char group[32];

  surface_width = integer_environment("WIDTH", DEFAULT_SURFACE_WIDTH);
  surface_height = integer_environment("HEIGHT", DEFAULT_SURFACE_HEIGHT);
  size[0] = surface_width;
  size[1] = surface_height;

  if (screen_create_context(&screen_context, SCREEN_APPLICATION_CONTEXT) != 0) {
    set_error("screen_create_context failed");
    return 0;
  }
  egl_display = eglGetDisplay(EGL_DEFAULT_DISPLAY);
  if (egl_display == EGL_NO_DISPLAY || !eglInitialize(egl_display, NULL, NULL) ||
      !eglBindAPI(EGL_OPENGL_ES_API) ||
      !eglChooseConfig(egl_display, config_attributes, &config, 1, &config_count) ||
      config_count != 1) {
    set_error("EGL display or configuration initialization failed");
    return 0;
  }
  egl_context = eglCreateContext(egl_display, config, EGL_NO_CONTEXT, context_attributes);
  if (egl_context == EGL_NO_CONTEXT) {
    set_error("eglCreateContext for OpenGL ES 2 failed");
    return 0;
  }
  if (screen_create_window(&screen_window, screen_context) != 0) {
    set_error("screen_create_window failed");
    return 0;
  }
  snprintf(group, sizeof(group), "pocketjs-%ld", (long)getpid());
  if (screen_create_window_group(screen_window, group) != 0 ||
      screen_set_window_property_iv(screen_window, SCREEN_PROPERTY_FORMAT, &format) != 0 ||
      screen_set_window_property_iv(screen_window, SCREEN_PROPERTY_USAGE, &usage) != 0 ||
      screen_set_window_property_iv(screen_window, SCREEN_PROPERTY_BUFFER_SIZE, size) != 0 ||
      screen_create_window_buffers(screen_window, 2) != 0) {
    set_error("libscreen window configuration failed");
    return 0;
  }
  egl_surface = eglCreateWindowSurface(egl_display, config, screen_window, NULL);
  if (egl_surface == EGL_NO_SURFACE ||
      !eglMakeCurrent(egl_display, egl_surface, egl_surface, egl_context) ||
      !eglSwapInterval(egl_display, 1)) {
    set_error("EGL window surface initialization failed");
    return 0;
  }
  glViewport(0, 0, surface_width, surface_height);
  glDisable(GL_DEPTH_TEST);
  glDisable(GL_CULL_FACE);
  return 1;
}

/* libscreen key symbols onto the portable mask (pocket_spec.h). */
static uint32_t button_for_key(int symbol)
{
  switch (symbol) {
    case KEYCODE_UP: return POCKET_BTN_UP;
    case KEYCODE_RIGHT: return POCKET_BTN_RIGHT;
    case KEYCODE_DOWN: return POCKET_BTN_DOWN;
    case KEYCODE_LEFT: return POCKET_BTN_LEFT;
    case KEYCODE_RETURN: return POCKET_BTN_CIRCLE;
    case KEYCODE_SPACE: return POCKET_BTN_START;
    case KEYCODE_MENU: return POCKET_BTN_TRIANGLE;
    default: return 0;
  }
}

static void handle_keyboard(screen_event_t event)
{
  int flags = 0;
  int symbol = 0;
  int scan = 0;
  if (screen_get_event_property_iv(event, SCREEN_PROPERTY_FLAGS, &flags) != 0) return;
  screen_get_event_property_iv(event, SCREEN_PROPERTY_SYM, &symbol);
  screen_get_event_property_iv(event, SCREEN_PROPERTY_SCAN, &scan);
  keyboard_event_count += 1;
  last_key_sym = symbol;
  last_key_scan = scan;
  last_key_flags = flags;
  status_dirty = 1;
  pocket_input_button(
    &input,
    button_for_key(symbol),
    (flags & SCREEN_FLAG_KEY_DOWN) != 0,
    (flags & SCREEN_FLAG_KEY_REPEAT) != 0
  );
}

static void handle_touch(screen_event_t event, int type)
{
  int position[2] = {0, 0};
  int id = -1;
  PocketTouchPhase phase;
  if (screen_get_event_property_iv(event, SCREEN_PROPERTY_SOURCE_POSITION, position) != 0 &&
      screen_get_event_property_iv(event, SCREEN_PROPERTY_POSITION, position) != 0) return;
  screen_get_event_property_iv(event, SCREEN_PROPERTY_TOUCH_ID, &id);
  touch_event_count += 1;
  status_dirty = 1;
  phase = type == SCREEN_EVENT_MTOUCH_TOUCH ? POCKET_TOUCH_DOWN
    : type == SCREEN_EVENT_MTOUCH_RELEASE ? POCKET_TOUCH_UP
    : POCKET_TOUCH_MOVE;
  pocket_input_touch(&input, phase, id, (float)position[0], (float)position[1]);
}

static void handle_trackpad(screen_event_t event)
{
  int displacement[2] = {0, 0};
  int position[2] = {0, 0};
  int buttons = 0;
  int primary;
  screen_get_event_property_iv(event, SCREEN_PROPERTY_DISPLACEMENT, displacement);
  screen_get_event_property_iv(event, SCREEN_PROPERTY_POSITION, position);
  screen_get_event_property_iv(event, SCREEN_PROPERTY_BUTTONS, &buttons);
  trackpad_event_count += 1;
  last_trackpad_dx = displacement[0];
  last_trackpad_dy = displacement[1];
  last_trackpad_x = position[0];
  last_trackpad_y = position[1];
  last_trackpad_buttons = buttons;
  status_dirty = 1;
  /* Integer joystick displacement: every non-zero event is one focus pulse. */
  pocket_input_relative(&input, (float)displacement[0], (float)displacement[1]);
  primary = buttons != 0;
  if (primary && !input.primary_down) trackpad_click_count += 1;
  pocket_input_primary(&input, primary);
}

static void handle_screen_event(bps_event_t *event)
{
  screen_event_t screen_event = screen_event_get_event(event);
  int type = SCREEN_EVENT_NONE;
  if (screen_event == NULL ||
      screen_get_event_property_iv(screen_event, SCREEN_PROPERTY_TYPE, &type) != 0) return;
  switch (type) {
    case SCREEN_EVENT_KEYBOARD:
      handle_keyboard(screen_event);
      break;
    case SCREEN_EVENT_MTOUCH_TOUCH:
    case SCREEN_EVENT_MTOUCH_MOVE:
    case SCREEN_EVENT_MTOUCH_RELEASE:
      handle_touch(screen_event, type);
      break;
    case SCREEN_EVENT_JOYSTICK:
      handle_trackpad(screen_event);
      break;
    default:
      break;
  }
}

static void handle_navigator_event(bps_event_t *event)
{
  int code = bps_event_get_code(event);
  switch (code) {
    case NAVIGATOR_EXIT:
      app_shutdown = 1;
      break;
    case NAVIGATOR_WINDOW_ACTIVE:
      app_active = 1;
      set_status("running", "window active");
      break;
    case NAVIGATOR_WINDOW_INACTIVE:
      app_active = 0;
      set_status("inactive", "window inactive");
      break;
    case NAVIGATOR_ORIENTATION_CHECK:
      navigator_orientation_check_response(event, false);
      break;
    case NAVIGATOR_SYSKEY_PRESS: {
      int key = navigator_event_get_syskey_key(event);
      const char *id = navigator_event_get_syskey_id(event);
      int handled = key == NAVIGATOR_SYSKEY_SEND;
      if (handled) pocket_input_pulse(&input, POCKET_BTN_CIRCLE);
      if (id != NULL) navigator_syskey_press_response(id, handled != 0);
      status_dirty = 1;
      break;
    }
    default:
      break;
  }
}

static void handle_event(bps_event_t *event)
{
  int domain;
  if (event == NULL) return;
  domain = bps_event_get_domain(event);
  if (domain == screen_get_domain()) handle_screen_event(event);
  else if (domain == navigator_get_domain()) handle_navigator_event(event);
}

static int render_frame(void)
{
  PocketInputSample sample;
  PocketRuntimeInput frame;
  unsigned long action_sequence;

  pocket_input_sample(&input, &sample);
  frame.buttons = sample.buttons;
  frame.touch_down = sample.touch_down;
  frame.touch_x = (int)(sample.touch_x * POCKET_LOGICAL_WIDTH / (surface_width > 0 ? surface_width : 1));
  frame.touch_y = (int)(sample.touch_y * POCKET_LOGICAL_HEIGHT / (surface_height > 0 ? surface_height : 1));
  frame.touch_hit = sample.touch_down
    ? pocket_legacy_runtime_hit_test_bounds((float)frame.touch_x, (float)frame.touch_y)
    : 0;
  if (!pocket_legacy_runtime_tick(&frame)) {
    set_error(pocket_legacy_runtime_error());
    return 0;
  }
  if (!pocket_legacy_runtime_gl_render(surface_width, surface_height) ||
      !eglSwapBuffers(egl_display, egl_surface)) {
    set_error("OpenGL ES frame presentation failed");
    return 0;
  }
  frame_count += 1;
  action_sequence = pocket_legacy_runtime_action_sequence();
  if (action_sequence != last_action_sequence) {
    last_action_sequence = action_sequence;
    set_status("action", pocket_legacy_runtime_action_name());
  }
  write_status();
  return 1;
}

int main(int argc, char **argv)
{
  Asset java_script = {NULL, 0};
  Asset pack = {NULL, 0};
  bps_event_t *event = NULL;
  int exit_code = EXIT_FAILURE;
  (void)argc;

  initialize_executable_directory(argv == NULL ? NULL : argv[0]);
  pocket_input_init(&input, 1.0f);
  write_status();
  if (bps_initialize() != BPS_SUCCESS) {
    set_error("bps_initialize failed");
    goto cleanup;
  }
  if (!initialize_graphics()) goto cleanup_bps;
  if (screen_request_events(screen_context) != BPS_SUCCESS ||
      navigator_request_events(0) != BPS_SUCCESS) {
    set_error("BPS screen or navigator event registration failed");
    goto cleanup_graphics;
  }
  if (!read_asset("app.js", &java_script) || !read_asset("app.pak", &pack)) {
    set_error("cannot read packaged app.js or app.pak");
    goto cleanup_graphics;
  }
  if (!pocket_legacy_runtime_boot(
        (const char *)java_script.bytes,
        java_script.length,
        pack.bytes,
        pack.length,
        POCKET_LOGICAL_WIDTH,
        POCKET_LOGICAL_HEIGHT
      )) {
    set_error(pocket_legacy_runtime_error());
    goto cleanup_graphics;
  }
  runtime_ready = 1;
  if (!pocket_legacy_runtime_gl_initialize()) {
    set_error("PocketJS GLES2 backend initialization failed");
    goto cleanup_runtime;
  }
  set_status("running", "Hero mounted");
  write_status();

  while (!app_shutdown) {
    int timeout = app_active ? 0 : -1;
    if (bps_get_event(&event, timeout) != BPS_SUCCESS) {
      set_error("bps_get_event failed");
      break;
    }
    handle_event(event);
    if (app_active) {
      do {
        event = NULL;
        if (bps_get_event(&event, 0) != BPS_SUCCESS) {
          set_error("bps_get_event drain failed");
          app_shutdown = 1;
          break;
        }
        handle_event(event);
      } while (event != NULL && !app_shutdown && app_active);
      if (!app_shutdown && !render_frame()) app_shutdown = 1;
    } else {
      write_status();
    }
  }
  exit_code = status_stage[0] == 'e' ? EXIT_FAILURE : EXIT_SUCCESS;

cleanup_runtime:
  if (runtime_ready) {
    pocket_legacy_runtime_gl_shutdown();
    pocket_legacy_runtime_shutdown();
    runtime_ready = 0;
  }
cleanup_graphics:
  destroy_graphics();
cleanup_bps:
  bps_shutdown();
cleanup:
  free(pack.bytes);
  free(java_script.bytes);
  if (exit_code == EXIT_SUCCESS) set_status("stopped", "navigator exit");
  write_status();
  return exit_code;
}
