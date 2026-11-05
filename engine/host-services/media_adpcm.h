#ifndef POCKETJS_MEDIA_ADPCM_H
#define POCKETJS_MEDIA_ADPCM_H
#include "media_wire.h"
static const uint16_t media_ima_steps[89]={7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,24623,27086,29794,32767};
static inline unsigned media_decode_audio(const uint8_t *p,unsigned n,int16_t *out) {
  static const int change[8]={-1,-1,-1,-1,2,4,6,8};
  if(n<8 || n>MEDIA_AUDIO_FRAMES+7 || p[2]>88 || p[6]>88 || p[3] || p[7]) return 0;
  int value[2]={(int16_t)media_u16(p),(int16_t)media_u16(p+4)},index[2]={p[2],p[6]};
  out[0]=value[0];out[1]=value[1];
  for(unsigned frame=1;frame<n-7;frame++) for(unsigned ch=0;ch<2;ch++) {
    unsigned code=(p[frame+7]>>(ch*4))&15,step=media_ima_steps[index[ch]];
    int delta=step>>3;
    if(code&4) delta+=step;
    if(code&2) delta+=step>>1;
    if(code&1) delta+=step>>2;
    value[ch]+=(code&8)?-delta:delta;
    if(value[ch]>32767) value[ch]=32767;
    if(value[ch]<-32768) value[ch]=-32768;
    index[ch]+=change[code&7];
    if(index[ch]<0) index[ch]=0;
    if(index[ch]>88) index[ch]=88;
    out[frame*2+ch]=(int16_t)value[ch];
  }
  return n-7;
}
#endif
