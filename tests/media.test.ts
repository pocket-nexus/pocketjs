import { expect, test } from "bun:test";
import { createConnection } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MEDIA, validMediaSource } from "../contracts/spec/media.ts";
import { encodeMediaAudio } from "../contracts/spec/media-adpcm.ts";
import { createMediaScrubber, mediaPlayer } from "../framework/src/media.ts";
import { createMediaStreamServer, createPal8Encoder, mediaHeader, mediaPacket, PAL8_CUBE, quantizeCube } from "../tools/media-stream.ts";

test("native and companion validate the same media bytes and reject malformed lengths", () => {
  const directory=mkdtempSync(join(tmpdir(),"pocket-media-"));
  try {
    const header=mediaHeader(1234,90000), video=mediaPacket({kind:1,ptsMs:1234,data:Uint8Array.of(0,0,1,0x65)});
    writeFileSync(join(directory,"wire.bin"),Buffer.concat([header,video]));
    writeFileSync(join(directory,"check.c"),`#include "media_wire.h"
#include <assert.h>
#include <stdio.h>
int main(int argc,char **argv) {
  unsigned char h[32],p[16]; FILE *f=fopen(argv[1],"rb"); assert(f);
  assert(fread(h,1,32,f)==32);assert(media_header_valid(h));assert(media_u32(h+24)==1234);
  h[9]=0;assert(!media_header_valid(h));
  assert(fread(p,1,16,f)==16);assert(media_packet_valid(p));assert(media_u32(p+8)==1234);
  p[7]=0xff;assert(!media_packet_valid(p));p[7]=0;p[1]=1;assert(!media_packet_valid(p));
  p[1]=0;p[0]=2;p[4]=3;assert(!media_packet_valid(p));fclose(f);return 0;
}`);
    const compile=Bun.spawnSync(["cc","-std=c11","-I",resolve("engine/host-services"),join(directory,"check.c"),"-o",join(directory,"check")]);
    expect(compile.exitCode,compile.stderr.toString()).toBe(0);
    expect(Bun.spawnSync([join(directory,"check"),join(directory,"wire.bin")]).exitCode).toBe(0);
    expect(()=>mediaPacket({kind:1,ptsMs:0,data:new Uint8Array(MEDIA.packetBytes+1)})).toThrow();
    expect(()=>mediaPacket({kind:2,ptsMs:0,data:new Uint8Array(3)})).toThrow();
  } finally { rmSync(directory,{recursive:true,force:true}); }
});

test("PAL8 deltas rebuild the producer's picture natively, frame after frame, and bad packets are refused",()=>{
  const directory=mkdtempSync(join(tmpdir(),"pocket-pal8-"));
  try {
    const w=37,h=11,encoder=createPal8Encoder(w,h);
    const frames:Uint8Array[]=[];
    const first=new Uint8Array(w*h); for(let i=0;i<first.length;i++) first[i]=(i*7)%252;
    const second=first.slice(); for(let i=40;i<52;i++) second[i]=(second[i]!+1)%252; second[w*h-1]=3;
    const third=second.slice();
    frames.push(first,second,third);
    const packets=frames.map(frame=>encoder.encode(frame));
    expect(new DataView(packets[0]!.buffer).getUint16(4,true)).toBe(252);
    expect(new DataView(packets[1]!.buffer).getUint16(4,true)).toBe(0);
    expect(packets[1]!.length).toBeLessThan(40);
    expect(packets[2]!.length).toBe(8+3);
    const blob=Buffer.concat(packets.flatMap(p=>[Buffer.from(Uint32Array.of(p.length).buffer),Buffer.from(p)]));
    writeFileSync(join(directory,"pal8.bin"),blob);
    writeFileSync(join(directory,"expect.bin"),Buffer.concat(frames.map(f=>Buffer.from(f))));
    writeFileSync(join(directory,"header.bin"),mediaHeader(0,1000,12,"pal8"));
    writeFileSync(join(directory,"pal8.c"),`#include "media_wire.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
static uint8_t ref[MEDIA_WIDTH*MEDIA_HEIGHT]; static uint16_t out[MEDIA_WIDTH*MEDIA_HEIGHT];
static const uint16_t cube[252]={${[...PAL8_CUBE].join(",")}};
int main(int argc,char **argv) {
  uint8_t h[32],expect[3][${w*h}],p[4096]; FILE *f=fopen(argv[3],"rb"); assert(fread(h,1,32,f)==32); fclose(f);
  assert(media_header_valid(h)); assert(media_u16(h+14)==MEDIA_CODEC_PAL8);
  f=fopen(argv[2],"rb"); assert(fread(expect,1,sizeof expect,f)==sizeof expect); fclose(f);
  MediaPal8 state={0}; f=fopen(argv[1],"rb");
  for (int k=0;k<3;k++) {
    uint32_t n; assert(fread(&n,4,1,f)==1); assert(n<=sizeof p); assert(fread(p,1,n,f)==n);
    if (k==1) { assert(!media_pal8_apply(&(MediaPal8){0},ref,p,n)); }
    if (k==0) { assert(!media_pal8_apply(&(MediaPal8){0},ref,p,n-1)); memset(ref,0,sizeof ref); }
    assert(media_pal8_apply(&state,ref,p,n));
    assert(memcmp(ref,expect[k],${w*h})==0);
    media_pal8_expand(&state,ref,out,MEDIA_WIDTH);
    for (int y=0;y<${h};y++) for (int x=0;x<${w};x++) assert(out[y*MEDIA_WIDTH+x]==cube[expect[k][y*${w}+x]]);
    assert(out[${w}]==out[${w-1}]); assert(out[${h}*MEDIA_WIDTH+3]==out[${h-1}*MEDIA_WIDTH+3]);
  }
  fclose(f);
  MediaPal8 other=state; other.width=36; assert(!media_pal8_apply(&other,ref,p,10));
  h[14]=3; assert(!media_header_valid(h));
  return 0;
}`);
    const compile=Bun.spawnSync(["cc","-std=c11","-I",resolve("engine/host-services"),join(directory,"pal8.c"),"-o",join(directory,"pal8")]);
    expect(compile.exitCode,compile.stderr.toString()).toBe(0);
    const run=Bun.spawnSync([join(directory,"pal8"),join(directory,"pal8.bin"),join(directory,"expect.bin"),join(directory,"header.bin")]);
    expect(run.exitCode,run.stderr.toString()).toBe(0);
    expect(()=>createPal8Encoder(600,3)).toThrow();
    expect(()=>encoder.encode(new Uint8Array(3))).toThrow();
    const rgb=new Uint8Array(4*4*3).fill(255);
    expect([...quantizeCube(rgb,4,4)]).toEqual(new Array(16).fill(251));
  } finally { rmSync(directory,{recursive:true,force:true}); }
});

test("scrubbing previews locally and commits one seek; cancelled drags issue none",()=>{
  const seeks:number[]=[],scrub=createMediaScrubber(s=>seeks.push(s));
  scrub.begin(.1,120);for(let n=0;n<100;n++)scrub.move(n/100,120);
  expect(seeks).toEqual([]);expect(scrub.preview()).toBe(118.8);
  scrub.commit();scrub.commit();expect(seeks).toEqual([118.8]);
  scrub.begin(.5,120);scrub.cancel();scrub.commit();expect(seeks).toHaveLength(1);
});

test("stereo ADPCM crosses the native boundary at one quarter of PCM bandwidth",()=>{
  const directory=mkdtempSync(join(tmpdir(),"pocket-audio-"));
  try {
    const pcm=new Int16Array(MEDIA.audioFrames*2);
    for(let i=0;i<MEDIA.audioFrames;i++) {pcm[i*2]=Math.sin(i*.1)*10000;pcm[i*2+1]=Math.cos(i*.13)*8000;}
    const block=encodeMediaAudio(new Uint8Array(pcm.buffer));
    expect(block.length).toBe(1031);
    writeFileSync(join(directory,"audio.bin"),block);
    writeFileSync(join(directory,"audio.c"),`#include "media_adpcm.h"
#include <assert.h>
#include <stdio.h>
int main(int argc,char **argv) {
  uint8_t b[1031];int16_t out[2048];FILE *f=fopen(argv[1],"rb");assert(f);
  assert(fread(b,1,sizeof b,f)==sizeof b);fclose(f);assert(media_decode_audio(b,sizeof b,out)==1024);
  fwrite(out,sizeof out,1,stdout);b[2]=89;assert(!media_decode_audio(b,sizeof b,out));return 0;
}`);
    const compile=Bun.spawnSync(["cc","-std=c11","-I",resolve("engine/host-services"),join(directory,"audio.c"),"-o",join(directory,"audio")]);
    expect(compile.exitCode,compile.stderr.toString()).toBe(0);
    const decode=Bun.spawnSync([join(directory,"audio"),join(directory,"audio.bin")]);
    expect(decode.exitCode,decode.stderr.toString()).toBe(0);
    const out=new DataView(decode.stdout.buffer,decode.stdout.byteOffset,decode.stdout.byteLength);
    let squared=0;for(let i=128;i<pcm.length;i++)squared+=(out.getInt16(i*2,true)-pcm[i])**2;
    expect(Math.sqrt(squared/(pcm.length-128))).toBeLessThan(200);
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test("native player validates source and volume before bounded handoff",()=>{
  const source={host:"192.168.1.2",port:9000,token:"a".repeat(64)},calls:unknown[]=[];
  const ops={open:(...args:unknown[])=>{calls.push(args);return true;},close(){},paused(){},volume(v:number){calls.push(v);},texture:()=>7,status:()=>'{"phase":"idle"}'};
  expect(mediaPlayer(ops).open(source)).toBe(true);
  expect(validMediaSource({...source,host:"192.168.999.1"})).toBe(false);
  expect(()=>mediaPlayer(ops).open({...source,token:"short"})).toThrow();
  mediaPlayer(ops).volume(2);mediaPlayer(ops).volume(NaN);
  expect(calls.slice(-2)).toEqual([1,0]);
});

test("one-use media ticket delivers a bounded stream and rejects reuse",async()=>{
  const server=await createMediaStreamServer({advertiseHost:"127.0.0.1"});
  const source=server.publish(mediaHeader(0,1000),async function*(){yield {kind:1,ptsMs:0,data:Uint8Array.of(0,0,1,0x65)};});
  const receive=()=>new Promise<Buffer>((resolve,reject)=>{
    const socket=createConnection(source.port,source.host,()=>socket.write(source.token));
    const chunks:Buffer[]=[];socket.on("data",chunk=>chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk));socket.on("error",reject);
    socket.on("close",()=>resolve(Buffer.concat(chunks)));
  });
  try { const bytes=await receive();expect(bytes.readUInt32LE(0)).toBe(MEDIA.magic);expect(bytes[32]).toBe(1);expect(bytes[52]).toBe(3);expect((await receive()).length).toBe(0); }
  finally { server.close(); }
});

test("disconnect aborts a producer while socket backpressure bounds its work",async()=>{
  const server=await createMediaStreamServer({advertiseHost:"127.0.0.1"});
  let abort:AbortSignal|undefined,produced=0;
  const source=server.publish(mediaHeader(0,1000000),async function*(signal){
    abort=signal;
    while(!signal.aborted) {produced++;yield {kind:1,ptsMs:0,data:new Uint8Array(MEDIA.packetBytes)};}
  });
  const socket=createConnection(source.port,source.host,()=>socket.write(source.token));socket.on("error",()=>{});
  socket.pause();
  try {
    await Bun.sleep(100);expect(produced).toBeGreaterThan(0);expect(produced).toBeLessThanOrEqual(MEDIA.packetCredits+1);
    socket.destroy();await Bun.sleep(100);expect(abort?.aborted).toBe(true);
  } finally {socket.destroy();server.close();}
});
