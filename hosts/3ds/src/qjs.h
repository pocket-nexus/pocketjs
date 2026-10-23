#ifndef POCKETJS_3DS_QJS_H
#define POCKETJS_3DS_QJS_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/*
 * QuickJS embedding: `globalThis.ui` over the pocketjs-3ds-core C ABI, plus
 * the frame contract.
 *
 * qjs_boot evaluates the app bundle and looks up `globalThis.frame`; the pack
 * is borrowed for the process lifetime (it is exposed to JS zero-copy as
 * `globalThis.__pak`). qjs_frame calls `frame(buttons, analog)` once and
 * drains QuickJS's pending job queue. Both return false and leave a message
 * in qjs_last_error on failure.
 *
 * With `bytecode`, qjs_boot also hands back the compiled bundle (malloc'd,
 * NULL when it could not be written) for bytecode.c to keep; the next boot
 * passes it to qjs_boot_bytecode in place of the source.
 */
bool qjs_boot(
  const char *source,
  size_t source_length,
  const uint8_t *pack,
  size_t pack_length,
  uint8_t **bytecode,
  size_t *bytecode_length
);
bool qjs_boot_bytecode(
  const uint8_t *bytecode,
  size_t bytecode_length,
  const uint8_t *pack,
  size_t pack_length
);
bool qjs_frame(
  int32_t buttons,
  int32_t analog,
  const uint32_t *touches,
  const int32_t *hits,
  size_t touch_count,
  int32_t right_analog
);
const char *qjs_last_error(void);
void qjs_shutdown(void);

/* Called from QuickJS's interrupt handler while the guest's code runs (a
 * boot or a frame), every few thousand bytecode steps. Returning true ends
 * that code with an uncatchable error: the boot or the frame returns false
 * and qjs_interrupted is true until the next one starts. */
typedef bool (*QjsInterrupt)(void);
void qjs_set_interrupt(QjsInterrupt hook);
bool qjs_interrupted(void);

#endif
