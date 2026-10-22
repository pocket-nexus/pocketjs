#include <assert.h>
#include <stdarg.h>
#include "../../../programs/android/app/jni/runtime.c"

typedef struct { const jbyte *bytes; jsize count; int fail; } Bytes;
static int pending_exception, boots, resets, gl_ok;
static PocketRuntimeContactsInput captured;
static jboolean exception_check(JNIEnv *env) { (void)env; return pending_exception != 0; }
static void exception_clear(JNIEnv *env) { (void)env; pending_exception = 0; }
static jsize array_length(JNIEnv *env, jarray array) { (void)env; return ((Bytes *)array)->count; }
static void array_region(JNIEnv *env, jbyteArray array, jsize start, jsize length, jbyte *out) {
  (void)env; Bytes *bytes = (Bytes *)array;
  assert(start == 0 && length == bytes->count);
  pending_exception = bytes->fail;
  if (!pending_exception) memcpy(out, bytes->bytes, length);
}
static const char *string_chars(JNIEnv *env, jstring value, jboolean *copy) {
  (void)env; (void)copy; return (const char *)value;
}
static void release_chars(JNIEnv *env, jstring value, const char *chars) { (void)env; (void)value; (void)chars; }
static jstring new_string(JNIEnv *env, const char *value) { (void)env; return (jstring)value; }
int __android_log_print(int priority, const char *tag, const char *format, ...) {
  (void)priority; (void)tag; (void)format; return 0;
}
int pocket_legacy_runtime_boot(const char *js, size_t js_length, const uint8_t *pak, size_t pak_length, int width, int height) {
  assert(js_length == 3 && !memcmp(js, "abc", 3) && js[3] == 0);
  assert(pak_length == 3 && pak[0] == 7 && pak[1] == 0 && pak[2] == 9);
  assert(width == POCKET_LOGICAL_WIDTH && height == POCKET_LOGICAL_HEIGHT);
  boots++; return 1;
}
void pocket_legacy_runtime_gl_reset(void) { resets++; }
int pocket_legacy_runtime_gl_initialize(void) { return gl_ok; }
int pocket_legacy_runtime_gl_render(int width, int height) { assert(width > 0 && height > 0); return 1; }
int pocket_legacy_runtime_tick_contacts(const PocketRuntimeContactsInput *frame) { captured = *frame; return 1; }
const char *pocket_legacy_runtime_error(void) { return "test runtime error"; }
const char *pocket_legacy_runtime_action_name(void) { return ""; }
int pocket_legacy_runtime_action_value(void) { return 0; }
void pocket_legacy_runtime_offload_key(const char *path) { assert(strstr(path, "offload.key")); }
int main(void) {
#ifdef _JAVASOFT_JNI_H_
  const struct JNINativeInterface_ table =
#else
  const struct JNINativeInterface table =
#endif
  {.ExceptionCheck=exception_check, .ExceptionClear=exception_clear,
    .GetArrayLength=array_length, .GetByteArrayRegion=array_region, .GetStringUTFChars=string_chars,
    .ReleaseStringUTFChars=release_chars, .NewStringUTF=new_string};
  JNIEnv env = &table;
  const jbyte js[] = {'a','b','c'}, pak[] = {7,0,9};
  Bytes code = {js,3,0}, data = {pak,3,1};
  Java_dev_pocketnexus_android_PocketActivity_nativeConfigure(&env, NULL, (jstring)"/nonexistent-android-fixture");
  assert(input);
  Java_dev_pocketnexus_android_PocketActivity_nativeSurfaceCreated(&env, NULL, (jbyteArray)&code, (jbyteArray)&data);
  assert(!runtime_booted && !pending_exception && boots == 0);
  data.fail = 0;
  Java_dev_pocketnexus_android_PocketActivity_nativeSurfaceCreated(&env, NULL, (jbyteArray)&code, (jbyteArray)&data);
  assert(runtime_booted && !gl_initialized && boots == 1);
  gl_ok = 1;
  Java_dev_pocketnexus_android_PocketActivity_nativeSurfaceCreated(&env, NULL, (jbyteArray)&code, (jbyteArray)&data);
  assert(gl_initialized && boots == 1 && resets == 1);
  Java_dev_pocketnexus_android_PocketActivity_nativeSurfaceChanged(&env, NULL, 720, 1280);
  Java_dev_pocketnexus_android_PocketActivity_nativeTouch(&env, NULL, 0, 55, 180, 320);
  Java_dev_pocketnexus_android_PocketActivity_nativeTouch(&env, NULL, 1, 55, 180, 320);
  assert(Java_dev_pocketnexus_android_PocketActivity_nativeFrame(&env, NULL));
  assert(captured.contact_count == 1 && captured.contacts[0].x == POCKET_LOGICAL_WIDTH / 4 && captured.contacts[0].y == POCKET_LOGICAL_HEIGHT / 4);
  assert(Java_dev_pocketnexus_android_PocketActivity_nativeFrame(&env, NULL) && captured.contact_count == 0);
  Java_dev_pocketnexus_android_PocketActivity_nativeTouch(&env, NULL, 0, 55, 180, 320);
  assert(Java_dev_pocketnexus_android_PocketActivity_nativeFrame(&env, NULL) && captured.contact_count == 1);
  Java_dev_pocketnexus_android_PocketActivity_nativeCancelTouches(&env, NULL);
  assert(Java_dev_pocketnexus_android_PocketActivity_nativeFrame(&env, NULL) && captured.cancelled_count == 1);
  assert(Java_dev_pocketnexus_android_PocketActivity_nativeFrame(&env, NULL) && captured.cancelled_count == 0);
  pocket_android_input_destroy(input);
  puts("PocketJS Android: JNI failure retry, GLES recreation and canonical input adapter passed");
}
