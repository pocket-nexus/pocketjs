#include <android/log.h>
#include <jni.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "pocket/android_input.h"
#include "pocket/android_jni.h"
#include "pocket/android_hooks.h"
#include "pocket/compat/input_types.h"
#include "pocket_legacy_runtime.h"
#include "pocket_spec.h"

#define LOG_TAG "PocketJSAndroid"


/* The logical viewport comes from the resolved build plan (tools/android.ts);
 * the defaults match the private moto-g-play-dev profile. PocketActivity
 * sizes the surface to this aspect ratio inside the window and centres it,
 * so the picture has one scale in both directions on every panel, and a
 * contact arrives relative to the surface. */
#ifndef POCKET_LOGICAL_WIDTH
#define POCKET_LOGICAL_WIDTH 360
#endif
#ifndef POCKET_LOGICAL_HEIGHT
#define POCKET_LOGICAL_HEIGHT 800
#endif

static pocket_android_input *input;
static int surface_width = 720;
static int surface_height = 720;

static int runtime_booted;
static int gl_initialized;
static char android_error[512];
static char receipt_path[1024];
static unsigned long frames;
static _Atomic unsigned long touch_sequences;
/* Sums over the 60 frames between two receipts, in microseconds: the guest's
 * frame() with the core's tick, the GL submission, and the slowest of their
 * sums. The mean interval is the time the 60 frames took, swap included. */
static uint64_t window_tick_us, window_render_us, window_started_us;
static uint32_t window_worst_us;

JNIEXPORT jint JNICALL Java_dev_pocketnexus_android_PocketActivity_nativeLogicalWidth(JNIEnv *env, jclass owner) {
  (void)env; (void)owner; return POCKET_LOGICAL_WIDTH;
}
JNIEXPORT jint JNICALL Java_dev_pocketnexus_android_PocketActivity_nativeLogicalHeight(JNIEnv *env, jclass owner) {
  (void)env; (void)owner; return POCKET_LOGICAL_HEIGHT;
}
JNIEXPORT void JNICALL Java_dev_pocketnexus_android_PocketActivity_nativeConfigure(JNIEnv *env, jclass owner, jstring directory) {
  (void)owner;
  if (!input) {
    pocket_android_input_config config = {sizeof(config), POCKET_LOGICAL_WIDTH, POCKET_LOGICAL_HEIGHT,
      0.35f, POCKET_INPUT_CLASS_BUTTONS | POCKET_INPUT_CLASS_CONTACT};
    input = pocket_android_input_create(&config);
  }
  const char *path = (*env)->GetStringUTFChars(env, directory, NULL);
  if (!path) return;
  snprintf(receipt_path, sizeof receipt_path, "%s/runtime.txt", path);
#ifdef POCKET_OFFLOAD_POSIX
  char key[1024]; snprintf(key, sizeof key, "%s/offload.key", path);
  pocket_legacy_runtime_offload_key(key);
#endif
  (*env)->ReleaseStringUTFChars(env, directory, path);
}
JNIEXPORT void JNICALL Java_dev_pocketnexus_android_PocketActivity_nativeCancelTouches(JNIEnv *env, jclass owner) {
  (void)env; (void)owner;
  pocket_android_input_cancel_touches(input);
}


static void set_android_error(const char *message)
{
  size_t length = message == NULL ? 0 : strlen(message);
  if (length >= sizeof(android_error)) length = sizeof(android_error) - 1;
  if (length > 0) memcpy(android_error, message, length);
  android_error[length] = '\0';
  pocket_android_log(ANDROID_LOG_ERROR, LOG_TAG, android_error, length);
}

/* The APK shell consumes the generic driver's facts through its compatibility
 * program bridge. Hit ownership remains inside the canonical Runtime. */
static int32_t collect_input(void *context, const pocket_input_frame *source)
{
  PocketRuntimeContactsInput *out = context;
  if (source->contact_count > POCKET_RUNTIME_MAX_CONTACTS || source->cancelled_count > POCKET_RUNTIME_MAX_CONTACTS)
    return POCKET_STATUS_INVALID;
  out->buttons = source->buttons;
  out->contact_count = (unsigned)source->contact_count;
  out->cancelled_count = (unsigned)source->cancelled_count;
  for (unsigned i = 0; i < out->contact_count; i++) {
    const pocket_contact *contact = &source->contacts[i];
    out->contacts[i] = (PocketRuntimeContact){(int)contact->id, (int)contact->x, (int)contact->y, 0};
  }
  for (unsigned i = 0; i < out->cancelled_count; i++) out->cancelled[i] = (int)source->cancelled[i].id;
  return POCKET_STATUS_OK;
}

JNIEXPORT jstring JNICALL
Java_dev_pocketnexus_android_PocketActivity_nativeSurfaceCreated(
  JNIEnv *env,
  jclass owner,
  jbyteArray guest_java_script,
  jbyteArray guest_asset_pack
)
{
  (void)owner;
  android_error[0] = '\0';
  if (!input) return (*env)->NewStringUTF(env, "Android input allocation failed");
  if (runtime_booted) {
    pocket_legacy_runtime_gl_reset();
    gl_initialized = pocket_legacy_runtime_gl_initialize();
    if (!gl_initialized) set_android_error("GLES2 backend reinitialization failed");
    return (*env)->NewStringUTF(env, gl_initialized ? "ok" : android_error);
  }

  size_t guest_js_length = 0, guest_pack_length = 0;
  uint8_t *new_guest_js = pocket_android_copy_bytes(env, guest_java_script, 64u * 1024u * 1024u, &guest_js_length);
  uint8_t *new_guest_pack = pocket_android_copy_bytes(env, guest_asset_pack, 64u * 1024u * 1024u, &guest_pack_length);
  if (new_guest_js == NULL || new_guest_pack == NULL) {
    free(new_guest_js);
    free(new_guest_pack);
    set_android_error("APK assets/app.js or assets/app.pak could not be copied");
    return (*env)->NewStringUTF(env, android_error);
  }
  int booted = pocket_legacy_runtime_boot(
        (const char *)new_guest_js,
        guest_js_length,
        new_guest_pack,
        guest_pack_length,
        POCKET_LOGICAL_WIDTH,
        POCKET_LOGICAL_HEIGHT
      );
  /* NativeProgram owns its package bytes when boot returns, including on
   * failure. JNI copies never become another process-lifetime asset owner. */
  free(new_guest_js);
  free(new_guest_pack);
  if (!booted) {
    set_android_error(pocket_legacy_runtime_error());
    return (*env)->NewStringUTF(env, android_error);
  }
  runtime_booted = 1;
  gl_initialized = pocket_legacy_runtime_gl_initialize();
  if (!gl_initialized) {
    set_android_error("PocketJS GLES2 backend initialization failed");
  }
  return (*env)->NewStringUTF(env, gl_initialized ? "ok" : android_error);
}

JNIEXPORT void JNICALL
Java_dev_pocketnexus_android_PocketActivity_nativeSurfaceChanged(
  JNIEnv *env,
  jclass owner,
  jint width,
  jint height
)
{
  (void)env;
  (void)owner;
  surface_width = width > 0 ? width : 1;
  surface_height = height > 0 ? height : 1;
  pocket_android_input_resize(input, surface_width, surface_height);
}

JNIEXPORT jboolean JNICALL
Java_dev_pocketnexus_android_PocketActivity_nativeFrame(
  JNIEnv *env,
  jclass owner
)
{
  (void)env;
  (void)owner;
  if (!runtime_booted || !gl_initialized) return JNI_FALSE;

  PocketRuntimeContactsInput frame;
  memset(&frame, 0, sizeof frame);
  int width;
  int height;
  unsigned long sequences;
  width = surface_width;
  height = surface_height;
  sequences = atomic_load(&touch_sequences);
  pocket_input_frame_builder builder = {sizeof(builder), &frame, collect_input};
  if (pocket_android_input_vtable()->poll(input, &builder) != POCKET_STATUS_OK) {
    set_android_error("Android input sampling failed");
    return JNI_FALSE;
  }
  uint64_t started = pocket_android_monotonic_us();
  if (window_started_us == 0) window_started_us = started;
  if (!pocket_legacy_runtime_tick_contacts(&frame)) {
    set_android_error(pocket_legacy_runtime_error());
    return JNI_FALSE;
  }
  uint64_t ticked = pocket_android_monotonic_us();
  if (!pocket_legacy_runtime_gl_render(width, height)) {
    set_android_error("PocketJS GLES2 frame submission failed");
    return JNI_FALSE;
  }
  uint64_t rendered = pocket_android_monotonic_us();
  window_tick_us += ticked - started;
  window_render_us += rendered - ticked;
  if (rendered - started > window_worst_us) window_worst_us = (uint32_t)(rendered - started);
  frames++;
  if (frames % 60 == 0) {
    if (receipt_path[0]) {
      FILE *receipt = fopen(receipt_path, "w");
      if (receipt) {
        fprintf(receipt, "state=running\nrenderer=gles2\nframes=%lu\ntouch_sequences=%lu\nlogical_width=%d\nlogical_height=%d\nsurface_width=%d\nsurface_height=%d\naction_name=%s\naction_value=%d\n"
          "tick_us=%lu\nrender_us=%lu\nframe_us_max=%lu\ninterval_us=%lu\n",
          frames, sequences, POCKET_LOGICAL_WIDTH, POCKET_LOGICAL_HEIGHT, width, height,
          pocket_legacy_runtime_action_name(), pocket_legacy_runtime_action_value(),
          (unsigned long)(window_tick_us / 60), (unsigned long)(window_render_us / 60),
          (unsigned long)window_worst_us, (unsigned long)((rendered - window_started_us) / 60));
        fclose(receipt);
      }
    }
    window_tick_us = 0;
    window_render_us = 0;
    window_worst_us = 0;
    window_started_us = rendered;
  }
  return JNI_TRUE;
}

JNIEXPORT jstring JNICALL
Java_dev_pocketnexus_android_PocketActivity_nativeError(JNIEnv *env, jclass owner)
{
  (void)owner;
  const char *message = android_error[0] != '\0'
    ? android_error
    : pocket_legacy_runtime_error();
  return (*env)->NewStringUTF(env, message == NULL ? "unknown error" : message);
}

JNIEXPORT void JNICALL
Java_dev_pocketnexus_android_PocketActivity_nativeKey(
  JNIEnv *env,
  jclass owner,
  jint action,
  jint key_code,
  jint scan_code,
  jint unicode,
  jint repeat
)
{
  (void)env;
  (void)owner;
  (void)scan_code;
  (void)unicode;
  pocket_android_input_key(input, action, key_code, repeat);
}

JNIEXPORT void JNICALL
Java_dev_pocketnexus_android_PocketActivity_nativeTouch(
  JNIEnv *env,
  jclass owner,
  jint action,
  jint pointer_id,
  jfloat x,
  jfloat y
)
{
  (void)env;
  (void)owner;
  atomic_fetch_add(&touch_sequences, (unsigned long)pocket_android_input_touch(input, action, pointer_id, x, y));
}

JNIEXPORT void JNICALL
Java_dev_pocketnexus_android_PocketActivity_nativeRelative(
  JNIEnv *env,
  jclass owner,
  jfloat delta_x,
  jfloat delta_y,
  jint action,
  jint button_state
)
{
  (void)env;
  (void)owner;
  pocket_android_input_relative(input, delta_x, delta_y, action, button_state);
}
