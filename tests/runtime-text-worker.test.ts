import { expect, test } from "bun:test";
import { runtimeEngine, runtimeFontPaths, runtimeWorker } from "./helpers/runtime-text-worker.ts";
import { resolve } from "node:path";
import { mkdtemp, readFile, writeFile, rm, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectOffloadUsbProvider, usbHash, usbPacket, usbSlot } from "../tools/offload-usb-provider.ts";
import { createWasmUi } from "../hosts/web/wasm-ops.js";
import { createRuntimeFont } from "../framework/src/runtime-fonts.ts";
import { createOffloadClient } from "../framework/src/offload.ts";
import { runServicePumps } from "../framework/src/services.ts";
import { NODE_TYPE, PROP } from "../contracts/spec/spec.ts";
import { readTextWorkerFonts } from "../tools/text-worker-assets.ts";
import { TEXT_WORKER_ASSETS } from "../tools/text-assets.ts";

const font = { family: "Inter", size: 24, fallback: ["Pocket CJK Test"] };
test("worker deployment includes its FreeType module, wasm and license", async () => {
  for (const asset of TEXT_WORKER_ASSETS) expect(await Bun.file(`hosts/web/${asset}`).exists(), asset).toBe(true);
  const source = await Bun.file("hosts/web/text-engine.js").text();
  for (const match of source.matchAll(/["']\.\/([^"']+)["']/g)) expect(TEXT_WORKER_ASSETS as readonly string[]).toContain(match[1]);
  expect(await Bun.file("site/build.ts").text()).toContain("for (const name of TEXT_WORKER_ASSETS)");
});
test("worker source budget refuses oversized font files before reading coverage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pocket-font-source-")), path = join(directory, "huge.ttf");
  try {
    const file = await open(path, "w"); await file.truncate(32 * 1024 * 1024 + 1); await file.close();
    const error = await readTextWorkerFonts([path]).catch(e => e);
    expect(error).toBeInstanceOf(Error); expect(error.message).toContain("budget");
    expect(await readTextWorkerFonts([runtimeFontPaths[0], runtimeFontPaths[0]])).toHaveLength(1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
async function page(worker: { request(method: string, value: unknown): any }, layout: number, kind: string) {
  const result: any[] = [];
  let offset: number | null = 0;
  do {
    const response = await worker.request("runtime.layout.page", { layout, kind, offset });
    result.push(...response.items); offset = response.next;
  } while (offset !== null);
  return result;
}

test("real WASM worker shapes fallback, ligatures and combining carets before grayscale resources", async () => {
  const worker = await runtimeWorker();
  try {
    expect((await worker.request("runtime.fonts")).families).toContain("Pocket CJK Test");
    const instance = await worker.request("runtime.font", { ...font, family: "Pocket Ligature Test" });
    const text = "AV office e\u0301 你好";
    const shaped = await worker.request("runtime.shape", { font: instance.font, text });
    expect(shaped.missing).toBe(0);
    expect(shaped.glyphs).toBeLessThan(Array.from(text).length);
    const layout = await worker.request("runtime.layout", { shape: shaped.shape, width: 120 });
    await worker.request("runtime.lease", { layout: layout.layout, action: "pin" });
    const glyphs = await page(worker, layout.layout, "glyphs");
    expect(glyphs.some(g => text.slice(g[4], g[5]) === "ffi")).toBe(true);
    const carets = await page(worker, layout.layout, "carets");
    expect(carets.map(c => c[0])).not.toContain(text.indexOf("\u0301"));
    expect(layout.rows).toBeGreaterThan(1);
    let hasGray = false;
    for (const glyph of new Set(glyphs.map(g => g[0]))) {
      const bitmap = await worker.request("runtime.glyph", { glyph });
      expect(bitmap.total).toBe(bitmap.width * bitmap.height);
      const bytes = Buffer.from(bitmap.coverage, "base64");
      hasGray ||= bytes.some(b => b > 0 && b < 255);
    }
    expect(hasGray).toBe(true);
    const before = await worker.request("runtime.stats");
    await worker.request("runtime.budget", { bitmap: 0 });
    expect(await page(worker, layout.layout, "glyphs")).toEqual(glyphs);
    expect(await page(worker, layout.layout, "carets")).toEqual(carets);
    const wider = await worker.request("runtime.layout", { shape: shaped.shape, width: 300 });
    expect(wider.rows).toBeLessThan(layout.rows);
    const after = await worker.request("runtime.stats");
    expect(after.shapeCount).toBe(before.shapeCount);
    expect(after.bitmap.bytes).toBe(0);
    const refused = await worker.request("runtime.glyph", { glyph: glyphs[0][0] }).catch(error => error);
    expect(refused).toBeInstanceOf(Error);
    expect(refused.message).toContain("budget");
    expect((await worker.request("runtime.stats")).shapeCount).toBe(after.shapeCount);
    await worker.request("runtime.lease", { layout: layout.layout, action: "release" });
  } finally { worker.close(); }
}, 30000);

test("worker -> prepareText -> core Text paints one layout and preserves it across color, width and bitmap eviction", async () => {
  const worker = await runtimeWorker(), wasm = await createWasmUi(await Bun.file("hosts/web/pocketjs.wasm").arrayBuffer());
  const replies: string[] = [];
  const client = createOffloadClient({ session: () => 1, take: () => replies.shift(), submit(raw) {
    const r = JSON.parse(raw);
    worker.request(r.method, JSON.parse(r.payload)).then(value => replies.push(JSON.stringify({ id: r.id, payload: JSON.stringify(value) })),
      error => replies.push(JSON.stringify({ id: r.id, error: String(error) })));
    return true;
  } });
  const font = createRuntimeFont({ family: "Pocket Ligature Test", size: 24, fallback: ["Pocket CJK Test"] }, wasm.ops, client);
  const node = wasm.ops.createNode(NODE_TYPE.text);
  wasm.ops.setProp(node, PROP.textColor, 0xffffffff); wasm.ops.insertBefore(1, node, 0);
  const original = font.prepareText("AV office e\u0301 你好", { width: 100 });
  let wide: ReturnType<typeof font.prepareText> | undefined;
  let largeFont: ReturnType<typeof createRuntimeFont> | undefined, large: typeof original | undefined;
  const settle = async (batch: typeof original) => {
    for (let frame = 0; frame < 1000 && batch.state().status === "pending"; frame++) {
      client.step(); runServicePumps(); wasm.tick(); await Bun.sleep(1);
    }
    const state = batch.state();
    expect(state.status, state.status === "error" ? String(state.error) : "timed out").toBe("ready");
    if (state.status !== "ready") throw Error("Not ready");
    return state.value;
  };
  try {
    const prepared = await settle(original), layout = original.layout()!;
    expect(prepared.paint!(node)).toBe(true); wasm.tick();
    const pixels = Uint8Array.from(wasm.render());
    expect(pixels.some((b, i) => i % 4 !== 3 && b > 0)).toBe(true);
    const baseline = wasm.drawHash!();
    await worker.request("runtime.budget", { bitmap: 0 });
    wasm.tick(); expect(wasm.drawHash!()).toBe(baseline); expect(Uint8Array.from(wasm.render())).toEqual(pixels);
    expect(original.layout()).toBe(layout);
    const stats = await worker.request("runtime.stats");
    wasm.ops.setProp(node, PROP.textColor, 0xff0088ff); wasm.tick();
    expect(wasm.drawHash!()).not.toBe(baseline);
    expect(original.layout()).toBe(layout);
    expect((await worker.request("runtime.stats")).layoutCount).toBe(stats.layoutCount);
    const uploads = font.stats().uploads;
    wide = font.prepareText(layout.text, { width: 400 });
    const next = await settle(wide);
    expect(wide.layout()!.rows.length).toBeLessThan(layout.rows.length);
    expect(font.stats().uploads).toBe(uploads);
    expect((await worker.request("runtime.stats")).shapeCount).toBe(stats.shapeCount);
    expect(next.paint!(node)).toBe(true);
    await worker.request("runtime.budget", { bitmap: 2 * 1024 * 1024 });
    largeFont = createRuntimeFont({ family: "Pocket Ligature Test", size: 48, fallback: ["Pocket CJK Test"] }, wasm.ops, client);
    large = largeFont.prepareText(layout.text, { width: 400 });
    await settle(large);
    expect(large.layout()!.font.font).not.toBe(layout.font.font);
    const ids = new Set(layout.glyphs.map(g => g[0]));
    expect(large.layout()!.glyphs.every(g => !ids.has(g[0]))).toBe(true);
    expect(original.state().status).toBe("ready");
    expect(original.layout()).toBe(layout);
    expect(large.layout()!.height).toBeGreaterThan(wide.layout()!.height);
  } finally { original.dispose(); wide?.dispose(); large?.dispose(); largeFont?.dispose(); font.dispose(); client.dispose(); worker.close(); }
}, 30000);

test("native and WASM services produce identical geometry and stable IDs", async () => {
  const engine = await runtimeEngine();
  const requests = [
    ["runtime.font", font],
    ["runtime.shape", { font: 1, text: "AV office e\u0301 你好" }],
    ["runtime.layout", { shape: 1, width: 110 }],
    ["runtime.layout.page", { layout: 1, kind: "glyphs", offset: 0 }],
    ["runtime.layout.page", { layout: 1, kind: "carets", offset: 0 }],
  ] as const;
  const records = requests.map(([method, data], i) => JSON.stringify({ v: 1, id: i + 1, method, payload: JSON.stringify(data) })).join("\n") + "\n";
  const native = Bun.spawnSync({ cmd: [resolve("engine/crates/pocket-text/target/release/examples/runtime_probe"), ...runtimeFontPaths], stdin: Buffer.from(records), stdout: "pipe", stderr: "pipe" });
  expect(native.exitCode, native.stderr.toString()).toBe(0);
  const replies = native.stdout.toString().trim().split("\n").map(line => JSON.parse(line));
  expect(replies).toHaveLength(requests.length);
  requests.forEach(([method, data], i) => {
    expect(replies[i].error).toBeUndefined();
    expect(JSON.parse(replies[i].payload)).toEqual(engine.request(method, data));
  });
}, 30000);

test("PSP USB companion carries runtime shaping and gray8 pages through its generation fence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pocket-runtime-usb-"));
  const app = "dev.pocket-stack.runtime-font-test";
  const root = join(directory, "pocket-offload", usbSlot(app));
  const provider = connectOffloadUsbProvider({ directory, app, worker: new URL("../tools/text-provider-worker.ts", import.meta.url),
    data: { wasm: resolve("hosts/web/pocket_text.wasm"), fonts: runtimeFontPaths } });
  const waitFile = async (name: string) => {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      try { return await readFile(join(root, name)); } catch { await Bun.sleep(10); }
    }
    throw Error(`USB timeout: ${name}`);
  };
  try {
    const ready = await waitFile("ready"), epoch = ready.readUInt32LE(4);
    let sequence = 0;
    const request = async (method: string, data: unknown) => {
      const id = ++sequence;
      const payload = Buffer.from(JSON.stringify({ v: 1, id, method, payload: JSON.stringify(data) }));
      await writeFile(join(root, "req0"), usbPacket(epoch, 17, id, id, payload));
      let bytes: Buffer;
      const end = Date.now() + 10000;
      do { bytes = await waitFile("res0"); if (bytes.readUInt32LE(12) === id) break; await Bun.sleep(10); } while (Date.now() < end);
      expect(bytes.readUInt32LE(4)).toBe(epoch); expect(bytes.readUInt32LE(8)).toBe(17);
      expect(bytes.readUInt32LE(12)).toBe(id); expect(bytes.readUInt32LE(36)).toBe(usbHash(bytes.subarray(64)));
      const reply = JSON.parse(bytes.subarray(64).toString());
      expect(reply.error).toBeUndefined(); return JSON.parse(reply.payload);
    };
    const instance = await request("runtime.font", font);
    const shape = await request("runtime.shape", { font: instance.font, text: "你好 AV" });
    const layout = await request("runtime.layout", { shape: shape.shape, width: 480 });
    const glyphs = await request("runtime.layout.page", { layout: layout.layout, kind: "glyphs", offset: 0 });
    const bitmap = await request("runtime.glyph", { glyph: glyphs.items[0][0] });
    expect(bitmap.width * bitmap.height).toBeGreaterThan(0);
    expect(Buffer.from(bitmap.coverage, "base64").some(b => b > 0)).toBe(true);
  } finally { provider.close(); await rm(directory, { recursive: true, force: true }); }
}, 30000);
