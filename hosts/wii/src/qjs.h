#ifndef POCKET_WII_QJS_H
#define POCKET_WII_QJS_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

bool qjs_boot(const char *source, size_t source_length, const uint8_t *pak, size_t pak_length);
bool qjs_frame(uint32_t buttons, uint32_t analog);
const char *qjs_last_error(void);
void qjs_shutdown(void);

#endif
