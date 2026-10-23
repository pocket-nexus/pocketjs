/* KeyOS libc shim: the C library functions QuickJS links against on
 * armv7a-unknown-xous-elf, where Rust's std is the only runtime.
 *
 * Rust's compiler_builtins exports memcpy, memmove, memset, memcmp, strlen
 * and most of <math.h>. The host crate (hosts/keyos/runtime/src/libc.rs)
 * exports malloc, calloc, realloc, free, clock_gettime, gettimeofday and
 * localtime_r, plus the two hooks declared below. This file supplies the
 * rest: string search, formatted output, strtod through QuickJS's own
 * correctly rounded js_atod, and the math functions compiler_builtins omits.
 */
#include <errno.h>
#include <math.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "dtoa.h"

/* Host hooks (Rust). */
void pocket_keyos_libc_write(int stream, const char *bytes, size_t len);
_Noreturn void pocket_keyos_libc_abort(const char *message, size_t len);

int errno;

struct __pocket_keyos_file {
    int stream;
};
static struct __pocket_keyos_file file_stdout = {1};
static struct __pocket_keyos_file file_stderr = {2};
FILE *const stdout = &file_stdout;
FILE *const stderr = &file_stderr;

/* ---- string ---------------------------------------------------------- */

void *memchr(const void *s, int c, size_t n) {
    const unsigned char *p = s;
    for (; n; n--, p++)
        if (*p == (unsigned char)c) return (void *)p;
    return NULL;
}

int strcmp(const char *a, const char *b) {
    while (*a && *a == *b) a++, b++;
    return (unsigned char)*a - (unsigned char)*b;
}

int strncmp(const char *a, const char *b, size_t n) {
    for (; n; n--, a++, b++) {
        if (*a != *b) return (unsigned char)*a - (unsigned char)*b;
        if (!*a) return 0;
    }
    return 0;
}

char *strchr(const char *s, int c) {
    for (;; s++) {
        if (*s == (char)c) return (char *)s;
        if (!*s) return NULL;
    }
}

char *strrchr(const char *s, int c) {
    const char *last = NULL;
    for (;; s++) {
        if (*s == (char)c) last = s;
        if (!*s) return (char *)last;
    }
}

char *strstr(const char *haystack, const char *needle) {
    size_t n = strlen(needle);
    if (!n) return (char *)haystack;
    for (; *haystack; haystack++)
        if (*haystack == *needle && !strncmp(haystack, needle, n)) return (char *)haystack;
    return NULL;
}

char *strcpy(char *restrict dst, const char *restrict src) {
    return memcpy(dst, src, strlen(src) + 1);
}

char *strncpy(char *restrict dst, const char *restrict src, size_t n) {
    size_t i = 0;
    for (; i < n && src[i]; i++) dst[i] = src[i];
    for (; i < n; i++) dst[i] = 0;
    return dst;
}

char *strcat(char *restrict dst, const char *restrict src) {
    strcpy(dst + strlen(dst), src);
    return dst;
}

char *strdup(const char *s) {
    size_t n = strlen(s) + 1;
    char *copy = malloc(n);
    return copy ? memcpy(copy, s, n) : NULL;
}

char *strerror(int errnum) {
    (void)errnum;
    return "error";
}

char *getenv(const char *name) {
    (void)name;
    return NULL;
}

int abs(int value) { return value < 0 ? -value : value; }

/* ---- numbers --------------------------------------------------------- */

double strtod(const char *restrict str, char **restrict end) {
    JSATODTempMem tmp;
    const char *p = str;
    while (*p == ' ' || (*p >= '\t' && *p <= '\r')) p++;
    const char *next = p;
    double value = js_atod(p, &next, 10, 0, &tmp);
    if (next == p) next = str;
    if (end) *end = (char *)next;
    return value;
}

static unsigned long parse_unsigned(const char *str, char **end, int base, int *negative) {
    const char *p = str;
    while (*p == ' ' || (*p >= '\t' && *p <= '\r')) p++;
    *negative = 0;
    if (*p == '-' || *p == '+') *negative = *p++ == '-';
    if ((base == 0 || base == 16) && p[0] == '0' && (p[1] | 32) == 'x') {
        p += 2;
        base = 16;
    } else if (base == 0) {
        base = p[0] == '0' ? 8 : 10;
    }
    const char *digits = p;
    unsigned long value = 0;
    for (;; p++) {
        int c = *p, d;
        if (c >= '0' && c <= '9') d = c - '0';
        else if ((c | 32) >= 'a' && (c | 32) <= 'z') d = (c | 32) - 'a' + 10;
        else break;
        if (d >= base) break;
        value = value * base + d;
    }
    if (end) *end = (char *)(p == digits ? str : p);
    return value;
}

long strtol(const char *restrict str, char **restrict end, int base) {
    int negative;
    unsigned long value = parse_unsigned(str, end, base, &negative);
    return negative ? -(long)value : (long)value;
}

unsigned long strtoul(const char *restrict str, char **restrict end, int base) {
    int negative;
    unsigned long value = parse_unsigned(str, end, base, &negative);
    return negative ? -value : value;
}

/* ---- math compiler_builtins omits ------------------------------------ */

double scalbn(double x, int exp) { return ldexp(x, exp); }

double frexp(double x, int *exp) {
    union { double d; uint64_t u; } v = {x};
    int e = (int)(v.u >> 52 & 0x7ff);
    if (!e) {
        if (x == 0) {
            *exp = 0;
            return x;
        }
        x = frexp(x * 0x1p64, exp);
        *exp -= 64;
        return x;
    }
    if (e == 0x7ff) {
        *exp = 0;
        return x;
    }
    *exp = e - 0x3fe;
    v.u = (v.u & 0x800fffffffffffffULL) | 0x3fe0000000000000ULL;
    return v.d;
}

double atanh(double x) {
    /* atanh(x) = log1p(2x / (1 - x)) / 2, with the sign carried separately. */
    double a = fabs(x);
    double r = 0.5 * log1p(2 * a / (1 - a));
    return x < 0 ? -r : r;
}

double modf(double x, double *ipart) {
    double i = trunc(x);
    *ipart = i;
    return isinf(x) ? copysign(0.0, x) : x - i;
}

long lrint(double x) { return (long)rint(x); }

double nearbyint(double x) { return rint(x); }

/* ---- formatted output ------------------------------------------------ */

struct sink {
    char *buf;
    size_t size;
    size_t len;
};

static void put(struct sink *s, char c) {
    if (s->len + 1 < s->size) s->buf[s->len] = c;
    s->len++;
}

static void put_padded(struct sink *s, const char *text, size_t len, int width, int left, char pad) {
    int fill = width > (int)len ? width - (int)len : 0;
    if (!left)
        for (; fill; fill--) put(s, pad);
    for (size_t i = 0; i < len; i++) put(s, text[i]);
    for (; fill; fill--) put(s, ' ');
}

static size_t format_unsigned(char *out, unsigned long long v, unsigned base, int upper) {
    const char *digits = upper ? "0123456789ABCDEF" : "0123456789abcdef";
    char tmp[24];
    size_t n = 0;
    do {
        tmp[n++] = digits[v % base];
        v /= base;
    } while (v);
    for (size_t i = 0; i < n; i++) out[i] = tmp[n - 1 - i];
    return n;
}

int vsnprintf(char *restrict buf, size_t size, const char *restrict fmt, va_list ap) {
    struct sink s = {buf, size, 0};
    for (; *fmt; fmt++) {
        if (*fmt != '%') {
            put(&s, *fmt);
            continue;
        }
        fmt++;
        int left = 0, zero = 0, plus = 0, space = 0, alt = 0;
        for (;; fmt++) {
            if (*fmt == '-') left = 1;
            else if (*fmt == '0') zero = 1;
            else if (*fmt == '+') plus = 1;
            else if (*fmt == ' ') space = 1;
            else if (*fmt == '#') alt = 1;
            else break;
        }
        int width = 0, precision = -1;
        if (*fmt == '*') {
            width = va_arg(ap, int);
            if (width < 0) left = 1, width = -width;
            fmt++;
        } else {
            while (*fmt >= '0' && *fmt <= '9') width = width * 10 + (*fmt++ - '0');
        }
        if (*fmt == '.') {
            fmt++;
            precision = 0;
            if (*fmt == '*') {
                precision = va_arg(ap, int);
                fmt++;
            } else {
                while (*fmt >= '0' && *fmt <= '9') precision = precision * 10 + (*fmt++ - '0');
            }
        }
        int longs = 0;
        for (;; fmt++) {
            if (*fmt == 'l') longs++;
            else if (*fmt == 'z' || *fmt == 't') longs = sizeof(size_t) == 8 ? 2 : 0;
            else if (*fmt == 'j') longs = 2;
            else if (*fmt != 'h') break;
        }
        char num[72];
        size_t n = 0;
        switch (*fmt) {
        case 'd':
        case 'i': {
            long long v = longs >= 2 ? va_arg(ap, long long) : longs ? va_arg(ap, long) : va_arg(ap, int);
            unsigned long long m = v < 0 ? 0ULL - (unsigned long long)v : (unsigned long long)v;
            char sign = v < 0 ? '-' : plus ? '+' : space ? ' ' : 0;
            size_t digits = format_unsigned(num + 32, m, 10, 0);
            int zeros = precision - (int)digits;
            if (zero && !left && precision < 0) zeros = width - (int)digits - (sign != 0);
            if (sign) num[n++] = sign;
            for (; zeros > 0; zeros--) num[n++] = '0';
            memmove(num + n, num + 32, digits);
            n += digits;
            put_padded(&s, num, n, width, left, ' ');
            break;
        }
        case 'u':
        case 'x':
        case 'X':
        case 'o': {
            unsigned long long v = longs >= 2 ? va_arg(ap, unsigned long long)
                                   : longs  ? va_arg(ap, unsigned long)
                                            : va_arg(ap, unsigned int);
            unsigned base = *fmt == 'u' ? 10 : *fmt == 'o' ? 8 : 16;
            if (alt && base == 16 && v) num[n++] = '0', num[n++] = *fmt;
            size_t digits = format_unsigned(num + 32, v, base, *fmt == 'X');
            int zeros = precision - (int)digits;
            if (zero && !left && precision < 0) zeros = width - (int)digits - (int)n;
            for (; zeros > 0; zeros--) num[n++] = '0';
            memmove(num + n, num + 32, digits);
            n += digits;
            put_padded(&s, num, n, width, left, ' ');
            break;
        }
        case 'p': {
            uintptr_t v = (uintptr_t)va_arg(ap, void *);
            num[n++] = '0';
            num[n++] = 'x';
            n += format_unsigned(num + n, v, 16, 0);
            put_padded(&s, num, n, width, left, ' ');
            break;
        }
        case 'c':
            num[0] = (char)va_arg(ap, int);
            put_padded(&s, num, 1, width, left, ' ');
            break;
        case 's': {
            const char *str = va_arg(ap, const char *);
            if (!str) str = "(null)";
            size_t len = 0;
            while ((precision < 0 || (int)len < precision) && str[len]) len++;
            put_padded(&s, str, len, width, left, ' ');
            break;
        }
        case 'f':
        case 'F':
        case 'e':
        case 'E':
        case 'g':
        case 'G': {
            /* QuickJS formats JS numbers through js_dtoa; this path only
             * serves diagnostics, so it prints the shortest round-trip form. */
            double v = va_arg(ap, double);
            JSDTOATempMem tmp;
            char text[JS_DTOA_MAX_DIGITS + 16];
            int len = js_dtoa(text, v, 10, 0, JS_DTOA_FORMAT_FREE, &tmp);
            put_padded(&s, text, (size_t)len, width, left, ' ');
            break;
        }
        case '%':
            put(&s, '%');
            break;
        default:
            put(&s, '%');
            if (*fmt) put(&s, *fmt);
            else fmt--;
            break;
        }
    }
    if (size) buf[s.len < size ? s.len : size - 1] = 0;
    return (int)s.len;
}

int snprintf(char *restrict buf, size_t size, const char *restrict fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(buf, size, fmt, ap);
    va_end(ap);
    return n;
}

int vfprintf(FILE *restrict stream, const char *restrict fmt, va_list ap) {
    char text[512];
    va_list copy;
    va_copy(copy, ap);
    int n = vsnprintf(text, sizeof text, fmt, copy);
    va_end(copy);
    if (n < 0) return n;
    pocket_keyos_libc_write(stream->stream, text, (size_t)n < sizeof text ? (size_t)n : sizeof text - 1);
    return n;
}

int fprintf(FILE *restrict stream, const char *restrict fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    int n = vfprintf(stream, fmt, ap);
    va_end(ap);
    return n;
}

int vprintf(const char *restrict fmt, va_list ap) { return vfprintf(stdout, fmt, ap); }

int printf(const char *restrict fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    int n = vfprintf(stdout, fmt, ap);
    va_end(ap);
    return n;
}

size_t fwrite(const void *restrict ptr, size_t size, size_t count, FILE *restrict stream) {
    pocket_keyos_libc_write(stream->stream, ptr, size * count);
    return count;
}

int fputc(int c, FILE *stream) {
    char ch = (char)c;
    pocket_keyos_libc_write(stream->stream, &ch, 1);
    return (unsigned char)c;
}

int putc(int c, FILE *stream) { return fputc(c, stream); }

int putchar(int c) { return fputc(c, stdout); }

int fputs(const char *restrict s, FILE *restrict stream) {
    pocket_keyos_libc_write(stream->stream, s, strlen(s));
    return 0;
}

int puts(const char *s) {
    fputs(s, stdout);
    return fputc('\n', stdout);
}

int fflush(FILE *stream) {
    (void)stream;
    return 0;
}

_Noreturn void __pocket_keyos_assert(const char *expr, const char *file, int line) {
    char text[256];
    int n = snprintf(text, sizeof text, "assertion failed: %s (%s:%d)", expr, file, line);
    pocket_keyos_libc_abort(text, (size_t)n < sizeof text ? (size_t)n : sizeof text - 1);
}
