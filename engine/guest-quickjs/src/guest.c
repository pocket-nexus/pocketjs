/* QuickJS-NG adapter. Signatures and mount tables are generated; this file
 * owns only engine lifetime, coercion policy, and the existing frame wire. */
#include "pocket_guest_quickjs.h"
#include "generated_ops.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(__APPLE__)
extern int JS_SetImmutableArrayBuffer(JSValueConst object, bool immutable) __attribute__((weak_import));
#define HAS_IMMUTABLE_API (JS_SetImmutableArrayBuffer != NULL)
#elif defined(__GNUC__)
extern int JS_SetImmutableArrayBuffer(JSValueConst object, bool immutable) __attribute__((weak));
#define HAS_IMMUTABLE_API (JS_SetImmutableArrayBuffer != NULL)
#elif defined(POCKET_QJS_IMMUTABLE_API)
#define HAS_IMMUTABLE_API 1
#else
#define HAS_IMMUTABLE_API 0
#endif

struct pocket_guest_quickjs {
  JSRuntime *engine;
  JSContext *context;
  pocket_runtime *runtime;
  pocket_qjs_profile profile;
  int attached, mounted, mounted_pak;
  JSValue token, pak;
  char error[256];
};
#define HAS_FIELD(value,type,field) ((value)->struct_size >= offsetof(type,field) + sizeof((value)->field))
#define NEXT_RECORD(value,type) ((const type *)((const uint8_t *)(value) + (value)->struct_size))
static void shutdown(void *opaque);
static int32_t fail(pocket_guest_quickjs *guest) {
  JSValue error=JS_GetException(guest->context);
  const char *message=JS_ToCString(guest->context,error);
  snprintf(guest->error,sizeof guest->error,"%s",message?message:"QuickJS exception");
  if(message) JS_FreeCString(guest->context,message);
  JS_FreeValue(guest->context,error);
  return -1;
}
static int valid_utf8(const unsigned char *bytes,size_t length) {
  for(size_t i=0;i<length;) {
    unsigned a=bytes[i++]; if(a<128) continue;
    unsigned count=a>=0xc2&&a<=0xdf?1:a>=0xe0&&a<=0xef?2:a>=0xf0&&a<=0xf4?3:0;
    if(!count||count>length-i) return 0;
    unsigned b=bytes[i];
    if((a==0xe0&&b<0xa0)||(a==0xed&&b>=0xa0)||(a==0xf0&&b<0x90)||(a==0xf4&&b>=0x90)) return 0;
    for(unsigned n=0;n<count;n++) if((bytes[i++]&0xc0)!=0x80) return 0;
  }
  return 1;
}
/* Replace one invalid UTF-8 sequence at a time, matching Rust from_utf8_lossy. */
static char *lossy_utf8(const unsigned char *bytes,size_t length,size_t *out_length) {
  if(length>(SIZE_MAX-1)/3) return NULL;
  char *out=malloc(length*3+1); if(!out) return NULL;
  size_t size=0;
  for(size_t i=0;i<length;) {
    unsigned a=bytes[i],count=a<128?1:a>=0xc2&&a<=0xdf?2:a>=0xe0&&a<=0xef?3:a>=0xf0&&a<=0xf4?4:0;
    size_t accepted=1;
    if(count>1) {
      for(;accepted<count&&i+accepted<length;accepted++) {
        unsigned b=bytes[i+accepted];
        if((b&0xc0)!=0x80 || (accepted==1&&((a==0xe0&&b<0xa0)||(a==0xed&&b>=0xa0)||(a==0xf0&&b<0x90)||(a==0xf4&&b>=0x90)))) break;
      }
    }
    if(count&&accepted==count) { memcpy(out+size,bytes+i,count);size+=count;i+=count; }
    else { memcpy(out+size,"\xef\xbf\xbd",3);size+=3;i+=accepted; }
  }
  out[size]=0;*out_length=size;return out;
}
static JSValue invoke(JSContext *ctx,JSValueConst self,int argc,JSValueConst *argv,int magic,JSValue *data) {
  (void)self;
  size_t token_length=0;
  uint8_t *token=JS_GetArrayBuffer(ctx,&token_length,data[0]);
  pocket_guest_quickjs *guest=NULL;
  if(token&&token_length==sizeof guest) memcpy(&guest,token,sizeof guest);
  if(!guest||!guest->runtime||magic<0||(size_t)magic>=POCKET_UI_OP_COUNT) return JS_ThrowInternalError(ctx,"inactive UI binding");
  const pocket_ui_op_descriptor *op=&pocket_ui_ops[magic];
  if(guest->profile==POCKET_QJS_IDF&&((op->op==16&&argc<1)||(op->op==43&&argc<3))) {
    uint32_t slot=0;if(argc>1&&JS_ToUint32(ctx,&slot,argv[1])<0)return JS_EXCEPTION;
    return op->op==16?JS_NewFloat64(ctx,0):JS_NewArray(ctx);
  }
  pocket_op_arg args[6];memset(args,0,sizeof args);
  const char *strings[6]={0};char *replacement[6]={0};
  JSValue buffers[6];for(int i=0;i<6;i++) buffers[i]=JS_UNDEFINED;
  JSValue result=JS_EXCEPTION;
  /* Coercion may run user JS; finish it before borrowing buffer pointers. */
  for(unsigned pass=0;pass<2;pass++) {
  for(unsigned i=0;i<op->argc;i++) {
    if((op->args[i].kind==PJS_ARG_STRING)!=(pass==1))continue;
    args[i].struct_size=sizeof args[i];
    unsigned kind=op->args[i].kind;
    int missing=i>=(unsigned)argc;
    int optional=op->args[i].optional&&(missing||JS_IsUndefined(argv[i]));
    if(missing&&!optional&&!(guest->profile==POCKET_QJS_IDF&&kind!=PJS_ARG_STRING&&kind!=PJS_ARG_BYTES)) { JS_ThrowTypeError(ctx,"missing argument %u for %s",i,op->name);goto done; }
    if(kind==PJS_ARG_BYTES) {args[i].tag=POCKET_ARG_BYTES;continue;}
    if(kind==PJS_ARG_STRING) {
      size_t length=0;strings[i]=JS_ToCStringLen(ctx,&length,argv[i]);if(!strings[i]) goto done;
      args[i].tag=POCKET_ARG_BYTES;args[i].bytes=(const uint8_t*)strings[i];args[i].byte_length=length;
      if(!valid_utf8(args[i].bytes,length)) {
        if(guest->profile==POCKET_QJS_IDF) {if(op->op==16||op->op==43){result=op->op==16?JS_NewFloat64(ctx,0):JS_NewArray(ctx);goto done;}JS_ThrowInternalError(ctx,"invalid UTF-8");goto done;}
        if(guest->profile==POCKET_QJS_LEGACY_C) args[i].byte_length=0;
        else {replacement[i]=lossy_utf8(args[i].bytes,length,&args[i].byte_length);if(!replacement[i]) {JS_ThrowOutOfMemory(ctx);goto done;}args[i].bytes=(const uint8_t*)replacement[i];}
      }
    } else if(kind==PJS_ARG_REAL) {
      args[i].tag=POCKET_ARG_REAL;if(!missing&&!optional&&JS_ToFloat64(ctx,&args[i].real,argv[i])<0) goto done;
    } else {
      args[i].tag=POCKET_ARG_INTEGER;
      if(!missing&&!optional) {
        if(kind==PJS_ARG_NONNEGATIVE&&guest->profile!=POCKET_QJS_IDF) {double number;if(JS_ToFloat64(ctx,&number,argv[i])<0) goto done;args[i].integer=!(number>0)?0:number>=UINT32_MAX?UINT32_MAX:(uint32_t)number;}
        else if(kind==PJS_ARG_U32||kind==PJS_ARG_NONNEGATIVE) {uint32_t number;if(JS_ToUint32(ctx,&number,argv[i])<0)goto done;args[i].integer=number;}
        else {int32_t number;if(JS_ToInt32(ctx,&number,argv[i])<0)goto done;args[i].integer=number;}
      }
    }
  }
  }
  for(unsigned i=0;i<op->argc;i++) if(op->args[i].kind==PJS_ARG_BYTES) {
    size_t offset=0,length=0,backing=0,element=0;
    if(guest->profile==POCKET_QJS_IDF&&JS_GetTypedArrayType(argv[i])!=JS_TYPED_ARRAY_UINT8) {JS_ThrowTypeError(ctx,"expected Uint8Array");goto done;}
    if(JS_IsArrayBuffer(argv[i])) {buffers[i]=JS_DupValue(ctx,argv[i]);}
    else {buffers[i]=JS_GetTypedArrayBuffer(ctx,argv[i],&offset,&length,&element);if(JS_IsException(buffers[i]))goto done;}
    uint8_t *bytes=JS_GetArrayBuffer(ctx,&backing,buffers[i]);if(!bytes)goto done;
    if(JS_IsArrayBuffer(argv[i]))length=backing;
    if(offset>backing||length>backing-offset) {JS_ThrowTypeError(ctx,"invalid byte view");goto done;}
    args[i].bytes=bytes+offset;args[i].byte_length=length;
  }
  pocket_result output={0};output.struct_size=sizeof output;
  if(pocket_runtime_op(guest->runtime,op->op,args,op->argc*sizeof args[0],&output)!=0) {JS_ThrowInternalError(ctx,"UI operation failed: %s",op->name);goto done;}
  if(op->result==PJS_RESULT_NONE || ((op->result==PJS_RESULT_OPTIONALSTRING||op->result==PJS_RESULT_OPTIONALBYTES)&&output.tag==POCKET_RESULT_NONE)) result=JS_UNDEFINED;
  else if(op->result==PJS_RESULT_BOOLEAN&&output.tag==POCKET_RESULT_I64) result=JS_NewBool(ctx,output.integer!=0);
  else if(op->result==PJS_RESULT_INTEGER&&output.tag==POCKET_RESULT_I64) result=JS_NewInt64(ctx,output.integer);
  else if(op->result==PJS_RESULT_REAL&&output.tag==POCKET_RESULT_F64) result=JS_NewFloat64(ctx,output.real);
  else if((op->result==PJS_RESULT_STRING||op->result==PJS_RESULT_OPTIONALSTRING)&&output.tag==POCKET_RESULT_BYTES) result=JS_NewStringLen(ctx,(const char*)output.bytes,output.byte_length);
  else if((op->result==PJS_RESULT_BYTES||op->result==PJS_RESULT_OPTIONALBYTES)&&output.tag==POCKET_RESULT_BYTES) result=JS_NewArrayBufferCopy(ctx,output.bytes,output.byte_length);
  else if(op->result==PJS_RESULT_U32ARRAY&&output.tag==POCKET_RESULT_BYTES&&output.byte_length%4==0) {
    result=JS_NewArray(ctx);
    for(size_t i=0;i<output.byte_length/4&&!JS_IsException(result);i++) {
      const uint8_t *b=output.bytes+i*4;uint32_t value=(uint32_t)b[0]|(uint32_t)b[1]<<8|(uint32_t)b[2]<<16|(uint32_t)b[3]<<24;
      if(JS_DefinePropertyValueUint32(ctx,result,(uint32_t)i,JS_NewUint32(ctx,value),JS_PROP_C_W_E)<0) {JS_FreeValue(ctx,result);result=JS_EXCEPTION;}
    }
  } else JS_ThrowInternalError(ctx,"invalid UI result");
done:
  for(int i=0;i<6;i++) {if(strings[i])JS_FreeCString(ctx,strings[i]);free(replacement[i]);JS_FreeValue(ctx,buffers[i]);}
  return result;
}
static int set(JSContext *ctx,JSValueConst object,const char *name,JSValue value) { return JS_DefinePropertyValueStr(ctx,object,name,value,JS_PROP_C_W_E); }
static JSValue viewport(JSContext *ctx,uint32_t width,uint32_t height) {JSValue value=JS_NewObject(ctx);if(set(ctx,value,"w",JS_NewUint32(ctx,width))<0||set(ctx,value,"h",JS_NewUint32(ctx,height))<0){JS_FreeValue(ctx,value);return JS_EXCEPTION;}return value;}
#if defined(POCKET_QJS_VERIFIED_IMMUTABLE_PAK)
static void borrowed_free(JSRuntime *rt,void *opaque,void *ptr) {(void)rt;(void)opaque;(void)ptr;}
#endif
static JSValue package_buffer(JSContext *ctx,pocket_guest_quickjs *guest,const pocket_guest_environment *env) {
  JSValue pak;
  /* LoadedPackage belongs to Rust. A normal JS ArrayBuffer must never expose
   * its bytes for writing, even when the legacy profile permits JS mutation. */
#if defined(POCKET_QJS_VERIFIED_IMMUTABLE_PAK)
  if(guest->profile!=POCKET_QJS_LEGACY_C&&HAS_IMMUTABLE_API) {
    pak=JS_NewArrayBuffer(ctx,(uint8_t*)env->pak,env->pak_length,borrowed_free,NULL,false);
  } else
#endif
  {pak=JS_NewArrayBufferCopy(ctx,env->pak,env->pak_length);}
  if(!JS_IsException(pak)&&guest->profile!=POCKET_QJS_LEGACY_C&&HAS_IMMUTABLE_API) {
#if defined(__GNUC__) || defined(POCKET_QJS_IMMUTABLE_API)
    if(JS_SetImmutableArrayBuffer(pak,true)<0){JS_FreeValue(ctx,pak);return JS_ThrowInternalError(ctx,"cannot protect package buffer");}
#endif
  }
  return pak;
}
static JSValue console_log(JSContext *ctx,JSValueConst self,int argc,JSValueConst *argv) {
  (void)self;
  for(int i=0;i<argc;i++){const char *text=JS_ToCString(ctx,argv[i]);if(!text)return JS_EXCEPTION;if(i)fputc(' ',stderr);fputs(text,stderr);JS_FreeCString(ctx,text);}fputc('\n',stderr);return JS_UNDEFINED;
}
static int32_t initialize(void *opaque,pocket_runtime *runtime,const pocket_guest_environment *env) {
  pocket_guest_quickjs *guest=opaque;
  if(!guest||!runtime||!env||!HAS_FIELD(env,pocket_guest_environment,sprite_count)||guest->mounted)return -1;
  if(!guest->context) {guest->engine=JS_NewRuntime();if(!guest->engine)return -1;if(env->heap_limit)JS_SetMemoryLimit(guest->engine,env->heap_limit);guest->context=JS_NewContext(guest->engine);if(!guest->context){JS_FreeRuntime(guest->engine);guest->engine=NULL;return -1;}}
  JSContext *ctx=guest->context;JSValue global=JS_GetGlobalObject(ctx),ui=JS_NewObject(ctx);
  JSValue existing=JS_GetPropertyStr(ctx,global,"ui");int occupied=!JS_IsUndefined(existing);JS_FreeValue(ctx,existing);
  if(occupied) {JS_ThrowTypeError(ctx,"ui is already mounted");goto failed;}
  if(env->pak_length) {existing=JS_GetPropertyStr(ctx,global,"__pak");occupied=!JS_IsUndefined(existing);JS_FreeValue(ctx,existing);if(occupied){JS_ThrowTypeError(ctx,"__pak is already mounted");goto failed;}}
  existing=JS_GetPropertyStr(ctx,global,"console");
  if(JS_IsUndefined(existing)) {JSValue console=JS_NewObject(ctx);const char *names[]={"log","info","warn","error","debug"};for(size_t i=0;i<5;i++)if(set(ctx,console,names[i],JS_NewCFunction(ctx,console_log,names[i],1))<0){JS_FreeValue(ctx,console);JS_FreeValue(ctx,existing);goto failed;}if(set(ctx,global,"console",console)<0){JS_FreeValue(ctx,existing);goto failed;}}JS_FreeValue(ctx,existing);
  guest->runtime=runtime;guest->token=JS_NewArrayBufferCopy(ctx,(const uint8_t*)&guest,sizeof guest);
  if(JS_IsException(guest->token))goto failed;
  for(size_t i=0;i<POCKET_UI_OP_COUNT;i++) {
    const pocket_ui_op_descriptor *op=&pocket_ui_ops[i];
    if((guest->profile==POCKET_QJS_IDF&&!op->idf)||(guest->profile==POCKET_QJS_LEGACY_C&&!op->legacy_c&&!(op->op>=30&&op->op<=32)&&!(op->op>=52&&op->op<=56))||!pocket_runtime_supports_op(runtime,op->op))continue;
    JSValue function=JS_NewCFunctionData(ctx,invoke,op->argc,(int)i,1,&guest->token);
    if(JS_IsException(function))goto failed;if(JS_DefinePropertyValueStr(ctx,function,"name",JS_NewString(ctx,op->name),JS_PROP_CONFIGURABLE)<0){JS_FreeValue(ctx,function);goto failed;}if(set(ctx,ui,op->name,function)<0)goto failed;
  }
  if(set(ctx,ui,"__host",JS_NewStringLen(ctx,(const char*)env->host,env->host_length))<0||set(ctx,ui,"__hostAbi",JS_NewUint32(ctx,env->host_abi))<0||set(ctx,ui,"__viewport",viewport(ctx,env->viewport_width,env->viewport_height))<0)goto failed;
  if(guest->profile!=POCKET_QJS_LEGACY_C&&set(ctx,ui,"__tickHz",JS_NewUint32(ctx,env->tick_hz))<0)goto failed;
  if(HAS_FIELD(env,pocket_guest_environment,assets_present)&&env->assets_present) {
    JSValue textures=JS_NewObjectProto(ctx,JS_NULL),sprites=JS_NewObjectProto(ctx,JS_NULL);
    const pocket_named_texture *texture=env->textures;const pocket_named_sprite *sprite_entry=env->sprites;
    if((env->texture_count&&!texture)||(env->sprite_count&&!sprite_entry)){JS_ThrowTypeError(ctx,"missing asset records");JS_FreeValue(ctx,textures);JS_FreeValue(ctx,sprites);goto failed;}
    for(size_t i=0;i<env->texture_count;i++) {const pocket_named_texture *item=texture;if(!HAS_FIELD(item,pocket_named_texture,handle)||item->struct_size%_Alignof(pocket_named_texture)){JS_ThrowTypeError(ctx,"short texture record");JS_FreeValue(ctx,textures);JS_FreeValue(ctx,sprites);goto failed;}texture=NEXT_RECORD(item,pocket_named_texture);JSAtom key=JS_NewAtomLen(ctx,(const char*)item->name,item->name_length);int ok=JS_DefinePropertyValue(ctx,textures,key,JS_NewInt32(ctx,item->handle),JS_PROP_C_W_E);JS_FreeAtom(ctx,key);if(ok<0){JS_FreeValue(ctx,textures);JS_FreeValue(ctx,sprites);goto failed;}}
    for(size_t i=0;i<env->sprite_count;i++) {const pocket_named_sprite *item=sprite_entry;if(!HAS_FIELD(item,pocket_named_sprite,step)||item->struct_size%_Alignof(pocket_named_sprite)){JS_ThrowTypeError(ctx,"short sprite record");JS_FreeValue(ctx,textures);JS_FreeValue(ctx,sprites);goto failed;}sprite_entry=NEXT_RECORD(item,pocket_named_sprite);JSValue sprite=JS_NewObject(ctx);if(set(ctx,sprite,"handle",JS_NewInt32(ctx,item->handle))<0||set(ctx,sprite,"frames",JS_NewUint32(ctx,item->frames))<0||set(ctx,sprite,"cols",JS_NewUint32(ctx,item->columns))<0||set(ctx,sprite,"step",JS_NewUint32(ctx,item->step))<0){JS_FreeValue(ctx,sprite);JS_FreeValue(ctx,textures);JS_FreeValue(ctx,sprites);goto failed;}JSAtom key=JS_NewAtomLen(ctx,(const char*)item->name,item->name_length);int ok=JS_DefinePropertyValue(ctx,sprites,key,sprite,JS_PROP_C_W_E);JS_FreeAtom(ctx,key);if(ok<0){JS_FreeValue(ctx,textures);JS_FreeValue(ctx,sprites);goto failed;}}
    if(set(ctx,ui,"__textures",textures)<0){JS_FreeValue(ctx,sprites);goto failed;}if(set(ctx,ui,"__sprites",sprites)<0||set(ctx,ui,"__surfaces",JS_NewObject(ctx))<0)goto failed;
  }
  if(env->auxiliary_width&&env->auxiliary_height) {JSValue auxiliary=viewport(ctx,env->auxiliary_width,env->auxiliary_height);if(set(ctx,auxiliary,"root",JS_NewInt32(ctx,env->auxiliary_root))<0){JS_FreeValue(ctx,auxiliary);goto failed;}if(set(ctx,ui,"__auxiliarySurface",auxiliary)<0)goto failed;}
  if(env->pak_length) {JSValue pak=package_buffer(ctx,guest,env);if(JS_IsException(pak))goto failed;guest->pak=JS_DupValue(ctx,pak);if(set(ctx,global,"__pak",pak)<0)goto failed;guest->mounted_pak=1;}
  if(guest->profile==POCKET_QJS_LEGACY_C&&set(ctx,global,"__simHz",JS_NewInt32(ctx,60))<0)goto failed;
  if(set(ctx,global,"ui",ui)<0){ui=JS_UNDEFINED;goto failed;}ui=JS_UNDEFINED;guest->mounted=1;JS_FreeValue(ctx,global);return 0;
failed:
  JS_FreeValue(ctx,ui);JS_FreeValue(ctx,global);int32_t status=fail(guest);shutdown(guest);return status;
}
static int32_t collect(void *opaque) {pocket_guest_quickjs *guest=opaque;if(!guest||!guest->context)return -1;JSContext *ctx=NULL;int status;while((status=JS_ExecutePendingJob(JS_GetRuntime(guest->context),&ctx))>0){}return status<0?fail(guest):0;}
static int32_t evaluate(void *opaque,pocket_runtime *runtime,const uint8_t *code,size_t length) {
  pocket_guest_quickjs *guest=opaque;if(!guest||!guest->context||guest->runtime!=runtime||(!code&&length)||length==SIZE_MAX)return -1;
  char *source=malloc(length+1);if(!source)return -1;memcpy(source,code,length);source[length]=0;
  JSValue result=JS_Eval(guest->context,source,length,"pocket:guest",JS_EVAL_TYPE_GLOBAL);free(source);int failed=JS_IsException(result);JS_FreeValue(guest->context,result);return failed?fail(guest):collect(guest);
}
static JSValue motion_value(JSContext *ctx,const pocket_motion_state *motion) {
  if(!motion)return JS_NULL;
  if(!HAS_FIELD(motion,pocket_motion_state,angles))return JS_ThrowTypeError(ctx,"short motion record");
  JSValue object=JS_NewObject(ctx);if(set(ctx,object,"timestamp",JS_NewFloat64(ctx,(double)motion->timestamp))<0)goto failed;
#define VECTOR(field,name,count) if(motion->field){const pocket_motion_##field *v=motion->field;if(v->struct_size<sizeof *v){JS_ThrowTypeError(ctx,"short motion estimate");goto failed;}JSValue estimate=JS_NewObject(ctx),values=JS_NewArray(ctx);for(unsigned i=0;i<count;i++)if(JS_DefinePropertyValueUint32(ctx,values,i,JS_NewFloat64(ctx,v->value[i]),JS_PROP_C_W_E)<0){JS_FreeValue(ctx,values);JS_FreeValue(ctx,estimate);goto failed;}if(set(ctx,estimate,"value",values)<0||set(ctx,estimate,"quality",JS_NewUint32(ctx,v->quality))<0){JS_FreeValue(ctx,estimate);goto failed;}
#define SCALAR(field,name) if(motion->field){const pocket_motion_##field *v=motion->field;if(v->struct_size<sizeof *v){JS_ThrowTypeError(ctx,"short motion estimate");goto failed;}JSValue estimate=JS_NewObject(ctx);if(set(ctx,estimate,"value",JS_NewFloat64(ctx,v->value[0]))<0||set(ctx,estimate,"quality",JS_NewUint32(ctx,v->quality))<0){JS_FreeValue(ctx,estimate);goto failed;}
#define REF if(set(ctx,estimate,"referenceFrame",JS_NewUint32(ctx,v->reference_frame))<0){JS_FreeValue(ctx,estimate);goto failed;}
#define EPOCH if(set(ctx,estimate,"epoch",JS_NewUint32(ctx,v->epoch))<0){JS_FreeValue(ctx,estimate);goto failed;}
#define END(name) if(set(ctx,object,name,estimate)<0)goto failed;}
  VECTOR(gravity_direction,"gravityDirection",3) END("gravityDirection")
  SCALAR(inclination,"inclination") END("inclination")
  VECTOR(linear_acceleration,"linearAcceleration",3) END("linearAcceleration")
  VECTOR(rotation_rate,"rotationRate",3) END("rotationRate")
  VECTOR(orientation,"orientation",4) REF EPOCH END("orientation")
  SCALAR(heading,"heading") REF if(set(ctx,estimate,"accuracy",JS_NewFloat64(ctx,v->value[1]))<0){JS_FreeValue(ctx,estimate);goto failed;} END("heading")
  SCALAR(screen_rotation,"screenRotation") END("screenRotation")
  VECTOR(tilt,"tilt",2) END("tilt")
  VECTOR(angles,"angles",3) REF EPOCH END("angles")
#undef VECTOR
#undef SCALAR
#undef REF
#undef EPOCH
#undef END
  return object;
failed:JS_FreeValue(ctx,object);return JS_EXCEPTION;
}
static int32_t frame(void *opaque,const pocket_guest_frame *input) {
  pocket_guest_quickjs *guest=opaque;if(!guest||!guest->context||!input||!HAS_FIELD(input,pocket_guest_frame,motion))return -1;JSContext *ctx=guest->context;
  JSValue global=JS_GetGlobalObject(ctx),function=JS_GetPropertyStr(ctx,global,"frame");JS_FreeValue(ctx,global);
  if(JS_IsUndefined(function)){JS_FreeValue(ctx,function);return collect(guest);}
  JSValue argv[8]={JS_NewUint32(ctx,input->buttons),JS_NewUint32(ctx,input->analog),JS_NewArray(ctx),JS_NewArray(ctx),JS_NewArray(ctx),JS_NewUint32(ctx,input->right_analog),JS_NewArray(ctx),motion_value(ctx,input->motion)};
  int status=-1;
  for(unsigned i=0;i<8;i++)if(JS_IsException(argv[i]))goto done;
  if((input->axis_delta_count&&!input->axis_deltas)||(input->touch_count&&(!input->touches||!input->hits||!input->touch_surfaces))){JS_ThrowTypeError(ctx,"missing frame arrays");goto done;}
  for(size_t i=0;i<input->touch_count;i++) {if(JS_DefinePropertyValueUint32(ctx,argv[2],(uint32_t)i,JS_NewUint32(ctx,input->touches[i]),JS_PROP_C_W_E)<0||JS_DefinePropertyValueUint32(ctx,argv[3],(uint32_t)i,JS_NewInt32(ctx,input->hits[i]),JS_PROP_C_W_E)<0||JS_DefinePropertyValueUint32(ctx,argv[4],(uint32_t)i,JS_NewUint32(ctx,input->touch_surfaces[i]),JS_PROP_C_W_E)<0)goto done;}
  const pocket_axis_delta *delta=input->axis_deltas;
  for(size_t i=0;i<input->axis_delta_count;i++) {if(!HAS_FIELD(delta,pocket_axis_delta,delta)||delta->struct_size%_Alignof(pocket_axis_delta)){JS_ThrowTypeError(ctx,"short axis delta record");goto done;}JSValue pair=JS_NewObject(ctx);if(set(ctx,pair,"axis",JS_NewUint32(ctx,delta->axis))<0||set(ctx,pair,"delta",JS_NewInt32(ctx,delta->delta))<0){JS_FreeValue(ctx,pair);goto done;}if(JS_DefinePropertyValueUint32(ctx,argv[6],(uint32_t)i,pair,JS_PROP_C_W_E)<0)goto done;delta=NEXT_RECORD(delta,pocket_axis_delta);}
  JSValue result=JS_Call(ctx,function,JS_UNDEFINED,8,argv);status=JS_IsException(result)?-1:0;JS_FreeValue(ctx,result);
done:for(unsigned i=0;i<8;i++)JS_FreeValue(ctx,argv[i]);JS_FreeValue(ctx,function);return status<0?fail(guest):collect(guest);
}
static void shutdown(void *opaque) {
  pocket_guest_quickjs *guest=opaque;if(!guest)return;
  if(guest->context) {
    if(!JS_IsUndefined(guest->pak)){JS_DetachArrayBuffer(guest->context,guest->pak);JS_FreeValue(guest->context,guest->pak);guest->pak=JS_UNDEFINED;}
    if(!JS_IsUndefined(guest->token)&&!JS_IsException(guest->token)) {size_t length=0;uint8_t *token=JS_GetArrayBuffer(guest->context,&length,guest->token);if(token)memset(token,0,length);JS_FreeValue(guest->context,guest->token);guest->token=JS_UNDEFINED;}
    if(guest->attached) {JSValue global=JS_GetGlobalObject(guest->context);if(guest->mounted){JSAtom key=JS_NewAtom(guest->context,"ui");JS_DeleteProperty(guest->context,global,key,0);JS_FreeAtom(guest->context,key);}if(guest->mounted_pak){JSAtom key=JS_NewAtom(guest->context,"__pak");JS_DeleteProperty(guest->context,global,key,0);JS_FreeAtom(guest->context,key);}JS_FreeValue(guest->context,global);}
    else {JS_FreeContext(guest->context);guest->context=NULL;JS_FreeRuntime(guest->engine);guest->engine=NULL;}
  }
  guest->runtime=NULL;guest->mounted=guest->mounted_pak=0;
}
static const pocket_guest_v1 vtable={sizeof(pocket_guest_v1),evaluate,frame,collect,shutdown,initialize};
pocket_guest_quickjs *pocket_guest_quickjs_create(pocket_qjs_profile profile) {if(profile<POCKET_QJS_CANONICAL||profile>POCKET_QJS_IDF)return NULL;pocket_guest_quickjs *guest=calloc(1,sizeof *guest);if(guest){guest->profile=profile;guest->token=guest->pak=JS_UNDEFINED;}return guest;}
pocket_guest_quickjs *pocket_guest_quickjs_attach(JSContext *ctx,pocket_qjs_profile profile) {if(!ctx)return NULL;pocket_guest_quickjs *guest=pocket_guest_quickjs_create(profile);if(guest){guest->context=ctx;guest->engine=JS_GetRuntime(ctx);guest->attached=1;}return guest;}
const pocket_guest_v1 *pocket_guest_quickjs_vtable(void){return &vtable;}
const char *pocket_guest_quickjs_error(const pocket_guest_quickjs *guest){return guest?guest->error:"invalid guest";}
JSContext *pocket_guest_quickjs_context(pocket_guest_quickjs *guest){return guest?guest->context:NULL;}
void pocket_guest_quickjs_destroy(pocket_guest_quickjs *guest){if(guest){shutdown(guest);free(guest);}}
