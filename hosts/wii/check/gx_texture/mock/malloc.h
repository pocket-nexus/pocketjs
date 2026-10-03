#ifndef POCKET_WII_GX_TEXTURE_MOCK_MALLOC_H
#define POCKET_WII_GX_TEXTURE_MOCK_MALLOC_H

#include <stddef.h>

void *mock_memalign(size_t alignment, size_t size);
void mock_free(void *pointer);

#define memalign mock_memalign
#define free mock_free

#endif
