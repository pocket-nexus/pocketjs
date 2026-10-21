#define _DEFAULT_SOURCE
#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200112L
#include "pocket_runtime.h"
#include "fixture.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

static size_t live_allocations;
void *pocket_host_alloc(size_t size,size_t alignment) {
  void *pointer=NULL;
  if(alignment<sizeof(void*)) alignment=sizeof(void*);
  if(posix_memalign(&pointer,alignment,size ? size : 1)!=0) return NULL;
  live_allocations++;
  return pointer;
}
void pocket_host_free(void *pointer,size_t size,size_t alignment) {
  (void)size;(void)alignment;
  if(pointer){assert(live_allocations>0);live_allocations--;free(pointer);}
}
void *pocket_host_realloc(void *pointer,size_t old_size,size_t alignment,size_t new_size) {
  void *replacement=pocket_host_alloc(new_size,alignment);
  if(!replacement)return NULL;
  if(pointer)memcpy(replacement,pointer,old_size<new_size?old_size:new_size);
  pocket_host_free(pointer,old_size,alignment);
  return replacement;
}
void pocket_host_panic(const char *message,size_t length){fwrite(message,1,length,stderr);abort();}
void pocket_host_log(int32_t level,const char *message,size_t length){(void)level;(void)message;(void)length;}
void pocket_host_boot_stage(int32_t stage){(void)stage;}

static pocket_runtime *instance;
static int initialized,evaluated,frames,shutdowns,flushes,waits,failed_wait;
static uint8_t pixels[64];
static pocket_rect acquired;
static pocket_surface acquired_surface;
static void create_node(void);
static int provider_mode, provider_calls;
static uint8_t provider_bytes[]="service reply";
static int32_t provider_dispatch(void *self,uint16_t op,const pocket_op_arg *arguments,size_t argument_length,pocket_result *out){
  assert(self==&provider_mode && op==31 && argument_length==0);(void)arguments;provider_calls++;
  if(provider_mode==1){out->struct_size=sizeof(size_t);return 0;}
  if(provider_mode==2){out->tag=99;return 0;}
  if(provider_mode==3){out->tag=POCKET_RESULT_BYTES;out->bytes=NULL;out->byte_length=1;return 0;}
  if(provider_mode==4)return POCKET_STATUS_UNSUPPORTED;
  if(provider_mode==5){
    pocket_result nested={0};nested.struct_size=sizeof(nested);
    assert(pocket_runtime_op(instance,31,NULL,0,&nested)==POCKET_STATUS_FAILED);
    assert(pocket_runtime_tick(instance)==POCKET_STATUS_FAILED);
    pocket_runtime_destroy(instance); /* No guest callback is needed to guard this case. */
  }
  out->tag=POCKET_RESULT_BYTES;out->bytes=provider_bytes;out->byte_length=sizeof(provider_bytes)-1;return 0;
}
static void provider_operations(void){
  assert(pocket_runtime_supports_op(instance,31)==1);
  for(provider_mode=0;provider_mode<=5;provider_mode++){
    pocket_result result={0};result.struct_size=sizeof(result);
    int status=pocket_runtime_op(instance,31,NULL,0,&result);
    if(provider_mode==4)assert(status==POCKET_STATUS_UNSUPPORTED);
    else if(provider_mode>=1 && provider_mode<=3)assert(status==POCKET_STATUS_INVALID);
    else {
      assert(status==0 && result.tag==POCKET_RESULT_BYTES && result.byte_length==sizeof(provider_bytes)-1);
      assert(memcmp(result.bytes,provider_bytes,result.byte_length)==0 && result.bytes!=provider_bytes);
      provider_bytes[0]='S';assert(result.bytes[0]=='s');provider_bytes[0]='s';
    }
  }
  provider_mode=0;
}
static void register_provider(void){
  pocket_op_provider_v1 provider={sizeof(provider),provider_dispatch};
  uint16_t ops[]={31,31};
  assert(pocket_runtime_add_op_provider(instance,&provider,&provider_mode,ops,2)==POCKET_STATUS_INVALID);
  const uint16_t invalid[]={0,1,23,44,65535};
  for(size_t i=0;i<sizeof(invalid)/sizeof(invalid[0]);i++)assert(pocket_runtime_add_op_provider(instance,&provider,&provider_mode,&invalid[i],1)==POCKET_STATUS_INVALID);
  assert(pocket_runtime_add_op_provider(instance,&provider,&provider_mode,NULL,0)==POCKET_STATUS_INVALID);
  assert(pocket_runtime_add_op_provider(instance,&provider,&provider_mode,ops,1)==0);
  assert(pocket_runtime_add_op_provider(instance,&provider,&provider_mode,ops,1)==POCKET_STATUS_INVALID);
  provider.dispatch=NULL;ops[0]=1; /* Registration copied both records. */
  provider_operations();create_node();
}
static pocket_op_arg integer(int64_t value){pocket_op_arg arg={0};arg.struct_size=sizeof(arg);arg.tag=POCKET_ARG_INTEGER;arg.integer=value;return arg;}
static void create_node(void){
  pocket_op_arg arg=integer(1);pocket_result result={0};result.struct_size=sizeof(result);
  assert(pocket_runtime_op(instance,1,&arg,sizeof(arg),&result)==0);
  assert(result.tag==POCKET_RESULT_I64 && result.integer>0);
}
static int32_t initialize(void *self,pocket_runtime *runtime,const pocket_guest_environment *environment){
  (void)self;instance=runtime;initialized++;
  assert(environment->viewport_width==4 && environment->viewport_height==4);
  assert(environment->assets_present==1 && environment->texture_count==0);
  assert(pocket_runtime_supports_op(runtime,1)==1);assert(pocket_runtime_supports_op(runtime,65535)==0);
  provider_operations();
  create_node();
  assert(pocket_runtime_tick(runtime)<0); /* Recursive lifecycle calls are rejected. */
  pocket_runtime_destroy(runtime); /* Reentrant destruction cannot free our caller. */
  create_node();return 0;
}
static int32_t evaluate(void *self,pocket_runtime *runtime,const uint8_t *code,size_t length){
  (void)self;assert(runtime==instance);assert(length==5 && memcmp(code,"test\0",5)==0);evaluated++;create_node();return 0;
}
static int32_t frame(void *self,const pocket_guest_frame *input){
  (void)self;assert(input->analog==0x8080);frames++;create_node();return 0;
}
static void shutdown_guest(void *self){(void)self;shutdowns++;}
static int32_t source_length(void *self,size_t *length){(void)self;*length=sizeof(package_bytes);return 0;}
static int32_t source_range(void *self,size_t offset,uint8_t *buffer,size_t capacity,size_t *read){
  (void)self;assert(offset<=sizeof(package_bytes));size_t remaining=sizeof(package_bytes)-offset;
  *read=remaining<capacity?remaining:capacity;if(*read>7)*read=7; /* Range-only, short reads. */
  memcpy(buffer,package_bytes+offset,*read);return 0;
}
static int32_t descriptor(void *self,pocket_display_descriptor *out){
  (void)self;pocket_display_descriptor result={0};result.struct_size=sizeof(result);result.role=POCKET_DISPLAY_ROLE_PRIMARY;result.width=4;result.height=4;result.pixel_format=POCKET_PIXEL_FORMAT_RGBA8888;result.stride_bytes=16;result.target_kind=POCKET_TARGET_CPU_VISIBLE;result.refresh_width=1;result.refresh_height=1;result.window_x_alignment=1;result.window_y_alignment=1;*out=result;return 0;
}
static int32_t acquire(void *self,const pocket_rect *region,pocket_target *out){
  (void)self;acquired=*region;acquired_surface=(pocket_surface){sizeof(pocket_surface),pixels,sizeof(pixels),&acquired,16,POCKET_PIXEL_FORMAT_RGBA8888};
  *out=(pocket_target){sizeof(pocket_target),POCKET_TARGET_CPU_VISIBLE,&acquired,POCKET_PIXEL_FORMAT_RGBA8888,&acquired_surface,0};
  /* Mutating runtime from a display callback must be rejected. */
  pocket_op_arg arg=integer(1);pocket_result result={0};result.struct_size=sizeof(result);
  assert(pocket_runtime_op(instance,1,&arg,sizeof(arg),&result)<0);
  return 0;
}
static int32_t flush(void *self,const pocket_rect *regions,size_t count,uint64_t *token){(void)self;assert(regions && count);*token=(uint64_t)++flushes;return 0;}
static int32_t display_wait(void *self,uint64_t token){(void)self;assert(token>0);waits++;if(!failed_wait){failed_wait=1;return POCKET_STATUS_FAILED;}return 0;}

static void prefix_and_operation_tests(void){
  size_t page=(size_t)sysconf(_SC_PAGESIZE);
  uint8_t *mapping=mmap(NULL,page*2,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
  assert(mapping!=MAP_FAILED);assert(mprotect(mapping+page,page,PROT_NONE)==0);
  size_t *prefix=(size_t *)(mapping+page-sizeof(size_t));*prefix=sizeof(size_t);
  assert(pocket_runtime_create((const pocket_runtime_config *)prefix)==NULL);
  assert(munmap(mapping,page*2)==0);
  struct short_result {size_t struct_size;uint32_t tag;uint32_t sentinel;} result={offsetof(struct short_result,sentinel),99,0xa1b2c3d4};
  struct extended_arg {pocket_op_arg arg;uint64_t extension;} arg={0};arg.arg=integer(1);arg.arg.struct_size=sizeof(arg);arg.extension=0xfedcba;
  assert(pocket_runtime_op(instance,1,&arg,sizeof(arg),(pocket_result *)&result)==0);
  assert(result.tag==POCKET_RESULT_I64 && result.sentinel==0xa1b2c3d4);
  pocket_result full={0};full.struct_size=sizeof(full);
  arg.arg.struct_size=sizeof(arg)+8;
  assert(pocket_runtime_op(instance,1,&arg,sizeof(arg),&full)==POCKET_STATUS_INVALID);
  assert(full.tag==POCKET_RESULT_NONE && full.bytes==NULL && full.integer==0);
  /* Reject an arithmetic-wrapping span before reading its first record. */
  assert(pocket_runtime_op(instance,1,(const void *)(UINTPTR_MAX-7),16,&full)==POCKET_STATUS_INVALID);
  assert(pocket_runtime_op(instance,58,NULL,0,&full)==0);
  assert(full.tag==POCKET_RESULT_BYTES);const uint8_t *bytes=full.bytes;size_t length=full.byte_length;
  assert(pocket_runtime_supports_op(instance,1)==1);
  assert(full.bytes==bytes && full.byte_length==length); /* Read-only probe preserves borrow. */
  assert(pocket_runtime_op(instance,65535,NULL,0,&full)==POCKET_STATUS_UNSUPPORTED);
  assert(full.tag==POCKET_RESULT_NONE && full.bytes==NULL);
}
static void raster_test(void){
  uint8_t memory[24];memset(memory,0x5a,sizeof(memory));
  pocket_rect region={sizeof(pocket_rect),2,1,2,2};
  pocket_surface surface={sizeof(pocket_surface),memory,sizeof(memory),&region,12,POCKET_PIXEL_FORMAT_RGBA8888};
  uint32_t words[]={POCKET_DRAW_OP_RECT,1,2|(2<<16),0xff0000ff};
  pocket_logical_clip clip={sizeof(pocket_logical_clip),1,0,2,2};
  pocket_draw_op operation={sizeof(pocket_draw_op),words,4,&clip,2};
  pocket_render_resources resources={0};resources.struct_size=sizeof(resources);resources.viewport_width=4;resources.viewport_height=4;
  assert(pocket_raster_draw_op(&surface,&operation,&resources)==0);
  for(int row=0;row<2;row++)for(int x=0;x<2;x++){size_t at=(size_t)row*12+(size_t)x*4;assert(memory[at]==255 && memory[at+1]==0 && memory[at+2]==0 && memory[at+3]==255);}
  for(int i=8;i<12;i++)assert(memory[i]==0x5a);for(int i=20;i<24;i++)assert(memory[i]==0x5a);
  operation.scale=0;assert(pocket_raster_draw_op(&surface,&operation,&resources)<0);
}
struct visit_state {pocket_surface *surface;const pocket_render_resources *resources;int calls;int fail_at;};
static int32_t visit_operation(void *context,const pocket_draw_op *operation){
  struct visit_state *state=context;state->calls++;
  assert(operation->scale==1 && operation->clip);
  if(state->calls<=2)assert(operation->clip->x0==1 && operation->clip->y0==1 && operation->clip->x1==3 && operation->clip->y1==3);
  else assert(operation->clip->x0==0 && operation->clip->y0==0 && operation->clip->x1==4 && operation->clip->y1==4);
  if(state->calls==state->fail_at)return -42;
  return pocket_raster_draw_op(state->surface,operation,state->resources);
}
static void draw_list_test(void){
  uint8_t memory[64]={0};
  pocket_rect region={sizeof(region),0,0,4,4};
  pocket_surface surface={sizeof(surface),memory,sizeof(memory),&region,16,POCKET_PIXEL_FORMAT_RGBA8888};
  pocket_render_resources resources={0};resources.struct_size=sizeof(resources);resources.viewport_width=4;resources.viewport_height=4;
  uint32_t words[]={POCKET_DRAW_OP_SCISSOR,1|(1<<16),2|(2<<16),POCKET_DRAW_OP_RECT,0,4|(4<<16),0xff0000ff,POCKET_DRAW_OP_SCISSOR_POP,POCKET_DRAW_OP_RECT,0,1|(1<<16),0xffff0000,0};
  pocket_draw_list list={sizeof(list),words,12,POCKET_DRAW_LIST_VERSION};
  struct visit_state state={&surface,&resources,0,0};
  assert(pocket_draw_list_visit(&list,&resources,1,visit_operation,&state)==0 && state.calls==4);
  assert(memory[2]==255 && memory[3]==255); /* blue after pop */
  assert(memory[20]==255 && memory[23]==255); /* red inside inherited clip */
  assert(memory[4]==0 && memory[63]==0); /* untouched outside both rectangles */
  state.calls=0;state.fail_at=2;
  assert(pocket_draw_list_visit(&list,&resources,1,visit_operation,&state)==-42 && state.calls==2);
  state.calls=0;list.word_count=13;words[12]=0xffffffff;
  assert(pocket_draw_list_visit(&list,&resources,1,visit_operation,&state)==POCKET_STATUS_INVALID && state.calls==0);
  list.word_count=7; /* Missing scissor pop is rejected before any callback. */
  assert(pocket_draw_list_visit(&list,&resources,1,visit_operation,&state)==POCKET_STATUS_INVALID && state.calls==0);
  list.word_count=12;list.version++;
  assert(pocket_draw_list_visit(&list,&resources,1,visit_operation,&state)==POCKET_STATUS_UNSUPPORTED);
  list.version--;assert(pocket_draw_list_visit(&list,&resources,0,visit_operation,&state)==POCKET_STATUS_INVALID);
  assert(pocket_draw_list_visit(&list,&resources,1,NULL,&state)==POCKET_STATUS_INVALID);
}
int main(void){
  pocket_runtime_config config={0};config.struct_size=sizeof(config);memcpy(config.profile_hash,profile_hash,32);config.host_abi=1;config.tick_hz=60;config.heap_limit=65536;config.frame_buffer_budget=64;config.profile_json=profile_json;config.profile_json_length=sizeof(profile_json)-1;
  instance=pocket_runtime_create(&config);assert(instance);
  prefix_and_operation_tests();raster_test();draw_list_test();register_provider();
  pocket_package_source_v1 source={sizeof(source),source_length,NULL,source_range};
  pocket_guest_v1 guest={sizeof(guest),evaluate,frame,NULL,shutdown_guest,initialize};
  pocket_display_output_v1 display={sizeof(display),descriptor,acquire,flush,display_wait,NULL};
  assert(pocket_runtime_set_package_source(instance,&source,NULL)==0);
  assert(pocket_runtime_set_guest(instance,&guest,NULL)==0);
  assert(pocket_runtime_add_display(instance,&display,NULL,POCKET_RENDERER_SOFTWARE)==0);
  assert(pocket_runtime_boot(instance)==POCKET_STATUS_FAILED); /* terminal display failure */
  assert(initialized==1 && evaluated==1 && frames==0 && flushes==1 && waits==1);
  assert(pocket_runtime_tick(instance)==0);assert(frames==1 && flushes==2 && waits==2);
  pocket_op_provider_v1 provider={sizeof(provider),provider_dispatch};const uint16_t op=31;
  assert(pocket_runtime_add_op_provider(instance,&provider,&provider_mode,&op,1)==POCKET_STATUS_INVALID);
  assert(provider_calls==12);
  pocket_runtime_destroy(instance);assert(shutdowns==1);assert(live_allocations==0);
  puts("runtime C ABI: prefixes, reentry, range source, raster and terminal lifecycle passed");return 0;
}
