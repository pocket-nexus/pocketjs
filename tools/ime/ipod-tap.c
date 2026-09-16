/* Test-only iOS 6 ARMv7 UIKit event sender. Not linked into PocketJS apps.
 * ABI reference: mringwal/hid-support, 3rdParty/GraphicsServices/GSEvent.h.
 * Target is restricted to the Clear test bundle; coordinates are logical points. */
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
int main(int argc,char **argv) {
 // x y [hold-ms [end-x end-y drag-ms]]; existing taps retain their timing.
 if(argc!=3 && argc!=4 && argc!=7)return 2;
 int hold=argc>=4?atoi(argv[3]):150, drag=argc==7?atoi(argv[6]):0;
 if(hold<0||hold>30000||drag<0||drag>30000)return 2;
 Point start={atof(argv[1]),atof(argv[2])};
 Point end=argc==7?(Point){atof(argv[4]),atof(argv[5])}:start;
 int moves=drag>0?(drag+15)/16:0;
 void *lib=dlopen("/System/Library/PrivateFrameworks/GraphicsServices.framework/GraphicsServices",RTLD_NOW);
 unsigned (*port)(const char*)=dlsym(lib,"GSCopyPurpleNamedPort");
 uint64_t (*now)(void)=dlsym(lib,"GSCurrentEventTimestamp");
 void (*send)(void*,unsigned)=dlsym(lib,"GSSendEvent");
 if(!port||!now||!send)return 3;
 unsigned target=port("dev.pocket-stack.clear");
 printf("port=%u record=%lu hand=%lu path=%lu\n",target,(unsigned long)sizeof(Record),(unsigned long)sizeof(Hand),(unsigned long)sizeof(Path));
 if(!target)return 4;
 for(int step=0;step<=moves+1;step++) {
  int down=step<=moves;
  float t=step==0?0: moves>0?(float)step/moves:1; if(t>1)t=1;
  struct {Record record;Hand hand;Path path;} event;
  memset(&event,0,sizeof event);
  event.record.type=3001;event.record.location=(Point){start.x+(end.x-start.x)*t,start.y+(end.y-start.y)*t};event.record.windowLocation=event.record.location;
  event.record.time=now();event.record.size=sizeof(Hand)+sizeof(Path);
  event.hand.type=step==0?1:down?2:6;event.hand.x52=1;
  event.path.index=1;event.path.identity=2;event.path.proximity=down?3:0;event.path.pressure=1;event.path.radius=1;event.path.location=event.record.location;
  send(&event,target);usleep(step==0?hold*1000:down?drag*1000/moves:150000);
 }
 return 0;
}
