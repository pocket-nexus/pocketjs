import { expect, test } from "bun:test";
import { createConnection } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MEDIA, validMediaSource } from "../contracts/spec/media.ts";
import { encodeMediaAudio } from "../contracts/spec/media-adpcm.ts";
import { createMediaScrubber, mediaPlayer } from "../framework/src/media.ts";
import { createMediaStreamServer, mediaHeader, mediaPacket } from "../tools/media-stream.ts";

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
    const compile=Bun.spawnSync(["cc","-std=c11","-I",resolve("hosts/3ds/src"),join(directory,"check.c"),"-o",join(directory,"check")]);
    expect(compile.exitCode,compile.stderr.toString()).toBe(0);
    expect(Bun.spawnSync([join(directory,"check"),join(directory,"wire.bin")]).exitCode).toBe(0);
    expect(()=>mediaPacket({kind:1,ptsMs:0,data:new Uint8Array(MEDIA.packetBytes+1)})).toThrow();
    expect(()=>mediaPacket({kind:2,ptsMs:0,data:new Uint8Array(3)})).toThrow();
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
    const compile=Bun.spawnSync(["cc","-std=c11","-I",resolve("hosts/3ds/src"),join(directory,"audio.c"),"-o",join(directory,"audio")]);
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
