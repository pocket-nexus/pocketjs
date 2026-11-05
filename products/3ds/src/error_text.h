#ifndef POCKETJS_3DS_ERROR_TEXT_H
#define POCKETJS_3DS_ERROR_TEXT_H

#include <stdarg.h>
#include <stddef.h>
#include <stdio.h>

/* Format a failure into the caller's fixed buffer. A NULL or zero-length
 * buffer means the caller does not want the text. */
__attribute__((format(printf, 3, 4)))
static inline void pocket_set_error(char *out, size_t length, const char *format, ...) {
  if (out == NULL || length == 0) return;
  va_list arguments;
  va_start(arguments, format);
  vsnprintf(out, length, format, arguments);
  va_end(arguments);
}

#endif
