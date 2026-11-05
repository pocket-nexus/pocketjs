#ifndef POCKETJS_3DS_RUNTIME_H
#define POCKETJS_3DS_RUNTIME_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "pocket_core.h"

/* Pairing identifies the console, so every Pocket app shares one key. Guest
 * state is application-scoped: two .3dsx entries on the same SD card must not
 * recover or hot-load one another's package. */
#define POCKET_RUNTIME_ROOT "sdmc:/pocketjs/runtime"
#define POCKET_RUNTIME_APPS POCKET_RUNTIME_ROOT "/apps"
#define POCKET_RUNTIME_DEV_KEY POCKET_RUNTIME_ROOT "/dev.key"

/* The application's directory below POCKET_RUNTIME_APPS is named at boot from
 * the package in the .3dsx's RomFS (PocketGuestPackage.slot, the first 16 hex
 * digits of SHA-256 of its app id), so one runtime binary serves every game.
 * runtime_select_slot accepts exactly 16 lowercase hex digits; the paths
 * below are empty strings until it succeeds. The upload path is the dev
 * wire's staging file and keeps the first selected slot for the process
 * lifetime; the others follow the selected slot. */
bool runtime_select_slot(const char *slot);
const char *runtime_slot(void);
const char *runtime_app_root(void);
const char *runtime_pending_path(void);
const char *runtime_upload_path(void);
#define POCKET_RUNTIME_APP_ROOT runtime_app_root()
#define POCKET_RUNTIME_PENDING runtime_pending_path()
#define POCKET_RUNTIME_UPLOAD runtime_upload_path()

typedef struct {
  uint8_t *bytes;
  size_t length;
  PocketGuestPackage guest;
  char origin[192];
} PocketRuntimePackage;

typedef struct {
  uint32_t generation;
  uint64_t active_hash;
  uint64_t last_good_hash;
} PocketRuntimeState;

/* One recovery episode can reject a staged candidate, the active package and
 * last-good before selecting the embedded package (hash 0). Keep that lineage
 * in memory until a recovered guest retires its first frame. The embedded
 * package is the last resort, except on the start after an install, which
 * tries it first (runtime_note_embedded). */
#define POCKET_RUNTIME_FAILURE_CAPACITY 3
typedef struct {
  uint64_t hashes[POCKET_RUNTIME_FAILURE_CAPACITY];
  size_t count;
  bool embedded_failed;
} PocketRuntimeFailureLineage;

void runtime_failure_lineage_reset(PocketRuntimeFailureLineage *lineage);
bool runtime_failure_lineage_add(PocketRuntimeFailureLineage *lineage, uint64_t hash);
/* Record that the package `hash` (0: embedded) failed. Returns false when no
 * untried package remains, so the failure is fatal. */
bool runtime_failure_lineage_reject(
  PocketRuntimeFailureLineage *lineage,
  const PocketRuntimeState *state,
  uint64_t hash
);
/* Return the next non-failed stored package, or 0 for embedded ROMFS. */
uint64_t runtime_recovery_hash(
  const PocketRuntimeState *state,
  const PocketRuntimeFailureLineage *lineage
);

/* Creates the runtime directories and loads the newest committed generation. */
bool runtime_storage_init(PocketRuntimeState *state, char *error, size_t error_length);

/* Read, hash-check and admit one target/ABI package. */
PocketRuntimePackage *runtime_package_load(
  const char *path,
  char *error,
  size_t error_length
);
PocketRuntimePackage *runtime_package_load_hash(
  uint64_t hash,
  char *error,
  size_t error_length
);
void runtime_package_free(PocketRuntimePackage *package);

/*
 * Consume pending.pocket only after it is complete and verified. The file is
 * renamed to its immutable content-addressed blob before READY is returned.
 * NONE means no upload was present; ERROR leaves an invalid/partial upload in
 * place so an in-progress FTP transfer is never destroyed.
 */
typedef enum {
  RUNTIME_PENDING_ERROR = -1,
  RUNTIME_PENDING_NONE = 0,
  RUNTIME_PENDING_READY = 1,
} RuntimePendingResult;
RuntimePendingResult runtime_prepare_pending(
  PocketRuntimePackage **out,
  char *error,
  size_t error_length
);
/* Admit a completed transport-owned file and move it to immutable storage.
 * expected_hash is the footer declared before transfer (0 skips that extra
 * comparison). The source remains in place on any validation error. */
RuntimePendingResult runtime_prepare_file(
  const char *path,
  uint64_t expected_hash,
  PocketRuntimePackage **out,
  char *error,
  size_t error_length
);

/*
 * The slot records the embedded package it last booted beside
 * (embedded.txt). Returns true, and records the new hash, when this .3dsx
 * embeds a different package: it was installed since, and its guest boots in
 * place of the active package once, so a pushed guest never shadows an
 * install. A missing record counts as a change.
 */
bool runtime_note_embedded(uint64_t embedded_hash);

/* Append one power-loss-safe state generation after a guest frame is accepted. */
bool runtime_commit(
  PocketRuntimeState *state,
  uint64_t active_hash,
  uint64_t last_good_hash,
  char *error,
  size_t error_length
);

void runtime_write_status(
  const PocketRuntimeState *state,
  const PocketRuntimePackage *package,
  const char *phase
);
void runtime_write_error(const char *phase, const char *message);

/*
 * Other slots. The launcher lists every slot under POCKET_RUNTIME_APPS that
 * has a committed active package; Pocket Link installs and dev pushes of
 * another app write into the app's OWN slot, never the running one's.
 */
/* POCKET_RUNTIME_APPS/<slot>[/leaf]; false for a malformed slot. */
bool runtime_slot_path(const char *slot, const char *leaf, char *out, size_t length);
/* The newest committed generation of `slot` (zeroed when none). */
bool runtime_slot_state(const char *slot, PocketRuntimeState *state);
PocketRuntimePackage *runtime_slot_package_load(
  const char *slot,
  uint64_t hash,
  char *error,
  size_t error_length
);
/*
 * Admit the completed file `path` (runtime_prepare_file rules), require that
 * its app id names `slot`, and commit it as that slot's active package (the
 * previous active becomes last-good). When `slot` is the selected one,
 * `current_state` is the caller's live state and is updated in place, so the
 * running guest's next commit continues the same generation sequence.
 * Returns the admitted package (caller frees) or NULL with `error`.
 */
PocketRuntimePackage *runtime_slot_install(
  const char *slot,
  const char *path,
  uint64_t expected_hash,
  PocketRuntimeState *current_state,
  char *error,
  size_t error_length
);
/* Delete a slot's whole directory. Refuses the selected (running) slot. */
bool runtime_slot_remove(const char *slot, char *error, size_t error_length);
/* runtime_write_error into another slot's last-error.txt. */
void runtime_slot_write_error(const char *slot, const char *phase, const char *message);

#endif
