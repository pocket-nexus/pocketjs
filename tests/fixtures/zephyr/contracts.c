#include "pocket/zephyr.h"
#include <zephyr/drivers/display.h>
#include <zephyr/input/input.h>
#include <zephyr/dt-bindings/input/input-event-codes.h>
#include <zephyr/kernel.h>
#include <assert.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#ifdef CONFIG_POCKETJS_GUEST_QUICKJS
#include "pocket_guest_quickjs.h"
#include "pocket_profile.h"
#endif
static uint8_t panel[8*6*4];
static unsigned writes;
static bool fail_write;
static uint32_t screen_info;
static uint32_t pixel_format=PIXEL_FORMAT_RGB_565;
static void get_caps(const struct device *d, struct display_capabilities *c) {
  (void)d; memset(c,0,sizeof(*c)); c->x_resolution=8; c->y_resolution=6; c->current_pixel_format=pixel_format; c->screen_info=screen_info;
}
static int write_pixels(const struct device *d,uint16_t x,uint16_t y,const struct display_buffer_descriptor *desc,const void *pixels) {
  (void)d; assert(x==0 && desc->width==8 && desc->pitch==8 && desc->height<=6-y);
  size_t stride=8*(pixel_format==PIXEL_FORMAT_RGB_565?2:4); assert(desc->buf_size==stride*desc->height);
  assert(!desc->frame_incomplete);
  writes++; if(fail_write) return -1;
  memcpy(panel+y*stride,pixels,desc->buf_size); return 0;
}
#ifdef POCKET_ZEPHYR_NATIVE
static DEVICE_API(display, display_api)={.write=write_pixels,.get_capabilities=get_caps};
DEVICE_DT_DEFINE(DT_NODELABEL(pocket_test_display),NULL,NULL,NULL,NULL,POST_KERNEL,80,&display_api);
#define DISPLAY_DEVICE DEVICE_DT_GET(DT_NODELABEL(pocket_test_display))
#define INPUT_DEVICE DISPLAY_DEVICE
static void report(uint8_t type,uint16_t code,int32_t value,bool sync) { assert(input_report(INPUT_DEVICE,type,code,value,sync,K_NO_WAIT)==0); }
#else
static struct device display_device={1}, other_device={1};
#define DISPLAY_DEVICE (&display_device)
#define INPUT_DEVICE DISPLAY_DEVICE
void display_get_capabilities(const struct device *d,struct display_capabilities *c) { get_caps(d,c); }
int display_write(const struct device *d,uint16_t x,uint16_t y,const struct display_buffer_descriptor *b,const void *p) { return write_pixels(d,x,y,b,p); }
void *pocket_host_alloc(size_t size,size_t align) { (void)align; return calloc(1,size); }
void pocket_host_free(void *p,size_t size,size_t align) { (void)size;(void)align;free(p); }
static void report(uint8_t type,uint16_t code,int32_t value,bool sync) {
  struct input_event e={INPUT_DEVICE,sync,type,code,value}; fixture_input_event(&e);
}
#endif
static int32_t fail_append;
static uint32_t buttons; static size_t contacts,cancels; static float x,y;
static int32_t append(void *ctx,const pocket_input_frame *f) {
  (void)ctx; buttons=f->buttons; contacts=f->contact_count; cancels=f->cancelled_count;
  if(contacts) { assert(f->contacts[0].id==0 && f->contacts[0].surface==1); x=f->contacts[0].x; y=f->contacts[0].y; }
  return fail_append;
}
static void test_input(void) {
  pocket_zephyr_key keys[]={{INPUT_KEY_ENTER,POCKET_BTN_CROSS}};
  pocket_zephyr_input_config config={sizeof(config),INPUT_DEVICE,keys,1,true,1,0.5f,2.0f};
  pocket_zephyr_input *d=pocket_zephyr_input_create(&config); assert(d);
  const pocket_input_source_v1 *v=pocket_zephyr_input_vtable();
  pocket_input_frame_builder b={sizeof(b),NULL,append};
  assert(v->classes(d)==(POCKET_INPUT_CLASS_BUTTONS|POCKET_INPUT_CLASS_CONTACT));
  report(INPUT_EV_ABS,INPUT_ABS_X,6,false); report(INPUT_EV_ABS,INPUT_ABS_Y,2,false);
  report(INPUT_EV_KEY,INPUT_BTN_TOUCH,1,false); report(INPUT_EV_KEY,INPUT_KEY_ENTER,1,false);
  assert(v->poll(d,&b)==0 && !contacts && !buttons);
  report(INPUT_EV_KEY,INPUT_KEY_ENTER,1,true);
  assert(v->poll(d,&b)==0 && contacts==1 && buttons==POCKET_BTN_CROSS && x==3 && y==4);
  pocket_zephyr_input_cancel(d); fail_append=POCKET_STATUS_FAILED;
  assert(v->poll(d,&b)==POCKET_STATUS_FAILED && cancels==1 && !contacts && !buttons);
  fail_append=0; assert(v->poll(d,&b)==0 && cancels==1); assert(v->poll(d,&b)==0 && !cancels);
  report(INPUT_EV_KEY,INPUT_BTN_TOUCH,1,true); assert(v->poll(d,&b)==0 && contacts==1);
  report(INPUT_EV_KEY,INPUT_BTN_TOUCH,0,true); assert(v->poll(d,&b)==0 && !contacts && !cancels);
#ifndef POCKET_ZEPHYR_NATIVE
  struct input_event other={&other_device,1,INPUT_EV_KEY,INPUT_KEY_ENTER,1};fixture_input_event(&other);
  assert(v->poll(d,&b)==0 && !buttons);
#endif
  pocket_zephyr_input_destroy(d); report(INPUT_EV_KEY,INPUT_KEY_ENTER,1,true);
  config.key_count=33; assert(!pocket_zephyr_input_create(&config));
}
static void paint(pocket_surface *s,uint32_t color) {
#ifdef POCKET_ZEPHYR_NATIVE
  const uint32_t words[]={POCKET_DRAW_OP_RECT,0,(6u<<16)|8u,color};
  pocket_logical_clip clip={sizeof(clip),0,0,8,6};
  pocket_draw_op op={sizeof(op),words,4,&clip,1};
  pocket_render_resources resources={.struct_size=sizeof(resources),.viewport_width=8,.viewport_height=6};
  assert(pocket_raster_draw_op(s,&op,&resources)==POCKET_STATUS_OK);
#else
  for(size_t i=0;i<s->byte_length;i++) s->pixels[i]=(uint8_t)color;
#endif
}
static void test_display(void) {
  const pocket_display_output_v1 *v=pocket_zephyr_display_vtable();
  for(unsigned format=0;format<2;format++) {
    pixel_format=format?PIXEL_FORMAT_ARGB_8888:PIXEL_FORMAT_RGB_565;
    unsigned bpp=format?4:2;
    pocket_zephyr_display_config c={sizeof(c),DISPLAY_DEVICE,0,2,8*2*bpp};
    pocket_zephyr_display *d=pocket_zephyr_display_create(&c); assert(d);
    assert(pocket_zephyr_display_buffer_bytes(d)==8*2*bpp);
    pocket_display_descriptor desc={.struct_size=sizeof(desc)}; assert(v->descriptor(d,&desc)==0 && desc.stride_bytes==8*bpp);
    pocket_buffer_identity id={.struct_size=sizeof(id)};assert(v->frame_identity(d,&id)==0 && id.generation==1);
    for(uint32_t row=0;row<6;row+=2) {
      pocket_rect r={sizeof(r),0,row,8,2}; pocket_target target={.struct_size=sizeof(target)}; uint64_t token=0;
      assert(v->acquire(d,&r,&target)==0); assert(target.surface->byte_length==8*2*bpp);
      paint(target.surface,0xff0000ffu); assert(v->flush(d,&r,1,&token)==0);
      assert(v->acquire(d,&r,&target)==POCKET_STATUS_FAILED); assert(v->wait(d,token+1)==POCKET_STATUS_INVALID);
      assert(v->wait(d,token)==0); assert(v->wait(d,token)==POCKET_STATUS_INVALID);
    }
#ifdef POCKET_ZEPHYR_NATIVE
    for(size_t i=0;i<8*6;i++) { if(format) { assert(panel[i*4]==255 && panel[i*4+1]==255 && panel[i*4+2]==0 && panel[i*4+3]==0); }
      else { assert(panel[i*2]==0xf8 && panel[i*2+1]==0); } }
#endif
    pocket_rect r={sizeof(r),0,0,8,2};pocket_target target={.struct_size=sizeof(target)};uint64_t token=0;
    assert(v->acquire(d,&r,&target)==0); pocket_rect bad=r;bad.y=6;unsigned before=writes;
    assert(v->flush(d,&bad,1,&token)==POCKET_STATUS_INVALID && writes==before);
    fail_write=true; assert(v->flush(d,&r,1,&token)==POCKET_STATUS_FAILED);fail_write=false;
    assert(v->frame_identity(d,&id)==0 && id.generation==2);
    assert(v->acquire(d,&r,&target)==0 && v->flush(d,&r,1,&token)==0 && v->wait(d,token)==0);
    pocket_zephyr_display_destroy(d); c.frame_buffer_budget--;assert(!pocket_zephyr_display_create(&c));
  }
  screen_info=SCREEN_INFO_DOUBLE_BUFFER;pixel_format=PIXEL_FORMAT_RGB_565;
  pocket_zephyr_display_config double_config={sizeof(double_config),DISPLAY_DEVICE,0,2,96};
  assert(!pocket_zephyr_display_create(&double_config));double_config.strip_rows=6;
  pocket_zephyr_display *double_display=pocket_zephyr_display_create(&double_config);assert(double_display);
  pocket_rect full={sizeof(full),0,0,8,6},partial={sizeof(partial),0,0,8,2};
  pocket_target double_target={.struct_size=sizeof(double_target)};uint64_t double_token=0;
  assert(v->acquire(double_display,&partial,&double_target)==POCKET_STATUS_INVALID);
  assert(v->acquire(double_display,&full,&double_target)==0);
  assert(v->flush(double_display,&partial,1,&double_token)==POCKET_STATUS_INVALID);
  assert(v->flush(double_display,&full,1,&double_token)==0 && v->wait(double_display,double_token)==0);
  pocket_zephyr_display_destroy(double_display);screen_info=0;
  pixel_format=0; pocket_zephyr_display_config c={sizeof(c),DISPLAY_DEVICE,0,1,64};assert(!pocket_zephyr_display_create(&c));
}
int main(void) {
  test_input();test_display();
#ifdef CONFIG_POCKETJS_GUEST_QUICKJS
  pocket_guest_quickjs *guest=pocket_guest_quickjs_create(POCKET_QJS_CANONICAL);assert(guest);
  pocket_runtime_config config={.struct_size=sizeof(config),.host_abi=POCKET_BINDING_GENERATION,.tick_hz=30,.heap_limit=262144,.frame_buffer_budget=128,.profile_json=pocket_profile.profile_json,.profile_json_length=pocket_profile.profile_json_length};
  memcpy(config.profile_hash,pocket_profile.profile_hash,32);
  pocket_runtime *runtime=pocket_runtime_create(&config);assert(runtime);
  const pocket_guest_v1 *v=pocket_guest_quickjs_vtable();
  pocket_guest_environment environment={.struct_size=sizeof(environment),.host="zephyr-contract",.host_length=15,.host_abi=POCKET_BINDING_GENERATION,.tick_hz=30,.viewport_width=8,.viewport_height=6,.raster_density=1,.heap_limit=262144};
  /* This guest exercises pure script evaluation; the full runtime bindings are
   * covered by the SDK consumer. No ui operation is issued without a runtime. */
  assert(v->initialize(guest,runtime,&environment)==POCKET_STATUS_OK);
  static const uint8_t source[]="globalThis.__frame = () => {}; globalThis.fixtureResult = 6 * 7;";
  assert(v->evaluate(guest,runtime,source,sizeof(source))==POCKET_STATUS_OK);
  JSContext *js=pocket_guest_quickjs_context(guest);JSValue global=JS_GetGlobalObject(js);JSValue result=JS_GetPropertyStr(js,global,"fixtureResult");int32_t number=0;
  assert(JS_ToInt32(js,&number,result)==0 && number==42);JS_FreeValue(js,result);JS_FreeValue(js,global);
  pocket_guest_quickjs_destroy(guest);pocket_runtime_destroy(runtime);
#endif
#ifdef POCKET_ZEPHYR_NATIVE
  void *p=pocket_host_alloc(32,64);assert(p && !((uintptr_t)p%64));memset(p,123,32);
  assert(!pocket_host_realloc(p,32,64,SIZE_MAX));assert(((uint8_t *)p)[0]==123);
  void *q=pocket_host_realloc(p,32,64,64);assert(q && ((uint8_t *)q)[31]==123);pocket_host_free(q,64,64);
  const pocket_clock_v1 *clock=pocket_zephyr_clock();uint64_t start=clock->now(NULL);clock->sleep_until(NULL,start+1000);assert(clock->now(NULL)>=start+1000);
#endif
  puts("Zephyr driver contracts passed");
#ifdef POCKET_ZEPHYR_NATIVE
  extern void nsi_exit(int status); nsi_exit(0);
#endif
  return 0;
}
