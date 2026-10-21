/*
 * Pocket Link wire facts (contracts/spec/link.ts) that need no sockets: the
 * constants, the beacon and frame layouts, the pairing URI and the HMAC
 * proofs. Portable C, so tests/3ds-link.test.ts compiles it on the build
 * machine and checks it against the TypeScript contract and Bun's crypto.
 */

#ifndef POCKETJS_3DS_LINK_PROTO_H
#define POCKETJS_3DS_LINK_PROTO_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define LINK_BEACON_PORT 8627u
#define LINK_PORT 8628u
#define LINK_BEACON_MAGIC 0x424c4b50u /* 'PKLB' LE */
#define LINK_BEACON_BYTES 64u
#define LINK_BEACON_NAME_BYTES 40u
#define LINK_BEACON_FLAG_PAIRING 1u
#define LINK_MAGIC 0x4b4c4b50u /* 'PKLK' LE */
#define LINK_VERSION 1u
#define LINK_PREAMBLE_BYTES 8u
#define LINK_HEADER_BYTES 8u
#define LINK_FRAME_PING 0x01u
#define LINK_FRAME_PONG 0x02u
#define LINK_FRAME_CTRL 0x10u
#define LINK_FRAME_DATA 0x20u
#define LINK_MAX_CTRL (32u * 1024u)
#define LINK_MAX_DATA (32u * 1024u)
#define LINK_MAX_FRAME (LINK_MAX_DATA + 4u)
#define LINK_PING_MS 3000u
#define LINK_SILENCE_MS 10000u
#define LINK_CONNECT_TIMEOUT_MS 4000u
#define LINK_HANDSHAKE_TIMEOUT_MS 6000u
#define LINK_KEY_BYTES 32u
#define LINK_NONCE_BYTES 16u
#define LINK_ID_HEX 16u
#define LINK_PAIR_SECRET_BYTES 16u
#define LINK_PAIR_MAX_HOSTS 3u
#define LINK_PAIR_URI_MAX 160u
#define LINK_CATALOG_MAX_APPS 64u
#define LINK_INSTALL_MAX_BYTES (24u * 1024u * 1024u)
#define LINK_MAX_REQUESTS 4u

#define LINK_LABEL_COMPANION "pocket-link/1/companion"
#define LINK_LABEL_CONSOLE "pocket-link/1/console"
#define LINK_LABEL_KEY "pocket-link/1/key"

#define LINK_NAME_BYTES 64u

typedef struct {
  char companion[LINK_ID_HEX + 1];
  char name[LINK_NAME_BYTES];
  char hosts[LINK_PAIR_MAX_HOSTS][16];
  size_t host_count;
  uint16_t port;
  uint8_t secret[LINK_PAIR_SECRET_BYTES];
} LinkPairUri;

/* pocketlink://pair?v=1&c=<id16>&h=<ipv4>[,<ipv4>…]&p=<port>&s=<hex32>&n=<name> */
bool link_parse_pair_uri(const char *uri, size_t length, LinkPairUri *out);

typedef struct {
  uint8_t flags;
  uint16_t port;
  char companion[LINK_ID_HEX + 1];
  char name[LINK_BEACON_NAME_BYTES + 1];
} LinkBeacon;

bool link_parse_beacon(const uint8_t *datagram, size_t length, LinkBeacon *out);

/* A lowercase 16-hex-digit id. */
bool link_valid_id(const char *text, size_t length);

void link_write_preamble(uint8_t out[LINK_PREAMBLE_BYTES]);
void link_write_header(uint8_t out[LINK_HEADER_BYTES], uint8_t type, uint32_t length);

/* HMAC(secret, label "\n" nD "\n" nC "\n" device "\n" companion). */
void link_proof(
  const uint8_t *secret,
  size_t secret_length,
  const char *label,
  const char *device_nonce,
  const char *companion_nonce,
  const char *device,
  const char *companion,
  uint8_t out[32]
);
/* HMAC(secret, "pocket-link/1/key\n" nD "\n" nC): XOR it with paired.key. */
void link_key_mask(
  const uint8_t *secret,
  size_t secret_length,
  const char *device_nonce,
  const char *companion_nonce,
  uint8_t out[32]
);

static inline uint32_t link_read_u32(const uint8_t *at) {
  return (uint32_t)at[0] | ((uint32_t)at[1] << 8) | ((uint32_t)at[2] << 16) | ((uint32_t)at[3] << 24);
}

static inline void link_write_u32(uint8_t *at, uint32_t value) {
  at[0] = (uint8_t)value;
  at[1] = (uint8_t)(value >> 8);
  at[2] = (uint8_t)(value >> 16);
  at[3] = (uint8_t)(value >> 24);
}

#endif
