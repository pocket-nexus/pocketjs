#include "pocket/input_touch.h"
#include "pocket/input_gpio.h"
#include <assert.h>
#include <stdio.h>
static int touch_error,adc_error,pressed,level,raw; static int64_t now;
static pocket_input_frame last; static pocket_contact contact; static pocket_cancelled_contact cancelled; static int append_error;
esp_err_t esp_lcd_touch_read_data(esp_lcd_touch_handle_t h){assert(h);return touch_error;}
bool esp_lcd_touch_get_coordinates(esp_lcd_touch_handle_t h,uint16_t*x,uint16_t*y,uint16_t*s,uint8_t*n,uint8_t max){(void)h;(void)s;assert(max==1);*x=20;*y=40;*n=pressed?1:0;return pressed;}
int gpio_get_level(gpio_num_t pin){assert(pin==2);return level;}
esp_err_t adc_oneshot_read(adc_oneshot_unit_handle_t u,adc_channel_t c,int*v){assert(u && c==1);*v=raw;return adc_error;}
int64_t esp_timer_get_time(void){return now;}
static int32_t append(void*c,const pocket_input_frame*f){(void)c;last=*f;if(f->contact_count)contact=f->contacts[0];if(f->cancelled_count)cancelled=f->cancelled[0];return append_error;}
int main(void){
 pocket_input_frame_builder b={sizeof(b),NULL,append};
 pocket_input_touch_config tc={sizeof(tc),(void*)1,0,0.5f,0.25f};
 pocket_input_touch*t=pocket_input_touch_create(&tc);assert(t);
 const pocket_input_source_v1*tv=pocket_input_touch_vtable();assert(tv->classes(t)==POCKET_INPUT_CLASS_CONTACT);
 pressed=1;assert(tv->poll(t,&b)==0);assert(last.contact_count==1 && contact.x==10 && contact.y==10 && contact.id==0);
 touch_error=9;append_error=-1;assert(tv->poll(t,&b)==-1);assert(last.cancelled_count==1);
 append_error=0;assert(tv->poll(t,&b)==0);assert(last.cancelled_count==1 && cancelled.id==0);assert(pocket_input_touch_last_error(t)==9);
 assert(tv->poll(t,&b)==0 && last.cancelled_count==0);touch_error=0;pressed=0;assert(tv->poll(t,&b)==0 && last.contact_count==0);
 b.struct_size=0;assert(tv->poll(t,&b)==POCKET_STATUS_INVALID);b.struct_size=sizeof(b);
 pocket_input_touch_destroy(t);tc.scale_x=0;assert(!pocket_input_touch_create(&tc));
 pocket_gpio_button g={2,1,true};pocket_adc_button a={(void*)1,1,100,200,2};
 pocket_input_gpio_config gc={sizeof(gc),&g,1,&a,1,100};pocket_input_gpio*d=pocket_input_gpio_create(&gc);assert(d);
 const pocket_input_source_v1*gv=pocket_input_gpio_vtable();assert(gv->classes(d)==POCKET_INPUT_CLASS_BUTTONS);
 level=0;raw=150;now=0;assert(gv->poll(d,&b)==0 && last.buttons==0);now=99;assert(gv->poll(d,&b)==0 && last.buttons==0);
 now=100;assert(gv->poll(d,&b)==0 && last.buttons==3);level=1;adc_error=7;now=101;assert(gv->poll(d,&b)==0 && last.buttons==3);
 now=201;assert(gv->poll(d,&b)==0 && last.buttons==0);assert(pocket_input_gpio_last_error(d)==7);
 pocket_input_gpio_destroy(d);gc.gpio_count=33;assert(!pocket_input_gpio_create(&gc));puts("IDF input contracts passed");
}
