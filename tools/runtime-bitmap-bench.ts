/** Streamed bitmap baseline: real archive Worker, 60 Hz delivery and WASM raster.
 * Archive baking and Worker construction are outside the measured runtime.
 * Run after building hosts/web/pocketjs.wasm. Keep raw output under .pocket-build.
 */
import { createWasmUi } from "../hosts/web/wasm-ops.js";
import { createFontArchive, type PreparedText } from "../framework/src/fonts.ts";
import { createOffloadClient } from "../framework/src/offload.ts";
import { runServicePumps } from "../framework/src/services.ts";
import { bakeAtlases } from "../framework/compiler/bake-font.ts";
import { bakeFontArchive } from "../framework/compiler/font-archive.ts";
import { NODE_TYPE, PROP } from "../contracts/spec/spec.ts";
import type { ResourceState } from "../framework/src/resource-state.ts";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";

const outputArg = Bun.argv.indexOf("--output");
const output = resolve(outputArg >= 0 ? Bun.argv[outputArg + 1]
  : ".pocket-build/validation/runtime-ttf/benchmark/bitmap.json");
const scratch = resolve(".pocket-build/validation/runtime-ttf/benchmark");
await mkdir(scratch, { recursive: true });
const fontPath = "tests/fixtures/runtime-font/NotoSansSC-Test.ttf";
const cjk = Array.from({ length: 256 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join("");
const archiveBytes = await bakeFontArchive({ font: fontPath, slots: [2],
  codepoints: Array.from(cjk + "你好", c => c.codePointAt(0)!) });
const archivePath = resolve(scratch, "bitmap-baseline.pjfa");
await Bun.write(archivePath, archiveBytes);
const [base] = await bakeAtlases({ slots: [2], codepoints: [] });
const core = await Bun.file("hosts/web/pocketjs.wasm").arrayBuffer();
const cases = [{ name: "new-han-256", text: cjk },
  { name: "editing", text: "AV office 你好", edits: 10 }];
const records: unknown[] = [];
const only = Bun.argv.find(arg => arg.startsWith("--only="))?.slice(7);

async function archiveWorker() {
  const worker = new Worker(new URL("../tests/fixtures/font-benchmark-worker.ts", import.meta.url), { type: "module" });
  let serial = 0;
  const pending = new Map<number, { resolve: (value: string) => void; reject: (error: Error) => void }>();
  await new Promise<void>((resolveReady, rejectReady) => {
    const timer = setTimeout(() => { worker.terminate(); rejectReady(Error("Archive Worker startup timeout")); }, 10000);
    worker.onerror = event => { clearTimeout(timer); rejectReady(Error(event.message)); };
    worker.onmessage = ({ data }) => {
      if (data.ready) { clearTimeout(timer); resolveReady(); return; }
      const request = pending.get(data.id);
      if (!request) return;
      pending.delete(data.id);
      if (data.error) request.reject(Error(data.error)); else request.resolve(data.payload);
    };
    worker.postMessage({ init: { archive: archivePath } });
  });
  return {
    request(method: string, payload: string) {
      const id = ++serial;
      return new Promise<string>((resolveReply, reject) => {
        pending.set(id, { resolve: resolveReply, reject });
        worker.postMessage({ id, method, payload });
      });
    },
    close() { for (const p of pending.values()) p.reject(Error("Worker closed")); pending.clear(); worker.terminate(); },
  };
}

for (const scenario of cases.filter(c => !only || c.name === only)) {
  const worker = await archiveWorker(), wasm = await createWasmUi(core);
  wasm.ops.loadFontAtlas!(base.bytes);
  const replies: string[] = [];
  let requests = 0, inflight = 0, requestWireBytes = 0, replyWireBytes = 0;
  const client = createOffloadClient({ session: () => 1, take: () => replies.shift(), submit(raw) {
    const request = JSON.parse(raw); requests++; inflight++; requestWireBytes += Buffer.byteLength(raw);
    worker.request(request.method, request.payload).then(payload => {
      const reply = JSON.stringify({ id: request.id, payload });
      replyWireBytes += Buffer.byteLength(reply); replies.push(reply);
    }, error => {
      const reply = JSON.stringify({ id: request.id, error: String(error) });
      replyWireBytes += Buffer.byteLength(reply); replies.push(reply);
    }).finally(() => inflight--);
    return true;
  } });
  let atlasCommitCount = 0, glyphsCommitted = 0, commitBytes = 0, coverageBytesInstalled = 0, layoutBinds = 0;
  const commit = wasm.ops.fontStreamCommit!.bind(wasm.ops);
  wasm.ops.fontStreamCommit = bytes => {
    const accepted = commit(bytes);
    if (accepted > 0) {
      atlasCommitCount++; glyphsCommitted += accepted; commitBytes += bytes.length;
      coverageBytesInstalled += accepted * Math.max(base.cellW, bytes[10]) * Math.max(base.cellH, bytes[11]);
    }
    return accepted;
  };
  const node = wasm.ops.createNode(NODE_TYPE.text);
  wasm.ops.setProp(node, PROP.fontSlot, 2); wasm.ops.setProp(node, PROP.textColor, 0xffffffff);
  wasm.ops.insertBefore(1, node, 0);
  const started = performance.now();
  const font = createFontArchive({ path: "benchmark.pjfa", slots: [2], capacity: 1024 }, wasm.ops, client);
  let batch = font.prepareText(scenario.text, { slot: 2 }), visible: PreparedText | undefined;
  let state: ResourceState<PreparedText> = batch.state();
  const frames: number[] = [], visibleMs: number[] = [], slowFrames: unknown[] = [], editRequests: number[] = [];
  let rows = 0;
  const awaitVisible = async (edge: number) => {
    for (let frame = 0; frame < 3600; frame++) {
      const before = performance.now();
      client.step(); runServicePumps();
      const afterPump = performance.now(); state = batch.state();
      if (state.status === "ready" && state.value !== visible) {
        const text = state.value.text;
        // Baked Text wraps through the existing core wrapper; render the same
        // 460px container as the TTF benchmark, rather than one clipped row.
        const breaks = wasm.ops.wrapText!(text, 2, 460), lines: string[] = [];
        let at = 0;
        for (const end of breaks) { lines.push(text.slice(at, end)); at = end; }
        lines.push(text.slice(at)); rows = lines.length;
        wasm.ops.setText(node, lines.join("\n")); visible = state.value; layoutBinds++;
      }
      const afterBind = performance.now(); wasm.tick(); const afterTick = performance.now();
      wasm.render(); const afterRender = performance.now(); frames.push(afterRender - before);
      if (afterRender - before > 8) slowFrames.push({ frame, pump: afterPump - before, bind: afterBind - afterPump,
        tick: afterTick - afterBind, render: afterRender - afterTick });
      if (state.status !== "pending") { visibleMs.push(performance.now() - edge); return; }
      await Bun.sleep(Math.max(0, 1000 / 60 - (performance.now() - before)));
    }
    throw Error(`Bitmap benchmark timeout: ${scenario.name}`);
  };
  try {
    await awaitVisible(started);
    for (let edit = 0; edit < (scenario.edits ?? 0); edit++) {
      const edge = performance.now(), priorRequests = requests, old = batch;
      batch = font.prepareText(scenario.text + "x".repeat(edit + 1), { slot: 2 });
      wasm.ops.setText(node, ""); visible = undefined; old.dispose();
      await awaitVisible(edge); editRequests.push(requests - priorRequests);
      // Input arrives on consecutive display frames, even when cache hits
      // can bind and become visible in the same frame.
      await Bun.sleep(Math.max(0, 1000 / 60 - (performance.now() - edge)));
    }
    const service = JSON.parse(await worker.request("font.stats", ""));
    const sorted = [...frames].sort((a, b) => a - b), resources = font.stats();
    const record = { case: scenario.name, path: "streamed-bitmap", slot: 2, size: 16,
      status: state.status, error: state.status === "error" ? String(state.error) : undefined,
      frames: frames.length, frameP50Ms: sorted[Math.floor(sorted.length * .5)],
      frameP95Ms: sorted[Math.floor(sorted.length * .95)], frameMaxMs: sorted.at(-1),
      firstVisibleMs: state.status === "ready" ? visibleMs[0] : null, subsequentVisibleMs: visibleMs.slice(1),
      elapsedMs: performance.now() - started, rows, slowFrames, requests, inflight, editRequests,
      requestWireBytes, replyWireBytes, wireBytes: requestWireBytes + replyWireBytes,
      cpuStreamResidentBytes: resources.bytes, baseAtlasBytes: base.bytes.length,
      coreLinearMemory: wasm.exports.memory.buffer.byteLength, resources, service,
      atlasCommitCount, glyphsCommitted, commitBytes, coverageBytesInstalled, layoutBinds,
      gpuUploadBytes: null, gpuUploadNote: "Software renderer: GPU transfer was not measured." };
    records.push(record); console.log(JSON.stringify(record));
  } finally { batch.dispose(); font.dispose(); client.dispose(); worker.close(); }
}
await mkdir(dirname(output), { recursive: true });
await Bun.write(output, JSON.stringify({ platform: `${process.platform}/${process.arch}`, timestamp: new Date().toISOString(),
  deliveryHz: 60, renderer: "shared WASM core software RGBA", archiveBytes: archiveBytes.length,
  archiveSha256: createHash("sha256").update(archiveBytes).digest("hex"),
  coreSha256: createHash("sha256").update(new Uint8Array(core)).digest("hex"),
  methodology: "Same 256 Han and editing strings, slot2/16px, width460. Archive bake and Worker construction excluded; archive open and all glyph I/O included. Cold draw waits for the entire batch; warm edits keep cached resources and preserve leases until replacement admission. Atlas commits are CPU events, not inferred GPU uploads.", records }, null, 2) + "\n");
