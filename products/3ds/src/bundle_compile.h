#ifndef POCKETJS_3DS_BUNDLE_COMPILE_H
#define POCKETJS_3DS_BUNDLE_COMPILE_H

#include <stddef.h>
#include <stdint.h>

/*
 * A guest bundle's source compiled to QuickJS bytecode in a QuickJS runtime
 * of its own: the bytes qjs_boot's own compile hands back for bytecode.c,
 * which qjs_boot then runs as it runs a cached bundle. The runtime is
 * created, used and freed inside the call and shares nothing with the
 * guest's, so the call runs on any thread while another thread does
 * something else (main.c: the link's pump, docs/POCKET-LINK.md §4.6).
 *
 * `code` is the package's JavaScript section with its terminal NUL, as the
 * runtime hands it to the guest's evaluate. `stack_bytes` is QuickJS's
 * stack limit; the calling thread's stack must be larger. `memory_limit` is
 * the runtime's heap limit, 0 for none.
 *
 * Returns the bytecode (free() it) and its length. NULL leaves `error`: the
 * exception's message and stack on one line when the source did not
 * compile, or "" when nothing was compiled (no terminal NUL, no memory for
 * a runtime) and the caller compiles the way it did before.
 */
uint8_t *bundle_compile(const uint8_t *code, size_t length, size_t stack_bytes, size_t memory_limit, size_t *bytecode_length, char *error, size_t error_length);

#endif
