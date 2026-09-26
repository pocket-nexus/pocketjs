import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeOffloadImage } from "../tools/offload-wire.ts";
import { dispatchOffload, connectOffloadProvider } from "../tools/offload-provider.ts";
import { createOffloadClient } from "../framework/src/offload.ts";
import { createResourceScheduler } from "../framework/src/resource-cache.ts";
import { createResourceRuntime, createResourceView } from "../framework/src/resource-view.ts";
import { createPackedImageCollection } from "../apps/manga/pack-client.ts";

for (const isolation of ["thread", "process"] as const) test(`actual native worker receives binary images from the ${isolation} provider transport and reconnects after realm reset`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "pocket-native-"));
  const server = Bun.serve({ port: 0, fetch: () => new Response("") }); const port = server.port!; server.stop(true);
  const key = randomBytes(32).toString("hex"), keyPath = join(directory, "pair.key"); writeFileSync(keyPath, key, { mode: 0o600 });
  let provider: ReturnType<typeof connectOffloadProvider> | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const binary = join(directory, "native");
    const compile = Bun.spawnSync(["cc", "-std=c11", "-O2", "-pthread", "-fsanitize=address,undefined", "-Itests/fixtures/offload-native", `-DPOCKETJS_OFFLOAD_KEY="${keyPath}"`, `-DPOCKETJS_OFFLOAD_PORT=${port}`,
      "tests/fixtures/offload-native/main.c", "hosts/3ds/src/offload.c", "-o", binary]);
    if (compile.exitCode) throw new Error(compile.stderr.toString());
    const process = Bun.spawn([binary], { stdout: "pipe", stderr: "pipe" }); child = process;
    provider = connectOffloadProvider({ address: "127.0.0.1", port, key, worker: new URL("./fixtures/offload-native/worker.ts", import.meta.url), data: {}, isolation });
    const [status, output, error] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    if (status) throw new Error(error); expect(output).toContain("realm-reset reconnect passed");
  } finally { provider?.close(); child?.kill(); rmSync(directory, { recursive: true }); }
}, 15000);

test("native image staging survives malformed envelopes, full credit, token reuse and concurrent transfer", () => {
  const directory = mkdtempSync(join(tmpdir(), "pocket-images-"));
  try {
    const binary = join(directory, "images");
    const compile = Bun.spawnSync(["cc", "-std=c11", "-O2", "-pthread", "-fsanitize=address,undefined", "tests/fixtures/offload-images.c", "-o", binary]);
    if (compile.exitCode) throw new Error(compile.stderr.toString());
    const run = Bun.spawnSync([binary]); if (run.exitCode) throw new Error(run.stderr.toString());
    expect(run.stdout.toString()).toContain("4000 binary images verified");
  } finally { rmSync(directory, { recursive: true }); }
});
test("binary response extension requires opt-in and exact bounded pixels", async () => {
  const image = { width: 16, height: 32, pixels: new Uint8Array(16 * 32 * 2), format: "r5g6b5" as const };
  const bytes = encodeOffloadImage(42, image);
  expect(bytes.readUInt32BE()).toBe(0x80000000 + 16 + image.pixels.length);
  expect(bytes.toString("ascii", 4, 8)).toBe("PIMG"); expect(bytes.readUInt32LE(8)).toBe(42);
  expect(bytes.readUInt16LE(12)).toBe(16); expect(bytes.readUInt16LE(14)).toBe(32);
  for (const width of [0, 15, 17, 512, Infinity]) expect(() => encodeOffloadImage(1, { ...image, width })).toThrow();
  expect(() => encodeOffloadImage(0, image)).toThrow();
  expect(() => encodeOffloadImage(1, { ...image, pixels: new Uint8Array(1) })).toThrow();
  const request = { v: 1 as const, id: 1, method: "tile", payload: "{}" };
  expect(await dispatchOffload({ tile: () => image }, request)).toHaveProperty("error");
  expect(await dispatchOffload({ tile: () => image }, { ...request, response: "image" })).toHaveProperty("image", image);
});
function rig() {
  let session = 1, uploaded = 0;
  const sent: string[] = [], replies: string[] = [], released: number[] = [];
  const client = createOffloadClient({ session: () => session, submit: raw => { sent.push(raw); return true; }, take: () => replies.shift(),
    uploadImage: () => ++uploaded, releaseImage: token => released.push(token) });
  return { client, sent, replies, released, uploaded: () => uploaded, disconnect: () => session = -1,
    reply(id: number, token: number) { replies.push(JSON.stringify({ id, image: { token, width: 16, height: 16 } })); } };
}
test("cancelled, stale and unrequested images return staging without uploading pixels", () => {
  const r = rig(); let delivered = 0;
  const id = r.client.requestImage("tile", "{}", () => delivered++);
  r.client.step(); expect(JSON.parse(r.sent[0]).response).toBe("image");
  r.client.cancel(id); r.reply(id, 8); r.client.step();
  const next = r.client.requestImage("tile", "{}", () => delivered++); r.client.step();
  r.disconnect(); r.reply(next, 16); r.client.step();
  expect(r.released).toEqual([8, 16]); expect(r.uploaded()).toBe(0); expect(delivered).toBe(1);
});
test("image collection releases raw staging on withdrawn demand before materialization", () => {
  createRoot(dispose => {
    const r = rig(), runtime = createResourceRuntime({ maxConcurrent: 1, maxCollections: 1, startsPerFrame: 1, completionsPerFrame: 1 });
    const images = createPackedImageCollection(runtime, { key: (i: string) => i, pack: () => undefined, fallback: { client: r.client, method: "tile", payload: i => i }, width: 16, height: 16, maxEntries: 2, maxViews: 1 });
    let wanted = true;
    createResourceView(images, { demand: () => wanted ? [{ input: "one", priority: 0 }] : [] });
    runtime.step(); r.client.step(); r.reply(JSON.parse(r.sent[0]).id, 8); r.client.step();
    wanted = false; runtime.step(); expect(r.released).toEqual([8]); expect(r.uploaded()).toBe(0);
    dispose(); expect(r.released).toEqual([8]);
  });
});
test("response cleanup covers success, materialize failure, oversized and late response", () => {
  const released: string[] = [], callbacks: ((value: any) => void)[] = [];
  const scheduler = createResourceScheduler({ maxConcurrent: 1, maxCollections: 1, startsPerFrame: 1, completionsPerFrame: 1 });
  const cache = scheduler.createCache<string, string, string>({ key: (s: string) => s, maxEntries: 2, maxCost: 2, cost: () => 1, maxResponseBytes: 16,
    load: (_, done) => { callbacks.push(done); return { cancel() {} }; }, materialize(raw: string) { if (raw === "fail") throw new Error("upload"); return raw; }, releaseResponse: raw => released.push(raw) });
  const demand = (input: string) => [{ input, priority: 0 }];
  cache.reconcile(demand("a")); scheduler.step(); callbacks[0]({ ok: true, value: "ok" }); scheduler.step();
  cache.reconcile(demand("b")); scheduler.step(); callbacks[1]({ ok: true, value: "fail" }); scheduler.step();
  cache.reconcile(demand("c")); scheduler.step(); callbacks[2]({ ok: true, value: "oversized" }); scheduler.step();
  cache.reconcile(demand("d")); scheduler.step(); cache.clear(); callbacks[3]({ ok: true, value: "late" });
  expect(released).toEqual(["ok", "fail", "oversized", "late"]); scheduler.dispose();
});
