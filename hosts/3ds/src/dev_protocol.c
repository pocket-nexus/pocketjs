#include "dev_protocol.h"

#include <string.h>

uint16_t pocket_runtime_read_u16(const uint8_t *bytes) {
  return (uint16_t)bytes[0] | (uint16_t)((uint16_t)bytes[1] << 8);
}

uint32_t pocket_runtime_read_u32(const uint8_t *bytes) {
  return (uint32_t)bytes[0] |
         ((uint32_t)bytes[1] << 8) |
         ((uint32_t)bytes[2] << 16) |
         ((uint32_t)bytes[3] << 24);
}

uint64_t pocket_runtime_read_u64(const uint8_t *bytes) {
  return (uint64_t)pocket_runtime_read_u32(bytes) |
         ((uint64_t)pocket_runtime_read_u32(bytes + 4) << 32);
}

void pocket_runtime_write_u16(uint8_t *bytes, uint16_t value) {
  bytes[0] = (uint8_t)value;
  bytes[1] = (uint8_t)(value >> 8);
}

void pocket_runtime_write_u32(uint8_t *bytes, uint32_t value) {
  bytes[0] = (uint8_t)value;
  bytes[1] = (uint8_t)(value >> 8);
  bytes[2] = (uint8_t)(value >> 16);
  bytes[3] = (uint8_t)(value >> 24);
}

void pocket_runtime_write_u64(uint8_t *bytes, uint64_t value) {
  pocket_runtime_write_u32(bytes, (uint32_t)value);
  pocket_runtime_write_u32(bytes + 4, (uint32_t)(value >> 32));
}

bool pocket_runtime_verify_hello(
  const uint8_t *bytes,
  size_t length,
  const uint8_t token[POCKET_RUNTIME_TOKEN_BYTES]
) {
  if (bytes == NULL || token == NULL || length != POCKET_RUNTIME_HELLO_BYTES) return false;
  if (pocket_runtime_read_u32(bytes) != POCKET_RUNTIME_WIRE_MAGIC ||
      bytes[4] != POCKET_RUNTIME_WIRE_VERSION || bytes[5] != 0 ||
      pocket_runtime_read_u16(bytes + 6) != POCKET_RUNTIME_TOKEN_BYTES) {
    return false;
  }
  /* Constant-time token comparison keeps a LAN peer from learning the
   * persistent pairing secret one byte at a time. */
  uint8_t different = 0;
  for (size_t index = 0; index < POCKET_RUNTIME_TOKEN_BYTES; index += 1) {
    different |= bytes[8 + index] ^ token[index];
  }
  return different == 0;
}

void pocket_runtime_encode_ack(
  uint8_t out[POCKET_RUNTIME_ACK_BYTES],
  uint8_t status,
  uint16_t host_abi,
  uint32_t generation,
  uint32_t flags,
  uint64_t active_hash
) {
  memset(out, 0, POCKET_RUNTIME_ACK_BYTES);
  pocket_runtime_write_u32(out, POCKET_RUNTIME_WIRE_MAGIC);
  out[4] = POCKET_RUNTIME_WIRE_VERSION;
  out[5] = status;
  pocket_runtime_write_u16(out + 6, host_abi);
  pocket_runtime_write_u32(out + 8, generation);
  pocket_runtime_write_u32(out + 12, flags);
  pocket_runtime_write_u64(out + 16, active_hash);
}

bool pocket_runtime_parse_frame_header(
  const uint8_t *bytes,
  size_t length,
  PocketRuntimeFrameHeader *out
) {
  if (bytes == NULL || out == NULL || length < POCKET_RUNTIME_FRAME_HEADER_BYTES) return false;
  uint32_t payload_length = pocket_runtime_read_u32(bytes + 4);
  if (bytes[2] != 0 || bytes[3] != 0 || payload_length > POCKET_RUNTIME_MAX_FRAME_BYTES) {
    return false;
  }
  out->type = bytes[0];
  out->flags = bytes[1];
  out->length = payload_length;
  return true;
}

void pocket_runtime_encode_frame_header(
  uint8_t out[POCKET_RUNTIME_FRAME_HEADER_BYTES],
  uint8_t type,
  uint8_t flags,
  uint32_t length
) {
  memset(out, 0, POCKET_RUNTIME_FRAME_HEADER_BYTES);
  out[0] = type;
  out[1] = flags;
  pocket_runtime_write_u32(out + 4, length);
}

bool pocket_runtime_parse_package_begin(
  const uint8_t *bytes,
  size_t length,
  PocketRuntimePackageBegin *out
) {
  if (bytes == NULL || out == NULL || length != POCKET_RUNTIME_PACKAGE_BEGIN_BYTES) return false;
  uint32_t package_length = pocket_runtime_read_u32(bytes);
  uint64_t footer_hash = pocket_runtime_read_u64(bytes + 4);
  if (package_length == 0 || package_length > 24u * 1024u * 1024u || footer_hash == 0) {
    return false;
  }
  out->length = package_length;
  out->footer_hash = footer_hash;
  return true;
}

bool pocket_runtime_native_name_valid(const char *name, size_t length) {
  static const char suffix[] = ".3dsx";
  const size_t suffix_length = sizeof suffix - 1;
  if (name == NULL || length <= suffix_length || length > POCKET_RUNTIME_NATIVE_NAME_BYTES) {
    return false;
  }
  if (name[0] == '.') return false;
  for (size_t index = 0; index < length; index += 1) {
    char c = name[index];
    bool allowed = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                   (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
    if (!allowed) return false;
  }
  for (size_t index = 0; index < suffix_length; index += 1) {
    char c = name[length - suffix_length + index];
    if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
    if (c != suffix[index]) return false;
  }
  return true;
}

static bool parse_native_name(
  const uint8_t *bytes,
  uint8_t length,
  char out[POCKET_RUNTIME_NATIVE_NAME_BYTES + 1]
) {
  if (length > POCKET_RUNTIME_NATIVE_NAME_BYTES) return false;
  for (size_t index = length; index < POCKET_RUNTIME_NATIVE_NAME_BYTES; index += 1) {
    if (bytes[index] != 0) return false;
  }
  memcpy(out, bytes, length);
  out[length] = '\0';
  return pocket_runtime_native_name_valid(out, length);
}

bool pocket_runtime_parse_native_begin(
  const uint8_t *bytes,
  size_t length,
  PocketRuntimeNativeBegin *out
) {
  if (bytes == NULL || out == NULL || length != POCKET_RUNTIME_NATIVE_BEGIN_BYTES) return false;
  memset(out, 0, sizeof *out);
  out->length = pocket_runtime_read_u32(bytes);
  out->crc32 = pocket_runtime_read_u32(bytes + 4);
  out->flags = bytes[8];
  if (out->length == 0 || out->length > POCKET_RUNTIME_NATIVE_MAX_BYTES ||
      (out->flags & ~POCKET_RUNTIME_NATIVE_FLAG_LAUNCH) != 0 ||
      pocket_runtime_read_u16(bytes + 10) != 0) {
    return false;
  }
  return parse_native_name(bytes + 12, bytes[9], out->name);
}

bool pocket_runtime_parse_launch(
  const uint8_t *bytes,
  size_t length,
  char name[POCKET_RUNTIME_NATIVE_NAME_BYTES + 1]
) {
  if (bytes == NULL || name == NULL || length != POCKET_RUNTIME_LAUNCH_BYTES) return false;
  if (bytes[1] != 0 || bytes[2] != 0 || bytes[3] != 0) return false;
  return parse_native_name(bytes + 4, bytes[0], name);
}

uint32_t pocket_runtime_crc32(uint32_t crc, const uint8_t *bytes, size_t length) {
  /* A byte table: chunks are checked on the render thread between frames. */
  static uint32_t table[256];
  static bool table_ready;
  if (!table_ready) {
    for (uint32_t index = 0; index < 256; index += 1) {
      uint32_t value = index;
      for (int bit = 0; bit < 8; bit += 1) value = (value >> 1) ^ (0xedb88320u & (0u - (value & 1u)));
      table[index] = value;
    }
    table_ready = true;
  }
  crc = ~crc;
  for (size_t index = 0; index < length; index += 1) {
    crc = table[(crc ^ bytes[index]) & 0xffu] ^ (crc >> 8);
  }
  return ~crc;
}

void pocket_runtime_encode_screenshot_begin(
  uint8_t out[POCKET_RUNTIME_SCREENSHOT_BEGIN_BYTES],
  uint32_t frame,
  uint16_t top_width,
  uint16_t top_height,
  uint16_t auxiliary_width,
  uint16_t auxiliary_height,
  uint32_t top_bytes,
  uint32_t auxiliary_bytes
) {
  memset(out, 0, POCKET_RUNTIME_SCREENSHOT_BEGIN_BYTES);
  pocket_runtime_write_u32(out, frame);
  pocket_runtime_write_u16(out + 4, top_width);
  pocket_runtime_write_u16(out + 6, top_height);
  pocket_runtime_write_u16(out + 8, auxiliary_width);
  pocket_runtime_write_u16(out + 10, auxiliary_height);
  out[12] = POCKET_RUNTIME_SCREENSHOT_FORMAT_ROTATED_RGB8;
  pocket_runtime_write_u32(out + 16, top_bytes);
  pocket_runtime_write_u32(out + 20, auxiliary_bytes);
}

uint64_t pocket_runtime_device_id(
  const uint8_t token[POCKET_RUNTIME_TOKEN_BYTES]
) {
  if (token == NULL) return 0;
  uint64_t hash = 0xcbf29ce484222325ULL;
  for (size_t index = 0; index < POCKET_RUNTIME_TOKEN_BYTES; index += 1) {
    hash ^= token[index];
    hash *= 0x100000001b3ULL;
  }
  return hash;
}

bool pocket_runtime_is_discovery_request(const uint8_t *bytes, size_t length) {
  return bytes != NULL && length == POCKET_RUNTIME_DISCOVERY_REQUEST_BYTES &&
         pocket_runtime_read_u32(bytes) == POCKET_RUNTIME_DISCOVERY_MAGIC &&
         bytes[4] == POCKET_RUNTIME_WIRE_VERSION &&
         bytes[5] == POCKET_RUNTIME_DISCOVERY_REQUEST &&
         bytes[6] == 0 && bytes[7] == 0;
}

static void write_fixed_text(uint8_t *out, size_t length, const char *text) {
  memset(out, 0, length);
  if (text == NULL) return;
  size_t text_length = strlen(text);
  if (text_length >= length) text_length = length - 1;
  memcpy(out, text, text_length);
}

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
) {
  memset(out, 0, POCKET_RUNTIME_DISCOVERY_REPLY_BYTES);
  pocket_runtime_write_u32(out, POCKET_RUNTIME_DISCOVERY_MAGIC);
  out[4] = POCKET_RUNTIME_WIRE_VERSION;
  out[5] = POCKET_RUNTIME_DISCOVERY_REPLY;
  pocket_runtime_write_u16(out + 6, host_abi);
  pocket_runtime_write_u16(out + 8, port);
  pocket_runtime_write_u16(out + 10, flags);
  pocket_runtime_write_u32(out + 12, generation);
  pocket_runtime_write_u64(out + 16, active_hash);
  pocket_runtime_write_u64(out + 24, device_id);
  write_fixed_text(out + 32, 16, target);
  write_fixed_text(out + 48, 16, label);
}
