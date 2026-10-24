/*
 * `globalThis.fs` (contracts/spec/fs.ts, capability data.fs): one guest's
 * file tree on the SD card, behind the nine synchronous ops of the contract.
 *
 * main.c binds the tree before the guest boots and unbinds it at teardown:
 * the root is POCKET_RUNTIME_APPS/<slot>/data, so a guest only ever names its
 * own files and an uninstall (runtime_slot_remove) deletes them with the
 * slot. Writes stage in POCKET_RUNTIME_APPS/<slot>/fs-tmp, outside the root.
 *
 * Replacing a file. FAT (the SD card through newlib's sdmc devoptab) refuses
 * a rename onto an existing name, so a truncating write over an existing
 * file stages the new bytes, records the destination in a sidecar, removes
 * the old file, renames the staged one into place and deletes the sidecar.
 * fs_bind finishes a replacement a power loss interrupted: the guest reads
 * the old content or the new, never neither.
 *
 * The module is plain POSIX C over stdio and dirent, so
 * tests/fixtures/3ds-fs.c runs it on the computer against the same cases as
 * the sim's fs host.
 */

#ifndef POCKETJS_3DS_FS_H
#define POCKETJS_3DS_FS_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* The quota for a guest that declares data.fs without an applet store
 * (Pocket Shell): 4 MiB, the largest store an applet may declare. */
#define FS_DEFAULT_QUOTA_BYTES (4u * 1024u * 1024u)
/* The deepest directory a guest's tree holds below its root. */
#define FS_MAX_DEPTH 8

/* Bind the tree at `root` (created when missing) with staging in `temp`;
 * quota 0 is unmetered. */
bool fs_bind(const char *root, const char *temp, uint64_t quota);
void fs_unbind(void);
bool fs_bound(void);

/* The ops. Strings are UTF-8 with explicit lengths (QuickJS's spelling);
 * the JSON-line ops return a buffer valid until the next op. */
const char *fs_read(const char *path, size_t path_length, double offset, double max_bytes);
int fs_write(const char *path, size_t path_length, const char *data, size_t data_length, int mode);
int fs_remove(const char *path, size_t path_length, int recursive);
const char *fs_list(const char *path, size_t path_length, double offset);
const char *fs_stat(const char *path, size_t path_length);
int fs_mkdir(const char *path, size_t path_length);
int fs_rename(const char *from, size_t from_length, const char *to, size_t to_length);
const char *fs_usage(void);
const char *fs_last_error(void);

/* Delete `path` and everything below it, at most max_depth directories
 * deep; true when nothing of it is left. runtime_slot_remove uses it for a
 * whole slot. */
bool fs_remove_tree(const char *path, unsigned max_depth);

/* The quota a package plan asks for: applet.store.maxBytes when present,
 * else FS_DEFAULT_QUOTA_BYTES. */
uint64_t fs_plan_quota(const char *plan, size_t plan_length);

#endif
