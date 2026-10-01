/*
 * Pocket Runtime package storage for Nintendo 3DS.
 *
 * FTP and future device transports write exactly one staging path. The host
 * verifies the complete `.pocket`, renames it to an immutable hash-named blob,
 * then appends a generation marker only after the new guest has presented a
 * frame. A torn upload, failed eval or power loss therefore cannot replace the
 * last accepted package; ROMFS app.pocket remains the final recovery guest.
 */

#include "runtime.h"
#include "error_text.h"

#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define PACKAGES_DIR POCKET_RUNTIME_APP_ROOT "/packages"
#define STATE_DIR POCKET_RUNTIME_APP_ROOT "/state"
#define MAX_PACKAGE_BYTES (24u * 1024u * 1024u)

static const char *package_error(int32_t code) {
  switch (code) {
    case 1: return "truncated package";
    case 2: return "bad package magic";
    case 3: return "unsupported package version";
    case 4: return "package footer hash mismatch";
    case 5: return "invalid package UTF-8";
    case 6: return "package has no " POCKETJS_TARGET_ID " variant";
    case 7: return "package host ABI mismatch";
    case 8: return "package identity section missing";
    case 9: return "package plan section missing";
    case 10: return "package JavaScript section missing";
    case 11: return "package JavaScript is not NUL-terminated";
    default: return "invalid package arguments";
  }
}

static bool ensure_directory(const char *path, char *error, size_t error_length) {
  if (mkdir(path, 0777) == 0 || errno == EEXIST) return true;
  pocket_set_error(error, error_length, "mkdir %s failed (%d)", path, errno);
  return false;
}

void runtime_failure_lineage_reset(PocketRuntimeFailureLineage *lineage) {
  if (lineage == NULL) return;
  memset(lineage, 0, sizeof *lineage);
}

static bool runtime_failure_lineage_contains(
  const PocketRuntimeFailureLineage *lineage,
  uint64_t hash
) {
  if (lineage == NULL || hash == 0) return false;
  for (size_t index = 0; index < lineage->count; index += 1) {
    if (lineage->hashes[index] == hash) return true;
  }
  return false;
}

bool runtime_failure_lineage_add(PocketRuntimeFailureLineage *lineage, uint64_t hash) {
  if (lineage == NULL || hash == 0) return false;
  if (runtime_failure_lineage_contains(lineage, hash)) return true;
  if (lineage->count == POCKET_RUNTIME_FAILURE_CAPACITY) return false;
  lineage->hashes[lineage->count++] = hash;
  return true;
}

bool runtime_failure_lineage_reject(
  PocketRuntimeFailureLineage *lineage,
  const PocketRuntimeState *state,
  uint64_t hash
) {
  if (lineage == NULL) return false;
  if (hash == 0) {
    if (lineage->embedded_failed) return false;
    lineage->embedded_failed = true;
  } else if (!runtime_failure_lineage_add(lineage, hash)) {
    return false;
  }
  return !lineage->embedded_failed || runtime_recovery_hash(state, lineage) != 0;
}

uint64_t runtime_recovery_hash(
  const PocketRuntimeState *state,
  const PocketRuntimeFailureLineage *lineage
) {
  if (state == NULL) return 0;
  const uint64_t candidates[] = { state->active_hash, state->last_good_hash };
  for (size_t index = 0; index < sizeof candidates / sizeof candidates[0]; index += 1) {
    uint64_t hash = candidates[index];
    if (hash != 0 && !runtime_failure_lineage_contains(lineage, hash)) return hash;
  }
  return 0;
}

bool runtime_storage_init(PocketRuntimeState *state, char *error, size_t error_length) {
  if (state == NULL) {
    pocket_set_error(error, error_length, "runtime state is null");
    return false;
  }
  memset(state, 0, sizeof *state);
  if (!ensure_directory("sdmc:/pocketjs", error, error_length) ||
      !ensure_directory(POCKET_RUNTIME_ROOT, error, error_length) ||
      !ensure_directory(POCKET_RUNTIME_APPS, error, error_length) ||
      !ensure_directory(POCKET_RUNTIME_APP_ROOT, error, error_length) ||
      !ensure_directory(PACKAGES_DIR, error, error_length) ||
      !ensure_directory(STATE_DIR, error, error_length)) {
    return false;
  }

  DIR *directory = opendir(STATE_DIR);
  if (directory == NULL) {
    pocket_set_error(error, error_length, "opendir %s failed (%d)", STATE_DIR, errno);
    return false;
  }
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    unsigned long generation = 0;
    unsigned long long active = 0;
    unsigned long long last_good = 0;
    int consumed = 0;
    int fields = sscanf(
      entry->d_name,
      "state-%8lx-%16llx-%16llx.commit%n",
      &generation,
      &active,
      &last_good,
      &consumed
    );
    if (fields == 3 && consumed == 55 && entry->d_name[consumed] == '\0' &&
        (uint32_t)generation > state->generation) {
      state->generation = (uint32_t)generation;
      state->active_hash = (uint64_t)active;
      state->last_good_hash = (uint64_t)last_good;
    }
  }
  closedir(directory);
  return true;
}

PocketRuntimePackage *runtime_package_load(
  const char *path,
  char *error,
  size_t error_length
) {
  FILE *file = fopen(path, "rb");
  if (file == NULL) {
    pocket_set_error(error, error_length, "open %s failed (%d)", path, errno);
    return NULL;
  }
  if (fseek(file, 0, SEEK_END) != 0) {
    pocket_set_error(error, error_length, "seek %s failed", path);
    fclose(file);
    return NULL;
  }
  long raw_length = ftell(file);
  if (raw_length <= 0 || (unsigned long)raw_length > MAX_PACKAGE_BYTES ||
      fseek(file, 0, SEEK_SET) != 0) {
    pocket_set_error(error, error_length, "%s has invalid package size %ld", path, raw_length);
    fclose(file);
    return NULL;
  }

  PocketRuntimePackage *package = calloc(1, sizeof *package);
  if (package == NULL) {
    pocket_set_error(error, error_length, "package descriptor allocation failed");
    fclose(file);
    return NULL;
  }
  package->length = (size_t)raw_length;
  package->bytes = malloc(package->length);
  if (package->bytes == NULL) {
    pocket_set_error(error, error_length, "%s needs %lu bytes", path, (unsigned long)package->length);
    fclose(file);
    free(package);
    return NULL;
  }
  size_t read = fread(package->bytes, 1, package->length, file);
  int close_result = fclose(file);
  if (read != package->length || close_result != 0) {
    pocket_set_error(error, error_length, "read %s was incomplete", path);
    runtime_package_free(package);
    return NULL;
  }

  int32_t result = pocket_package_open(
    package->bytes,
    package->length,
    (const uint8_t *)POCKETJS_TARGET_ID,
    sizeof POCKETJS_TARGET_ID - 1,
    POCKETJS_HOST_ABI,
    &package->guest
  );
  if (result != 0 || package->guest.package_hash == 0) {
    pocket_set_error(
      error,
      error_length,
      "%s: %s%s",
      path,
      package_error(result),
      result == 0 ? " (zero hash is reserved)" : ""
    );
    runtime_package_free(package);
    return NULL;
  }
  snprintf(package->origin, sizeof package->origin, "%s", path);
  return package;
}

void runtime_package_free(PocketRuntimePackage *package) {
  if (package == NULL) return;
  free(package->bytes);
  package->bytes = NULL;
  free(package);
}

static void blob_path(uint64_t hash, char *out, size_t length) {
  snprintf(out, length, PACKAGES_DIR "/%016llx.pocket", (unsigned long long)hash);
}

PocketRuntimePackage *runtime_package_load_hash(
  uint64_t hash,
  char *error,
  size_t error_length
) {
  if (hash == 0) {
    pocket_set_error(error, error_length, "zero names the embedded recovery guest");
    return NULL;
  }
  char path[192];
  blob_path(hash, path, sizeof path);
  PocketRuntimePackage *package = runtime_package_load(path, error, error_length);
  if (package != NULL && package->guest.package_hash != hash) {
    pocket_set_error(error, error_length, "%s content hash does not match its name", path);
    runtime_package_free(package);
    return NULL;
  }
  return package;
}

RuntimePendingResult runtime_prepare_pending(
  PocketRuntimePackage **out,
  char *error,
  size_t error_length
) {
  return runtime_prepare_file(POCKET_RUNTIME_PENDING, 0, out, error, error_length);
}

RuntimePendingResult runtime_prepare_file(
  const char *path,
  uint64_t expected_hash,
  PocketRuntimePackage **out,
  char *error,
  size_t error_length
) {
  if (out == NULL) {
    pocket_set_error(error, error_length, "package output is null");
    return RUNTIME_PENDING_ERROR;
  }
  *out = NULL;
  if (path == NULL || path[0] == '\0') {
    pocket_set_error(error, error_length, "package staging path is empty");
    return RUNTIME_PENDING_ERROR;
  }
  struct stat info;
  if (stat(path, &info) != 0) {
    if (errno == ENOENT) return RUNTIME_PENDING_NONE;
    pocket_set_error(error, error_length, "stat %s failed (%d)", path, errno);
    return RUNTIME_PENDING_ERROR;
  }

  PocketRuntimePackage *pending = runtime_package_load(path, error, error_length);
  if (pending == NULL) return RUNTIME_PENDING_ERROR;
  if (expected_hash != 0 && pending->guest.package_hash != expected_hash) {
    pocket_set_error(
      error,
      error_length,
      "%s footer %016llx does not match declared %016llx",
      path,
      (unsigned long long)pending->guest.package_hash,
      (unsigned long long)expected_hash
    );
    runtime_package_free(pending);
    return RUNTIME_PENDING_ERROR;
  }

  char destination[192];
  blob_path(pending->guest.package_hash, destination, sizeof destination);
  if (stat(destination, &info) == 0) {
    char duplicate_error[192] = {0};
    PocketRuntimePackage *existing = runtime_package_load_hash(
      pending->guest.package_hash,
      duplicate_error,
      sizeof duplicate_error
    );
    if (existing == NULL) {
      pocket_set_error(error, error_length, "existing blob is invalid: %s", duplicate_error);
      runtime_package_free(pending);
      return RUNTIME_PENDING_ERROR;
    }
    runtime_package_free(existing);
    if (remove(path) != 0) {
      pocket_set_error(error, error_length, "remove duplicate staged package failed (%d)", errno);
      runtime_package_free(pending);
      return RUNTIME_PENDING_ERROR;
    }
  } else if (errno != ENOENT) {
    pocket_set_error(error, error_length, "stat %s failed (%d)", destination, errno);
    runtime_package_free(pending);
    return RUNTIME_PENDING_ERROR;
  } else if (rename(path, destination) != 0) {
    pocket_set_error(error, error_length, "commit staged package failed (%d)", errno);
    runtime_package_free(pending);
    return RUNTIME_PENDING_ERROR;
  }
  snprintf(pending->origin, sizeof pending->origin, "%s", destination);
  *out = pending;
  return RUNTIME_PENDING_READY;
}

bool runtime_commit(
  PocketRuntimeState *state,
  uint64_t active_hash,
  uint64_t last_good_hash,
  char *error,
  size_t error_length
) {
  if (state == NULL || state->generation == UINT32_MAX) {
    pocket_set_error(error, error_length, "runtime state generation exhausted");
    return false;
  }
  uint32_t generation = state->generation + 1;
  char final_path[224];
  char temporary_path[192];
  snprintf(temporary_path, sizeof temporary_path, STATE_DIR "/state.tmp");
  snprintf(
    final_path,
    sizeof final_path,
    STATE_DIR "/state-%08lx-%016llx-%016llx.commit",
    (unsigned long)generation,
    (unsigned long long)active_hash,
    (unsigned long long)last_good_hash
  );
  remove(temporary_path);
  FILE *file = fopen(temporary_path, "wb");
  if (file == NULL) {
    pocket_set_error(error, error_length, "open state.tmp failed (%d)", errno);
    return false;
  }
  bool written = fputs("accepted\n", file) >= 0 && fflush(file) == 0;
  if (written) written = fsync(fileno(file)) == 0;
  if (fclose(file) != 0) written = false;
  if (!written || rename(temporary_path, final_path) != 0) {
    pocket_set_error(error, error_length, "commit runtime generation failed (%d)", errno);
    remove(temporary_path);
    return false;
  }
  state->generation = generation;
  state->active_hash = active_hash;
  state->last_good_hash = last_good_hash;
  return true;
}

static void write_report(const char *name, const char *text) {
  char path[192];
  char temporary[192];
  snprintf(path, sizeof path, POCKET_RUNTIME_APP_ROOT "/%s", name);
  snprintf(temporary, sizeof temporary, POCKET_RUNTIME_APP_ROOT "/.%s.tmp", name);
  FILE *file = fopen(temporary, "wb");
  if (file == NULL) return;
  fputs(text == NULL ? "" : text, file);
  fputs("\n", file);
  if (fclose(file) != 0) {
    remove(temporary);
    return;
  }
  remove(path);
  rename(temporary, path);
}

bool runtime_note_embedded(uint64_t embedded_hash) {
  unsigned long long recorded = 0;
  FILE *file = fopen(POCKET_RUNTIME_APP_ROOT "/embedded.txt", "rb");
  bool known = file != NULL && fscanf(file, "%16llx", &recorded) == 1;
  if (file != NULL) fclose(file);
  if (known && recorded == embedded_hash) return false;
  char text[24];
  snprintf(text, sizeof text, "%016llx", (unsigned long long)embedded_hash);
  write_report("embedded.txt", text);
  return true;
}

void runtime_write_status(
  const PocketRuntimeState *state,
  const PocketRuntimePackage *package,
  const char *phase
) {
  char message[512];
  snprintf(
    message,
    sizeof message,
    "phase=%s\nslot=%s\ngeneration=%lu\nactive=%016llx\nlast_good=%016llx\nrunning=%016llx\norigin=%s",
    phase == NULL ? "unknown" : phase,
    POCKETJS_RUNTIME_SLOT,
    (unsigned long)(state == NULL ? 0 : state->generation),
    (unsigned long long)(state == NULL ? 0 : state->active_hash),
    (unsigned long long)(state == NULL ? 0 : state->last_good_hash),
    (unsigned long long)(package == NULL ? 0 : package->guest.package_hash),
    package == NULL ? "none" : package->origin
  );
  write_report("status.txt", message);
}

void runtime_write_error(const char *phase, const char *message) {
  char text[512];
  snprintf(
    text,
    sizeof text,
    "phase=%s\nerror=%s",
    phase == NULL ? "unknown" : phase,
    message == NULL ? "unknown failure" : message
  );
  write_report("last-error.txt", text);
}
