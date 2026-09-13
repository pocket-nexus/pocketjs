/* The worker owns sockets, MVD and NDSP. The UI copies commands and snapshots;
 * PICA texture transfer happens after the previous frame has retired. */
#include "media.h"
#include "media_wire.h"
#include "media_adpcm.h"
#include "pocket_core.h"
#include "soc.h"
#include <3ds.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

enum { IDLE, OPENING, BUFFERING, PLAYING, ENDED, FAILED };
enum { ERR_NONE, ERR_MEMORY, ERR_SOCKET, ERR_HEADER, ERR_PACKET, ERR_MVD_INIT, ERR_MVD_DECODE, ERR_MVD_RENDER, ERR_AUDIO, ERR_REMOTE };
enum { VIDEO_SLOTS=16, AUDIO_SLOTS=24, COMMAND_SLOTS=4, AUDIO_CHANNEL=0 };
typedef struct { char host[16], token[65]; unsigned port, generation; } Command;
typedef struct { uint8_t *pixels; uint32_t pts, generation; } VideoFrame;
static Command commands[COMMAND_SLOTS];
static _Atomic unsigned command_read, command_write, requested, status_generation;
static _Atomic bool requested_open;
static VideoFrame frames[VIDEO_SLOTS];
static _Atomic unsigned frame_read, frame_write;
static _Atomic unsigned phase, position, received, decoded, presented, dropped, decode_max, underruns, failure, result_code;
static _Atomic unsigned volume_percent=100, buffered_until;
static _Atomic bool running, paused, hardware;
static Thread worker;
static C3D_Tex texture;
static bool texture_live;
static int32_t texture_handle=-1;
static ndspWaveBuf waves[AUDIO_SLOTS];
static void *audio_buffers[AUDIO_SLOTS];
static uint32_t audio_pts[AUDIO_SLOTS];
static bool audio_live, audio_started, was_starved, last_paused;
static bool startup_ready, draining;
static uint32_t origin_position, buffer_origin;
static unsigned last_volume=101;
static uint8_t *nal_buffer;
static unsigned current_generation;
_Static_assert(ATOMIC_INT_LOCK_FREE==2, "Media UI handoff must be lock-free");

static bool current(void) { return atomic_load(&running) && atomic_load(&requested)==current_generation; }
static void fail(unsigned error, uint32_t result) {
  if (!current()) return;
  atomic_store(&failure,error); atomic_store(&result_code,result); atomic_store(&phase,FAILED);
}
static void audio_tick(void) {
  if (!audio_live) return;
  if(!startup_ready && atomic_load(&decoded) && atomic_load(&buffered_until)>=buffer_origin+300) startup_ready=true;
  bool stop=atomic_load(&paused) || !startup_ready;
  if(stop!=last_paused) { ndspChnSetPaused(AUDIO_CHANNEL,stop); last_paused=stop; }
  unsigned volume=atomic_load(&volume_percent);
  if (volume!=last_volume) { float mix[12]={0}; mix[0]=mix[1]=volume/100.f; ndspChnSetMix(AUDIO_CHANNEL,mix); last_volume=volume; }
  bool playing=false, queued=false;
  for (unsigned i=0;i<AUDIO_SLOTS;i++) {
    if(waves[i].status==NDSP_WBUF_QUEUED) queued=true;
    if (waves[i].status==NDSP_WBUF_PLAYING) {
      atomic_store(&position,audio_pts[i]+ndspChnGetSamplePos(AUDIO_CHANNEL)*1000/MEDIA_SAMPLE_RATE);
      playing=true;
      audio_started=true;
    }
  }
  bool starved=audio_started && !stop && !playing && !queued && !draining;
  if(starved && !was_starved) {
    atomic_fetch_add(&underruns,1);
    buffer_origin=atomic_load(&buffered_until);
    atomic_store(&position,buffer_origin);
    startup_ready=false; audio_started=false;
    atomic_store(&phase,BUFFERING);
  }
  was_starved=starved;
}
static bool receive_exact(int fd, void *data, size_t count) {
  uint8_t *p=data; uint64_t deadline=osGetTime()+10000;
  while (count && current()) {
    audio_tick();
    if (atomic_load(&paused)) { deadline=osGetTime()+10000; svcSleepThread(1000000); continue; }
    int n=recv(fd,p,count,0);
    if (n>0) { p+=n; count-=n; atomic_fetch_add(&received,n); deadline=osGetTime()+10000; continue; }
    if (!n || (errno!=EWOULDBLOCK && errno!=EAGAIN) || osGetTime()>deadline) return false;
    svcSleepThread(1000000);
  }
  return count==0 && current();
}
static bool put_audio(const uint8_t *data, unsigned size, uint32_t pts) {
  while (current()) {
    audio_tick();
    for (unsigned i=0;i<AUDIO_SLOTS;i++) if (waves[i].status==NDSP_WBUF_FREE || waves[i].status==NDSP_WBUF_DONE) {
      unsigned count=media_decode_audio(data,size,audio_buffers[i]);
      if(!count) {fail(ERR_PACKET,0);return false;}
      DSP_FlushDataCache(waves[i].data_vaddr,count*4);
      waves[i].nsamples=count; waves[i].looping=false; audio_pts[i]=pts;
      ndspChnWaveBufAdd(AUDIO_CHANNEL,&waves[i]);
      atomic_store(&buffered_until,pts+count*1000/MEDIA_SAMPLE_RATE);
      if(startup_ready) atomic_store(&phase,PLAYING);
      return true;
    }
    svcSleepThread(1000000);
  }
  return false;
}
static bool render_frame(MVDSTD_Config *config, uint32_t pts) {
  unsigned write=0;
  while (current()) {
    audio_tick(); write=atomic_load_explicit(&frame_write,memory_order_relaxed);
    if (write-atomic_load_explicit(&frame_read,memory_order_acquire)<VIDEO_SLOTS) break;
    svcSleepThread(1000000);
  }
  if (!current()) return false;
  VideoFrame *slot=&frames[write%VIDEO_SLOTS];
  config->physaddr_outdata0=osConvertVirtToPhys(slot->pixels);
  uint64_t started=svcGetSystemTick();
  Result r=mvdstdRenderVideoFrame(config,true);
  unsigned us=(unsigned)((svcGetSystemTick()-started)*1000000/SYSCLOCK_ARM11);
  if(us>atomic_load(&decode_max)) atomic_store(&decode_max,us);
  if (r!=MVD_STATUS_OK) { fail(ERR_MVD_RENDER,r); return false; }
  slot->pts=pts; slot->generation=current_generation;
  atomic_fetch_add(&decoded,1);
  atomic_store_explicit(&frame_write,write+1,memory_order_release);
  return true;
}
static size_t prefix(const uint8_t *p,size_t n,size_t at) {
  if (at+3<=n && !p[at] && !p[at+1]) {
    if (p[at+2]==1) return 3;
    if (at+4<=n && !p[at+2] && p[at+3]==1) return 4;
  }
  return 0;
}
static bool decode_video(MVDSTD_Config *config,const uint8_t *data,size_t size,uint32_t pts) {
  for (size_t at=0;at<size;) {
    size_t head=prefix(data,size,at);
    if (!head) { fail(ERR_PACKET,0); return false; }
    size_t end=at+head;
    while (end<size && !prefix(data,size,end)) end++;
    size_t length=end-at-head;
    unsigned type=length ? data[at+head]&31 : 0;
    if (type==1 || type==5 || type==7 || type==8) {
      if (length+3>MEDIA_PACKET_BYTES) { fail(ERR_PACKET,0); return false; }
      nal_buffer[0]=nal_buffer[1]=0; nal_buffer[2]=1;
      memcpy(nal_buffer+3,data+at+head,length);
      GSPGPU_FlushDataCache(nal_buffer,length+3);
      MVDSTD_ProcessNALUnitOut out;
      uint64_t started=svcGetSystemTick();
      Result r=mvdstdProcessVideoFrame(nal_buffer,length+3,0,&out);
      unsigned us=(unsigned)((svcGetSystemTick()-started)*1000000/SYSCLOCK_ARM11);
      if(us>atomic_load(&decode_max)) atomic_store(&decode_max,us);
      if (!MVD_CHECKNALUPROC_SUCCESS(r)) { fail(ERR_MVD_DECODE,r); return false; }
      if (type==1 || type==5) {
        if (r==MVD_STATUS_OK || r==MVD_STATUS_FRAMEREADY) {
          if (!render_frame(config,pts)) return false;
        }
      }
    }
    at=end;
  }
  return current();
}
static void play(const Command *cmd) {
  current_generation=cmd->generation;
  atomic_store(&phase,OPENING); atomic_store(&failure,0); atomic_store(&result_code,0);
  atomic_store(&position,0); atomic_store(&received,0); atomic_store(&decoded,0);
  atomic_store(&presented,0); atomic_store(&dropped,0); atomic_store(&decode_max,0);
  atomic_store(&underruns,0); atomic_store(&buffered_until,0);
  atomic_store_explicit(&status_generation,current_generation,memory_order_release);
  int fd=-1; bool mvd=false; uint8_t *packet=NULL;
  while (current() && !soc_ensure(NULL,0)) svcSleepThread(10000000);
  if (!current()) return;
  fd=socket(AF_INET,SOCK_STREAM,0);
  if (fd<0) { fail(ERR_SOCKET,errno); goto done; }
  fcntl(fd,F_SETFL,O_NONBLOCK);
  struct sockaddr_in address={.sin_family=AF_INET,.sin_port=htons(cmd->port)};
  if (inet_pton(AF_INET,cmd->host,&address.sin_addr)!=1) { fail(ERR_SOCKET,0); goto done; }
  int connected=connect(fd,(struct sockaddr *)&address,sizeof address);
  if (connected<0 && errno!=EINPROGRESS) { fail(ERR_SOCKET,errno); goto done; }
  uint64_t deadline=osGetTime()+10000; size_t sent=0;
  while (current() && sent<64 && osGetTime()<deadline) {
    int n=send(fd,cmd->token+sent,64-sent,0);
    if (n>0) sent+=n;
    else if (errno!=EWOULDBLOCK && errno!=EAGAIN && errno!=ENOTCONN && errno!=EINPROGRESS) break;
    else svcSleepThread(1000000);
  }
  if (sent!=64) { fail(ERR_SOCKET,errno); goto done; }
  uint8_t header[32];
  if (!receive_exact(fd,header,32)) { fail(ERR_SOCKET,errno); goto done; }
  if (!media_header_valid(header)) { fail(ERR_HEADER,0); goto done; }
  origin_position=media_u32(header+24);
  buffer_origin=origin_position;
  atomic_store(&position,origin_position);
  packet=malloc(MEDIA_PACKET_BYTES);
  if (!packet) { fail(ERR_MEMORY,0); goto done; }
  /* MVD's BGR565 (0x40002) is the packed order consumed by GX/GPU_RGB565.
   * MVD_OUTPUT_RGB565 reverses red and blue; do not compensate in the encoder.
   * Matches devkitPro/3ds-examples mvd/source/main.c. */
  Result result=mvdstdInit(MVDMODE_VIDEOPROCESSING,MVD_INPUT_H264,MVD_OUTPUT_BGR565,MVD_DEFAULT_WORKBUF_SIZE,NULL);
  if (R_FAILED(result)) { fail(ERR_MVD_INIT,result); goto done; }
  mvd=true; atomic_store(&hardware,true);
  result=ndspInit();
  if (R_FAILED(result)) { fail(ERR_AUDIO,result); goto done; }
  audio_live=true; audio_started=false; was_starved=false; last_volume=101; last_paused=false;
  startup_ready=false; draining=false;
  ndspSetOutputMode(NDSP_OUTPUT_STEREO);
  ndspChnReset(AUDIO_CHANNEL); ndspChnSetInterp(AUDIO_CHANNEL,NDSP_INTERP_LINEAR);
  ndspChnSetRate(AUDIO_CHANNEL,MEDIA_SAMPLE_RATE); ndspChnSetFormat(AUDIO_CHANNEL,NDSP_FORMAT_STEREO_PCM16);
  for (unsigned i=0;i<AUDIO_SLOTS;i++) { waves[i].status=NDSP_WBUF_FREE; waves[i].nsamples=0; }
  MVDSTD_Config config;
  mvdstdGenerateDefaultConfig(&config,MEDIA_WIDTH,MEDIA_HEIGHT,MEDIA_WIDTH,MEDIA_HEIGHT,NULL,(u32*)frames[0].pixels,(u32*)frames[0].pixels);
  atomic_store(&phase,BUFFERING);
  uint32_t last_video=media_u32(header+24),last_audio=last_video;
  while (current()) {
    if (!receive_exact(fd,header,16)) { fail(ERR_SOCKET,errno); break; }
    if (!media_packet_valid(header)) { fail(ERR_PACKET,0); break; }
    uint32_t size=media_u32(header+4),pts=media_u32(header+8);
    if((header[0]==1 && (pts<last_video || pts-last_video>1000)) ||
       (header[0]==2 && (pts<last_audio || pts-last_audio>1000))) {fail(ERR_PACKET,0);break;}
    if(header[0]==1) last_video=pts;
    if(header[0]==2) last_audio=pts;
    if (size && !receive_exact(fd,packet,size)) { fail(ERR_SOCKET,errno); break; }
    if (header[0]==1 && !decode_video(&config,packet,size,pts)) break;
    if (header[0]==2 && !put_audio(packet,size,pts)) break;
    if (!atomic_load(&decoded) && (header[0]==1 || header[0]==2) && pts-origin_position>500) { fail(ERR_MVD_DECODE,0); break; }
    if (header[0]==4) { fail(ERR_REMOTE,0); break; }
    if(header[0]==1 || header[0]==2) {
      char credit=1; bool acknowledged=false;
      while(current()) {
        if(send(fd,&credit,1,0)==1) { acknowledged=true; break; }
        if(errno!=EWOULDBLOCK && errno!=EAGAIN) break;
        audio_tick();svcSleepThread(1000000);
      }
      if(!acknowledged) {fail(ERR_SOCKET,errno);break;}
    }
    if (header[0]==3) {
      if(!atomic_load(&decoded)) { fail(ERR_MVD_DECODE,0); break; }
      startup_ready=true; draining=true;
      while (current()) {
        audio_tick(); bool queued=false; uint32_t end=atomic_load(&position);
        for (unsigned i=0;i<AUDIO_SLOTS;i++) {
          if (waves[i].status==NDSP_WBUF_PLAYING || waves[i].status==NDSP_WBUF_QUEUED) queued=true;
          if (waves[i].nsamples && audio_pts[i]+waves[i].nsamples*1000/MEDIA_SAMPLE_RATE>end) end=audio_pts[i]+waves[i].nsamples*1000/MEDIA_SAMPLE_RATE;
        }
        if (!queued) { atomic_store(&position,end); atomic_store(&phase,ENDED); break; }
        svcSleepThread(1000000);
      }
      break;
    }
  }
done:
  if (fd>=0) close(fd);
  if (audio_live) { ndspChnWaveBufClear(AUDIO_CHANNEL); ndspExit(); audio_live=false; }
  if (mvd) mvdstdExit();
  free(packet);
}
static void run(void *unused) {
  (void)unused;
  while (atomic_load(&running)) {
    unsigned read=atomic_load_explicit(&command_read,memory_order_relaxed);
    unsigned write=atomic_load_explicit(&command_write,memory_order_acquire);
    if (read==write) { svcSleepThread(1000000); continue; }
    Command cmd=commands[read%COMMAND_SLOTS];
    atomic_store_explicit(&command_read,read+1,memory_order_release);
    if (cmd.generation==atomic_load(&requested)) play(&cmd);
  }
}
bool media_start(void) {
  nal_buffer=linearMemAlign(MEDIA_PACKET_BYTES,0x80);
  for (unsigned i=0;i<VIDEO_SLOTS;i++) {
    frames[i].pixels=linearMemAlign(MEDIA_WIDTH*MEDIA_HEIGHT*2,0x80);
    if (!frames[i].pixels) return false;
    memset(frames[i].pixels,0,MEDIA_WIDTH*MEDIA_HEIGHT*2);
    GSPGPU_FlushDataCache(frames[i].pixels,MEDIA_WIDTH*MEDIA_HEIGHT*2);
  }
  for (unsigned i=0;i<AUDIO_SLOTS;i++) {
    waves[i].data_vaddr=audio_buffers[i]=linearMemAlign(MEDIA_AUDIO_FRAMES*4,0x80);
    if (!waves[i].data_vaddr) return false;
  }
  if (!nal_buffer || !C3D_TexInit(&texture,MEDIA_WIDTH,MEDIA_HEIGHT,GPU_RGB565)) return false;
  texture_live=true; memset(texture.data,0,texture.size); GSPGPU_FlushDataCache(texture.data,texture.size);
  C3D_TexSetFilter(&texture,GPU_LINEAR,GPU_LINEAR); C3D_TexSetWrap(&texture,GPU_CLAMP_TO_EDGE,GPU_CLAMP_TO_EDGE);
  atomic_store(&running,true); worker=threadCreate(run,NULL,64*1024,0x3e,-2,false);
  return worker!=NULL;
}
void media_stop(void) {
  atomic_store(&running,false); atomic_fetch_add(&requested,1);
  if (worker) { threadJoin(worker,U64_MAX); threadFree(worker); worker=NULL; }
  for (unsigned i=0;i<VIDEO_SLOTS;i++) { if(frames[i].pixels) linearFree(frames[i].pixels); frames[i].pixels=NULL; }
  for (unsigned i=0;i<AUDIO_SLOTS;i++) { if(audio_buffers[i]) linearFree(audio_buffers[i]); audio_buffers[i]=NULL; waves[i].data_vaddr=NULL; }
  if(nal_buffer) linearFree(nal_buffer);
  nal_buffer=NULL;
  if(texture_live) C3D_TexDelete(&texture);
  texture_live=false;
}
bool media_open(const char *host,unsigned port,const char *token) {
  if (!atomic_load(&running) || !host || strlen(host)>15 || !port || port>65535 || !token || strlen(token)!=64) return false;
  for(unsigned i=0;i<64;i++) if(!((token[i]>='0' && token[i]<='9') || (token[i]>='a' && token[i]<='f'))) return false;
  unsigned write=atomic_load_explicit(&command_write,memory_order_relaxed);
  if(write-atomic_load_explicit(&command_read,memory_order_acquire)>=COMMAND_SLOTS) return false;
  Command *cmd=&commands[write%COMMAND_SLOTS]; strcpy(cmd->host,host); strcpy(cmd->token,token); cmd->port=port;
  cmd->generation=atomic_fetch_add(&requested,1)+1;
  atomic_store(&paused,false); atomic_store(&requested_open,true);
  atomic_store_explicit(&command_write,write+1,memory_order_release); return true;
}
void media_close(void) { atomic_fetch_add(&requested,1); atomic_store(&requested_open,false); atomic_store(&paused,false); }
void media_paused(bool value) { atomic_store(&paused,value); }
void media_volume(float value) { atomic_store(&volume_percent,(unsigned)(!isfinite(value) || value<0 ? 0 : value>1 ? 100 : value*100)); }
int32_t media_texture_handle(void) {
  if(texture_handle<0 && texture_live) {
    uint8_t *blank=calloc(MEDIA_WIDTH*MEDIA_HEIGHT,2);
    if(blank) { texture_handle=ui_upload_texture(blank,MEDIA_WIDTH*MEDIA_HEIGHT*2,MEDIA_WIDTH,MEDIA_HEIGHT,0); free(blank); }
  }
  return texture_handle;
}
void media_forget_guest(void) { media_close(); texture_handle=-1; }
C3D_Tex *media_texture(int32_t handle) { return texture_live && handle>=0 && handle==texture_handle ? &texture : NULL; }
void media_present(void) {
  unsigned read=atomic_load_explicit(&frame_read,memory_order_relaxed),write=atomic_load_explicit(&frame_write,memory_order_acquire);
  unsigned generation=atomic_load(&requested),now=atomic_load(&position); VideoFrame *chosen=NULL;
  while(read!=write) {
    VideoFrame *slot=&frames[read%VIDEO_SLOTS];
    if(slot->generation==generation && slot->pts>now+20 && atomic_load(&phase)!=ENDED) break;
    if(slot->generation==generation) {
      if(chosen) atomic_fetch_add(&dropped,1);
      chosen=slot;
    }
    read++;
  }
  if(chosen && texture_live) {
    C3D_SyncDisplayTransfer((u32*)chosen->pixels,GX_BUFFER_DIM(MEDIA_WIDTH,MEDIA_HEIGHT),(u32*)texture.data,GX_BUFFER_DIM(MEDIA_WIDTH,MEDIA_HEIGHT),
      GX_TRANSFER_FLIP_VERT(1)|GX_TRANSFER_OUT_TILED(1)|GX_TRANSFER_RAW_COPY(0)|GX_TRANSFER_IN_FORMAT(GX_TRANSFER_FMT_RGB565)|GX_TRANSFER_OUT_FORMAT(GX_TRANSFER_FMT_RGB565)|GX_TRANSFER_SCALING(GX_TRANSFER_SCALE_NO));
    atomic_fetch_add(&presented,1);
  }
  atomic_store_explicit(&frame_read,read,memory_order_release);
}
void media_snapshot(char *out,size_t capacity) {
  static const char *names[]={"idle","opening","buffering","playing","ended","error"};
  static const char *errors[]={"","Media allocation failed","Media connection lost","Unsupported media stream","Invalid media packet","H.264 hardware decoder unavailable","H.264 decode failed","Video render failed","Audio output unavailable","Companion media failed"};
  unsigned p=atomic_load(&phase),e=atomic_load(&failure),now=atomic_load(&position),until=atomic_load(&buffered_until);
  if(!atomic_load(&requested_open)) { p=IDLE; e=0; }
  else if(atomic_load_explicit(&status_generation,memory_order_acquire)!=atomic_load(&requested)) { p=OPENING; e=0; now=until=0; }
  const char *name=p<6 ? names[p] : "error";
  if(atomic_load(&paused) && (p==PLAYING || p==BUFFERING)) name="paused";
  unsigned code=atomic_load(&result_code);
  const char *detail=e<sizeof errors/sizeof errors[0] ? errors[e] : "Media failed";
  if(e==ERR_AUDIO && code==(unsigned)MAKERESULT(RL_PERMANENT,RS_NOTFOUND,RM_DSP,RD_NOT_FOUND))
    detail="DSP firmware missing; dump it in Rosalina";
  char message[120]; snprintf(message,sizeof message,"%s%s%08lx",detail,e ? " (0x" : "",(unsigned long)code);
  if(e) strncat(message,")",sizeof message-strlen(message)-1); else message[0]=0;
  snprintf(out,capacity,"{\"phase\":\"%s\",\"positionMs\":%u,\"bufferedMs\":%u,\"decodedFrames\":%u,\"presentedFrames\":%u,\"droppedFrames\":%u,\"receivedBytes\":%u,\"decodeMaxUs\":%u,\"audioUnderruns\":%u,\"hardware\":%s,\"error\":\"%s\"}",name,now,until>now ? until-now : 0,atomic_load(&decoded),atomic_load(&presented),atomic_load(&dropped),atomic_load(&received),atomic_load(&decode_max),atomic_load(&underruns),atomic_load(&hardware) ? "true" : "false",message);
}
