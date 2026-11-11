/* A slot's folders, created on a thread of their own (slot_folders.h). */

#include "slot_folders.h"

#include <3ds.h>
#include <errno.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>

#include "link2_host.h"
#include "push_timing.h"
#include "runtime.h"

#define MAX_FOLDERS 8
#define PATH_BYTES 96
#define FOLDER_STACK (16 * 1024)

typedef struct {
  Thread thread;
  char slot[17];
  bool data;
  char paths[MAX_FOLDERS][PATH_BYTES];
  unsigned long ms[MAX_FOLDERS];
  int result[MAX_FOLDERS];
  size_t count;
  atomic_bool done;
} FolderJob;

static FolderJob job;
/* The last slot whose job left a folder uncreated: ready once, so its
 * caller's mkdir reports the error instead of a loop of jobs. */
static char failed_slot[17];
static bool failed_data;

static bool exists(const char *path) {
  struct stat info;
  return stat(path, &info) == 0 && S_ISDIR(info.st_mode);
}

static void run(void *opaque) {
  FolderJob *folders = opaque;
  for (size_t i = 0; i < folders->count; i += 1) {
    u64 started = svcGetSystemTick();
    folders->result[i] = mkdir(folders->paths[i], 0777) == 0 || errno == EEXIST ? 0 : errno;
    folders->ms[i] = (unsigned long)((svcGetSystemTick() - started) * 1000 / SYSCLOCK_ARM11);
  }
  atomic_store(&folders->done, true);
}

/* The folders `slot` needs, parents first. */
static size_t wanted(const char *slot, bool data, char paths[MAX_FOLDERS][PATH_BYTES]) {
  static const char *const leaves[] = {NULL, "packages", "state", "data", "fs-tmp"};
  size_t count = 0;
  snprintf(paths[count++], PATH_BYTES, "%s", "sdmc:/pocketjs");
  snprintf(paths[count++], PATH_BYTES, "%s", POCKET_RUNTIME_ROOT);
  snprintf(paths[count++], PATH_BYTES, "%s", POCKET_RUNTIME_APPS);
  for (size_t i = 0; i < (data ? 5u : 3u); i += 1) {
    if (runtime_slot_path(slot, leaves[i], paths[count], PATH_BYTES)) count += 1;
  }
  return count;
}

/* The finished job: joined, and its calls reported. */
static void collect(void) {
  threadJoin(job.thread, U64_MAX);
  threadFree(job.thread);
  job.thread = NULL;
  char line[512];
  size_t used = (size_t)snprintf(line, sizeof line, "slot %s folders, on a thread with the link pumped:", job.slot);
  bool failed = false;
  for (size_t i = 0; i < job.count && used < sizeof line; i += 1) {
    const char *name = strrchr(job.paths[i], '/');
    used += (size_t)snprintf(line + used, sizeof line - used, "%s %s %lu ms%s", i == 0 ? "" : ",", name != NULL ? name + 1 : job.paths[i],
                             job.ms[i], job.result[i] == 0 ? "" : " (failed)");
    if (job.result[i] != 0) failed = true;
  }
  link2_host_report_log("info", line);
  push_timing_step("slot-folders-report", push_timing_now(), "%s", line);
  if (failed) {
    memcpy(failed_slot, job.slot, sizeof failed_slot);
    failed_data = job.data;
  }
}

bool slot_folders_ready(const char *slot, bool data) {
  if (slot == NULL || strlen(slot) != 16) return true;
  if (job.thread != NULL) {
    if (!atomic_load(&job.done)) return false;
    collect();
  }
  if (strcmp(failed_slot, slot) == 0 && (failed_data || !data)) {
    failed_slot[0] = '\0';
    return true;
  }
  char paths[MAX_FOLDERS][PATH_BYTES];
  size_t all = wanted(slot, data, paths);
  memset(&job.paths, 0, sizeof job.paths);
  job.count = 0;
  for (size_t i = 0; i < all; i += 1) {
    if (!exists(paths[i])) memcpy(job.paths[job.count++], paths[i], PATH_BYTES);
  }
  if (job.count == 0) return true;
  memcpy(job.slot, slot, sizeof job.slot);
  job.data = data;
  atomic_init(&job.done, false);
  s32 priority = 0x30;
  svcGetThreadPriority(&priority, CUR_THREAD_HANDLE);
  job.thread = threadCreate(run, &job, FOLDER_STACK, priority < 0x3f ? priority + 1 : priority, -2, false);
  /* No thread: the caller's own mkdir creates them, on its thread, as before. */
  return job.thread == NULL;
}
