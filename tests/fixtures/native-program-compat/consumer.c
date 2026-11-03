/* Cross-version consumer of pocket_native_program.h. tools/test-native-program-compat.ts
 * compiles it against old headers with the current archive and against current
 * headers with the old archive; only entry points the old revision declares
 * appear here. The std software archive supplies the six pocket_host_* hooks
 * and the ARGB buffer; a fake guest stands in for QuickJS. */
#include "pocket_native_program.h"
#ifdef POCKET_OLD_ARCHIVE
#include "fixture-old.h"
#else
#include "fixture-current.h"
#endif
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static PocketNativeProgram *program;
static int initialized, evaluated, frames, shutdowns;
static pocket_op_arg integer(int64_t value){pocket_op_arg arg={0};arg.struct_size=sizeof(arg);arg.tag=POCKET_ARG_INTEGER;arg.integer=value;return arg;}
static int32_t initialize(void *self,pocket_runtime *runtime,const pocket_guest_environment *environment){
  (void)self;initialized++;
  assert(runtime==pocket_native_program_runtime(program));
  assert(environment->viewport_width==FIXTURE_WIDTH && environment->viewport_height==FIXTURE_HEIGHT);
  assert(environment->host_abi==fixture_binding_generation);
  /* Guest bindings reach the runtime through pocket_runtime_op during initialize: createNode. */
  pocket_op_arg arg=integer(1);pocket_result result={0};result.struct_size=sizeof(result);
  assert(pocket_runtime_op(runtime,1,&arg,sizeof(arg),&result)==0);
  assert(result.tag==POCKET_RESULT_I64 && result.integer>0);
  return 0;
}
static int32_t evaluate(void *self,pocket_runtime *runtime,const uint8_t *code,size_t length){
  (void)self;(void)runtime;assert(length==5 && memcmp(code,"test\0",5)==0);evaluated++;return 0;
}
static int32_t frame(void *self,const pocket_guest_frame *input){(void)self;assert(input->buttons==17);frames++;return 0;}
static int32_t collect(void *self){(void)self;return 0;}
static void shutdown_guest(void *self){
  (void)self;shutdowns++;
  pocket_native_program_destroy(program); /* Recursive destruction is rejected. */
}
int main(int argc,char **argv){
  /* A real signal termination guards the runner against Bun exitCode=0. */
  if(argc==2 && strcmp(argv[1],"--abort")==0)abort();
  /* Fields are set by name, so the same source fills the record each header
   * revision declares; struct_size reports that revision's prefix. */
  static const uint32_t logical[]={FIXTURE_WIDTH,FIXTURE_HEIGHT};
  pocket_profile_display panel={0};panel.struct_size=sizeof(panel);panel.physical[0]=FIXTURE_WIDTH;panel.physical[1]=FIXTURE_HEIGHT;panel.logical=logical;panel.logical_count=1;panel.raster_density=FIXTURE_RASTER_DENSITY;
  pocket_profile_facts facts={0};facts.struct_size=sizeof(facts);facts.id=(const uint8_t *)FIXTURE_ID;facts.id_length=sizeof(FIXTURE_ID)-1;facts.tick_hz=FIXTURE_TICK_HZ;facts.input_classes=FIXTURE_INPUT_CLASSES;facts.display=&panel;
  const uint8_t *code=(const uint8_t *)"test"; /* Five bytes with the terminator: the package's JavaScript section. */
  /* Constructors reject another binding generation before reading the package. */
  assert(pocket_native_program_create_package(FIXTURE_ID,fixture_binding_generation+1,package_bytes,sizeof(package_bytes),"app","test.app","App",FIXTURE_WIDTH,FIXTURE_HEIGHT,FIXTURE_RASTER_DENSITY,0,&facts,profile_hash)==NULL);
  /* Package path: a catalog .pocket admitted against the host build's facts. */
  program=pocket_native_program_create_package(FIXTURE_ID,fixture_binding_generation,package_bytes,sizeof(package_bytes),"app","test.app","App",FIXTURE_WIDTH,FIXTURE_HEIGHT,FIXTURE_RASTER_DENSITY,0,&facts,profile_hash);
  assert(program);pocket_native_program_destroy(program);program=NULL;
  /* Bare adapter: raw JavaScript under the one named viewport. */
  program=pocket_native_program_create(FIXTURE_ID,fixture_binding_generation,code,5,NULL,0,FIXTURE_WIDTH,FIXTURE_HEIGHT,FIXTURE_RASTER_DENSITY,0);
  assert(program);pocket_native_program_destroy(program);program=NULL;
  /* Raw JavaScript with the exported profile: the path the QuickJS facade and nokia-e7 boot through. */
  program=pocket_native_program_create_profile(FIXTURE_ID,fixture_binding_generation,code,5,NULL,0,FIXTURE_WIDTH,FIXTURE_HEIGHT,FIXTURE_RASTER_DENSITY,0,&facts,profile_hash);
  assert(program);
  pocket_guest_v1 guest={.struct_size=sizeof(guest),.evaluate=evaluate,.frame=frame,.collect=collect,.shutdown=shutdown_guest,.initialize=initialize};
  assert(pocket_runtime_set_guest(pocket_native_program_runtime(program),&guest,NULL)==0);
  assert(pocket_native_program_boot(program)==0);
  assert(initialized==1 && evaluated==1 && frames==0);
  assert(pocket_native_program_width(program)==FIXTURE_WIDTH && pocket_native_program_height(program)==FIXTURE_HEIGHT);
  assert(pocket_native_program_stride(program)==FIXTURE_WIDTH*4 && pocket_native_program_length(program)==(size_t)FIXTURE_WIDTH*FIXTURE_HEIGHT*4);
  /* Software build: the ARGB buffer after a synchronous frame. The first frame redraws everything; an unchanged frame touches no pixel. */
  const uint8_t *pixels=pocket_native_program_render_argb(program);
  assert(pixels);
  assert(pocket_native_program_damage_full_redraws(program)==1 && pocket_native_program_damage_pixels(program)==FIXTURE_WIDTH*FIXTURE_HEIGHT);
  int32_t bounds[4]={0};
  assert(pocket_native_program_damage_bounds(program,bounds)==1 && bounds[2]==(int32_t)FIXTURE_WIDTH && bounds[3]==(int32_t)FIXTURE_HEIGHT);
  assert(pocket_native_program_render_argb(program)==pixels && pocket_native_program_damage_pixels(program)==0);
  assert(pocket_native_program_damage_attempts(program)==2 && pocket_native_program_damage_failures(program)==0);
  pocket_input_frame input;memset(&input,0,sizeof(input));input.struct_size=sizeof(input);input.buttons=17;
  assert(pocket_native_program_advance(program,&input,1)==0);
  assert(frames==1);
  assert(pocket_native_program_render_argb(program)==pixels);
  assert(pocket_native_program_collect(program)==0);
  /* GL entry points link in a software build and report unsupported. */
  assert(pocket_native_program_gl_initialize(program)==POCKET_STATUS_UNSUPPORTED);
  assert(pocket_native_program_gl_render(program,FIXTURE_WIDTH,FIXTURE_HEIGHT,0)==POCKET_STATUS_UNSUPPORTED);
  assert(pocket_native_program_gl_render_rect(program,0,0,FIXTURE_WIDTH,FIXTURE_HEIGHT,FIXTURE_WIDTH,FIXTURE_HEIGHT,0)==POCKET_STATUS_UNSUPPORTED);
  assert(pocket_native_program_resize_viewport(program,FIXTURE_WIDTH,FIXTURE_HEIGHT)==POCKET_STATUS_UNSUPPORTED);
  pocket_native_program_set_gl_trace(program,NULL);
  pocket_native_program_gl_reset(program);
  pocket_native_program_gl_shutdown(program);
  pocket_native_program_destroy(program);program=NULL;
  assert(shutdowns==1);
  puts("cross-version native program API: constructors and lifecycle passed");return 0;
}
