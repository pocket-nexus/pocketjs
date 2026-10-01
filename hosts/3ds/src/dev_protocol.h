#ifndef POCKETJS_3DS_DEV_PROTOCOL_H
#define POCKETJS_3DS_DEV_PROTOCOL_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define POCKET_RUNTIME_WIRE_MAGIC 0x54524b50u /* 'PKRT' little-endian */
#define POCKET_RUNTIME_DISCOVERY_MAGIC 0x44524b50u /* 'PKRD' little-endian */
#define POCKET_RUNTIME_WIRE_VERSION 1u
#define POCKET_RUNTIME_WIRE_PORT 8131u
#define POCKET_RUNTIME_DISCOVERY_REQUEST_BYTES 8u
#define POCKET_RUNTIME_DISCOVERY_REPLY_BYTES 64u
#define POCKET_RUNTIME_DISCOVERY_REQUEST 1u
#define POCKET_RUNTIME_DISCOVERY_REPLY 2u
#define POCKET_RUNTIME_TOKEN_BYTES 32u
#define POCKET_RUNTIME_HELLO_BYTES 40u
#define POCKET_RUNTIME_ACK_BYTES 24u
#define POCKET_RUNTIME_FRAME_HEADER_BYTES 8u
#define POCKET_RUNTIME_MAX_FRAME_BYTES (64u * 1024u)
#define POCKET_RUNTIME_MAX_CTRL_BYTES (16u * 1024u)
#define POCKET_RUNTIME_PACKAGE_BEGIN_BYTES 12u
#define POCKET_RUNTIME_SCREENSHOT_BEGIN_BYTES 24u
#define POCKET_RUNTIME_SCREENSHOT_FORMAT_ROTATED_RGB8 1u
/* Ack flags: the listener is up, and this Runtime installs and launches
 * .3dsx files (NATIVE_* and LAUNCH messages). */
#define POCKET_RUNTIME_ACK_FLAG_LISTENING 1u
#define POCKET_RUNTIME_ACK_FLAG_NATIVE 2u
/* A .3dsx travels under a bare file name and lands at sdmc:/3ds/<name>. */
#define POCKET_RUNTIME_NATIVE_NAME_BYTES 64u
#define POCKET_RUNTIME_NATIVE_BEGIN_BYTES (12u + POCKET_RUNTIME_NATIVE_NAME_BYTES)
#define POCKET_RUNTIME_LAUNCH_BYTES (4u + POCKET_RUNTIME_NATIVE_NAME_BYTES)
/* A 3DSX header alone is 0x20 bytes. */
#define POCKET_RUNTIME_NATIVE_MIN_BYTES 0x20u
#define POCKET_RUNTIME_NATIVE_MAX_BYTES (32u * 1024u * 1024u)
#define POCKET_RUNTIME_NATIVE_FLAG_LAUNCH 1u

enum PocketRuntimeMessage {
  POCKET_RUNTIME_MSG_PING = 0x01,
  POCKET_RUNTIME_MSG_PONG = 0x02,
  POCKET_RUNTIME_MSG_CTRL = 0x10,
  POCKET_RUNTIME_MSG_PACKAGE_BEGIN = 0x20,
  POCKET_RUNTIME_MSG_PACKAGE_CHUNK = 0x21,
  POCKET_RUNTIME_MSG_PACKAGE_COMMIT = 0x22,
  POCKET_RUNTIME_MSG_PACKAGE_ABORT = 0x23,
  POCKET_RUNTIME_MSG_NATIVE_BEGIN = 0x24,
  POCKET_RUNTIME_MSG_NATIVE_CHUNK = 0x25,
  POCKET_RUNTIME_MSG_NATIVE_COMMIT = 0x26,
  POCKET_RUNTIME_MSG_NATIVE_ABORT = 0x27,
  POCKET_RUNTIME_MSG_LAUNCH = 0x28,
  POCKET_RUNTIME_MSG_SCREENSHOT_BEGIN = 0x30,
  POCKET_RUNTIME_MSG_SCREENSHOT_CHUNK = 0x31,
  POCKET_RUNTIME_MSG_SCREENSHOT_END = 0x32,
  POCKET_RUNTIME_MSG_STATUS_REQUEST = 0x40,
};

typedef struct {
  uint8_t type;
  uint8_t flags;
  uint32_t length;
} PocketRuntimeFrameHeader;

typedef struct {
  uint32_t length;
  uint64_t footer_hash;
} PocketRuntimePackageBegin;

typedef struct {
  uint32_t length;
  uint32_t crc32;
  uint8_t flags;
  char name[POCKET_RUNTIME_NATIVE_NAME_BYTES + 1];
} PocketRuntimeNativeBegin;

uint16_t pocket_runtime_read_u16(const uint8_t *bytes);
uint32_t pocket_runtime_read_u32(const uint8_t *bytes);
uint64_t pocket_runtime_read_u64(const uint8_t *bytes);
void pocket_runtime_write_u16(uint8_t *bytes, uint16_t value);
void pocket_runtime_write_u32(uint8_t *bytes, uint32_t value);
void pocket_runtime_write_u64(uint8_t *bytes, uint64_t value);

bool pocket_runtime_verify_hello(
  const uint8_t *bytes,
  size_t length,
  const uint8_t token[POCKET_RUNTIME_TOKEN_BYTES]
);
void pocket_runtime_encode_ack(
  uint8_t out[POCKET_RUNTIME_ACK_BYTES],
  uint8_t status,
  uint16_t host_abi,
  uint32_t generation,
  uint32_t flags,
  uint64_t active_hash
);
bool pocket_runtime_parse_frame_header(
  const uint8_t *bytes,
  size_t length,
  PocketRuntimeFrameHeader *out
);
void pocket_runtime_encode_frame_header(
  uint8_t out[POCKET_RUNTIME_FRAME_HEADER_BYTES],
  uint8_t type,
  uint8_t flags,
  uint32_t length
);
bool pocket_runtime_parse_package_begin(
  const uint8_t *bytes,
  size_t length,
  PocketRuntimePackageBegin *out
);
/* A .3dsx name is 6..64 bytes of [A-Za-z0-9._-], ends in ".3dsx" and does
 * not start with a dot, so it names one file directly under sdmc:/3ds/. */
bool pocket_runtime_native_name_valid(const char *name, size_t length);
/* Layout: u32 length, u32 CRC-32, u8 flags, u8 name length, u16 zero,
 * 64 name bytes zero-padded. */
bool pocket_runtime_parse_native_begin(
  const uint8_t *bytes,
  size_t length,
  PocketRuntimeNativeBegin *out
);
/* Layout: u8 name length, three zero bytes, 64 name bytes zero-padded. */
bool pocket_runtime_parse_launch(
  const uint8_t *bytes,
  size_t length,
  char name[POCKET_RUNTIME_NATIVE_NAME_BYTES + 1]
);
/* zlib's CRC-32; start from 0 and feed the running value back in. */
uint32_t pocket_runtime_crc32(uint32_t crc, const uint8_t *bytes, size_t length);
void pocket_runtime_encode_screenshot_begin(
  uint8_t out[POCKET_RUNTIME_SCREENSHOT_BEGIN_BYTES],
  uint32_t frame,
  uint16_t top_width,
  uint16_t top_height,
  uint16_t auxiliary_width,
  uint16_t auxiliary_height,
  uint32_t top_bytes,
  uint32_t auxiliary_bytes
);
uint64_t pocket_runtime_device_id(
  const uint8_t token[POCKET_RUNTIME_TOKEN_BYTES]
);
bool pocket_runtime_is_discovery_request(const uint8_t *bytes, size_t length);
void pocket_runtime_encode_discovery_reply(
  uint8_t out[POCKET_RUNTIME_DISCOVERY_REPLY_BYTES],
  uint16_t host_abi,
  uint16_t port,
  uint16_t flags,
  uint32_t generation,
  uint64_t active_hash,
  uint64_t device_id,
  const char *target,
  const char *label
);

#endif
