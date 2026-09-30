#include <assert.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "native.h"

static int exists(const char *path) {
  struct stat info;
  return stat(path, &info) == 0;
}

static void write_text(const char *path, const char *text) {
  FILE *file = fopen(path, "wb");
  assert(file != NULL);
  assert(fputs(text, file) >= 0);
  assert(fclose(file) == 0);
}

static int contains(const char *path, const char *text) {
  char buffer[128] = {0};
  FILE *file = fopen(path, "rb");
  if (file == NULL) return 0;
  size_t length = fread(buffer, 1, sizeof buffer - 1, file);
  fclose(file);
  return length == strlen(text) && memcmp(buffer, text, length) == 0;
}

static PocketRuntimeNativeBegin header(const char *name, const char *bytes, uint8_t flags) {
  PocketRuntimeNativeBegin begin;
  memset(&begin, 0, sizeof begin);
  begin.length = (uint32_t)strlen(bytes);
  begin.crc32 = pocket_runtime_crc32(0, (const uint8_t *)bytes, strlen(bytes));
  begin.flags = flags;
  snprintf(begin.name, sizeof begin.name, "%s", name);
  return begin;
}

/* Streams `bytes` in two chunks, the way the tool splits a large file. */
static int transfer(const PocketRuntimeNativeBegin *begin, const char *bytes, NativeInstall *out, char *error) {
  size_t length = strlen(bytes);
  size_t split = length / 2;
  if (!native_begin(begin, error, 160)) return 0;
  if (!native_write(0, (const uint8_t *)bytes, split, error, 160)) return 0;
  if (!native_write((uint32_t)split, (const uint8_t *)bytes + split, length - split, error, 160)) return 0;
  return native_commit(out, error, 160);
}

int main(int argc, char **argv) {
  assert(argc == 2);
  assert(chdir(argv[1]) == 0);
  assert(mkdir("sdmc:", 0777) == 0 || errno == EEXIST);
  assert(mkdir("sdmc:/pocketjs", 0777) == 0 || errno == EEXIST);
  assert(mkdir(POCKET_RUNTIME_ROOT, 0777) == 0 || errno == EEXIST);

  /* zlib's CRC-32 check value, fed whole and in pieces. */
  assert(pocket_runtime_crc32(0, (const uint8_t *)"123456789", 9) == 0xcbf43926u);
  assert(pocket_runtime_crc32(pocket_runtime_crc32(0, (const uint8_t *)"1234", 4), (const uint8_t *)"56789", 5) == 0xcbf43926u);

  /* Names address one file directly under sdmc:/3ds. */
  assert(pocket_runtime_native_name_valid("pocketshell-main.3dsx", 21));
  assert(pocket_runtime_native_name_valid("Pocket_Nexus.3DSX", 17));
  assert(!pocket_runtime_native_name_valid(".3dsx", 5));
  assert(!pocket_runtime_native_name_valid(".hidden.3dsx", 12));
  assert(!pocket_runtime_native_name_valid("../boot.3dsx", 12));
  assert(!pocket_runtime_native_name_valid("dir/app.3dsx", 12));
  assert(!pocket_runtime_native_name_valid("app.cia", 7));
  assert(!pocket_runtime_native_name_valid("app 1.3dsx", 10));

  uint8_t frame[POCKET_RUNTIME_NATIVE_BEGIN_BYTES] = {0};
  pocket_runtime_write_u32(frame, 2810384);
  pocket_runtime_write_u32(frame + 4, 0xafe26828u);
  frame[8] = POCKET_RUNTIME_NATIVE_FLAG_LAUNCH;
  frame[9] = 21;
  memcpy(frame + 12, "pocketshell-main.3dsx", 21);
  PocketRuntimeNativeBegin parsed;
  assert(pocket_runtime_parse_native_begin(frame, sizeof frame, &parsed));
  assert(parsed.length == 2810384 && parsed.crc32 == 0xafe26828u);
  assert(parsed.flags == POCKET_RUNTIME_NATIVE_FLAG_LAUNCH);
  assert(strcmp(parsed.name, "pocketshell-main.3dsx") == 0);
  frame[12 + 30] = 'x'; /* bytes after the name must be zero */
  assert(!pocket_runtime_parse_native_begin(frame, sizeof frame, &parsed));
  frame[12 + 30] = 0;
  frame[8] = 0x80; /* unknown flag */
  assert(!pocket_runtime_parse_native_begin(frame, sizeof frame, &parsed));
  frame[8] = 0;
  pocket_runtime_write_u32(frame, POCKET_RUNTIME_NATIVE_MAX_BYTES + 1);
  assert(!pocket_runtime_parse_native_begin(frame, sizeof frame, &parsed));

  uint8_t launch[POCKET_RUNTIME_LAUNCH_BYTES] = {0};
  char name[POCKET_RUNTIME_NATIVE_NAME_BYTES + 1];
  launch[0] = 10;
  memcpy(launch + 4, "nexus.3dsx", 10);
  assert(pocket_runtime_parse_launch(launch, sizeof launch, name));
  assert(strcmp(name, "nexus.3dsx") == 0);
  launch[2] = 1;
  assert(!pocket_runtime_parse_launch(launch, sizeof launch, name));

  char error[160] = {0};
  NativeInstall install;
  native_set_running_path("sdmc:/3ds/Self.3dsx");

  /* A new file lands under sdmc:/3ds, which is created on demand. */
  PocketRuntimeNativeBegin other = header("other.3dsx", "3DSX-first", POCKET_RUNTIME_NATIVE_FLAG_LAUNCH);
  assert(transfer(&other, "3DSX-first", &install, error));
  assert(!install.deferred && install.launch);
  assert(strcmp(install.path, "sdmc:/3ds/other.3dsx") == 0);
  assert(contains("sdmc:/3ds/other.3dsx", "3DSX-first"));
  assert(!exists(POCKET_NATIVE_UPLOAD) && !exists(POCKET_NATIVE_PREVIOUS));

  /* Replacing it keeps the previous file. */
  other = header("other.3dsx", "3DSX-second", 0);
  assert(transfer(&other, "3DSX-second", &install, error));
  assert(!install.launch);
  assert(contains("sdmc:/3ds/other.3dsx", "3DSX-second"));
  assert(contains(POCKET_NATIVE_PREVIOUS, "3DSX-first"));

  /* A corrupted transfer, a non-3DSX file and a gap all leave the target alone. */
  other = header("other.3dsx", "3DSX-third", 0);
  other.crc32 ^= 1;
  assert(!transfer(&other, "3DSX-third", &install, error));
  assert(strstr(error, "CRC-32") != NULL);
  assert(contains("sdmc:/3ds/other.3dsx", "3DSX-second"));
  assert(!exists(POCKET_NATIVE_UPLOAD));
  other = header("other.3dsx", "ELF-binary", 0);
  assert(!transfer(&other, "ELF-binary", &install, error));
  assert(strstr(error, "not a 3DSX") != NULL);
  other = header("other.3dsx", "3DSX-gap", 0);
  assert(native_begin(&other, error, sizeof error));
  assert(!native_write(2, (const uint8_t *)"SX-gap", 6, error, sizeof error));
  assert(!native_receiving() && !exists(POCKET_NATIVE_UPLOAD));
  assert(contains("sdmc:/3ds/other.3dsx", "3DSX-second"));

  /* The running .3dsx (matched without case) is replaced only at exit. */
  write_text("sdmc:/3ds/self.3dsx", "3DSX-running");
  PocketRuntimeNativeBegin self = header("self.3dsx", "3DSX-update", POCKET_RUNTIME_NATIVE_FLAG_LAUNCH);
  assert(transfer(&self, "3DSX-update", &install, error));
  assert(install.deferred && install.launch);
  assert(native_exit_pending());
  assert(contains("sdmc:/3ds/self.3dsx", "3DSX-running"));
  assert(native_finish_exit(error, sizeof error));
  assert(!native_exit_pending());
  assert(contains("sdmc:/3ds/self.3dsx", "3DSX-update"));
  assert(contains(POCKET_NATIVE_PREVIOUS, "3DSX-running"));
  return 0;
}
