#ifndef POCKETJS_3DS_NATIVE_H
#define POCKETJS_3DS_NATIVE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "dev_protocol.h"
#include "runtime.h"

/*
 * .3dsx files installed over the development connection.
 *
 * One transfer at a time streams to a device-wide staging file, is checked
 * against its declared length, CRC-32 and 3DSX magic, and then replaces
 * sdmc:/3ds/<name>. The replaced file is kept as native-previous.3dsx. A
 * transfer that replaces the running .3dsx waits for the process to exit:
 * libctru reads the ROMFS of a running .3dsx from that file.
 */
#define POCKET_NATIVE_DIR "sdmc:/3ds"
#define POCKET_NATIVE_UPLOAD POCKET_RUNTIME_ROOT "/native-upload.3dsx"
#define POCKET_NATIVE_PREVIOUS POCKET_RUNTIME_ROOT "/native-previous.3dsx"
#define POCKET_NATIVE_PATH_BYTES 96u

typedef struct {
  char name[POCKET_RUNTIME_NATIVE_NAME_BYTES + 1];
  char path[POCKET_NATIVE_PATH_BYTES];
  bool launch;
  /* The file is the running .3dsx: it is installed when the process exits. */
  bool deferred;
} NativeInstall;

/* argv[0] of this process, e.g. sdmc:/3ds/pocketshell-main.3dsx. */
void native_set_running_path(const char *path);
bool native_path_for(const char *name, char out[POCKET_NATIVE_PATH_BYTES]);

bool native_begin(const PocketRuntimeNativeBegin *begin, char *error, size_t error_length);
bool native_write(
  uint32_t offset,
  const uint8_t *bytes,
  size_t length,
  char *error,
  size_t error_length
);
bool native_commit(NativeInstall *out, char *error, size_t error_length);
void native_abort(void);
bool native_receiving(void);
const char *native_receiving_name(void);

/* Replace `target` with `staged`, keeping the old file at NATIVE_PREVIOUS and
 * restoring it when the rename fails. */
bool native_swap(const char *staged, const char *target, char *error, size_t error_length);

/* Called once the process has left ROMFS: installs a deferred replacement. */
bool native_exit_pending(void);
bool native_finish_exit(char *error, size_t error_length);

#endif
