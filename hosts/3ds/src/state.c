#include "state.h"
#include "runtime.h"

#include <stdio.h>
#include <sys/stat.h>

/* POCKET_RUNTIME_APP_ROOT is application-scoped, so two .3dsx entries on one
 * SD card never read or clobber one another's saved state. */
#define STATE_FILE POCKET_RUNTIME_APP_ROOT "/state.json"
#define STATE_BACKUP POCKET_RUNTIME_APP_ROOT "/state.json.bak"
#define STATE_TEMP POCKET_RUNTIME_APP_ROOT "/state.json.partial"

/* The runtime creates these on boot, but a save can be the first thing an app
 * does, so create them defensively; EEXIST is success. */
static void ensure_root(void) {
  mkdir("sdmc:/pocketjs", 0777);
  mkdir("sdmc:/pocketjs/runtime", 0777);
  mkdir("sdmc:/pocketjs/runtime/apps", 0777);
  mkdir(POCKET_RUNTIME_APP_ROOT, 0777);
}

size_t state_read(uint8_t *out, size_t capacity) {
  FILE *file = fopen(STATE_FILE, "rb");
  if (file == NULL) file = fopen(STATE_BACKUP, "rb");
  if (file == NULL) return 0;
  size_t length = fread(out, 1, capacity, file);
  fclose(file);
  return length;
}

bool state_write(const uint8_t *bytes, size_t length) {
  if (length > 65536) return false;
  ensure_root();
  FILE *file = fopen(STATE_TEMP, "wb");
  if (file == NULL) return false;
  size_t written = fwrite(bytes, 1, length, file);
  bool ok = written == length && fflush(file) == 0;
  if (fclose(file)) ok = false;
  if (!ok) {
    remove(STATE_TEMP);
    return false;
  }
  if (rename(STATE_TEMP, STATE_FILE) == 0) { remove(STATE_BACKUP); return true; }
  /* FAT cannot replace an existing destination. Preserve the last committed
   * save until the new file has a name; reads recover that backup after a cut. */
  remove(STATE_BACKUP);
  if (rename(STATE_FILE, STATE_BACKUP) != 0) return false;
  if (rename(STATE_TEMP, STATE_FILE) != 0) { rename(STATE_BACKUP, STATE_FILE); return false; }
  remove(STATE_BACKUP);
  return true;
}
