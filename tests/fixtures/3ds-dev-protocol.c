#include <assert.h>
#include <stdint.h>
#include <string.h>

#include "dev_protocol.h"

int main(void) {
  uint8_t token[POCKET_RUNTIME_TOKEN_BYTES];
  uint8_t hello[POCKET_RUNTIME_HELLO_BYTES] = {0};
  for (uint32_t index = 0; index < POCKET_RUNTIME_TOKEN_BYTES; index += 1) {
    token[index] = (uint8_t)index;
  }
  pocket_runtime_write_u32(hello, POCKET_RUNTIME_WIRE_MAGIC);
  hello[4] = POCKET_RUNTIME_WIRE_VERSION;
  pocket_runtime_write_u16(hello + 6, POCKET_RUNTIME_TOKEN_BYTES);
  memcpy(hello + 8, token, sizeof token);
  assert(pocket_runtime_verify_hello(hello, sizeof hello, token));
  hello[39] ^= 1;
  assert(!pocket_runtime_verify_hello(hello, sizeof hello, token));

  uint8_t ack[POCKET_RUNTIME_ACK_BYTES];
  pocket_runtime_encode_ack(ack, 0, 8, 0x11223344, 3, 0x0102030405060708ULL);
  assert(pocket_runtime_read_u32(ack) == POCKET_RUNTIME_WIRE_MAGIC);
  assert(ack[4] == POCKET_RUNTIME_WIRE_VERSION && ack[5] == 0);
  assert(pocket_runtime_read_u16(ack + 6) == 8);
  assert(pocket_runtime_read_u32(ack + 8) == 0x11223344);
  assert(pocket_runtime_read_u64(ack + 16) == 0x0102030405060708ULL);

  uint8_t header[POCKET_RUNTIME_FRAME_HEADER_BYTES];
  pocket_runtime_encode_frame_header(header, POCKET_RUNTIME_MSG_CTRL, 7, 1234);
  PocketRuntimeFrameHeader parsed;
  assert(pocket_runtime_parse_frame_header(header, sizeof header, &parsed));
  assert(parsed.type == POCKET_RUNTIME_MSG_CTRL && parsed.flags == 7 && parsed.length == 1234);
  pocket_runtime_write_u32(header + 4, POCKET_RUNTIME_MAX_FRAME_BYTES + 1);
  assert(!pocket_runtime_parse_frame_header(header, sizeof header, &parsed));

  uint8_t begin[POCKET_RUNTIME_PACKAGE_BEGIN_BYTES];
  pocket_runtime_write_u32(begin, 390200);
  pocket_runtime_write_u64(begin + 4, 0xe01adc15327d4203ULL);
  PocketRuntimePackageBegin package;
  assert(pocket_runtime_parse_package_begin(begin, sizeof begin, &package));
  assert(package.length == 390200 && package.footer_hash == 0xe01adc15327d4203ULL);

  uint8_t screenshot[POCKET_RUNTIME_SCREENSHOT_BEGIN_BYTES];
  pocket_runtime_encode_screenshot_begin(
    screenshot,
    99,
    400,
    240,
    320,
    240,
    400 * 240 * 3,
    320 * 240 * 3
  );
  assert(pocket_runtime_read_u32(screenshot) == 99);
  assert(pocket_runtime_read_u16(screenshot + 4) == 400);
  assert(pocket_runtime_read_u16(screenshot + 8) == 320);
  assert(screenshot[12] == POCKET_RUNTIME_SCREENSHOT_FORMAT_ROTATED_RGB8);
  assert(pocket_runtime_read_u32(screenshot + 16) == 400 * 240 * 3);

  uint8_t discovery_request[POCKET_RUNTIME_DISCOVERY_REQUEST_BYTES] = {0};
  pocket_runtime_write_u32(discovery_request, POCKET_RUNTIME_DISCOVERY_MAGIC);
  discovery_request[4] = POCKET_RUNTIME_WIRE_VERSION;
  discovery_request[5] = POCKET_RUNTIME_DISCOVERY_REQUEST;
  assert(pocket_runtime_is_discovery_request(discovery_request, sizeof discovery_request));
  assert(pocket_runtime_device_id(token) == 0xe6cb594c1a148ac5ULL);

  uint8_t discovery[POCKET_RUNTIME_DISCOVERY_REPLY_BYTES];
  pocket_runtime_encode_discovery_reply(
    discovery,
    8,
    8131,
    1,
    3,
    0xe01adc15327d4203ULL,
    pocket_runtime_device_id(token),
    "3ds-dev",
    "PocketJS 3DS"
  );
  assert(pocket_runtime_read_u32(discovery) == POCKET_RUNTIME_DISCOVERY_MAGIC);
  assert(discovery[5] == POCKET_RUNTIME_DISCOVERY_REPLY);
  assert(pocket_runtime_read_u16(discovery + 8) == 8131);
  assert(pocket_runtime_read_u64(discovery + 24) == 0xe6cb594c1a148ac5ULL);
  assert(strcmp((const char *)discovery + 32, "3ds-dev") == 0);

  /* zlib's CRC-32 check value, fed whole and in pieces. */
  assert(pocket_runtime_crc32(0, (const uint8_t *)"123456789", 9) == 0xcbf43926u);
  assert(pocket_runtime_crc32(pocket_runtime_crc32(0, (const uint8_t *)"1234", 4), (const uint8_t *)"56789", 5) == 0xcbf43926u);

  /* .3dsx names address one file directly under sdmc:/3ds. */
  assert(pocket_runtime_native_name_valid("pocketshell-main.3dsx", 21));
  assert(pocket_runtime_native_name_valid("Pocket_Nexus.3DSX", 17));
  assert(pocket_runtime_native_name_valid("a.3dsx", 6));
  assert(!pocket_runtime_native_name_valid(".3dsx", 5));
  assert(!pocket_runtime_native_name_valid(".hidden.3dsx", 12));
  assert(!pocket_runtime_native_name_valid("../boot.3dsx", 12));
  assert(!pocket_runtime_native_name_valid("dir/app.3dsx", 12));
  assert(!pocket_runtime_native_name_valid("app.cia", 7));
  assert(!pocket_runtime_native_name_valid("app 1.3dsx", 10));

  /* The NATIVE_BEGIN frame tests/3ds-runtime-wire.test.ts encodes. */
  uint8_t native[POCKET_RUNTIME_NATIVE_BEGIN_BYTES] = {0};
  pocket_runtime_write_u32(native, 2810384);
  pocket_runtime_write_u32(native + 4, 0xafe26828u);
  native[8] = POCKET_RUNTIME_NATIVE_FLAG_LAUNCH;
  native[9] = 21;
  memcpy(native + 12, "pocketshell-main.3dsx", 21);
  PocketRuntimeNativeBegin native_begin;
  assert(pocket_runtime_parse_native_begin(native, sizeof native, &native_begin));
  assert(native_begin.length == 2810384 && native_begin.crc32 == 0xafe26828u);
  assert(native_begin.flags == POCKET_RUNTIME_NATIVE_FLAG_LAUNCH);
  assert(strcmp(native_begin.name, "pocketshell-main.3dsx") == 0);
  native[12 + 30] = 'x'; /* bytes after the name must be zero */
  assert(!pocket_runtime_parse_native_begin(native, sizeof native, &native_begin));
  native[12 + 30] = 0;
  native[8] = 0x80; /* unknown flag */
  assert(!pocket_runtime_parse_native_begin(native, sizeof native, &native_begin));
  native[8] = 0;
  pocket_runtime_write_u32(native, POCKET_RUNTIME_NATIVE_MAX_BYTES + 1);
  assert(!pocket_runtime_parse_native_begin(native, sizeof native, &native_begin));
  pocket_runtime_write_u32(native, POCKET_RUNTIME_NATIVE_MIN_BYTES - 1); /* shorter than a 3DSX header */
  assert(!pocket_runtime_parse_native_begin(native, sizeof native, &native_begin));

  uint8_t launch[POCKET_RUNTIME_LAUNCH_BYTES] = {0};
  char name[POCKET_RUNTIME_NATIVE_NAME_BYTES + 1];
  launch[0] = 10;
  memcpy(launch + 4, "nexus.3dsx", 10);
  assert(pocket_runtime_parse_launch(launch, sizeof launch, name));
  assert(strcmp(name, "nexus.3dsx") == 0);
  launch[2] = 1;
  assert(!pocket_runtime_parse_launch(launch, sizeof launch, name));
  return 0;
}
