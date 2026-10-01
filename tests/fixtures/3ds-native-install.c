#include <assert.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "native.h"

/* A 3DSX header is 0x20 bytes: every fixture file is at least that long. */
#define BODY "................................"

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

  char error[160] = {0};
  NativeInstall install;
  /* argv[0] without the device prefix still names the running file. */
  native_set_running_path("/3ds/Self.3dsx");

  /* A new file lands under sdmc:/3ds, which is created on demand. */
  PocketRuntimeNativeBegin other = header("other.3dsx", "3DSX-first" BODY, POCKET_RUNTIME_NATIVE_FLAG_LAUNCH);
  assert(transfer(&other, "3DSX-first" BODY, &install, error));
  assert(!install.deferred && install.launch);
  assert(strcmp(install.name, "other.3dsx") == 0);
  assert(strcmp(install.path, "sdmc:/3ds/other.3dsx") == 0);
  assert(contains("sdmc:/3ds/other.3dsx", "3DSX-first" BODY));
  assert(!exists(POCKET_NATIVE_UPLOAD) && !exists(POCKET_NATIVE_PREVIOUS));
  assert(strcmp(native_receiving_name(), "") == 0);

  /* Replacing it keeps the previous file. */
  other = header("other.3dsx", "3DSX-second" BODY, 0);
  assert(transfer(&other, "3DSX-second" BODY, &install, error));
  assert(!install.launch);
  assert(contains("sdmc:/3ds/other.3dsx", "3DSX-second" BODY));
  assert(contains(POCKET_NATIVE_PREVIOUS, "3DSX-first" BODY));

  /* A corrupted transfer, a non-3DSX file, a short file and a gap all leave
   * the target alone. The magic of the previous transfer does not carry over. */
  other = header("other.3dsx", "3DSX-third" BODY, 0);
  other.crc32 ^= 1;
  assert(!transfer(&other, "3DSX-third" BODY, &install, error));
  assert(strstr(error, "CRC-32") != NULL);
  assert(contains("sdmc:/3ds/other.3dsx", "3DSX-second" BODY));
  assert(!exists(POCKET_NATIVE_UPLOAD));
  other = header("other.3dsx", "ELF-binary" BODY, 0);
  assert(!transfer(&other, "ELF-binary" BODY, &install, error));
  assert(strstr(error, "not a 3DSX") != NULL);
  other = header("other.3dsx", "3", 0);
  assert(!native_begin(&other, error, sizeof error));
  other = header("other.3dsx", "3DSX-gap" BODY, 0);
  assert(native_begin(&other, error, sizeof error));
  assert(strcmp(native_receiving_name(), "other.3dsx") == 0);
  assert(!native_write(2, (const uint8_t *)"SX-gap", 6, error, sizeof error));
  assert(!native_receiving() && !exists(POCKET_NATIVE_UPLOAD));
  assert(strcmp(native_receiving_name(), "") == 0);
  assert(contains("sdmc:/3ds/other.3dsx", "3DSX-second" BODY));

  /* The running .3dsx (matched without case or device prefix) moves to its
   * own file and is replaced only at exit. */
  write_text("sdmc:/3ds/self.3dsx", "3DSX-running" BODY);
  PocketRuntimeNativeBegin self = header("self.3dsx", "3DSX-update" BODY, POCKET_RUNTIME_NATIVE_FLAG_LAUNCH);
  assert(transfer(&self, "3DSX-update" BODY, &install, error));
  assert(install.deferred && install.launch);
  assert(native_exit_pending());
  assert(contains(POCKET_NATIVE_DEFERRED, "3DSX-update" BODY));
  assert(!exists(POCKET_NATIVE_UPLOAD));
  assert(contains("sdmc:/3ds/self.3dsx", "3DSX-running" BODY));

  /* Later transfers, failed ones and aborts do not disturb it. */
  other = header("other.3dsx", "3DSX-fourth" BODY, 0);
  assert(transfer(&other, "3DSX-fourth" BODY, &install, error));
  assert(native_begin(&other, error, sizeof error));
  native_abort();
  assert(native_exit_pending() && contains(POCKET_NATIVE_DEFERRED, "3DSX-update" BODY));

  assert(native_finish_exit(error, sizeof error));
  assert(!native_exit_pending());
  assert(contains("sdmc:/3ds/self.3dsx", "3DSX-update" BODY));
  assert(contains(POCKET_NATIVE_PREVIOUS, "3DSX-running" BODY));
  assert(!exists(POCKET_NATIVE_DEFERRED));

  /* A swap without its staged file touches neither the target nor the backup. */
  assert(!native_swap(POCKET_NATIVE_DEFERRED, "sdmc:/3ds/self.3dsx", error, sizeof error));
  assert(strstr(error, "missing") != NULL);
  assert(contains("sdmc:/3ds/self.3dsx", "3DSX-update" BODY));
  assert(contains(POCKET_NATIVE_PREVIOUS, "3DSX-running" BODY));
  return 0;
}
