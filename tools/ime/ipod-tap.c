/* Test-only iOS 6 ARMv7 UIKit event sender. Not linked into PocketJS apps.
 * ABI reference: mringwal/hid-support, 3rdParty/GraphicsServices/GSEvent.h.
 * Target is fixed at compile time; coordinates are logical points. */
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
typedef struct { float x,y; } Point;
typedef struct { int type,subtype; Point location,windowLocation; int context; uint64_t time; void *window; unsigned flags,pid; int size; } Record;
typedef struct { int type; short dx,dy; float a,b,width,c,height,d; unsigned char e,count; unsigned short x52; } Hand;
typedef struct { unsigned char index,identity,proximity; float pressure,radius; Point location; void *window; } Path;
#ifndef POCKET_TEST_BUNDLE
#define POCKET_TEST_BUNDLE "dev.pocket-stack.clear"
#endif
static uint64_t (*event_now)(void);
static void (*event_send)(void*,unsigned);
static void emit(unsigned target, Point point, int type) {
 struct {Record record;Hand hand;Path path;} event;
 memset(&event,0,sizeof event);
 event.record.type=3001;event.record.location=point;event.record.windowLocation=point;
 event.record.time=event_now();event.record.size=sizeof(Hand)+sizeof(Path);
 event.hand.type=type;event.hand.x52=1;
 event.path.index=1;event.path.identity=2;event.path.proximity=type==6?0:3;
 event.path.pressure=1;event.path.radius=1;event.path.location=point;
 event_send(&event,target);
}
int main(int argc,char **argv) {
 // --path x y hold-ms [x y travel-ms ...]. Repeated points hold at the
 // destination; multiple segments exercise reversals without lifting.
 int path=argc>=5 && strcmp(argv[1],"--path")==0;
 // x y [hold-ms [end-x end-y drag-ms]]; existing taps retain their timing.
 if(path) { if((argc-2)%3 || argc>386)return 2; }
 else if(argc!=3 && argc!=4 && argc!=7)return 2;
 int hold=argc>=4?atoi(argv[3]):150, drag=argc==7?atoi(argv[6]):0;
 if(!path && (hold<0||hold>30000||drag<0||drag>30000))return 2;
 Point start={atof(argv[1]),atof(argv[2])};
 Point end=argc==7?(Point){atof(argv[4]),atof(argv[5])}:start;
 int moves=drag>0?(drag+15)/16:0;
 void *lib=dlopen("/System/Library/PrivateFrameworks/GraphicsServices.framework/GraphicsServices",RTLD_NOW);
 unsigned (*port)(const char*)=dlsym(lib,"GSCopyPurpleNamedPort");
 event_now=dlsym(lib,"GSCurrentEventTimestamp");
 event_send=dlsym(lib,"GSSendEvent");
 if(!port||!event_now||!event_send)return 3;
 unsigned target=port(POCKET_TEST_BUNDLE);
 printf("port=%u record=%lu hand=%lu path=%lu\n",target,(unsigned long)sizeof(Record),(unsigned long)sizeof(Hand),(unsigned long)sizeof(Path));
 if(!target)return 4;
 if(path) {
  for(int i=2;i<argc;i+=3) {
   int x=atoi(argv[i]),y=atoi(argv[i+1]),ms=atoi(argv[i+2]);
   if(x<0||x>319||y<0||y>479||ms<0||ms>30000)return 2;
  }
  Point p={atof(argv[2]),atof(argv[3])};
  emit(target,p,1);usleep(atoi(argv[4])*1000);
  for(int i=5;i<argc;i+=3) {
   Point to={atof(argv[i]),atof(argv[i+1])};
   int ms=atoi(argv[i+2]),count=(ms+15)/16;if(count<1)count=1;
   for(int j=1;j<=count;j++) {
    usleep(ms*1000/count);
    Point at={p.x+(to.x-p.x)*j/count,p.y+(to.y-p.y)*j/count};
    emit(target,at,2);
   }
   p=to;
  }
  emit(target,p,6);usleep(150000);return 0;
 }
 for(int step=0;step<=moves+1;step++) {
  int down=step<=moves;
  float t=step==0?0: moves>0?(float)step/moves:1; if(t>1)t=1;
  Point at={start.x+(end.x-start.x)*t,start.y+(end.y-start.y)*t};
  emit(target,at,step==0?1:down?2:6);
  usleep(step==0?hold*1000:down?drag*1000/moves:150000);
 }
 return 0;
}
