/*
 * .3dsx installation for the Pocket Runtime development connection.
 *
 * Plain stdio and rename: the same file compiles on the host for tests
 * (tests/fixtures/3ds-native-install.c), where "sdmc:" is a directory.
 */

#include "native.h"

#include <errno.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>

static FILE *upload_file;
static PocketRuntimeNativeBegin upload;
static uint32_t upload_received;
static uint32_t upload_crc;
static uint8_t upload_magic[4];

static char running_path[POCKET_NATIVE_PATH_BYTES];
static bool exit_pending;
static char exit_target[POCKET_NATIVE_PATH_BYTES];

static void set_error(char *out, size_t length, const char *format, ...) {
  if (out == NULL || length == 0) return;
  va_list arguments;
  va_start(arguments, format);
  vsnprintf(out, length, format, arguments);
  va_end(arguments);
}

static bool same_path(const char *a, const char *b) {
  /* FAT compares names without case. */
  for (;; a += 1, b += 1) {
    char x = *a >= 'A' && *a <= 'Z' ? (char)(*a - 'A' + 'a') : *a;
    char y = *b >= 'A' && *b <= 'Z' ? (char)(*b - 'A' + 'a') : *b;
    if (x != y) return false;
    if (x == '\0') return true;
  }
}

void native_set_running_path(const char *path) {
  snprintf(running_path, sizeof running_path, "%s", path == NULL ? "" : path);
}

bool native_path_for(const char *name, char out[POCKET_NATIVE_PATH_BYTES]) {
  if (name == NULL || !pocket_runtime_native_name_valid(name, strlen(name))) return false;
  int written = snprintf(out, POCKET_NATIVE_PATH_BYTES, "%s/%s", POCKET_NATIVE_DIR, name);
  return written > 0 && (size_t)written < POCKET_NATIVE_PATH_BYTES;
}

bool native_receiving(void) {
  return upload_file != NULL;
}

const char *native_receiving_name(void) {
  return upload.name;
}

void native_abort(void) {
  if (upload_file != NULL) fclose(upload_file);
  upload_file = NULL;
  upload_received = 0;
  upload_crc = 0;
  remove(POCKET_NATIVE_UPLOAD);
}

bool native_begin(const PocketRuntimeNativeBegin *begin, char *error, size_t error_length) {
  native_abort();
  if (begin == NULL) {
    set_error(error, error_length, "missing .3dsx transfer header");
    return false;
  }
  /* A deferred replacement of the running binary shares the staging file. */
  exit_pending = false;
  upload = *begin;
  upload_file = fopen(POCKET_NATIVE_UPLOAD, "wb");
  if (upload_file == NULL) {
    set_error(error, error_length, "open %s failed (%d)", POCKET_NATIVE_UPLOAD, errno);
    return false;
  }
  return true;
}

bool native_write(
  uint32_t offset,
  const uint8_t *bytes,
  size_t length,
  char *error,
  size_t error_length
) {
  if (upload_file == NULL) {
    set_error(error, error_length, ".3dsx chunk arrived without an active transfer");
    return false;
  }
  if (offset != upload_received || length == 0 || length > upload.length - upload_received) {
    set_error(error, error_length, ".3dsx chunk at %lu does not continue %lu of %lu bytes",
      (unsigned long)offset, (unsigned long)upload_received, (unsigned long)upload.length);
    native_abort();
    return false;
  }
  if (fwrite(bytes, 1, length, upload_file) != length) {
    set_error(error, error_length, "SD write failed at %lu (%d)", (unsigned long)offset, errno);
    native_abort();
    return false;
  }
  for (size_t index = 0; index < length && offset + index < sizeof upload_magic; index += 1) {
    upload_magic[offset + index] = bytes[index];
  }
  upload_crc = pocket_runtime_crc32(upload_crc, bytes, length);
  upload_received += (uint32_t)length;
  return true;
}

bool native_commit(NativeInstall *out, char *error, size_t error_length) {
  if (upload_file == NULL || upload_received != upload.length) {
    set_error(error, error_length, ".3dsx commit arrived before every declared byte");
    native_abort();
    return false;
  }
  bool flushed = fflush(upload_file) == 0;
  if (fclose(upload_file) != 0) flushed = false;
  upload_file = NULL;
  if (!flushed) {
    set_error(error, error_length, "flush %s failed", POCKET_NATIVE_UPLOAD);
    native_abort();
    return false;
  }
  if (upload_crc != upload.crc32) {
    set_error(error, error_length, "CRC-32 %08lx does not match the declared %08lx",
      (unsigned long)upload_crc, (unsigned long)upload.crc32);
    native_abort();
    return false;
  }
  if (memcmp(upload_magic, "3DSX", sizeof upload_magic) != 0) {
    set_error(error, error_length, "%s is not a 3DSX executable", upload.name);
    native_abort();
    return false;
  }

  NativeInstall install;
  memset(&install, 0, sizeof install);
  snprintf(install.name, sizeof install.name, "%s", upload.name);
  if (!native_path_for(install.name, install.path)) {
    set_error(error, error_length, "invalid .3dsx name %s", install.name);
    native_abort();
    return false;
  }
  install.launch = (upload.flags & POCKET_RUNTIME_NATIVE_FLAG_LAUNCH) != 0;
  install.deferred = running_path[0] != '\0' && same_path(running_path, install.path);
  if (mkdir(POCKET_NATIVE_DIR, 0777) != 0 && errno != EEXIST) {
    set_error(error, error_length, "mkdir %s failed (%d)", POCKET_NATIVE_DIR, errno);
    native_abort();
    return false;
  }
  if (install.deferred) {
    exit_pending = true;
    snprintf(exit_target, sizeof exit_target, "%s", install.path);
  } else if (!native_swap(POCKET_NATIVE_UPLOAD, install.path, error, error_length)) {
    native_abort();
    return false;
  }
  if (out != NULL) *out = install;
  return true;
}

bool native_swap(const char *staged, const char *target, char *error, size_t error_length) {
  struct stat info;
  bool had_target = stat(target, &info) == 0;
  if (remove(POCKET_NATIVE_PREVIOUS) != 0 && errno != ENOENT) {
    set_error(error, error_length, "remove %s failed (%d)", POCKET_NATIVE_PREVIOUS, errno);
    return false;
  }
  if (had_target && rename(target, POCKET_NATIVE_PREVIOUS) != 0) {
    set_error(error, error_length, "move %s aside failed (%d)", target, errno);
    return false;
  }
  if (rename(staged, target) != 0) {
    int code = errno;
    if (had_target) rename(POCKET_NATIVE_PREVIOUS, target);
    set_error(error, error_length, "rename into %s failed (%d)", target, code);
    return false;
  }
  return true;
}

bool native_exit_pending(void) {
  return exit_pending;
}

bool native_finish_exit(char *error, size_t error_length) {
  if (!exit_pending) return true;
  exit_pending = false;
  return native_swap(POCKET_NATIVE_UPLOAD, exit_target, error, error_length);
}
