/** Real text Worker + shared core software renderer; 60 Hz delivery gate.
 * Build text/core WASM first. Output records contain measured, not simulated, latency. */
import { createWasmUi } from "../hosts/web/wasm-ops.js";
import { createRuntimeFont } from "../framework/src/runtime-fonts.ts";
import { createOffloadClient } from "../framework/src/offload.ts";
import { runServicePumps } from "../framework/src/services.ts";
import { runtimeWorker } from "../tests/helpers/runtime-text-worker.ts";
import { bakeAtlases } from "../framework/compiler/bake-font.ts";
import { NODE_TYPE, PROP } from "../contracts/spec/spec.ts";
import type { PreparedText } from "../framework/src/fonts.ts";
import type { ResourceState } from "../framework/src/resource-state.ts";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const out = resolve(Bun.argv[Bun.argv.indexOf("--output") + 1] && Bun.argv.includes("--output")
  ? Bun.argv[Bun.argv.indexOf("--output") + 1] : ".pocket-build/validation/runtime-ttf/benchmark/ttf.json");
const cjk = Array.from({ length: 256 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join("");
const cases = [
  { name: "cold-latin", text: "AV office variable width e\u0301 你好", size: 16 },
  { name: "new-han-256", text: cjk, size: 16 },
  { name: "cache-overflow", text: cjk, size: 24, gpuBytes: 4096 },
  { name: "size-24", text: "AV office 你好", size: 24 },
  { name: "size-48", text: "AV office 你好", size: 48 },
  { name: "large-128", text: "AV你好", size: 128 },
  { name: "editing", text: "AV office 你好", size: 16, edits: 10 },
];
const core = await Bun.file("hosts/web/pocketjs.wasm").arrayBuffer();
const records: unknown[] = [];
const only = Bun.argv.find(arg => arg.startsWith("--only="))?.slice(7);
for (const scenario of cases.filter(c => !only || c.name === only)) {
  const workerStart = performance.now();
  const worker = await runtimeWorker();
  const workerStartupMs = performance.now() - workerStart;
  const wasm = await createWasmUi(core);
  const replies: string[] = [];
  let requests = 0, inflight = 0, requestWireBytes = 0, replyWireBytes = 0;
  const client = createOffloadClient({ session: () => 1, take: () => replies.shift(), submit(raw) {
    const r = JSON.parse(raw); requests++; inflight++; requestWireBytes += Buffer.byteLength(raw);
    const enqueue = (reply: unknown) => { const raw = JSON.stringify(reply); replyWireBytes += Buffer.byteLength(raw); replies.push(raw); };
    worker.request(r.method, JSON.parse(r.payload)).then(value => enqueue({ id: r.id, payload: JSON.stringify(value) }),
      error => enqueue({ id: r.id, error: String(error) })).finally(() => inflight--);
    return true;
  } });
  const font = createRuntimeFont({ family: "Inter", size: scenario.size, fallback: ["Pocket CJK Test"], gpuBytes: scenario.gpuBytes }, wasm.ops, client);
  const node = wasm.ops.createNode(NODE_TYPE.text);
  wasm.ops.setProp(node, PROP.textColor, 0xffffffff); wasm.ops.insertBefore(1, node, 0);
  let batch = font.prepareText(scenario.text, { width: 460 });
  let visible: PreparedText | undefined;
  const frames: number[] = [], visibleMs: number[] = [], slowFrames: unknown[] = [];
  const started = performance.now();
  let state: ResourceState<PreparedText> = batch.state();
  const awaitVisible = async () => {
    const start = performance.now();
    for (let frame = 0; frame < 3600; frame++) {
      const before = performance.now();
      client.step(); runServicePumps();
      const afterPump = performance.now();
      state = batch.state();
      if (state.status === "ready" && state.value !== visible) { state.value.paint!(node); visible = state.value; }
      const afterBind = performance.now();
      wasm.tick(); const afterTick = performance.now();
      wasm.render(); const afterRender = performance.now();
      frames.push(afterRender - before);
      if (afterRender - before > 8) slowFrames.push({ frame, pump: afterPump - before, bind: afterBind - afterPump, tick: afterTick - afterBind, render: afterRender - afterTick });
      if (state.status !== "pending") { visibleMs.push(performance.now() - start); return; }
      await Bun.sleep(Math.max(0, 1000 / 60 - (performance.now() - before)));
    }
    throw Error(`Benchmark timeout: ${scenario.name}`);
  };
  try {
    await awaitVisible();
    for (let i = 0; i < (scenario.edits ?? 0); i++) {
      const old = batch;
      batch = font.prepareText(scenario.text + "x".repeat(i + 1), { width: 460 });
      // Old geometry is cleared at the input edge; no stale source remains painted.
      visible?.clear?.(node); visible = undefined; old.dispose();
      await awaitVisible();
    }
    const stats = await worker.request("runtime.stats");
    const sorted = [...frames].sort((a, b) => a - b);
    const record = { case: scenario.name, path: "runtime-ttf", size: scenario.size,
      status: state.status, error: state.status === "error" ? String(state.error) : undefined,
      frames: frames.length, frameP50Ms: sorted[Math.floor(sorted.length * .5)], frameP95Ms: sorted[Math.floor(sorted.length * .95)], frameMaxMs: sorted.at(-1),
      firstVisibleMs: state.status === "ready" ? visibleMs[0] : null, settledMs: visibleMs[0], subsequentVisibleMs: visibleMs.slice(1), elapsedMs: performance.now() - started, slowFrames,
      requests, inflight, workerStartupMs, requestWireBytes, replyWireBytes, coreLinearMemory: wasm.exports.memory.buffer.byteLength,
      // Bun exposes Darwin ru_maxrss in bytes; Linux reports KiB.
      processPeakRss: process.resourceUsage().maxRSS * (process.platform === "darwin" ? 1 : 1024), resources: font.stats(), service: stats };
    records.push(record); console.log(JSON.stringify(record));
  } finally { batch.dispose(); font.dispose(); client.dispose(); worker.close(); }
}

// The legacy baseline pays baking before runtime; it has no dynamic-size API.
for (const text of [cases[0].text, cjk]) {
  const [atlas] = await bakeAtlases({ slots: [2], regularTtf: "assets/fonts/Inter-Regular.ttf",
    fallbackTtfs: ["tests/fixtures/runtime-font/NotoSansSC-Test.ttf"], codepoints: Array.from(text, c => c.codePointAt(0)!) });
  const wasm = await createWasmUi(core), frames: number[] = [];
  const start = performance.now(); wasm.ops.loadFontAtlas!(atlas.bytes);
  const node = wasm.ops.createNode(NODE_TYPE.text);
  wasm.ops.setProp(node, PROP.fontSlot, 2); wasm.ops.setProp(node, PROP.textColor, 0xffffffff);
  wasm.ops.setText(node, text); wasm.ops.insertBefore(1, node, 0);
  wasm.tick(); wasm.render(); const firstVisibleMs = performance.now() - start;
  for (let i = 0; i < 60; i++) { const before = performance.now(); wasm.tick(); wasm.render(); frames.push(performance.now() - before); }
  const sorted = [...frames].sort((a, b) => a - b);
  const record = { case: text === cjk ? "new-han-256" : "cold-latin", path: "baked", firstVisibleMs,
    frameP50Ms: sorted[30], frameP95Ms: sorted[57], frameMaxMs: sorted.at(-1), atlasBytes: atlas.bytes.length,
    sourceCoverageBytes: atlas.bytes.length - 16 - atlas.glyphCount * 8, coreLinearMemory: wasm.exports.memory.buffer.byteLength };
  records.push(record); console.log(JSON.stringify(record));
}
await mkdir(dirname(out), { recursive: true });
await Bun.write(out, JSON.stringify({ platform: `${process.platform}/${process.arch}`, timestamp: new Date().toISOString(),
  deliveryHz: 60, renderer: "shared WASM core software RGBA", records }, null, 2) + "\n");
