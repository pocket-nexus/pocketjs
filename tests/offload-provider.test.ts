import { test, expect } from "bun:test";
import { createServer, type Socket } from "node:net";
import { connectOffloadProvider } from "../tools/offload-provider.ts";
import { OffloadDecoder, encodeOffloadRecord } from "../tools/offload-wire.ts";
import type { OffloadReply } from "../contracts/spec/offload.ts";

test("slow writes preserve bounded duplex admission instead of stopping healthy work", async () => {
  const child = Bun.spawn([process.execPath, new URL("./fixtures/offload-native/duplex-credit.ts", import.meta.url).pathname],
    { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, error: err }).toEqual({ code: 0, error: "" });
  expect(out).toContain("20 intact images; eight total reservations; no disconnect");
}, 10000);

function queue<T>() {
  const values: T[] = [], pending: ((value: T) => void)[] = [];
  return { push(value: T) { const take = pending.shift(); if (take) take(value); else values.push(value); },
    take(): Promise<T> { if (values.length) return Promise.resolve(values.shift()!); return new Promise(resolve => pending.push(resolve)); } };
}
async function rig(url = "", binaryReplies = false) {
  const key = "ab".repeat(32), peers = queue<{ socket: Socket; read(): Promise<OffloadReply>; send(method: string, id?: number): void }>();
  const sockets = new Set<Socket>(), logs: string[] = [];
  const server = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
    let prefix = Buffer.alloc(0), paired = false, imageBuffer = Buffer.alloc(0);
    const decoder = new OffloadDecoder(), replies = queue<OffloadReply>();
    socket.on("data", data => {
      let bytes = Buffer.from(data);
      if (!paired) {
        prefix = Buffer.concat([prefix, bytes]); if (prefix.length < 64) return;
        expect(prefix.subarray(0, 64).toString()).toBe(key); paired = true; bytes = prefix.subarray(64);
        peers.push({ socket, read: replies.take, send(method, id = 1) { socket.write(encodeOffloadRecord(JSON.stringify({ v: 1, id, method, payload: "{}" }))); } });
      }
      if (binaryReplies) {
        imageBuffer = Buffer.concat([imageBuffer, bytes]);
        while (imageBuffer.length >= 4) {
          const size = imageBuffer.readUInt32BE() & 0x7fffffff; expect(size).toBeLessThanOrEqual(131088);
          if (imageBuffer.length < size + 4) break;
          const frame = imageBuffer.subarray(4, size + 4);
          const id = frame.readUInt32LE(4); expect(frame.length).toBe(131088);
          for (let n = 16; n < frame.length; n++) if (frame[n] !== (id & 255)) throw new Error("Corrupt image under backpressure");
          replies.push({ id }); imageBuffer = imageBuffer.subarray(size + 4);
        }
      } else decoder.push(bytes, raw => { replies.push(JSON.parse(raw)); });
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const provider = connectOffloadProvider({ address: "127.0.0.1", port, key, isolation: "process", data: { url },
    worker: new URL("./fixtures/offload-native/process-worker.ts", import.meta.url), log: line => logs.push(line) });
  return { next: peers.take, logs, async close() {
    provider.close(); for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

test("a provider process crash cannot kill the transport; request IDs can restart without replay", async () => {
  const r = await rig();
  try {
    const first = await r.next(); first.send("test.pid"); const pid = Number((await first.read()).payload);
    expect(pid).not.toBe(process.pid);
    first.send("test.crash", 2);
    const second = await r.next(); second.send("test.pid"); const replacement = await second.read();
    expect(replacement.id).toBe(1); expect(Number(replacement.payload)).not.toBe(pid);
    expect(r.logs.some(line => line.includes("provider process exited"))).toBe(true);
  } finally { await r.close(); }
}, 10000);

test("repeated disconnects during in-flight fetches reap providers and fence old replies", async () => {
  const starts = queue<void>();
  const http = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { starts.push(); return new Promise<Response>(() => {}); } });
  const r = await rig(String(http.url)); const pids = new Set<number>();
  try {
    for (let n = 0; n < 8; n++) {
      const peer = await r.next(); peer.send("test.pid"); const pid = Number((await peer.read()).payload); pids.add(pid);
      peer.send("test.fetch", 2); await starts.take();
      const closed = new Promise<void>(resolve => peer.socket.once("close", resolve)); peer.socket.destroy(); await closed;
    }
    const final = await r.next(); final.send("test.pid"); expect((await final.read()).id).toBe(1);
    expect(pids.size).toBe(8);
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  } finally { await r.close(); http.stop(true); }
}, 25000);

test("a wedged provider has a bounded deadline and its work is not replayed", async () => {
  const r = await rig();
  try {
    const peer = await r.next(); peer.send("test.hang");
    const next = await r.next(); next.send("test.pid"); expect((await next.read()).id).toBe(1);
    expect(r.logs.some(line => line.includes("request deadline: test.hang id=1"))).toBe(true);
  } finally { await r.close(); }
}, 15000);

test("a slow device drains a burst of images without backlog disconnects or lost requests", async () => {
  const r = await rig("", true);
  try {
    const peer = await r.next(); peer.socket.pause();
    const records = Array.from({ length: 64 }, (_, n) => encodeOffloadRecord(JSON.stringify({ v: 1, id: n + 1, method: "test.image", payload: "{}", response: "image" })));
    peer.socket.write(Buffer.concat(records));
    await Bun.sleep(500); peer.socket.resume();
    const seen = new Set<number>();
    for (let n = 0; n < 64; n++) seen.add((await peer.read()).id);
    expect(seen.size).toBe(64); expect(r.logs.filter(line => line.includes("transport connected;")).length).toBe(1);
    expect(r.logs.some(line => line.includes("disconnected:"))).toBe(false);
  } finally { await r.close(); }
}, 10000);

test("offload worker readiness survives shared sessions and reconnect creates a fresh worker", async () => {
  const key = "ab".repeat(32), sockets = new Set<Socket>();
  const replies: unknown[] = [];
  let connections = 0, finish!: () => void;
  const done = new Promise<void>(resolve => {finish = resolve;});
  const server = createServer(socket => {
    const generation = ++connections;
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    let auth = Buffer.alloc(0), paired = false;
    const decoder = new OffloadDecoder();
    socket.on("data", rawChunk => {
      let chunk = typeof rawChunk === "string" ? Buffer.from(rawChunk) : rawChunk;
      if (!paired) {
        auth = Buffer.concat([auth, chunk]);
        if (auth.length < 64) return;
        expect(auth.subarray(0,64).toString()).toBe(key);
        chunk = auth.subarray(64); paired = true;
        socket.write(encodeOffloadRecord(JSON.stringify({v:1,id:1,method:"test.echo",payload:`session-${generation}`})));
      }
      decoder.push(chunk, raw => {
        replies.push(JSON.parse(raw));
        if (generation === 1) socket.destroy(); else finish();
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listen failed");
  const provider = connectOffloadProvider({address:"127.0.0.1",port:address.port,key,
    worker:new URL("./fixtures/offload-ready-worker.ts",import.meta.url)});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([done, new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("provider reconnect timeout")),4500)})]);
    expect(connections).toBe(2);
    expect(replies).toEqual([{id:1,payload:"1:session-1"},{id:1,payload:"1:session-2"}]);
  } finally {
    clearTimeout(timer);provider.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(()=>resolve()));
  }
}, 6000);
