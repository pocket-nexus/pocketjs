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
/* The header's video codec (offset 14): H.264 for the hardware decoder, or
 * small palettized frames a console without one expands in software. */
#define MEDIA_CODEC_H264 1
#define MEDIA_CODEC_PAL8 2
static inline uint32_t media_u32(const uint8_t *p) {
  return (uint32_t)p[0] | (uint32_t)p[1]<<8 | (uint32_t)p[2]<<16 | (uint32_t)p[3]<<24;
}
static inline uint16_t media_u16(const uint8_t *p) { return p[0] | (uint16_t)p[1]<<8; }
static inline bool media_header_valid(const uint8_t *p) {
  return media_u32(p)==0x564d4b50 && media_u16(p+4)==1 && media_u16(p+6)==32
    && media_u16(p+8)==MEDIA_WIDTH && media_u16(p+10)==MEDIA_HEIGHT
    && media_u16(p+12)>0 && media_u16(p+12)<=60
    && (media_u16(p+14)==MEDIA_CODEC_H264 || media_u16(p+14)==MEDIA_CODEC_PAL8)
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
/* A PAL8 video packet updates a palettized reference picture that both
 * ends keep for the stream (zeros at its start):
 *
 *   u16 width, u16 height, u16 colours, u16 zero
 *   colours x u16 RGB565       a new palette, or none when colours is 0
 *   runs until width*height pixels are covered, rows top to bottom:
 *     varint unchanged pixels, varint changed pixels, that many indices
 *
 * A varint is 7 bits a byte, low bits first, at most three bytes. The size
 * is fixed by the stream's first packet, which must carry a palette. */
typedef struct {
  unsigned width, height;
  bool palette_set;
  uint16_t lut[256];
} MediaPal8;
static inline bool media_varint(const uint8_t *p, size_t n, size_t *at, unsigned *out) {
  unsigned value=0;
  for (unsigned shift=0;shift<21;shift+=7) {
    if (*at>=n) return false;
    uint8_t byte=p[(*at)++]; value|=(unsigned)(byte&127)<<shift;
    if (!(byte&128)) { *out=value; return true; }
  }
  return false;
}
/* Apply one packet to `ref` (MEDIA_WIDTH*MEDIA_HEIGHT bytes). False when it
 * is malformed; `ref` may then be partly updated and the stream must stop. */
static inline bool media_pal8_apply(MediaPal8 *state, uint8_t *ref, const uint8_t *p, size_t n) {
  if (n<8 || media_u16(p+6)) return false;
  unsigned w=media_u16(p),h=media_u16(p+2),colors=media_u16(p+4);
  if (!w || !h || w>MEDIA_WIDTH || h>MEDIA_HEIGHT || colors>256) return false;
  if (state->width && (w!=state->width || h!=state->height)) return false;
  if (!colors && !state->palette_set) return false;
  size_t at=8+(size_t)colors*2;
  if (at>n) return false;
  for (unsigned i=0;i<colors;i++) state->lut[i]=media_u16(p+8+i*2);
  if (colors) state->palette_set=true;
  state->width=w; state->height=h;
  size_t total=(size_t)w*h,pixel=0;
  while (pixel<total) {
    unsigned skip,count;
    if (!media_varint(p,n,&at,&skip) || !media_varint(p,n,&at,&count)) return false;
    if (pixel+skip+count>total || at+count>n) return false;
    pixel+=skip;
    for (unsigned i=0;i<count;i++) ref[pixel+i]=p[at+i];
    pixel+=count; at+=count;
  }
  return at==n;
}
/* Expand the reference picture into RGB565 rows `stride` pixels apart, and
 * repeat its last column and row once, so a filtered texture read at the
 * picture's edge does not blend in pixels from outside it. */
static inline void media_pal8_expand(const MediaPal8 *state, const uint8_t *ref, uint16_t *out, unsigned stride) {
  unsigned w=state->width,h=state->height;
  for (unsigned y=0;y<h;y++) {
    uint16_t *row=out+(size_t)y*stride; const uint8_t *src=ref+(size_t)y*w;
    for (unsigned x=0;x<w;x++) row[x]=state->lut[src[x]];
    if (w<stride) row[w]=row[w-1];
  }
  if (h<MEDIA_HEIGHT) {
    uint16_t *last=out+(size_t)(h-1)*stride,*next=out+(size_t)h*stride;
    for (unsigned x=0;x<w+(w<stride);x++) next[x]=last[x];
  }
}
#endif
