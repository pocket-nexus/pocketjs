/** Companion bulk-media endpoint. A one-use ticket binds a native consumer to
 * one stream. Consumer credits bound producer work; disconnect aborts it. */
import { createServer, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { MEDIA, MEDIA_PACKET, type MediaSource } from "../contracts/spec/media.ts";
export { MEDIA_PACKET };
export interface MediaPacket { kind: number; ptsMs: number; data: Uint8Array }
export function mediaHeader(originMs: number, durationMs: number, fps = 30): Buffer {
  if (![originMs, durationMs, fps].every(Number.isInteger) || originMs < 0 || durationMs < 0 || fps < 1 || fps > 60) throw new Error("Invalid media timing");
  const out=Buffer.alloc(MEDIA.headerBytes);
  out.writeUInt32LE(MEDIA.magic,0); out.writeUInt16LE(MEDIA.version,4); out.writeUInt16LE(MEDIA.headerBytes,6);
  out.writeUInt16LE(MEDIA.width,8); out.writeUInt16LE(MEDIA.height,10); out.writeUInt16LE(fps,12); out.writeUInt16LE(1,14);
  out.writeUInt32LE(MEDIA.sampleRate,16); out.writeUInt16LE(MEDIA.channels,20); out.writeUInt16LE(2,22);
  out.writeUInt32LE(originMs,24); out.writeUInt32LE(durationMs,28);
  return out;
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
export async function createMediaStreamServer(options: { advertiseHost: string; port?: number; log?: (message: string) => void }) {
  type Ticket={ header:Buffer; produce:(signal:AbortSignal)=>AsyncIterable<MediaPacket>; expires:number };
  const tickets=new Map<string,Ticket>(), sockets=new Map<string,Socket>();
  const connections=new Set<Socket>();
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
  return {
    publish(header:Buffer,produce:Ticket["produce"]):MediaSource {
      for(const [token,ticket] of tickets) if(ticket.expires<Date.now()) tickets.delete(token);
      if(tickets.size+sockets.size>=4 || header.length!==MEDIA.headerBytes) throw new Error("Media stream capacity exceeded");
      const token=randomBytes(32).toString("hex"); tickets.set(token,{header,produce,expires:Date.now()+60000});
      return {host:options.advertiseHost,port:address.port,token};
    },
    revoke(source:MediaSource) { tickets.delete(source.token);sockets.get(source.token)?.destroy(); },
    close() { tickets.clear();for(const socket of connections)socket.destroy();server.close(); },
  };
}
