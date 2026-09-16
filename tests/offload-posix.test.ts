import { afterAll, expect, test } from "bun:test";
import { dlopen, ptr, FFIType } from "bun:ffi";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import { encodeOffloadRecord } from "../tools/offload-wire.ts";
const directory = mkdtempSync(join(tmpdir(), "pocket-posix-"));
const library = join(directory, process.platform === "darwin" ? "transport.dylib" : "transport.so");
const compile = Bun.spawnSync(["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-shared", "-fPIC", "-pthread",
  "hosts/shared/offload_posix.c", "-o", library], { stderr: "pipe" });
if (compile.exitCode) throw new Error(compile.stderr.toString());
const native = dlopen(library, {
  pocket_offload_start: { args: [FFIType.cstring, FFIType.u32], returns: FFIType.void },
  pocket_offload_stop: { args: [], returns: FFIType.void },
  pocket_offload_session: { args: [], returns: FFIType.u32 },
  pocket_offload_submit: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  pocket_offload_take: { args: [FFIType.ptr], returns: FFIType.u64 },
});
const key = "a".repeat(64), keyPath = join(directory, "key");
writeFileSync(keyPath, key, { mode: 0o600 });
const cpath = Buffer.from(`${keyPath}\0`), buffer = Buffer.alloc(4096);
const api = native.symbols;
const port = 28471;
afterAll(() => { api.pocket_offload_stop(); native.close(); rmSync(directory, { recursive: true, force: true }); });
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await Bun.sleep(5); }
  throw new Error("Timed out waiting for native transport");
}
async function socket(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connect({ port, host: "127.0.0.1" }, () => resolve(s)); s.on("error", reject);
  });
}
test("POSIX worker authenticates USB sessions, reassembles split UTF-8, bounds queues and rejects old generations", async () => {
  api.pocket_offload_start(ptr(cpath), port); await Bun.sleep(30);
  const wrong = await socket(); wrong.write("b".repeat(64));
  await new Promise<void>(resolve => wrong.on("close", () => resolve()));
  expect(api.pocket_offload_session()).toBe(0);
  const peer = await socket(); peer.write(key);
  await until(() => api.pocket_offload_session() > 0);
  const first = api.pocket_offload_session();
  const frame = encodeOffloadRecord('{"id":1,"payload":"你好"}');
  for (const byte of frame) { peer.write(Buffer.from([byte])); await Bun.sleep(1); }
  let length = 0;
  await until(() => (length = Number(api.pocket_offload_take(ptr(buffer)))) > 0);
  expect(buffer.toString("utf8", 0, length)).toBe('{"id":1,"payload":"你好"}');
  peer.write(frame);
  await Bun.sleep(30); // Leave one delivery queued across the disconnect.
  peer.destroy(); await until(() => api.pocket_offload_session() === 0);
  const reply = Buffer.from("reply");
  expect(api.pocket_offload_submit(ptr(reply), reply.length)).toBe(0);
  const second = await socket(); second.write(key);
  await until(() => api.pocket_offload_session() > first);
  expect(Number(api.pocket_offload_take(ptr(buffer)))).toBe(0);
  second.write(Buffer.from([0, 0, 32, 0]));
  await until(() => api.pocket_offload_session() === 0);
  second.destroy();
  const full = await socket(); full.write(key);
  await until(() => api.pocket_offload_session() > first);
  full.write(Buffer.concat(Array.from({ length: 9 }, () => frame)));
  await until(() => api.pocket_offload_session() === 0);
  full.destroy();
}, 10000);
