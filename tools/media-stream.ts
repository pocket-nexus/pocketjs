/** Companion bulk-media endpoint. A one-use ticket binds a native consumer to
 * one stream. Consumer credits bound producer work; disconnect aborts it. */
import { createServer, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { MEDIA, MEDIA_CODEC, MEDIA_PACKET, type MediaCodec, type MediaSource } from "../contracts/spec/media.ts";
export { MEDIA_PACKET };
export interface MediaPacket { kind: number; ptsMs: number; data: Uint8Array }
export function mediaHeader(originMs: number, durationMs: number, fps = 30, codec: MediaCodec = "h264"): Buffer {
  if (![originMs, durationMs, fps].every(Number.isInteger) || originMs < 0 || durationMs < 0 || fps < 1 || fps > 60) throw new Error("Invalid media timing");
  const out=Buffer.alloc(MEDIA.headerBytes);
  out.writeUInt32LE(MEDIA.magic,0); out.writeUInt16LE(MEDIA.version,4); out.writeUInt16LE(MEDIA.headerBytes,6);
  out.writeUInt16LE(MEDIA.width,8); out.writeUInt16LE(MEDIA.height,10); out.writeUInt16LE(fps,12); out.writeUInt16LE(MEDIA_CODEC[codec],14);
  out.writeUInt32LE(MEDIA.sampleRate,16); out.writeUInt16LE(MEDIA.channels,20); out.writeUInt16LE(2,22);
  out.writeUInt32LE(originMs,24); out.writeUInt32LE(durationMs,28);
  return out;
}
/** The PAL8 palette producers use: a 6x7x6 RGB cube (252 colours), so an
 *  unchanged pixel keeps its index from frame to frame and the runs of a
 *  PAL8 packet stay short. */
export const PAL8_CUBE: Uint16Array = (() => {
  const out = new Uint16Array(252);
  for (let r = 0; r < 6; r++) for (let g = 0; g < 7; g++) for (let b = 0; b < 6; b++) {
    const R = Math.round((r * 255) / 5), G = Math.round((g * 255) / 6), B = Math.round((b * 255) / 5);
    out[r * 42 + g * 6 + b] = ((R >> 3) << 11) | ((G >> 2) << 5) | (B >> 3);
  }
  return out;
})();
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16 - 0.5);

/** RGB24 rows to PAL8_CUBE indices with a 4x4 ordered dither: a still
 *  pixel dithers the same way every frame. */
export function quantizeCube(rgb: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 0, i = 0; y < height; y++) {
    const row = (y & 3) * 4;
    for (let x = 0; x < width; x++, i++) {
      const d = BAYER4[row + (x & 3)]!, o = i * 3;
      const r = Math.max(0, Math.min(5, Math.round((rgb[o]! * 5) / 255 + d)));
      const g = Math.max(0, Math.min(6, Math.round((rgb[o + 1]! * 6) / 255 + d)));
      const b = Math.max(0, Math.min(5, Math.round((rgb[o + 2]! * 5) / 255 + d)));
      out[i] = r * 42 + g * 6 + b;
    }
  }
  return out;
}

/** PAL8 packets (MEDIA_CODEC.pal8) for one stream. The encoder keeps the
 *  picture the console has, so a frame the producer skips leaves nothing
 *  out of step: the next packet carries every pixel that differs from what
 *  was last sent. */
export function createPal8Encoder(width: number, height: number, palette: Uint16Array = PAL8_CUBE) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MEDIA.width || height > MEDIA.height) throw new Error("Invalid PAL8 frame size");
  if (palette.length < 1 || palette.length > 256) throw new Error("Invalid PAL8 palette");
  const pixels = width * height, sent = new Uint8Array(pixels);
  let first = true;
  const varint = (out: number[], value: number) => {
    do { out.push((value & 127) | (value > 127 ? 128 : 0)); value >>>= 7; } while (value);
  };
  return {
    encode(indices: Uint8Array): Uint8Array {
      if (indices.length !== pixels) throw new Error("Invalid PAL8 frame");
      const runs: number[] = [];
      for (let i = 0; i < pixels; ) {
        let start = i;
        while (start < pixels && indices[start] === sent[start]) start++;
        if (start === pixels) {
          varint(runs, start - i);
          varint(runs, 0);
          break;
        }
        // The changed run [start, end) takes in gaps of up to three equal
        // pixels: copying them costs less than a new pair of counts.
        let end = start + 1, gap = 0;
        for (let k = start + 1; k < pixels; k++) {
          if (indices[k] !== sent[k]) {
            gap = 0;
            end = k + 1;
          } else if (++gap > 3) break;
        }
        varint(runs, start - i);
        varint(runs, end - start);
        for (let k = start; k < end; k++) runs.push(indices[k]!);
        i = end;
      }
      sent.set(indices);
      const colors = first ? palette.length : 0;
      first = false;
      const out = new Uint8Array(8 + colors * 2 + runs.length), view = new DataView(out.buffer);
      view.setUint16(0, width, true); view.setUint16(2, height, true); view.setUint16(4, colors, true);
      for (let k = 0; k < colors; k++) view.setUint16(8 + k * 2, palette[k]!, true);
      out.set(runs, 8 + colors * 2);
      return out;
    },
  };
}
export function mediaPacket(packet: MediaPacket): Buffer {
  const n=packet.data.byteLength;
  const valid=packet.kind===1 ? n>=4 && n<=MEDIA.packetBytes
    : packet.kind===2 ? n>=8 && n<=MEDIA.audioFrames+7
    : packet.kind===3 ? n===0 : packet.kind===4 && n>0 && n<=160;
  if (!valid || !Number.isInteger(packet.ptsMs) || packet.ptsMs<0) throw new Error("Invalid media packet");
  const out=Buffer.alloc(MEDIA.packetHeaderBytes+n);
  out[0]=packet.kind; out.writeUInt32LE(n,4); out.writeUInt32LE(packet.ptsMs,8);
  out.set(packet.data,MEDIA.packetHeaderBytes); return out;
}
async function write(socket: Socket, bytes: Uint8Array): Promise<void> {
  if(socket.destroyed) throw new Error("Media consumer disconnected");
  if(socket.write(bytes)) return;
  await new Promise<void>((resolve,reject)=>{
    const cleanup=()=>{socket.off("drain",drain);socket.off("close",close);socket.off("error",error);};
    const drain=()=>{cleanup();resolve();};
    const close=()=>{cleanup();reject(new Error("Media consumer disconnected"));};
    const error=(err:Error)=>{cleanup();reject(err);};
    socket.once("drain",drain);socket.once("close",close);socket.once("error",error);
  });
}
/** A ticket a consumer other than a socket took: the USB carrier
 *  (tools/companion/usb.ts) runs `produce` itself and paces it by the ring
 *  the console reads. `signal` aborts when the ticket is revoked. */
export interface MediaTicket {
  header: Buffer;
  produce: (signal: AbortSignal) => AsyncIterable<MediaPacket>;
  signal: AbortSignal;
  /** The consumer stopped: the stream no longer counts against capacity. */
  release(): void;
}
const servers = new Set<{ take(token: string): MediaTicket | undefined }>();
/** The ticket `token` names on any stream server in this process, once. */
export function takeMediaTicket(token: string): MediaTicket | undefined {
  for (const server of servers) {
    const ticket = server.take(token);
    if (ticket) return ticket;
  }
  return undefined;
}
/** A stream server on every interface. A ticket names `host` (default
 *  `advertiseHost`), the address its console reaches this machine at. */
export async function createMediaStreamServer(options: { advertiseHost?: string; port?: number; log?: (message: string) => void }) {
  type Ticket={ header:Buffer; produce:(signal:AbortSignal)=>AsyncIterable<MediaPacket>; expires:number };
  const tickets=new Map<string,Ticket>(), sockets=new Map<string,Socket>(), local=new Map<string,AbortController>();
  const connections=new Set<Socket>();
  const entry={
    take(token:string):MediaTicket|undefined {
      const ticket=tickets.get(token);
      if(!ticket) return undefined;
      tickets.delete(token);
      if(ticket.expires<Date.now()) return undefined;
      const abort=new AbortController(); local.set(token,abort);
      return { header:ticket.header, produce:ticket.produce, signal:abort.signal, release:()=>{ if(local.get(token)===abort) local.delete(token); } };
    },
  };
  const server=createServer(socket=>{
    connections.add(socket);socket.once("close",()=>connections.delete(socket));
    socket.setNoDelay(true); socket.setTimeout(10000,()=>socket.destroy());
    socket.on("error",()=>{});
    let offered=Buffer.alloc(0);
    const authenticate=(chunk:Buffer)=>{
      if(offered.length+chunk.length>MEDIA.tokenChars) return socket.destroy();
      offered=Buffer.concat([offered,chunk]);
      if(offered.length<MEDIA.tokenChars) return;
      socket.off("data",authenticate);
      const token=offered.toString("ascii"),ticket=tickets.get(token);
      tickets.delete(token);
      if(!ticket || ticket.expires<Date.now()) return socket.destroy();
      sockets.set(token,socket);socket.setTimeout(0);
      const abort=new AbortController();
      let credits=MEDIA.packetCredits, wake:(()=>void)|undefined;
      // Application credits also bound Bun's native socket queue, whose
      // writableLength need not account for every byte accepted by the OS.
      socket.on("data",chunk=>{
        for(const byte of chunk) {
          if(byte!==1 || credits>=MEDIA.packetCredits) return socket.destroy();
          credits++;
        }
        wake?.();wake=undefined;
      });
      socket.once("close",()=>{abort.abort();sockets.delete(token);wake?.();});
      void (async()=>{
        try {
          await write(socket,ticket.header);
          for await(const packet of ticket.produce(abort.signal)) {
            while(!credits && !abort.signal.aborted) await new Promise<void>(resolve=>{wake=resolve;});
            if(abort.signal.aborted) break;
            credits--;
            await write(socket,mediaPacket(packet));
          }
          if(!abort.signal.aborted) { await write(socket,mediaPacket({kind:MEDIA_PACKET.end,ptsMs:0,data:new Uint8Array()}));socket.end(); }
        } catch {
          options.log?.("Media producer failed; stream closed");
          // Detailed source errors belong in the provider log, not stream URLs.
          if(!socket.destroyed) socket.end(mediaPacket({kind:MEDIA_PACKET.error,ptsMs:0,data:new TextEncoder().encode("Media source failed")}));
        }
      })();
    };
    socket.on("data",authenticate);
  });
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(options.port??0,"0.0.0.0",()=>{server.off("error",reject);resolve();});});
  const address=server.address();
  if(!address || typeof address==="string") throw new Error("No media listener");
  servers.add(entry);
  return {
    publish(header:Buffer,produce:Ticket["produce"],host=options.advertiseHost):MediaSource {
      if(!host) throw new Error("Media stream needs the host its console reaches");
      for(const [token,ticket] of tickets) if(ticket.expires<Date.now()) tickets.delete(token);
      if(tickets.size+sockets.size+local.size>=4 || header.length!==MEDIA.headerBytes) throw new Error("Media stream capacity exceeded");
      const token=randomBytes(32).toString("hex"); tickets.set(token,{header,produce,expires:Date.now()+60000});
      return {host,port:address.port,token};
    },
    revoke(source:MediaSource) { tickets.delete(source.token);sockets.get(source.token)?.destroy();local.get(source.token)?.abort(); },
    close() { servers.delete(entry);tickets.clear();for(const socket of connections)socket.destroy();for(const abort of local.values())abort.abort();local.clear();server.close(); },
  };
}
