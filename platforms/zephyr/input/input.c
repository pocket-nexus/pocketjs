#include "pocket/zephyr.h"
#include <zephyr/input/input.h>
#include <zephyr/dt-bindings/input/input-event-codes.h>
#include <zephyr/kernel.h>
#include <math.h>
#include <string.h>
struct snapshot { uint32_t buttons; int32_t x,y; bool touching; };
struct pocket_zephyr_input {
  struct pocket_zephyr_input *next;
  pocket_zephyr_input_config config;
  pocket_zephyr_key keys[32];
  bool held[32];
  struct snapshot pending, published;
  bool cancelled;
  uint64_t cancel_epoch;
};
static struct k_spinlock lock;
static pocket_zephyr_input *instances;
static void receive(struct input_event *event, void *context) {
  (void)context;
  k_spinlock_key_t key=k_spin_lock(&lock);
  for (pocket_zephyr_input *d=instances;d;d=d->next) {
    if (event->dev!=d->config.device) continue;
    if (event->type==INPUT_EV_KEY) {
      for (size_t i=0;i<d->config.key_count;i++) if(d->keys[i].code==event->code) d->held[i]=event->value!=0;
      d->pending.buttons=0;
      for(size_t i=0;i<d->config.key_count;i++) if(d->held[i]) d->pending.buttons|=d->keys[i].buttons;
      if(d->config.touch && event->code==INPUT_BTN_TOUCH) d->pending.touching=event->value!=0;
    } else if(d->config.touch && event->type==INPUT_EV_ABS) {
      if(event->code==INPUT_ABS_X) d->pending.x=event->value;
      if(event->code==INPUT_ABS_Y) d->pending.y=event->value;
    }
    if(event->sync) d->published=d->pending;
  }
  k_spin_unlock(&lock,key);
}
INPUT_CALLBACK_DEFINE(NULL, receive, NULL);
pocket_zephyr_input *pocket_zephyr_input_create(const pocket_zephyr_input_config *c) {
  if(!c || c->struct_size<sizeof(*c) || !c->device || !device_is_ready(c->device) ||
     c->key_count>32 || (c->key_count && !c->keys) || c->surface>1 ||
     (c->touch && (!isfinite(c->scale_x) || !isfinite(c->scale_y) || c->scale_x<=0 || c->scale_y<=0 || c->scale_x>65535 || c->scale_y>65535))) return NULL;
  for(size_t i=0;i<c->key_count;i++) if(!c->keys[i].buttons) return NULL;
  pocket_zephyr_input *d=pocket_host_alloc(sizeof(*d),_Alignof(pocket_zephyr_input));
  if(!d) return NULL;
  memset(d,0,sizeof(*d)); d->config=*c;
  if(c->key_count) memcpy(d->keys,c->keys,c->key_count*sizeof(*c->keys));
  d->config.keys=d->keys;
  k_spinlock_key_t key=k_spin_lock(&lock); d->next=instances; instances=d; k_spin_unlock(&lock,key);
  return d;
}
static uint32_t classes(void *context) {
  pocket_zephyr_input *d=context;
  return d? (d->config.key_count?POCKET_INPUT_CLASS_BUTTONS:0)|(d->config.touch?POCKET_INPUT_CLASS_CONTACT:0):0;
}
static int32_t poll(void *context, pocket_input_frame_builder *builder) {
  pocket_zephyr_input *d=context;
  if(!d || !builder || builder->struct_size<sizeof(*builder) || !builder->append) return POCKET_STATUS_INVALID;
  k_spinlock_key_t key=k_spin_lock(&lock);
  struct snapshot state=d->published; bool cancelled=d->cancelled; uint64_t epoch=d->cancel_epoch;
  k_spin_unlock(&lock,key);
  pocket_contact contact={.struct_size=sizeof(contact),.surface=d->config.surface,.id=0,
    .x=(float)state.x*d->config.scale_x,.y=(float)state.y*d->config.scale_y};
  pocket_cancelled_contact cancel={.struct_size=sizeof(cancel),.surface=d->config.surface,.id=0};
  pocket_input_frame frame={.struct_size=sizeof(frame),.buttons=state.buttons,
    .contacts=state.touching?&contact:NULL,.contact_count=state.touching?1:0,
    .cancelled=cancelled?&cancel:NULL,.cancelled_count=cancelled?1:0};
  int32_t result=builder->append(builder->context,&frame);
  if(result==POCKET_STATUS_OK && cancelled) {
    key=k_spin_lock(&lock); if(d->cancel_epoch==epoch) d->cancelled=false; k_spin_unlock(&lock,key);
  }
  return result;
}
static const pocket_input_source_v1 INPUT={.struct_size=sizeof(INPUT),.classes=classes,.poll=poll};
const pocket_input_source_v1 *pocket_zephyr_input_vtable(void) { return &INPUT; }
void pocket_zephyr_input_cancel(pocket_zephyr_input *d) {
  if(!d) return;
  k_spinlock_key_t key=k_spin_lock(&lock);
  if(d->published.touching) { d->cancelled=true; d->cancel_epoch++; }
  memset(d->held,0,sizeof(d->held)); memset(&d->pending,0,sizeof(d->pending)); d->published=d->pending;
  k_spin_unlock(&lock,key);
}
void pocket_zephyr_input_destroy(pocket_zephyr_input *d) {
  if(!d) return;
  k_spinlock_key_t key=k_spin_lock(&lock);
  pocket_zephyr_input **at=&instances;
  while(*at && *at!=d) at=&(*at)->next;
  if(*at) *at=d->next;
  k_spin_unlock(&lock,key);
  pocket_host_free(d,sizeof(*d),_Alignof(pocket_zephyr_input));
}
