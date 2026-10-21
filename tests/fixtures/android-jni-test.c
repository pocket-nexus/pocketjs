#include "pocket/android_jni.h"
#include <assert.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
static int exception, fail_length, fail_region, reads;
static jsize count;
static const jbyte payload[] = {'A', 0, (jbyte)0xff};
static jboolean exception_check(JNIEnv *env) { (void)env; return exception != 0; }
static void exception_clear(JNIEnv *env) { (void)env; exception = 0; }
static jsize array_length(JNIEnv *env, jarray array) { (void)env; (void)array; exception = fail_length; return count; }
static void array_region(JNIEnv *env, jbyteArray array, jsize start, jsize length, jbyte *out) {
  (void)env; (void)array; assert(start == 0 && length == 3); reads++;
  memcpy(out, payload, length); exception = fail_region;
}
int main(void) {
#ifdef _JAVASOFT_JNI_H_
  const struct JNINativeInterface_ table =
#else
  const struct JNINativeInterface table =
#endif
  {.ExceptionCheck = exception_check,
    .ExceptionClear = exception_clear, .GetArrayLength = array_length, .GetByteArrayRegion = array_region};
  JNIEnv env = &table;
  jbyteArray array = (jbyteArray)&count;
  size_t length = 99;
  count = 3;
  uint8_t *copy = pocket_android_copy_bytes(&env, array, 3, &length);
  assert(copy && length == 3 && !memcmp(copy, payload, 3) && copy[3] == 0); free(copy);
  assert(!pocket_android_copy_bytes(&env, array, 2, &length) && length == 0 && reads == 1);
  fail_length = 1;
  assert(!pocket_android_copy_bytes(&env, array, 3, &length) && !exception && reads == 1);
  fail_length = 0; fail_region = 1;
  assert(!pocket_android_copy_bytes(&env, array, 3, &length) && length == 0 && !exception);
  fail_region = 0; exception = 1;
  assert(!pocket_android_copy_bytes(&env, array, 3, &length) && exception);
  exception = 0; count = 0;
  copy = pocket_android_copy_bytes(&env, array, 0, &length);
  assert(copy && length == 0 && copy[0] == 0); free(copy);
  assert(!pocket_android_copy_bytes(NULL, array, 3, &length));
  puts("android JNI: ownership, binary payload, bounds and exceptions passed");
}
