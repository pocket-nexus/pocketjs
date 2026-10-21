#ifndef POCKET_ANDROID_HOOKS_H
#define POCKET_ANDROID_HOOKS_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
uint64_t pocket_android_monotonic_us(void);
/* Android log priority; these helpers do not own canonical pocket_host_* symbols. */
void pocket_android_log(int priority, const char *tag, const char *message, size_t length);
#ifdef __cplusplus
}
#endif
#endif
