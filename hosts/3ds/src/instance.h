#ifndef POCKET_3DS_INSTANCE_H
#define POCKET_3DS_INSTANCE_H
#include "runtime.h"
pocket_runtime *instance_create(PocketRuntimePackage *package);
void instance_destroy(void);
void instance_input(uint32_t buttons, uint32_t analog, const uint32_t *touches,
                    size_t count, uint32_t right);
#endif
