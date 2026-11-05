#ifndef POCKET_3DS_INSTANCE_H
#define POCKET_3DS_INSTANCE_H
#include "runtime.h"
#include <stdbool.h>
/* Runtime limits of the guest the program composes: the QuickJS heap and the
 * frame buffers of the 400x240 top and 320x240 bottom screens. */
#define INSTANCE_HEAP_LIMIT (64u * 1024u * 1024u)
#define INSTANCE_FRAME_BUFFER_BUDGET (400u * 240u * 4u + 320u * 240u * 4u)
/* The package source over the PocketRuntimePackage passed as its context,
 * which stays live until the program is destroyed. Runtime keeps native asset
 * loading on for it. */
const pocket_package_source_v1 *instance_package_source(void);
/* Register the input source, product op provider, PICA renderer and both
 * displays on a program's runtime before boot. One runtime at a time; false
 * leaves nothing attached. */
bool instance_attach(pocket_runtime *runtime);
/* Forget the attached runtime before its program is destroyed. */
void instance_detach(void);
void instance_input(uint32_t buttons, uint32_t analog, const uint32_t *touches,
                    size_t count, uint32_t right);
#endif
