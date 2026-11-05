#ifndef POCKET_3DS_FILE_SOURCE_H
#define POCKET_3DS_FILE_SOURCE_H
#include <pocket_runtime.h>
#include <stdio.h>
/* Zero-initialize before open. Close before reopening. The program retains
 * this open file until runtime destruction; Runtime never closes the FILE. */
typedef struct { FILE *file; size_t length; } pocket_3ds_file_source;
int pocket_3ds_file_source_open(pocket_3ds_file_source *, const char *path);
void pocket_3ds_file_source_close(pocket_3ds_file_source *);
const pocket_package_source_v1 *pocket_3ds_file_source_vtable(void);
#endif
