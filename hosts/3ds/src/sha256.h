/*
 * SHA-256 and HMAC-SHA256 (FIPS 180-4, RFC 2104) for the Pocket Link
 * handshake (contracts/spec/link.ts) and the runtime slot of an app id
 * (the first 16 hex digits of SHA-256(id), the same derivation the Rust
 * core makes in pocket_package_open). Portable C: tests/3ds-link.test.ts
 * compiles it on the build machine and checks it against Bun's crypto.
 */

#ifndef POCKETJS_3DS_SHA256_H
#define POCKETJS_3DS_SHA256_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define SHA256_BYTES 32u
#define SHA256_BLOCK_BYTES 64u

typedef struct {
  uint32_t state[8];
  uint64_t length;
  uint8_t block[SHA256_BLOCK_BYTES];
  size_t used;
} Sha256;

void sha256_init(Sha256 *context);
void sha256_update(Sha256 *context, const void *bytes, size_t length);
void sha256_final(Sha256 *context, uint8_t out[SHA256_BYTES]);
void sha256(const void *bytes, size_t length, uint8_t out[SHA256_BYTES]);

typedef struct {
  Sha256 inner;
  uint8_t outer_key[SHA256_BLOCK_BYTES];
} HmacSha256;

void hmac_sha256_init(HmacSha256 *context, const uint8_t *key, size_t key_length);
void hmac_sha256_update(HmacSha256 *context, const void *bytes, size_t length);
void hmac_sha256_final(HmacSha256 *context, uint8_t out[SHA256_BYTES]);

/* Lowercase hex of `length` bytes into `out` (2 * length + 1 bytes). */
void hex_encode(const uint8_t *bytes, size_t length, char *out);
/* Exactly 2 * length hex digits (either case) into `length` bytes. */
bool hex_decode(const char *text, size_t text_length, uint8_t *out, size_t length);

/* The runtime slot of an app id: 16 lowercase hex digits + NUL. */
void sha256_slot(const char *app_id, size_t length, char out[17]);

/* Compare without an early exit, so timing does not reveal the prefix. */
bool constant_time_equal(const uint8_t *a, const uint8_t *b, size_t length);

#endif
