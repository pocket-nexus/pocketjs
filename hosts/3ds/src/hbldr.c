/*
 * Luma3DS homebrew loader requests, as devkitPro's 3ds-hbmenu sends them
 * (source/loaders/rosalina.c): SetTarget (0x20002) takes the path without the
 * "sdmc:" device prefix, SetArgv (0x30002) takes hbmenu's argument block — a
 * u32 argc followed by NUL-terminated strings, 0x400 bytes in all.
 */

#include "hbldr.h"
#include "error_text.h"

#include <3ds.h>
#include <stdio.h>
#include <string.h>

#define HBLDR_ARGV_BYTES 0x400u

static Result send_static(Handle handle, u32 command, const void *buffer, u32 size, u32 slot) {
  u32 *words = getThreadCommandBuffer();
  words[0] = IPC_MakeHeader(command, 0, 2);
  words[1] = IPC_Desc_StaticBuffer(size, slot);
  words[2] = (u32)buffer;
  Result result = svcSendSyncRequest(handle);
  return R_SUCCEEDED(result) ? (Result)words[1] : result;
}

bool hbldr_launch_on_exit(const char *path, char *error, size_t error_length) {
  static u32 arguments[HBLDR_ARGV_BYTES / sizeof(u32)];
  static char target[HBLDR_ARGV_BYTES];
  if (path == NULL || strlen(path) + 1 > HBLDR_ARGV_BYTES - sizeof(u32)) {
    pocket_set_error(error, error_length, "launch path is empty or too long");
    return false;
  }
  if (!envIsHomebrew()) {
    pocket_set_error(error, error_length, "not running under the Homebrew Launcher");
    return false;
  }
  Handle handle = 0;
  Result result = svcConnectToPort(&handle, "hb:ldr");
  if (R_FAILED(result)) {
    pocket_set_error(error, error_length, "hb:ldr unavailable (0x%08lx); start the .3dsx from the Homebrew Launcher", (unsigned long)result);
    return false;
  }
  snprintf(target, sizeof target, "%s", strncmp(path, "sdmc:/", 6) == 0 ? path + 5 : path);
  result = send_static(handle, 2, target, (u32)strlen(target) + 1, 0);
  if (R_SUCCEEDED(result)) {
    memset(arguments, 0, sizeof arguments);
    arguments[0] = 1;
    memcpy(&arguments[1], path, strlen(path) + 1);
    result = send_static(handle, 3, arguments, sizeof arguments, 1);
  }
  svcCloseHandle(handle);
  if (R_FAILED(result)) {
    pocket_set_error(error, error_length, "hb:ldr refused %s (0x%08lx)", path, (unsigned long)result);
    return false;
  }
  return true;
}
