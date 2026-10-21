/*
 * The 3DS app table (docs/LAUNCHER.md, spec ops 39..41): the embedded ROMFS
 * guest is the launcher, and every OTHER runtime slot with a committed active
 * package is an installed app it can switch to.
 *
 * This module owns the table and the switch request; main.c owns the swap
 * itself (teardown, slot selection, boot) at a GPU-idle frame boundary. The
 * table is cached and rebuilt only after launcher_invalidate (an install, a
 * removal, a routed push), never by scanning the SD card on every read.
 *
 *   appTable() -> {"apps":[{output,id,title,version,bytes}],"current",
 *                  "resume","launcher","lastError":{output,message}|null}
 *   appLaunch(output) -> 1 | 0      switch after this frame presents
 *   appShot() -> -1                 no frozen frame on this host (v1)
 */

#ifndef POCKETJS_3DS_LAUNCHER_H
#define POCKETJS_3DS_LAUNCHER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "runtime.h"

#define LAUNCHER_OUTPUT_BYTES 64
#define LAUNCHER_ID_BYTES 128

typedef struct {
  char slot[17];
  char output[LAUNCHER_OUTPUT_BYTES];
  /* The launcher itself (the embedded guest's slot). */
  bool home;
} LauncherTarget;

/* Record the embedded guest as the launcher. Call once at boot. */
void launcher_init(const PocketRuntimePackage *embedded);
/* Rebuild the table on its next read. */
void launcher_invalidate(void);

/* spec op 39. The returned string lives until the next call. Reading it
 * clears a reported lastError. */
const char *launcher_table_json(void);
/* spec op 40: schedule a switch; false for an unknown output. */
bool launcher_launch(const char *output);
/* The SELECT press-edge in a guest other than the launcher. */
void launcher_summon(void);
bool launcher_take_request(LauncherTarget *out);

/* The guest that just booted: home when `slot` is the launcher's. */
void launcher_set_current(const char *slot, const PocketRuntimePackage *package);
bool launcher_home_running(void);
const char *launcher_home_slot(void);
const char *launcher_current_output(void);
const char *launcher_current_app_id(void);

/* An app failed to boot or threw from a frame: shown once as lastError. */
void launcher_report_failure(const char *output, const char *message);
/* A package just committed as `slot`'s active: refresh its cached metadata
 * (sdmc:/pocketjs/runtime/apps/<slot>/app.txt) and the table. */
void launcher_note_installed(const char *slot, const PocketRuntimePackage *package);
/* `output` read from a package's plan `app` object. */
bool launcher_package_output(const PocketRuntimePackage *package, char *out, size_t capacity);

#endif
