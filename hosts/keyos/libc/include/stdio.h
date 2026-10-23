/* KeyOS libc shim: formatted output for QuickJS's error messages and dumps.
 * stdout and stderr go to the host's log. */
#ifndef POCKET_KEYOS_STDIO_H
#define POCKET_KEYOS_STDIO_H
#include <stdarg.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct __pocket_keyos_file FILE;
extern FILE *const stdout;
extern FILE *const stderr;
#define EOF (-1)

int vsnprintf(char *restrict buf, size_t size, const char *restrict fmt, va_list ap);
int snprintf(char *restrict buf, size_t size, const char *restrict fmt, ...)
    __attribute__((format(printf, 3, 4)));
int vfprintf(FILE *restrict stream, const char *restrict fmt, va_list ap);
int fprintf(FILE *restrict stream, const char *restrict fmt, ...)
    __attribute__((format(printf, 2, 3)));
int printf(const char *restrict fmt, ...) __attribute__((format(printf, 1, 2)));
int vprintf(const char *restrict fmt, va_list ap);
int fputc(int c, FILE *stream);
int putc(int c, FILE *stream);
int putchar(int c);
int fputs(const char *restrict s, FILE *restrict stream);
int puts(const char *s);
size_t fwrite(const void *restrict ptr, size_t size, size_t count, FILE *restrict stream);
int fflush(FILE *stream);

#ifdef __cplusplus
}
#endif
#endif
