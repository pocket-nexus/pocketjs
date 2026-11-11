#ifndef POCKETJS_3DS_BYTECODE_H
#define POCKETJS_3DS_BYTECODE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/*
 * A slot's guest bundle as QuickJS bytecode, kept on the SD card beside the
 * slot's state (runtime_slot_path(slot, "bundle.qbc")). Compiling a 410-480
 * KB bundle takes 1.9-2.3 s on an Old 3DS; reading its bytecode takes 70-80
 * ms. On a package's first boot main.c compiles the bundle on a thread of its
 * own (bundle_compile.h) and stores it here while the main thread pumps the
 * link, and every boot of the package, the first included, runs the
 * bytecode through qjs_boot. qjs_boot's own compile, which hands its bytecode
 * back for this file, is left for a boot whose thread could not start.
 *
 * A file is used when its header names the same package hash and the same
 * QuickJS build (POCKETJS_QUICKJS_STAMP, the key tools/3ds-toolchain.ts
 * caches libquickjs.a under) and its checksum holds. A build without
 * POCKETJS_QUICKJS_STAMP neither reads nor writes one.
 */

/* The bytecode (free() it) and its length, or NULL. */
uint8_t *bytecode_load(const char *path, uint64_t package_hash, size_t *length);
/* Written beside `path` and renamed over it; a failure leaves no file or the
 * old one. */
void bytecode_store(const char *path, uint64_t package_hash, const uint8_t *bytes, size_t length);

#endif
