#include <stdbool.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
typedef enum { GPU_RGBA8 } GPU_TEXCOLOR;
enum { GPU_TEX_2D };
typedef struct { void *data; size_t size; unsigned maxLevel; } C3D_Tex;
typedef struct { unsigned width,height,maxLevel; GPU_TEXCOLOR format; unsigned type; bool vram; } C3D_TexInitParams;
static unsigned allocations,deletions,flushes;
static size_t flushed_bytes;
static bool fail_alloc;
static size_t C3D_TexCalcTotalSize(size_t size, unsigned levels) {
  size_t total=0; for(unsigned i=0;i<=levels;i++){total+=size;size/=4;}return total;
}
static bool C3D_TexInitWithParams(C3D_Tex *t, void *cube, C3D_TexInitParams p) {
  (void)cube; if(fail_alloc)return false;
  t->size=p.width*p.height*4;t->maxLevel=p.maxLevel;
  t->data=malloc(C3D_TexCalcTotalSize(t->size,t->maxLevel));allocations++;return t->data!=NULL;
}
static void C3D_TexDelete(C3D_Tex *t) { free(t->data);deletions++; }
static void C3D_TexFlush(C3D_Tex *t) { flushes++;flushed_bytes=C3D_TexCalcTotalSize(t->size,t->maxLevel); }
