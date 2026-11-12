#ifndef POCKETJS_3DS_SLOT_FOLDERS_H
#define POCKETJS_3DS_SLOT_FOLDERS_H

#include <stdbool.h>

/*
 * A slot's folders, created on a thread of their own. On the SD card of the
 * New 3DS XL that was measured, creating the three folders of a new slot
 * (POCKET_RUNTIME_APPS/<slot>, packages/, state/) took 12.5 s, about 4.2 s
 * per folder; the same calls take 14 ms once the folders exist. On the main thread that left the
 * link without a pump past the 10 s silence limit (docs/POCKET-LINK.md §4.6).
 *
 * slot_folders_ready() is true when every folder the slot needs exists:
 * its root, packages/ and state/, and with `data` the data.fs tree's data/
 * and fs-tmp/ (fs.c). Otherwise it starts creating the missing ones on the
 * folder thread, if that thread is free, and is false: the caller pumps the
 * link and asks again (main.c), or asks again at a later pump (an install
 * from the console's store, link2_guest.c). It never blocks on a folder.
 *
 * When the thread has created folders, one host `log` line reports each
 * call's milliseconds. A slot whose folders could not all be created is
 * reported ready once, so the caller's own mkdir reports the error.
 */
bool slot_folders_ready(const char *slot, bool data);

#endif
