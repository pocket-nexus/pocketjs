/* KeyOS libc shim: the subset of <stdlib.h> QuickJS calls. */
#ifndef POCKET_KEYOS_STDLIB_H
#define POCKET_KEYOS_STDLIB_H
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

void *malloc(size_t size);
void *calloc(size_t count, size_t size);
void *realloc(void *ptr, size_t size);
void free(void *ptr);
_Noreturn void abort(void);
double strtod(const char *restrict str, char **restrict end);
long strtol(const char *restrict str, char **restrict end, int base);
unsigned long strtoul(const char *restrict str, char **restrict end, int base);
int abs(int value);
char *getenv(const char *name);

#define alloca(size) __builtin_alloca(size)

#ifdef __cplusplus
}
#endif
#endif
