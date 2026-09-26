// Run in its own process so the deterministic socket mock cannot affect the
// real TCP / native transport tests. The capability executor is a real process.
import { EventEmitter } from "node:events";
import { strict as assert } from "node:assert";
import { encodeOffloadRecord } from "../../../tools/offload-wire.ts";

class Socket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  paused = false;
  frames: number[] = [];
  input: Buffer[] = [];
  scheduled = false;
  setNoDelay() { return this; }
  setTimeout() { return this; }
  pause() { this.paused = true; return this; }
  resume() { this.paused = false; this.pump(); return this; }
  pump() {
    if (this.scheduled || this.paused || !this.input.length) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.paused && this.input.length) this.emit("data", this.input.shift()!);
    });
  }
  send(ids: number[]) {
    this.input.push(Buffer.concat(ids.map(id => encodeOffloadRecord(JSON.stringify({
      v: 1, id, method: "test.image", payload: "private-payload", response: "image",
    })))));
    this.pump();
  }
  write(bytes: string | Buffer) {
    if (typeof bytes === "string") return true; // Pairing key.
    assert.equal(bytes.readUInt32BE(0) >>> 31, 1);
    const id = bytes.readUInt32LE(8);
    assert.equal(bytes.length, 131092);
    assert(bytes.subarray(20).every(byte => byte === id));
    this.frames.push(id); this.writableLength = bytes.length;
    return false; // No write credit until the test's receiver drains it.
  }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit("close"); } return this; }
}

const socket = new Socket(), logs: string[] = [];
require("node:net").connect = () => { queueMicrotask(() => socket.emit("connect")); return socket; };
const { connectOffloadProvider } = await import("../../../tools/offload-provider.ts");
const provider = connectOffloadProvider({ address: "127.0.0.1", key: "ab".repeat(32),
  worker: new URL("./process-worker.ts", import.meta.url), isolation: "process", data: {},
  trace: true, log: line => logs.push(line) });
async function until(done: () => boolean) {
  const start = Date.now();
  while (!done()) { if (Date.now() - start > 2000) throw new Error("Fixture timed out"); await Bun.sleep(5); }
}
try {
  await until(() => logs.some(line => line.includes("transport connected;")));
  socket.send([1]); await until(() => socket.frames.length === 1);
  socket.send(Array.from({ length: 19 }, (_, n) => n + 2));
  // A blocked image must not prevent admitting other work within the shared
  // eight-request/reply/write budget. Replies themselves remain queued.
  await Bun.sleep(100);
  assert.equal(logs.filter(line => line.includes(": request id=")).length, 8,
    "blocked output should still admit seven jobs without exceeding total credit");
  assert.equal(socket.frames.length, 1);
  for (let n = 1; n < 20; n++) {
    socket.writableLength = 0; socket.emit("drain");
    await until(() => socket.frames.length > n);
  }
  socket.emit("drain");
  assert.equal(new Set(socket.frames).size, 20);
  assert.equal(logs.some(line => line.includes("private-payload")), false);
  assert.equal(logs.some(line => line.includes("disconnected:")), false);
  console.log("duplex credit: 20 intact images; eight total reservations; no disconnect");
} catch (error) { console.error(logs.join("\n")); throw error; }
finally { provider.close(); }
