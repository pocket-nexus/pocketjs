/* Real generated guest + canonical no_std program; only the GL device is mocked. */
#include "pocket_native_program.h"
#include "pocket_guest_quickjs.h"
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static unsigned gl_calls, finishes, draws, buffers, textures, sequence, shutdowns;
static int pending, viewport[4];
static float logical[2];
static uint32_t stages;
static PocketNativeProgram *program;
static pocket_guest_quickjs *guest;
static JSContext *context;
static void eval(const char *code) {
  JSValue value = JS_Eval(context, code, strlen(code), "assert.js", JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(value)) {
    JSValue exception = JS_GetException(context);
    const char *text = JS_ToCString(context, exception);
    fprintf(stderr, "%s\n", text ? text : "JS exception");
    JS_FreeCString(context, text); JS_FreeValue(context, exception);
    assert(0);
  }
  JS_FreeValue(context, value);
}
static int32_t initialize(void *opaque, pocket_runtime *runtime, const pocket_guest_environment *env) {
  (void)opaque;
  assert(env->viewport_width == 360 && env->viewport_height == 640);
  assert(env->host_abi == POCKET_BINDING_GENERATION);
  return pocket_guest_quickjs_vtable()->initialize(guest, runtime, env);
}
static int32_t evaluate(void *opaque, pocket_runtime *runtime, const uint8_t *source, size_t length) {
  (void)opaque; return pocket_guest_quickjs_vtable()->evaluate(guest, runtime, source, length);
}
static int32_t frame(void *opaque, const pocket_guest_frame *input) {
  (void)opaque; return pocket_guest_quickjs_vtable()->frame(guest, input);
}
static int32_t collect(void *opaque) {
  (void)opaque;
  /* Exercises ui callbacks while Runtime owns its guest borrow. */
  eval("ui.setProp(n, 64, 0xff00ff00); globalThis.collected = true");
  return pocket_guest_quickjs_vtable()->collect(guest);
}
static void shutdown(void *opaque) {
  (void)opaque; ++shutdowns;
  pocket_native_program_destroy(program); /* recursive program shutdown is rejected */
  pocket_guest_quickjs_vtable()->shutdown(guest);
}
static void trace(uint32_t stage, uint32_t commands, uint32_t vertices) {
  (void)commands; (void)vertices; stages |= 1u << stage;
}
int main(void) {
  static const char source_template[] =
    "if(ui.__host !== 'native-program-fixture' || ui.__hostAbi !== %u) throw Error('metadata');"
    "if(ui.svcOpen !== undefined || ui.appTable !== undefined || ui.__textures !== undefined) throw Error('namespace');"
    "var n = ui.createNode(0); ui.setProp(n,1,80); ui.setProp(n,2,40); ui.setProp(n,64,0xff0000ff); ui.insertBefore(1,n,-1);"
    "globalThis.retained = ui.createNode;"
    "globalThis.frame = function(buttons, analog, touches, hits, surfaces) {"
    "if(buttons!==17 || analog!==0x8080 || touches.length!==1 || hits.length!==1 || surfaces[0]!==0) throw Error('input');"
    "if((touches[0]>>>0)!==((0x80000000|(7<<20)|(200<<10)|600)>>>0)) throw Error('coordinate');"
    "};";
  char source[2048];
  int source_length = snprintf(source, sizeof source, source_template, (unsigned)POCKET_BINDING_GENERATION);
  assert(source_length > 0 && (size_t)source_length < sizeof source);
  assert(!pocket_native_program_create_package("native-program-fixture", POCKET_BINDING_GENERATION - 1, fixture_package, sizeof fixture_package,
    "fixture", "dev.fixture", "Fixture", 360, 640, 1, 0,
    (const uint8_t *)POCKETJS_HOST_PROFILE_JSON, sizeof POCKETJS_HOST_PROFILE_JSON - 1, POCKETJS_HOST_PROFILE_HASH));
  program = pocket_native_program_create_package("native-program-fixture", POCKET_BINDING_GENERATION, fixture_package, sizeof fixture_package,
    "fixture", "dev.fixture", "Fixture", 360, 640, 1, 0,
    (const uint8_t *)POCKETJS_HOST_PROFILE_JSON, sizeof POCKETJS_HOST_PROFILE_JSON - 1, POCKETJS_HOST_PROFILE_HASH);
  assert(program); pocket_native_program_destroy(program); program = NULL;
  program = pocket_native_program_create_profile("native-program-fixture", POCKET_BINDING_GENERATION, (const uint8_t *)source,
    (size_t)source_length, NULL, 0, 360, 640, 1, 0,
    (const uint8_t *)POCKETJS_HOST_PROFILE_JSON, sizeof POCKETJS_HOST_PROFILE_JSON - 1, POCKETJS_HOST_PROFILE_HASH);
  assert(program);
  JSRuntime *engine = JS_NewRuntime(); assert(engine);
  context = JS_NewContext(engine); assert(context);
  guest = pocket_guest_quickjs_attach(context, POCKET_QJS_LEGACY_C); assert(guest);
  const pocket_guest_v1 table = {sizeof table, evaluate, frame, collect, shutdown, initialize};
  assert(pocket_runtime_set_guest(pocket_native_program_runtime(program), &table, NULL) == 0);
  assert(pocket_native_program_boot(program) == 0);
  assert(gl_calls == 0); /* boot precedes QGLWidget context creation */
  pocket_native_program_set_gl_trace(program, trace);
  assert(pocket_native_program_gl_initialize(program) == 0);
  assert(pocket_native_program_gl_render_rect(program, 10, -20, 324, 576, 360, 640, 0) == 0);
  assert(viewport[0] == 10 && viewport[1] == 84 && viewport[2] == 324 && viewport[3] == 576);
  assert(logical[0] == 360 && logical[1] == 640 && finishes == 1 && draws > 0 && !pending);
  assert((stages & 63u) == 63u);
  assert(pocket_native_program_resize_viewport(program, 640, 360) == 0);
  assert(pocket_native_program_width(program) == 640 && pocket_native_program_height(program) == 360);
  assert(pocket_native_program_collect(program) == 0);
  eval("if(!collected) throw Error('collect')");
  pocket_contact contact = {sizeof contact, 0, 7, 600, 200, 0};
  pocket_input_frame input; memset(&input, 0, sizeof input);
  input.struct_size = sizeof input; input.buttons = 17; input.contacts = &contact; input.contact_count = 1;
  assert(pocket_native_program_advance(program, &input, 2) == 0);
  assert(pocket_native_program_gl_render_rect(program, 0, 0, 640, 332, 640, 360, 1) == 0);
  assert(logical[0] == 640 && logical[1] == 360 && finishes == 2 && !pending);
  assert(pocket_native_program_gl_render_rect(program, INT32_MAX, 0, 2, 2, 640, 360, 0) == POCKET_STATUS_INVALID);
  pocket_native_program_gl_shutdown(program);
  assert(buffers == 0 && textures == 0);
  assert(pocket_native_program_gl_initialize(program) == 0); /* native suspend/resume */
  assert(pocket_native_program_gl_render(program, 640, 360, 0) == 0);
  pocket_native_program_destroy(program); program = NULL;
  assert(shutdowns == 1 && buffers == 0 && textures == 0 && !pending);
  eval("var rejected=false; try {retained(0)} catch(e) {rejected=true} if(!rejected) throw Error('retained callback')");
  pocket_guest_quickjs_destroy(guest);
  JS_FreeContext(context); JS_FreeRuntime(engine);
  puts("native program GPU/collect/input/lifetime: ok");
}

/* Device mock records physical/logical viewports and enforces terminal-before-free. */
void glFinish(void) { ++gl_calls; ++finishes; pending = 0; }
void glBindBuffer(uint32_t a,uint32_t b) {(void)a;(void)b;}
void glBindTexture(uint32_t a,uint32_t b) {(void)a;(void)b;}
void glBufferData(uint32_t a,intptr_t b,const void*c,uint32_t d) {(void)a;(void)b;(void)c;(void)d;}
void glClear(uint32_t a) {(void)a;}
void glClearColor(float a,float b,float c,float d) {(void)a;(void)b;(void)c;(void)d;}
void glDeleteBuffers(int n,const uint32_t*p) {(void)p;assert(!pending);buffers-=n;}
void glDeleteTextures(int n,const uint32_t*p) {(void)p;assert(!pending);textures-=n;}
void glDisable(uint32_t a) {(void)a;}
void glEnable(uint32_t a) {(void)a;}
void glDrawArrays(uint32_t a,int b,int c) {(void)a;(void)b;assert(c>0);++draws;pending=1;}
void glGenBuffers(int n,uint32_t*p) {buffers+=n;while(n--)*p++=++sequence;}
void glGenTextures(int n,uint32_t*p) {textures+=n;while(n--)*p++=++sequence;}
uint32_t glGetError(void) {return 0;}
void glGetIntegerv(uint32_t a,int*p) {(void)a;++gl_calls;*p=2048;}
void glPixelStorei(uint32_t a,int b) {(void)a;(void)b;}
void glScissor(int a,int b,int c,int d) {(void)a;(void)b;(void)c;(void)d;}
void glTexImage2D(uint32_t a,int b,int c,int d,int e,int f,uint32_t g,uint32_t h,const void*i) {(void)a;(void)b;(void)c;(void)d;(void)e;(void)f;(void)g;(void)h;(void)i;}
void glTexParameteri(uint32_t a,uint32_t b,int c) {(void)a;(void)b;(void)c;}
void glViewport(int a,int b,int c,int d) {viewport[0]=a;viewport[1]=b;viewport[2]=c;viewport[3]=d;}
void glActiveTexture(uint32_t a) {(void)a;}
void glAttachShader(uint32_t a,uint32_t b) {(void)a;(void)b;}
void glBindAttribLocation(uint32_t a,uint32_t b,const char*c) {(void)a;(void)b;(void)c;}
void glBlendFuncSeparate(uint32_t a,uint32_t b,uint32_t c,uint32_t d) {(void)a;(void)b;(void)c;(void)d;}
void glCompileShader(uint32_t a) {(void)a;}
uint32_t glCreateProgram(void) {++gl_calls;return ++sequence;}
uint32_t glCreateShader(uint32_t a) {(void)a;++gl_calls;return ++sequence;}
void glDeleteProgram(uint32_t a) {(void)a;assert(!pending);}
void glDeleteShader(uint32_t a) {(void)a;}
void glDisableVertexAttribArray(uint32_t a) {(void)a;}
void glEnableVertexAttribArray(uint32_t a) {(void)a;}
void glGetProgramiv(uint32_t a,uint32_t b,int*c) {(void)a;(void)b;*c=1;}
void glGetShaderiv(uint32_t a,uint32_t b,int*c) {(void)a;(void)b;*c=1;}
int glGetUniformLocation(uint32_t a,const char*b) {(void)a;(void)b;return 0;}
void glLinkProgram(uint32_t a) {(void)a;}
void glShaderSource(uint32_t a,int b,const char**c,const int*d) {(void)a;(void)b;(void)c;(void)d;}
void glUniform1i(int a,int b) {(void)a;(void)b;}
void glUniform2f(int a,float b,float c) {(void)a;logical[0]=b;logical[1]=c;}
void glUseProgram(uint32_t a) {(void)a;}
void glVertexAttribPointer(uint32_t a,int b,uint32_t c,uint8_t d,int e,const void*f) {(void)a;(void)b;(void)c;(void)d;(void)e;(void)f;}
