#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include "pocket_guest_quickjs.h"
#include <sys/mman.h>
#include <unistd.h>
#include <assert.h>
#include <stdio.h>
#include <string.h>

struct pocket_runtime { unsigned calls; uint16_t last_op; int64_t integers[6]; uint8_t bytes[64]; size_t length; };
static unsigned support_queries;
uint32_t pocket_runtime_supports_op(const pocket_runtime *runtime,uint16_t op) {(void)runtime;support_queries++;return op!=23&&!(op>=30&&op<=41)&&!(op>=44&&op<=46)&&op!=51&&!(op>=52&&op<=56);}
int32_t pocket_runtime_op(pocket_runtime *runtime,uint16_t op,const void *data,size_t length,pocket_result *result) {
  const pocket_op_arg *args=data;size_t count=length/sizeof *args;
  runtime->calls++;runtime->last_op=op;
  for(size_t i=0;i<count;i++){assert(args[i].struct_size==sizeof *args);runtime->integers[i]=args[i].integer;if(args[i].tag==POCKET_ARG_BYTES){runtime->length=args[i].byte_length;assert(runtime->length<=sizeof runtime->bytes);if(runtime->length)memcpy(runtime->bytes,args[i].bytes,runtime->length);}}
  result->tag=POCKET_RESULT_NONE;
  if(op==1||op==9||op==25){result->tag=POCKET_RESULT_I64;result->integer=17;}
  if(op==14||op==15){result->tag=POCKET_RESULT_I64;result->integer=1;}
  if(op==16){result->tag=POCKET_RESULT_F64;result->real=0;}
  if(op==43){result->tag=POCKET_RESULT_BYTES;result->bytes=NULL;result->byte_length=0;}
  if(op==58){result->tag=POCKET_RESULT_BYTES;result->bytes=(const uint8_t*)"[]";result->byte_length=2;}
  return 0;
}
static void eval(pocket_guest_quickjs *guest,pocket_runtime *runtime,const char *source) {
  int32_t status=pocket_guest_quickjs_vtable()->evaluate(guest,runtime,(const uint8_t*)source,strlen(source));
  if(status)fprintf(stderr,"%s\n",pocket_guest_quickjs_error(guest));assert(status==0);
}
static pocket_guest_environment environment(void) {
  pocket_guest_environment env={0};env.struct_size=sizeof env;env.host=(const uint8_t*)"test";env.host_length=4;env.host_abi=POCKET_BINDING_GENERATION;env.tick_hz=60;env.viewport_width=480;env.viewport_height=272;return env;
}
static void assert_generation(pocket_guest_quickjs *guest,pocket_runtime *runtime) {
  char source[128];snprintf(source,sizeof source,"if(ui.__hostAbi!==%u)throw Error('binding generation')",(unsigned)POCKET_BINDING_GENERATION);eval(guest,runtime,source);
}
static void binding_generation(void) {
  /* Historical generations remain negative evidence, independent of profile. */
  static const uint32_t rejected[]={0,1,2,3,4,5,6,7,8,9,10,11,POCKET_BINDING_GENERATION+1,UINT32_MAX};
  for(int profile=POCKET_QJS_CANONICAL;profile<=POCKET_QJS_IDF;profile++) {
    for(int attached=0;attached<=1;attached++) {
      JSRuntime *engine=attached?JS_NewRuntime():NULL;
      JSContext *ctx=attached?JS_NewContext(engine):NULL;
      pocket_guest_quickjs *guest=attached?pocket_guest_quickjs_attach(ctx,(pocket_qjs_profile)profile):pocket_guest_quickjs_create((pocket_qjs_profile)profile);
      pocket_runtime runtime={0};pocket_guest_environment env=environment();const uint8_t pak[]={1};env.pak=pak;env.pak_length=sizeof pak;
      support_queries=0;
      for(size_t i=0;i<sizeof rejected/sizeof rejected[0];i++) {
        env.host_abi=rejected[i];assert(pocket_guest_quickjs_vtable()->initialize(guest,&runtime,&env)!=0);
        assert(strstr(pocket_guest_quickjs_error(guest),"Unsupported UI binding generation"));
        assert(!support_queries&&!runtime.calls);
        if(attached) {
          const char *source="if('ui' in globalThis||'__pak' in globalThis||'console' in globalThis)throw Error('mount side effect')";
          JSValue result=JS_Eval(ctx,source,strlen(source),"test",JS_EVAL_TYPE_GLOBAL);assert(!JS_IsException(result));JS_FreeValue(ctx,result);
        } else assert(!pocket_guest_quickjs_context(guest));
      }
      env.host_abi=POCKET_BINDING_GENERATION;assert(pocket_guest_quickjs_vtable()->initialize(guest,&runtime,&env)==0);assert_generation(guest,&runtime);
      pocket_guest_quickjs_destroy(guest);
      if(attached){JS_FreeContext(ctx);JS_FreeRuntime(engine);}
    }
  }
}
static void canonical(void) {
  pocket_runtime runtime={0};pocket_guest_quickjs *guest=pocket_guest_quickjs_create(POCKET_QJS_CANONICAL);pocket_guest_environment env=environment();
  assert(pocket_guest_quickjs_vtable()->initialize(guest,&runtime,&env)==0);
  assert_generation(guest,&runtime);
  eval(guest,&runtime,"function check(x){if(!x)throw new Error('assertion')}check(ui.__host==='test'&&ui.__tickHz===60&&ui.__viewport.w===480);check(!('__textures' in ui)&&!('svcOpen' in ui)&&!('physicsCreate' in ui));check(ui.takeAnimationCompletions()==='[]');check(ui.wrapText('',0,1).length===0);let caught=false;try{ui.createNode()}catch(e){caught=e instanceof TypeError}check(caught)");
  eval(guest,&runtime,"ui.uploadTexture(new Uint8Array([0,0,0,0,10,20,30,255]).subarray(4),{valueOf(){check(ui.createNode(0)===17);return 1}},1,3)");
  assert(runtime.last_op==9&&runtime.length==4&&memcmp(runtime.bytes,"\x0a\x14\x1e\xff",4)==0);
  eval(guest,&runtime,"ui.loadStyles(new ArrayBuffer(0));ui.loadStyles(new Uint8Array(new ArrayBuffer(0)));let bad=false;try{ui.loadStyles({})}catch(e){bad=e instanceof TypeError}check(bad);ui.createNode(0)");assert(runtime.last_op==1);
  eval(guest,&runtime,"ui.setText(17,{toString(){ui.createNode(0);return 'ok'}})");assert(runtime.last_op==7&&runtime.length==2&&memcmp(runtime.bytes,"ok",2)==0);
  eval(guest,&runtime,"ui.setText(17,'\\ud800')");assert(runtime.length>0&&runtime.bytes[0]==0xef);
  eval(guest,&runtime,"let b=new ArrayBuffer(4),v=new Uint8Array(b);let rejected=false;try{ui.uploadTexture(v,{valueOf(){b.transfer();return 1}},1,3)}catch(e){rejected=true}check(rejected)");
  eval(guest,&runtime,"globalThis.frame=(...args)=>{check(args.length===8&&args[2][0]===0x40040000&&args[6][0].axis===1&&args[6][0].delta===-5&&args[7].timestamp===100);Promise.resolve().then(()=>globalThis.drained=true)}");
  const uint32_t touches[]={0x40040000};const int32_t hits[]={0};const uint8_t surfaces[]={1};pocket_axis_delta delta={0};delta.struct_size=sizeof delta;delta.axis=1;delta.delta=-5;pocket_motion_state motion={0};motion.struct_size=sizeof motion;motion.timestamp=100;
  pocket_guest_frame frame={0};frame.struct_size=sizeof frame;frame.touches=touches;frame.hits=hits;frame.touch_surfaces=surfaces;frame.touch_count=1;frame.axis_deltas=&delta;frame.axis_delta_count=1;frame.motion=&motion;
  assert(pocket_guest_quickjs_vtable()->frame(guest,&frame)==0);eval(guest,&runtime,"check(drained)");
  pocket_guest_quickjs_destroy(guest);
}
static void idf(void) {
  pocket_runtime runtime={0};pocket_guest_quickjs *guest=pocket_guest_quickjs_create(POCKET_QJS_IDF);pocket_guest_environment env=environment();env.assets_present=1;
  assert(pocket_guest_quickjs_vtable()->initialize(guest,&runtime,&env)==0);
  eval(guest,&runtime,"function check(x){if(!x)throw new Error('assertion')}check(Object.getPrototypeOf(ui.__textures)===null&&Object.keys(ui.__sprites).length===0);check(ui.createNode()===17&&ui.measureText()===0&&ui.wrapText('x').length===0);check(Object.values(ui).filter(v=>typeof v==='function').length===25);let caught=false;try{ui.uploadTexture(new ArrayBuffer(4),1,1,3)}catch(e){caught=e instanceof TypeError}check(caught)");
  eval(guest,&runtime,"ui.loadStyles(new Uint8Array(0));let bad=false;try{ui.loadStyles(new Int8Array(0))}catch(e){bad=e instanceof TypeError}check(bad);ui.createNode(0)");
  eval(guest,&runtime,"ui.setSprite(1,2,-1,-2,-3)");assert(runtime.integers[2]==UINT32_MAX&&runtime.integers[3]==UINT32_MAX-1);
  pocket_guest_quickjs_destroy(guest);
}
static void attached_lifetime(void) {
  JSRuntime *engine=JS_NewRuntime();JSContext *ctx=JS_NewContext(engine);pocket_runtime runtime={0};pocket_guest_environment env=environment();const uint8_t pak[]={1,2,3};env.pak=pak;env.pak_length=3;
  pocket_guest_quickjs *guest=pocket_guest_quickjs_attach(ctx,POCKET_QJS_CANONICAL);assert(pocket_guest_quickjs_vtable()->initialize(guest,&runtime,&env)==0);
  eval(guest,&runtime,"globalThis.saved=ui.createNode;globalThis.savedPak=__pak");pocket_guest_quickjs_destroy(guest);
  const char *source="let rejected=false;try{saved(0)}catch(e){rejected=true}if(!rejected||savedPak.byteLength!==0||'ui' in globalThis)throw new Error('lifetime')";
  JSValue result=JS_Eval(ctx,source,strlen(source),"test",JS_EVAL_TYPE_GLOBAL);assert(!JS_IsException(result));JS_FreeValue(ctx,result);JS_FreeContext(ctx);JS_FreeRuntime(engine);
}
static void extensible_records(void) {
  struct extended_texture {pocket_named_texture base;uint64_t future;} textures[2]={0};
  struct extended_sprite {pocket_named_sprite base;uint64_t future;} sprites[2]={0};
  for(size_t i=0;i<2;i++){textures[i].base.struct_size=sizeof textures[i];textures[i].base.name=(const uint8_t*)(i?"second":"first");textures[i].base.name_length=i?6:5;textures[i].base.handle=(int32_t)(11+i);sprites[i].base.struct_size=sizeof sprites[i];sprites[i].base.name=textures[i].base.name;sprites[i].base.name_length=textures[i].base.name_length;sprites[i].base.handle=(int32_t)(21+i);sprites[i].base.frames=2;sprites[i].base.columns=1;sprites[i].base.step=3;}
  pocket_runtime runtime={0};pocket_guest_environment env=environment();env.assets_present=1;env.textures=&textures[0].base;env.texture_count=2;env.sprites=&sprites[0].base;env.sprite_count=2;
  pocket_guest_quickjs *guest=pocket_guest_quickjs_create(POCKET_QJS_CANONICAL);
  env.struct_size=sizeof(size_t);assert(pocket_guest_quickjs_vtable()->initialize(guest,&runtime,&env)!=0);
  env.struct_size=sizeof env;env.heap_limit=1;assert(pocket_guest_quickjs_vtable()->initialize(guest,&runtime,&env)!=0);
  env.heap_limit=0;assert(pocket_guest_quickjs_vtable()->initialize(guest,&runtime,&env)==0);
  eval(guest,&runtime,"if(ui.__textures.second!==12||ui.__sprites.second.handle!==22)throw new Error('asset stride');ui.loadStyles(new Uint8Array(0));globalThis.frame=(...args)=>{if(args[6][1].axis!==1||args[6][1].delta!==9)throw new Error('axis stride')}");
  struct extended_delta {pocket_axis_delta base;uint64_t future;} deltas[2]={0};for(size_t i=0;i<2;i++){deltas[i].base.struct_size=sizeof deltas[i];deltas[i].base.axis=(uint32_t)i;deltas[i].base.delta=(int32_t)(8+i);}
  pocket_guest_frame frame={0};frame.struct_size=sizeof(size_t);assert(pocket_guest_quickjs_vtable()->frame(guest,&frame)!=0);
  frame.struct_size=sizeof frame;frame.axis_deltas=&deltas[0].base;frame.axis_delta_count=2;assert(pocket_guest_quickjs_vtable()->frame(guest,&frame)==0);
  pocket_guest_quickjs_destroy(guest);
}
static void package_source_is_read_only(void) {
  size_t page=(size_t)sysconf(_SC_PAGESIZE);uint8_t *source=mmap(NULL,page,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);assert(source!=MAP_FAILED);source[0]=1;source[1]=2;source[2]=3;assert(mprotect(source,page,PROT_READ)==0);
  for(int profile=POCKET_QJS_CANONICAL;profile<=POCKET_QJS_IDF;profile++) {
    pocket_runtime runtime={0};pocket_guest_environment env=environment();env.pak=source;env.pak_length=3;pocket_guest_quickjs *guest=pocket_guest_quickjs_create((pocket_qjs_profile)profile);assert(pocket_guest_quickjs_vtable()->initialize(guest,&runtime,&env)==0);
    eval(guest,&runtime,"try{new Uint8Array(__pak)[0]=99}catch(e){};try{new DataView(__pak).setUint8(1,88)}catch(e){}");
    assert(source[0]==1&&source[1]==2&&source[2]==3);pocket_guest_quickjs_destroy(guest);
  }
  assert(munmap(source,page)==0);
}
static void package_terminal_nul(void) {
  static const uint8_t source[]="globalThis.packageEvaluated=42;";
  static const uint8_t invalid[]="globalThis.packageEvaluated=1;\0";
  for(int profile=POCKET_QJS_CANONICAL;profile<=POCKET_QJS_IDF;profile++) {
    pocket_runtime runtime={0};pocket_guest_environment env=environment();pocket_guest_quickjs *guest=pocket_guest_quickjs_create((pocket_qjs_profile)profile);
    assert(pocket_guest_quickjs_vtable()->initialize(guest,&runtime,&env)==0);
    assert(pocket_guest_quickjs_vtable()->evaluate(guest,&runtime,source,sizeof source)==0);
    eval(guest,&runtime,"if(packageEvaluated!==42)throw new Error('terminal NUL')");
    assert(pocket_guest_quickjs_vtable()->evaluate(guest,&runtime,NULL,0)==0);
    assert(pocket_guest_quickjs_vtable()->evaluate(guest,&runtime,invalid,sizeof invalid)!=0);
    pocket_guest_quickjs_destroy(guest);
  }
}
int main(void){binding_generation();canonical();idf();attached_lifetime();extensible_records();package_source_is_read_only();package_terminal_nul();puts("generated QuickJS bindings: ok");return 0;}
