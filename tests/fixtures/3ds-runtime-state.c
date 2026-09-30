#include <assert.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "runtime.h"

/* Host-test stand-in for the Rust package admission FFI. runtime.c still owns
 * every filesystem transition; this stub only supplies a deterministic footer
 * identity after checking the fixture marker and exact host ABI. */
int32_t pocket_package_open(
  const uint8_t *bytes,
  size_t length,
  const uint8_t *target,
  size_t target_length,
  uint32_t host_abi,
  PocketGuestPackage *out
) {
  if (length != 32 || bytes[0] != 0x50 || host_abi != 8 ||
      target_length != 7 || memcmp(target, "3ds-dev", 7) != 0) {
    return 4;
  }
  uint64_t hash = 0;
  memcpy(&hash, bytes + 24, sizeof hash);
  memset(out, 0, sizeof *out);
  out->javascript = bytes + 1;
  out->javascript_length = 1;
  out->package_hash = hash;
  out->variant_hash = hash ^ 0x55aa;
  return 0;
}

static void write_package(const char *path, uint64_t hash, int valid) {
  uint8_t bytes[32] = {0};
  bytes[0] = valid ? 0x50 : 0x00;
  memcpy(bytes + 24, &hash, sizeof hash);
  FILE *file = fopen(path, "wb");
  assert(file != NULL);
  assert(fwrite(bytes, 1, sizeof bytes, file) == sizeof bytes);
  assert(fclose(file) == 0);
}

static int exists(const char *path) {
  struct stat info;
  return stat(path, &info) == 0;
}

int main(int argc, char **argv) {
  assert(argc == 2);
  assert(chdir(argv[1]) == 0);
  assert(mkdir("sdmc:", 0777) == 0 || errno == EEXIST);

  /* Pre-slot state belongs to no application. A newly namespaced runtime
   * starts from its embedded guest instead of inheriting this package. */
  assert(mkdir("sdmc:/pocketjs", 0777) == 0);
  assert(mkdir("sdmc:/pocketjs/runtime", 0777) == 0);
  assert(mkdir("sdmc:/pocketjs/runtime/state", 0777) == 0);
  FILE *legacy = fopen(
    "sdmc:/pocketjs/runtime/state/state-00000007-1111222233334444-0000000000000000.commit",
    "wb"
  );
  assert(legacy != NULL);
  assert(fputs("accepted\n", legacy) >= 0);
  assert(fclose(legacy) == 0);

  char error[256] = {0};
  PocketRuntimeState state;
  assert(runtime_storage_init(&state, error, sizeof error));
  assert(state.generation == 0 && state.active_hash == 0 && state.last_good_hash == 0);
  assert(strcmp(POCKET_RUNTIME_APP_ROOT, "sdmc:/pocketjs/runtime/apps/0123456789abcdef") == 0);
  assert(strcmp(POCKET_RUNTIME_DEV_KEY, "sdmc:/pocketjs/runtime/dev.key") == 0);

  const uint64_t first_hash = 0x1111222233334444ULL;
  write_package(POCKET_RUNTIME_PENDING, first_hash, 1);
  PocketRuntimePackage *first = NULL;
  assert(runtime_prepare_pending(&first, error, sizeof error) == RUNTIME_PENDING_READY);
  assert(first != NULL && first->guest.package_hash == first_hash);
  assert(!exists(POCKET_RUNTIME_PENDING));
  assert(exists(
    "sdmc:/pocketjs/runtime/apps/0123456789abcdef/packages/1111222233334444.pocket"
  ));
  runtime_package_free(first);
  assert(runtime_commit(&state, first_hash, 0, error, sizeof error));

  /* Re-uploading the active bytes verifies the immutable blob and removes only
   * the duplicate staging file; it does not create a second blob. */
  write_package(POCKET_RUNTIME_PENDING, first_hash, 1);
  PocketRuntimePackage *duplicate = NULL;
  assert(runtime_prepare_pending(&duplicate, error, sizeof error) == RUNTIME_PENDING_READY);
  assert(duplicate != NULL && duplicate->guest.package_hash == first_hash);
  assert(!exists(POCKET_RUNTIME_PENDING));
  runtime_package_free(duplicate);

  PocketRuntimeState reloaded;
  assert(runtime_storage_init(&reloaded, error, sizeof error));
  assert(reloaded.generation == 1);
  assert(reloaded.active_hash == first_hash && reloaded.last_good_hash == 0);

  const uint64_t second_hash = 0xaaaabbbbccccddddULL;
  write_package(POCKET_RUNTIME_PENDING, second_hash, 1);
  PocketRuntimePackage *second = NULL;
  assert(runtime_prepare_pending(&second, error, sizeof error) == RUNTIME_PENDING_READY);
  runtime_package_free(second);
  assert(runtime_commit(&reloaded, second_hash, first_hash, error, sizeof error));

  PocketRuntimeState accepted;
  assert(runtime_storage_init(&accepted, error, sizeof error));
  assert(accepted.generation == 2);
  assert(accepted.active_hash == second_hash && accepted.last_good_hash == first_hash);

  /* Consecutive runtime failures retain the whole episode: a staged
   * candidate falls back to active, then last-good, then ROMFS (hash 0).
   * Reset happens only after a recovered guest is accepted. */
  const uint64_t candidate_hash = 0x123456789abcdef0ULL;
  PocketRuntimeFailureLineage failures = {0};
  assert(runtime_failure_lineage_add(&failures, candidate_hash));
  assert(runtime_recovery_hash(&accepted, &failures) == second_hash);
  assert(runtime_failure_lineage_add(&failures, second_hash));
  assert(runtime_recovery_hash(&accepted, &failures) == first_hash);
  assert(runtime_failure_lineage_add(&failures, first_hash));
  assert(runtime_recovery_hash(&accepted, &failures) == 0);
  assert(runtime_failure_lineage_add(&failures, first_hash));
  assert(failures.count == 3);
  runtime_failure_lineage_reset(&failures);
  assert(failures.count == 0);
  assert(runtime_recovery_hash(&accepted, &failures) == second_hash);

  PocketRuntimePackage *last_good = runtime_package_load_hash(first_hash, error, sizeof error);
  assert(last_good != NULL && last_good->guest.package_hash == first_hash);
  runtime_package_free(last_good);

  /* A partial/bad FTP upload is never renamed or deleted. */
  write_package(POCKET_RUNTIME_PENDING, 0x9999, 0);
  PocketRuntimePackage *invalid = NULL;
  assert(runtime_prepare_pending(&invalid, error, sizeof error) == RUNTIME_PENDING_ERROR);
  assert(invalid == NULL && exists(POCKET_RUNTIME_PENDING));

  /* The transport-declared footer is an independent admission check. A
   * mismatch remains inspectable at its staging path and creates no blob. */
  const char *network = POCKET_RUNTIME_UPLOAD;
  write_package(network, 0x123456789abcdef0ULL, 1);
  PocketRuntimePackage *mismatch = NULL;
  assert(runtime_prepare_file(
    network,
    0xfedcba9876543210ULL,
    &mismatch,
    error,
    sizeof error
  ) == RUNTIME_PENDING_ERROR);
  assert(mismatch == NULL && exists(network));
  assert(strstr(error, "does not match declared") != NULL);

  /* The first boot beside an embedded package, and every boot after a .3dsx
   * with a different one was installed, reports an install exactly once. */
  const char *embedded_record = POCKET_RUNTIME_APP_ROOT "/embedded.txt";
  assert(!exists(embedded_record));
  assert(runtime_note_embedded(0x1111222233334444ULL));
  assert(exists(embedded_record));
  assert(!runtime_note_embedded(0x1111222233334444ULL));
  assert(runtime_note_embedded(0x5555666677778888ULL));
  assert(!runtime_note_embedded(0x5555666677778888ULL));
  return 0;
}
