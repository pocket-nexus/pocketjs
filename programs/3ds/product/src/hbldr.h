#ifndef POCKETJS_3DS_HBLDR_H
#define POCKETJS_3DS_HBLDR_H

#include <stdbool.h>
#include <stddef.h>

/*
 * Ask Luma3DS's homebrew loader (the hb:ldr port) to start `path` when this
 * process exits, with argv[0] = path. This is what the Homebrew Launcher does
 * when it launches an entry; the caller then leaves its main loop. Fails
 * outside the Homebrew Launcher (a CIA, or an emulator loading the .3dsx).
 */
bool hbldr_launch_on_exit(const char *path, char *error, size_t error_length);

#endif
