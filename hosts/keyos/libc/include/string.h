/* KeyOS libc shim: the subset of <string.h> QuickJS calls. memcpy, memmove,
 * memset, memcmp and strlen come from Rust's compiler_builtins. */
#ifndef POCKET_KEYOS_STRING_H
#define POCKET_KEYOS_STRING_H
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

void *memcpy(void *restrict dst, const void *restrict src, size_t n);
void *memmove(void *dst, const void *src, size_t n);
void *memset(void *dst, int c, size_t n);
int memcmp(const void *a, const void *b, size_t n);
void *memchr(const void *s, int c, size_t n);
size_t strlen(const char *s);
int strcmp(const char *a, const char *b);
int strncmp(const char *a, const char *b, size_t n);
char *strchr(const char *s, int c);
char *strrchr(const char *s, int c);
char *strstr(const char *haystack, const char *needle);
char *strcpy(char *restrict dst, const char *restrict src);
char *strncpy(char *restrict dst, const char *restrict src, size_t n);
char *strcat(char *restrict dst, const char *restrict src);
char *strdup(const char *s);
char *strerror(int errnum);

#ifdef __cplusplus
}
#endif
#endif
