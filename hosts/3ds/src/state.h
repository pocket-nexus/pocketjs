#ifndef POCKETJS_3DS_STATE_H
#define POCKETJS_3DS_STATE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Pocket Manga-style per-app state: one bounded blob at
 * POCKET_RUNTIME_APP_ROOT/state.json. Both calls run on the QuickJS thread and
 * complete synchronously; the blob is small enough that an SD write costs one
 * frame at most, and the app throttles saves. */

/* Copies at most `capacity` bytes of the stored state into `out` and returns
 * the byte count; 0 when nothing is stored. */
size_t state_read(uint8_t *out, size_t capacity);

/* Replaces the stored state atomically (temp file + rename). Returns false on
 * any IO failure, leaving the previous blob in place. */
bool state_write(const uint8_t *bytes, size_t length);

#endif
