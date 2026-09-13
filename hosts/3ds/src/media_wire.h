#ifndef POCKETJS_MEDIA_WIRE_H
#define POCKETJS_MEDIA_WIRE_H
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#define MEDIA_WIDTH 512
#define MEDIA_HEIGHT 256
#define MEDIA_PACKET_BYTES (128 * 1024)
#define MEDIA_SAMPLE_RATE 22050
#define MEDIA_AUDIO_FRAMES 1024
static inline uint32_t media_u32(const uint8_t *p) {
  return (uint32_t)p[0] | (uint32_t)p[1]<<8 | (uint32_t)p[2]<<16 | (uint32_t)p[3]<<24;
}
static inline uint16_t media_u16(const uint8_t *p) { return p[0] | (uint16_t)p[1]<<8; }
static inline bool media_header_valid(const uint8_t *p) {
  return media_u32(p)==0x564d4b50 && media_u16(p+4)==1 && media_u16(p+6)==32
    && media_u16(p+8)==MEDIA_WIDTH && media_u16(p+10)==MEDIA_HEIGHT
    && media_u16(p+12)>0 && media_u16(p+12)<=60 && media_u16(p+14)==1
    && media_u32(p+16)==MEDIA_SAMPLE_RATE && media_u16(p+20)==2 && media_u16(p+22)==2;
}
static inline bool media_packet_valid(const uint8_t *p) {
  uint32_t n=media_u32(p+4);
  if (p[1] || media_u16(p+2) || media_u32(p+12) || n>MEDIA_PACKET_BYTES) return false;
  switch(p[0]) {
    case 1: return n>=4;
    case 2: return n>=8 && n<=MEDIA_AUDIO_FRAMES+7;
    case 3: return n==0;
    case 4: return n>0 && n<=160;
    default: return false;
  }
}
#endif
