/* SHA-256 / HMAC-SHA256 — see sha256.h. */

#include "sha256.h"

#include <string.h>

static const uint32_t ROUND[64] = {
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
};

static uint32_t rotate(uint32_t value, unsigned bits) {
  return (value >> bits) | (value << (32u - bits));
}

static void compress(uint32_t state[8], const uint8_t block[SHA256_BLOCK_BYTES]) {
  uint32_t w[64];
  for (unsigned i = 0; i < 16; i += 1) {
    w[i] = ((uint32_t)block[i * 4] << 24) | ((uint32_t)block[i * 4 + 1] << 16) |
           ((uint32_t)block[i * 4 + 2] << 8) | (uint32_t)block[i * 4 + 3];
  }
  for (unsigned i = 16; i < 64; i += 1) {
    uint32_t s0 = rotate(w[i - 15], 7) ^ rotate(w[i - 15], 18) ^ (w[i - 15] >> 3);
    uint32_t s1 = rotate(w[i - 2], 17) ^ rotate(w[i - 2], 19) ^ (w[i - 2] >> 10);
    w[i] = w[i - 16] + s0 + w[i - 7] + s1;
  }
  uint32_t a = state[0], b = state[1], c = state[2], d = state[3];
  uint32_t e = state[4], f = state[5], g = state[6], h = state[7];
  for (unsigned i = 0; i < 64; i += 1) {
    uint32_t s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
    uint32_t choose = (e & f) ^ (~e & g);
    uint32_t t1 = h + s1 + choose + ROUND[i] + w[i];
    uint32_t s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
    uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
    uint32_t t2 = s0 + majority;
    h = g;
    g = f;
    f = e;
    e = d + t1;
    d = c;
    c = b;
    b = a;
    a = t1 + t2;
  }
  state[0] += a;
  state[1] += b;
  state[2] += c;
  state[3] += d;
  state[4] += e;
  state[5] += f;
  state[6] += g;
  state[7] += h;
}

void sha256_init(Sha256 *context) {
  static const uint32_t INITIAL[8] = {
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  };
  memcpy(context->state, INITIAL, sizeof INITIAL);
  context->length = 0;
  context->used = 0;
}

void sha256_update(Sha256 *context, const void *bytes, size_t length) {
  const uint8_t *at = bytes;
  context->length += length;
  while (length > 0) {
    size_t take = SHA256_BLOCK_BYTES - context->used;
    if (take > length) take = length;
    memcpy(context->block + context->used, at, take);
    context->used += take;
    at += take;
    length -= take;
    if (context->used == SHA256_BLOCK_BYTES) {
      compress(context->state, context->block);
      context->used = 0;
    }
  }
}

void sha256_final(Sha256 *context, uint8_t out[SHA256_BYTES]) {
  uint64_t bits = context->length * 8u;
  uint8_t pad = 0x80;
  /* The length counter must not count padding, so append through the block
   * directly rather than sha256_update. */
  context->block[context->used++] = pad;
  if (context->used > SHA256_BLOCK_BYTES - 8) {
    memset(context->block + context->used, 0, SHA256_BLOCK_BYTES - context->used);
    compress(context->state, context->block);
    context->used = 0;
  }
  memset(context->block + context->used, 0, SHA256_BLOCK_BYTES - 8 - context->used);
  for (unsigned i = 0; i < 8; i += 1) {
    context->block[SHA256_BLOCK_BYTES - 1 - i] = (uint8_t)(bits >> (8 * i));
  }
  compress(context->state, context->block);
  for (unsigned i = 0; i < 8; i += 1) {
    out[i * 4] = (uint8_t)(context->state[i] >> 24);
    out[i * 4 + 1] = (uint8_t)(context->state[i] >> 16);
    out[i * 4 + 2] = (uint8_t)(context->state[i] >> 8);
    out[i * 4 + 3] = (uint8_t)context->state[i];
  }
  memset(context, 0, sizeof *context);
}

void sha256(const void *bytes, size_t length, uint8_t out[SHA256_BYTES]) {
  Sha256 context;
  sha256_init(&context);
  sha256_update(&context, bytes, length);
  sha256_final(&context, out);
}

void hmac_sha256_init(HmacSha256 *context, const uint8_t *key, size_t key_length) {
  uint8_t block[SHA256_BLOCK_BYTES] = {0};
  if (key_length > SHA256_BLOCK_BYTES) sha256(key, key_length, block);
  else if (key_length > 0) memcpy(block, key, key_length);
  uint8_t inner_key[SHA256_BLOCK_BYTES];
  for (unsigned i = 0; i < SHA256_BLOCK_BYTES; i += 1) {
    inner_key[i] = block[i] ^ 0x36;
    context->outer_key[i] = block[i] ^ 0x5c;
  }
  sha256_init(&context->inner);
  sha256_update(&context->inner, inner_key, sizeof inner_key);
  memset(block, 0, sizeof block);
  memset(inner_key, 0, sizeof inner_key);
}

void hmac_sha256_update(HmacSha256 *context, const void *bytes, size_t length) {
  sha256_update(&context->inner, bytes, length);
}

void hmac_sha256_final(HmacSha256 *context, uint8_t out[SHA256_BYTES]) {
  uint8_t inner[SHA256_BYTES];
  sha256_final(&context->inner, inner);
  Sha256 outer;
  sha256_init(&outer);
  sha256_update(&outer, context->outer_key, sizeof context->outer_key);
  sha256_update(&outer, inner, sizeof inner);
  sha256_final(&outer, out);
  memset(context, 0, sizeof *context);
}

void hex_encode(const uint8_t *bytes, size_t length, char *out) {
  static const char DIGITS[] = "0123456789abcdef";
  for (size_t i = 0; i < length; i += 1) {
    out[i * 2] = DIGITS[bytes[i] >> 4];
    out[i * 2 + 1] = DIGITS[bytes[i] & 15];
  }
  out[length * 2] = '\0';
}

static int hex_digit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

bool hex_decode(const char *text, size_t text_length, uint8_t *out, size_t length) {
  if (text == NULL || text_length != length * 2) return false;
  for (size_t i = 0; i < length; i += 1) {
    int high = hex_digit(text[i * 2]);
    int low = hex_digit(text[i * 2 + 1]);
    if (high < 0 || low < 0) return false;
    out[i] = (uint8_t)((high << 4) | low);
  }
  return true;
}

void sha256_slot(const char *app_id, size_t length, char out[17]) {
  uint8_t digest[SHA256_BYTES];
  sha256(app_id, length, digest);
  hex_encode(digest, 8, out);
}

bool constant_time_equal(const uint8_t *a, const uint8_t *b, size_t length) {
  uint8_t difference = 0;
  for (size_t i = 0; i < length; i += 1) difference |= (uint8_t)(a[i] ^ b[i]);
  return difference == 0;
}
