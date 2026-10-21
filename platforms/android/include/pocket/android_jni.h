#ifndef POCKET_ANDROID_JNI_H
#define POCKET_ANDROID_JNI_H
#include <jni.h>
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* Copies at most limit bytes and appends a NUL outside length. The caller frees
 * the result with free(). No Java array or JNIEnv borrow survives this call. */
uint8_t *pocket_android_copy_bytes(JNIEnv *env, jbyteArray source, size_t limit, size_t *length);
#ifdef __cplusplus
}
#endif
#endif
