import { expect, test } from "bun:test";
import { createConnection } from "node:net";
import { MEDIA, MEDIA_CODEC, validMediaSource } from "../contracts/spec/media.ts";
import { encodeMediaAudio } from "../contracts/spec/media-adpcm.ts";
import { createMediaScrubber, mediaPlayer } from "../framework/src/media.ts";
import { createMediaStreamServer, createPal8Encoder, mediaHeader, mediaPacket, quantizeCube } from "../tools/media-stream.ts";

test("the producer writes the header and packet layouts and refuses malformed lengths", () => {
  const header=mediaHeader(1234,90000), video=mediaPacket({kind:1,ptsMs:1234,data:Uint8Array.of(0,0,1,0x65)});
  expect(header.length).toBe(32);expect(header.readUInt32LE(0)).toBe(MEDIA.magic);expect(header.readUInt32LE(24)).toBe(1234);
  expect(video.length).toBe(16+4);expect(video[0]).toBe(1);expect(video.readUInt32LE(8)).toBe(1234);
  expect(()=>mediaPacket({kind:1,ptsMs:0,data:new Uint8Array(MEDIA.framePacketBytes+1)})).toThrow();
  expect(()=>mediaPacket({kind:2,ptsMs:0,data:new Uint8Array(3)})).toThrow();
});

test("PAL8 sends the palette once, then deltas, and refuses frames of another size",()=>{
  const w=37,h=11,encoder=createPal8Encoder(w,h);
  const first=new Uint8Array(w*h); for(let i=0;i<first.length;i++) first[i]=(i*7)%252;
  const second=first.slice(); for(let i=40;i<52;i++) second[i]=(second[i]!+1)%252; second[w*h-1]=3;
  const third=second.slice();
  const packets=[first,second,third].map(frame=>encoder.encode(frame));
  expect(new DataView(packets[0]!.buffer).getUint16(4,true)).toBe(252);
  expect(new DataView(packets[1]!.buffer).getUint16(4,true)).toBe(0);
  expect(packets[1]!.length).toBeLessThan(40);
  expect(packets[2]!.length).toBe(8+3);
  expect(mediaHeader(0,1000,12,"pal8").readUInt16LE(14)).toBe(MEDIA_CODEC.pal8);
  expect(()=>createPal8Encoder(600,3)).toThrow();
  expect(()=>encoder.encode(new Uint8Array(3))).toThrow();
  const rgb=new Uint8Array(4*4*3).fill(255);
  expect([...quantizeCube(rgb,4,4)]).toEqual(new Array(16).fill(251));
});

test("scrubbing previews locally and commits one seek; cancelled drags issue none",()=>{
  const seeks:number[]=[],scrub=createMediaScrubber(s=>seeks.push(s));
  scrub.begin(.1,120);for(let n=0;n<100;n++)scrub.move(n/100,120);
  expect(seeks).toEqual([]);expect(scrub.preview()).toBe(118.8);
  scrub.commit();scrub.commit();expect(seeks).toEqual([118.8]);
  scrub.begin(.5,120);scrub.cancel();scrub.commit();expect(seeks).toHaveLength(1);
});

test("a stereo ADPCM block carries 1024 frames at one quarter of PCM bandwidth",()=>{
  const pcm=new Int16Array(MEDIA.audioFrames*2);
  for(let i=0;i<MEDIA.audioFrames;i++) {pcm[i*2]=Math.sin(i*.1)*10000;pcm[i*2+1]=Math.cos(i*.13)*8000;}
  const block=encodeMediaAudio(new Uint8Array(pcm.buffer));
  expect(pcm.byteLength).toBe(4096);
  expect(block.length).toBe(1031);
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
