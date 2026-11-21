#include <pocket_pica.h>
#include <assert.h>
int main(void) {
  C3D_Tex t={0};
  assert(!pocket_pica_texture_init(&t,7,8,1,GPU_RGBA8,224));
  assert(!pocket_pica_texture_init(&t,8,8,2,GPU_RGBA8,320));
  assert(!allocations);
  fail_alloc=true;
  assert(!pocket_pica_texture_init(&t,8,8,1,GPU_RGBA8,256));
  assert(!t.data && !deletions);
  fail_alloc=false;
  assert(!pocket_pica_texture_init(&t,16,8,1,GPU_RGBA8,511));
  assert(allocations==1 && deletions==1 && !t.data);
  assert(pocket_pica_texture_init(&t,32,16,2,GPU_RGBA8,2560));
  assert(!pocket_pica_texture_init(&t,8,8,1,GPU_RGBA8,256));
  unsigned char data[2560]; memset(data,0xa5,sizeof data);
  assert(!pocket_pica_texture_upload(&t,data,sizeof data-1));
  assert(!pocket_pica_texture_publish(&t,sizeof data+1));
  assert(!flushes);
  assert(pocket_pica_texture_upload(&t,data,sizeof data));
  assert(flushes==1 && flushed_bytes==2560 && !memcmp(t.data,data,sizeof data));
  assert(pocket_pica_texture_publish(&t,sizeof data));
  pocket_pica_texture_destroy(&t);pocket_pica_texture_destroy(&t);
  assert(deletions==2 && !t.data && !t.size && flushes==2);
  assert(!pocket_pica_texture_publish(&t,sizeof data));
  return 0;
}
