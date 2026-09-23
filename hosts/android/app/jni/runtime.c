#include <android/log.h>
#include <jni.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "pocket_input.h"
#include "../../../shared/contact_latch.h"
#include "pocket_runtime.h"
#include "pocket_spec.h"

#define LOG_TAG "PocketJSAndroid"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

/* The logical viewport comes from the resolved build plan (tools/android.ts);
 * the defaults match the private moto-g-play-dev profile. */
#ifndef POCKET_LOGICAL_WIDTH
#define POCKET_LOGICAL_WIDTH 360
#endif
#ifndef POCKET_LOGICAL_HEIGHT
#define POCKET_LOGICAL_HEIGHT 800
#endif

#define KEYCODE_BACK 4
#define KEYCODE_DPAD_UP 19
#define KEYCODE_DPAD_DOWN 20
#define KEYCODE_DPAD_LEFT 21
#define KEYCODE_DPAD_RIGHT 22
#define KEYCODE_DPAD_CENTER 23
#define KEYCODE_SPACE 62
#define KEYCODE_ENTER 66
#define KEYCODE_MENU 82
#define KEYCODE_NUMPAD_ENTER 160

#define ACTION_DOWN 0
#define ACTION_UP 1
#define ACTION_CANCEL 3
#define ACTION_POINTER_DOWN 5
#define ACTION_POINTER_UP 6
#define BUTTON_PRIMARY 1

/* Trackball and scroll-axis deltas are fractional; this much accumulated
 * motion is one focus pulse. */
#define RELATIVE_PULSE_THRESHOLD 0.35f

static pthread_mutex_t input_mutex = PTHREAD_MUTEX_INITIALIZER;
static PocketInputState input;
static int input_ready;
static int surface_width = 720;
static int surface_height = 720;

static uint8_t *guest_js;
static size_t guest_js_length;
static uint8_t *guest_pack;
static size_t guest_pack_length;
static int runtime_booted;
static int gl_initialized;
static char android_error[512];
static char receipt_path[1024];
static unsigned long frames, touch_sequences;
static PocketContactLatch contacts;
JNIEXPORT jint JNICALL Java_dev_pocketstack_android_PocketActivity_nativeLogicalWidth(JNIEnv *env, jclass owner) {
  (void)env; (void)owner; return POCKET_LOGICAL_WIDTH;
}
JNIEXPORT jint JNICALL Java_dev_pocketstack_android_PocketActivity_nativeLogicalHeight(JNIEnv *env, jclass owner) {
  (void)env; (void)owner; return POCKET_LOGICAL_HEIGHT;
}
JNIEXPORT void JNICALL Java_dev_pocketstack_android_PocketActivity_nativeConfigure(JNIEnv *env, jclass owner, jstring directory) {
  (void)owner;
  const char *path = (*env)->GetStringUTFChars(env, directory, NULL);
  if (!path) return;
  snprintf(receipt_path, sizeof receipt_path, "%s/runtime.txt", path);
#ifdef POCKET_OFFLOAD_POSIX
  char key[1024]; snprintf(key, sizeof key, "%s/offload.key", path);
  pocket_runtime_offload_key(key);
#endif
  (*env)->ReleaseStringUTFChars(env, directory, path);
}
JNIEXPORT void JNICALL Java_dev_pocketstack_android_PocketActivity_nativeCancelTouches(JNIEnv *env, jclass owner) {
  (void)env; (void)owner;
  pthread_mutex_lock(&input_mutex);
  pocket_contacts_cancel(&contacts);
  pthread_mutex_unlock(&input_mutex);
}


static void set_android_error(const char *message)
{
  size_t length = message == NULL ? 0 : strlen(message);
  if (length >= sizeof(android_error)) length = sizeof(android_error) - 1;
  if (length > 0) memcpy(android_error, message, length);
  android_error[length] = '\0';
  LOGE("%s", android_error);
}

static uint8_t *copy_java_bytes(
  JNIEnv *env,
  jbyteArray source,
  size_t *length
)
{
  if (source == NULL) return NULL;
  jsize source_length = (*env)->GetArrayLength(env, source);
  if (source_length <= 0) return NULL;
  uint8_t *bytes = (uint8_t *)malloc((size_t)source_length);
  if (bytes == NULL) return NULL;
  (*env)->GetByteArrayRegion(env, source, 0, source_length, (jbyte *)bytes);
  if ((*env)->ExceptionCheck(env)) {
    (*env)->ExceptionClear(env);
    free(bytes);
    return NULL;
  }
  *length = (size_t)source_length;
  return bytes;
}

/* Android key codes onto the portable mask (pocket_spec.h). */
static uint32_t button_for_key(int key_code)
{
  switch (key_code) {
    case KEYCODE_DPAD_UP: return POCKET_BTN_UP;
    case KEYCODE_DPAD_RIGHT: return POCKET_BTN_RIGHT;
    case KEYCODE_DPAD_DOWN: return POCKET_BTN_DOWN;
    case KEYCODE_DPAD_LEFT: return POCKET_BTN_LEFT;
    case KEYCODE_DPAD_CENTER:
    case KEYCODE_ENTER:
    case KEYCODE_NUMPAD_ENTER:
      return POCKET_BTN_CIRCLE;
    case KEYCODE_SPACE: return POCKET_BTN_START;
    case KEYCODE_MENU: return POCKET_BTN_TRIANGLE;
    default: return 0;
  }
}

/* Input callbacks can arrive before the surface exists; the state machine is
 * initialized lazily under the mutex. */
static void ensure_input(void)
{
  if (input_ready) return;
  pocket_input_init(&input, RELATIVE_PULSE_THRESHOLD);
  input_ready = 1;
}

JNIEXPORT jstring JNICALL
Java_dev_pocketstack_android_PocketActivity_nativeSurfaceCreated(
  JNIEnv *env,
  jclass owner,
  jbyteArray guest_java_script,
  jbyteArray guest_asset_pack
)
{
  (void)owner;
  android_error[0] = '\0';
  if (runtime_booted) {
    pocket_runtime_gl_reset();
    gl_initialized = pocket_runtime_gl_initialize();
    if (!gl_initialized) set_android_error("GLES2 backend reinitialization failed");
    return (*env)->NewStringUTF(env, gl_initialized ? "ok" : android_error);
  }

  uint8_t *new_guest_js = copy_java_bytes(
    env,
    guest_java_script,
    &guest_js_length
  );
  uint8_t *new_guest_pack = copy_java_bytes(
    env,
    guest_asset_pack,
    &guest_pack_length
  );
  if (new_guest_js == NULL || new_guest_pack == NULL) {
    free(new_guest_js);
    free(new_guest_pack);
    set_android_error("APK assets/app.js or assets/app.pak could not be copied");
    return (*env)->NewStringUTF(env, android_error);
  }
  free(guest_js);
  free(guest_pack);
  guest_js = new_guest_js;
  guest_pack = new_guest_pack;

  if (!pocket_runtime_boot(
        (const char *)guest_js,
        guest_js_length,
        guest_pack,
        guest_pack_length,
        POCKET_LOGICAL_WIDTH,
        POCKET_LOGICAL_HEIGHT
      )) {
    set_android_error(pocket_runtime_error());
    return (*env)->NewStringUTF(env, android_error);
  }
  runtime_booted = 1;
  gl_initialized = pocket_runtime_gl_initialize();
  if (!gl_initialized) {
    set_android_error("PocketJS GLES2 backend initialization failed");
  }
  return (*env)->NewStringUTF(env, gl_initialized ? "ok" : android_error);
}

JNIEXPORT void JNICALL
Java_dev_pocketstack_android_PocketActivity_nativeSurfaceChanged(
  JNIEnv *env,
  jclass owner,
  jint width,
  jint height
)
{
  (void)env;
  (void)owner;
  pthread_mutex_lock(&input_mutex);
  surface_width = width > 0 ? width : 1;
  surface_height = height > 0 ? height : 1;
  pthread_mutex_unlock(&input_mutex);
}

JNIEXPORT jboolean JNICALL
Java_dev_pocketstack_android_PocketActivity_nativeFrame(
  JNIEnv *env,
  jclass owner
)
{
  (void)env;
  (void)owner;
  if (!runtime_booted || !gl_initialized) return JNI_FALSE;

  PocketInputSample sample;
  PocketRuntimeContactsInput frame;
  memset(&frame, 0, sizeof frame);
  int width;
  int height;
  unsigned long sequences;
  pthread_mutex_lock(&input_mutex);
  ensure_input();
  pocket_input_sample(&input, &sample);
  width = surface_width;
  height = surface_height;
  sequences = touch_sequences;
  frame.buttons = sample.buttons;
  pocket_contacts_sample(&contacts, &frame, width, height, POCKET_LOGICAL_WIDTH, POCKET_LOGICAL_HEIGHT,
    pocket_runtime_hit_test_bounds);
  pthread_mutex_unlock(&input_mutex);
  if (!pocket_runtime_tick_contacts(&frame)) {
    set_android_error(pocket_runtime_error());
    return JNI_FALSE;
  }
  if (!pocket_runtime_gl_render(width, height)) {
    set_android_error("PocketJS GLES2 frame submission failed");
    return JNI_FALSE;
  }
  frames++;
  if (frames % 60 == 0 && receipt_path[0]) {
    FILE *receipt = fopen(receipt_path, "w");
    if (receipt) {
      fprintf(receipt, "state=running\nrenderer=gles2\nframes=%lu\ntouch_sequences=%lu\nlogical_width=%d\nlogical_height=%d\nsurface_width=%d\nsurface_height=%d\naction_name=%s\naction_value=%d\n",
        frames, sequences, POCKET_LOGICAL_WIDTH, POCKET_LOGICAL_HEIGHT, width, height,
        pocket_runtime_action_name(), pocket_runtime_action_value());
      fclose(receipt);
    }
  }
  return JNI_TRUE;
}

JNIEXPORT jstring JNICALL
Java_dev_pocketstack_android_PocketActivity_nativeError(JNIEnv *env, jclass owner)
{
  (void)owner;
  const char *message = android_error[0] != '\0'
    ? android_error
    : pocket_runtime_error();
  return (*env)->NewStringUTF(env, message == NULL ? "unknown error" : message);
}

JNIEXPORT void JNICALL
Java_dev_pocketstack_android_PocketActivity_nativeKey(
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
  uint32_t button = button_for_key(key_code);
  if (button == 0 || key_code == KEYCODE_BACK) return;
  if (action != ACTION_DOWN && action != ACTION_UP) return;
  pthread_mutex_lock(&input_mutex);
  ensure_input();
  pocket_input_button(&input, button, action == ACTION_DOWN, repeat != 0);
  pthread_mutex_unlock(&input_mutex);
}

JNIEXPORT void JNICALL
Java_dev_pocketstack_android_PocketActivity_nativeTouch(
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
  PocketTouchPhase phase;
  if (action == ACTION_DOWN || action == ACTION_POINTER_DOWN) phase = POCKET_TOUCH_DOWN;
  else if (action == ACTION_UP || action == ACTION_POINTER_UP) phase = POCKET_TOUCH_UP;
  else if (action == ACTION_CANCEL) phase = POCKET_TOUCH_CANCEL;
  else phase = POCKET_TOUCH_MOVE;
  pthread_mutex_lock(&input_mutex);
  ensure_input();
  touch_sequences += pocket_contact_event(&contacts, phase, pointer_id, x, y, surface_width, surface_height);
  pthread_mutex_unlock(&input_mutex);
}

JNIEXPORT void JNICALL
Java_dev_pocketstack_android_PocketActivity_nativeRelative(
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
  int primary = (button_state & BUTTON_PRIMARY) != 0 || action == ACTION_DOWN;
  if (action == ACTION_UP || action == ACTION_CANCEL) primary = 0;
  pthread_mutex_lock(&input_mutex);
  ensure_input();
  pocket_input_relative(&input, delta_x, delta_y);
  pocket_input_primary(&input, primary);
  pthread_mutex_unlock(&input_mutex);
}
