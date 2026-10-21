#include "pocket/android_jni.h"
#include <stdlib.h>

uint8_t *pocket_android_copy_bytes(JNIEnv *env, jbyteArray source, size_t limit, size_t *length) {
  if (length) *length = 0;
  if (!env || !*env || !source || !length || (*env)->ExceptionCheck(env)) return NULL;
  jsize count = (*env)->GetArrayLength(env, source);
  if ((*env)->ExceptionCheck(env)) { (*env)->ExceptionClear(env); return NULL; }
  if (count < 0 || (size_t)count > limit || (size_t)count == SIZE_MAX) return NULL;
  uint8_t *copy = malloc((size_t)count + 1);
  if (!copy) return NULL;
  if (count) (*env)->GetByteArrayRegion(env, source, 0, count, (jbyte *)copy);
  if ((*env)->ExceptionCheck(env)) { (*env)->ExceptionClear(env); free(copy); return NULL; }
  copy[count] = 0;
  *length = (size_t)count;
  return copy;
}
