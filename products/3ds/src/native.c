/*
 * .3dsx installation for the Pocket Runtime development connection.
 *
 * Plain stdio and rename: the same file compiles on the host for tests
 * (tests/fixtures/3ds-native-install.c), where "sdmc:" is a directory.
 */

#include "native.h"
#include "error_text.h"

#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>

/* The transfer in progress; cleared by native_begin and native_abort. */
static FILE *upload_file;
static PocketRuntimeNativeBegin upload;
static uint32_t upload_received;
static uint32_t upload_crc;
static uint8_t upload_magic[4];

/* A committed replacement of the running .3dsx, held in its own file. */
static char running_path[POCKET_NATIVE_PATH_BYTES];
static bool exit_pending;
static char exit_target[POCKET_NATIVE_PATH_BYTES];

/* Paths compare without the "sdmc:" device prefix and without case: FAT
 * ignores case, and argv[0] may name the file either way. */
static const char *without_device(const char *path) {
  return strncmp(path, "sdmc:", 5) == 0 ? path + 5 : path;
}

static bool same_path(const char *a, const char *b) {
  a = without_device(a);
  b = without_device(b);
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
  return upload_file != NULL ? upload.name : "";
}

static void clear_transfer(void) {
  if (upload_file != NULL) fclose(upload_file);
  upload_file = NULL;
  memset(&upload, 0, sizeof upload);
  memset(upload_magic, 0, sizeof upload_magic);
  upload_received = 0;
  upload_crc = 0;
}

void native_abort(void) {
  clear_transfer();
  remove(POCKET_NATIVE_UPLOAD);
}

bool native_begin(const PocketRuntimeNativeBegin *begin, char *error, size_t error_length) {
  native_abort();
  if (begin == NULL || begin->length < POCKET_RUNTIME_NATIVE_MIN_BYTES ||
      begin->length > POCKET_RUNTIME_NATIVE_MAX_BYTES) {
    pocket_set_error(error, error_length, ".3dsx transfer header is missing or out of range");
    return false;
  }
  upload_file = fopen(POCKET_NATIVE_UPLOAD, "wb");
  if (upload_file == NULL) {
    pocket_set_error(error, error_length, "open %s failed (%d)", POCKET_NATIVE_UPLOAD, errno);
    return false;
  }
  upload = *begin;
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
    pocket_set_error(error, error_length, ".3dsx chunk arrived without an active transfer");
    return false;
  }
  if (offset != upload_received || length == 0 || length > upload.length - upload_received) {
    pocket_set_error(error, error_length, ".3dsx chunk at %lu does not continue %lu of %lu bytes",
      (unsigned long)offset, (unsigned long)upload_received, (unsigned long)upload.length);
    native_abort();
    return false;
  }
  if (fwrite(bytes, 1, length, upload_file) != length) {
    pocket_set_error(error, error_length, "SD write failed at %lu (%d)", (unsigned long)offset, errno);
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

static bool reject(char *error, size_t error_length, const char *message) {
  pocket_set_error(error, error_length, "%s", message);
  native_abort();
  return false;
}

bool native_commit(NativeInstall *out, char *error, size_t error_length) {
  if (upload_file == NULL || upload_received != upload.length) {
    return reject(error, error_length, ".3dsx commit arrived before every declared byte");
  }
  bool flushed = fflush(upload_file) == 0;
  if (fclose(upload_file) != 0) flushed = false;
  upload_file = NULL;
  if (!flushed) return reject(error, error_length, "flush " POCKET_NATIVE_UPLOAD " failed");
  if (upload_crc != upload.crc32) {
    char message[96];
    snprintf(message, sizeof message, "CRC-32 %08lx does not match the declared %08lx",
      (unsigned long)upload_crc, (unsigned long)upload.crc32);
    return reject(error, error_length, message);
  }
  if (memcmp(upload_magic, "3DSX", sizeof upload_magic) != 0) {
    return reject(error, error_length, "the file is not a 3DSX executable");
  }

  NativeInstall install;
  memset(&install, 0, sizeof install);
  snprintf(install.name, sizeof install.name, "%s", upload.name);
  if (!native_path_for(install.name, install.path)) {
    return reject(error, error_length, "invalid .3dsx name");
  }
  install.launch = (upload.flags & POCKET_RUNTIME_NATIVE_FLAG_LAUNCH) != 0;
  install.deferred = running_path[0] != '\0' && same_path(running_path, install.path);
  if (mkdir(POCKET_NATIVE_DIR, 0777) != 0 && errno != EEXIST) {
    return reject(error, error_length, "mkdir " POCKET_NATIVE_DIR " failed");
  }
  if (install.deferred) {
    /* Out of the staging path, so a later transfer or abort cannot touch it. */
    remove(POCKET_NATIVE_DEFERRED);
    if (rename(POCKET_NATIVE_UPLOAD, POCKET_NATIVE_DEFERRED) != 0) {
      return reject(error, error_length, "move the upload to " POCKET_NATIVE_DEFERRED " failed");
    }
    exit_pending = true;
    snprintf(exit_target, sizeof exit_target, "%s", install.path);
  } else if (!native_swap(POCKET_NATIVE_UPLOAD, install.path, error, error_length)) {
    native_abort();
    return false;
  }
  clear_transfer();
  if (out != NULL) *out = install;
  return true;
}

bool native_swap(const char *staged, const char *target, char *error, size_t error_length) {
  struct stat info;
  if (stat(staged, &info) != 0) {
    pocket_set_error(error, error_length, "%s is missing (%d)", staged, errno);
    return false;
  }
  bool had_target = stat(target, &info) == 0;
  if (remove(POCKET_NATIVE_PREVIOUS) != 0 && errno != ENOENT) {
    pocket_set_error(error, error_length, "remove %s failed (%d)", POCKET_NATIVE_PREVIOUS, errno);
    return false;
  }
  if (had_target && rename(target, POCKET_NATIVE_PREVIOUS) != 0) {
    pocket_set_error(error, error_length, "move %s aside failed (%d)", target, errno);
    return false;
  }
  if (rename(staged, target) != 0) {
    int code = errno;
    if (had_target) rename(POCKET_NATIVE_PREVIOUS, target);
    pocket_set_error(error, error_length, "rename into %s failed (%d)", target, code);
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
  return native_swap(POCKET_NATIVE_DEFERRED, exit_target, error, error_length);
}
