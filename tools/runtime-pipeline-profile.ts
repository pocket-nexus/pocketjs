/** Controlled async text pipeline measurements and scheduling experiments.
 * Run after tools/wasm.ts and tools/text-wasm.ts; raw output stays ignored. */
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createWasmUi } from "../hosts/web/wasm-ops.js";
import { createRuntimeFont } from "../framework/src/runtime-fonts.ts";
import { createOffloadClient, type OffloadOps, type OffloadResult } from "../framework/src/offload.ts";
import { runServicePumps } from "../framework/src/services.ts";
import { NODE_TYPE, PROP } from "../contracts/spec/spec.ts";

/** A profiling prototype of separate receive/plan/submit phases. Bounds on queue
 * size, record bytes, submissions and callback deliveries remain explicit. */
function phaseClient(ops: OffloadOps, deliveries: number) {
  type Ticket = { raw: string; cb: (r: OffloadResult) => void; sent: boolean; session?: number; deadline: number };
  const queue = new Map<number, Ticket>();
  let serial = 0, frame = 0, submitted = 0, dead = false;
  const finish = (id: number, reply: OffloadResult) => { const r = queue.get(id); if (r) { queue.delete(id); r.cb(reply); } };
  const flush = () => {
    if (dead) return;
    for (const r of queue.values()) {
      if (submitted >= 2) break;
      if (!r.sent && ops.session() > 0 && (r.session == null || r.session === ops.session()) && ops.submit(r.raw)) {
        r.sent = true; r.session = ops.session(); submitted++;
      }
    }
  };
  return {
    request(method: string, payload: string, cb: Ticket["cb"], options?: { session: number }) {
      if (dead || queue.size >= 8) return 0;
      const id = ++serial, raw = JSON.stringify({ v: 1, id, method, payload });
      if (payload.length > 2500 || Buffer.byteLength(raw) > 4096) throw Error("Profile request exceeded production wire bound");
      queue.set(id, { raw, cb, sent: false, session: options?.session, deadline: frame + 600 }); return id;
    },
    connected: () => !dead && ops.session() > 0, session: () => dead ? 0 : ops.session(), pending: () => queue.size,
    cancel(id: number) { queue.delete(id); },
    step() {
      if (dead) return;
      frame++; submitted = 0;
      let count = 0;
      while (count < deliveries) {
        const raw = ops.take(); if (!raw) break;
        const r = JSON.parse(raw), ticket = queue.get(r.id);
        if (ticket?.sent && ticket.session === ops.session()) {
          count++; finish(r.id, r.error ? { ok: false, error: r.error } : { ok: true, value: r.payload });
        }
      }
      for (const [id, r] of queue) if (count < deliveries && (r.deadline <= frame || r.session != null && r.session !== ops.session())) {
        count++; finish(id, { ok: false, error: "Expired profile request" });
      }
      flush();
    },
    flush,
    dispose() { dead = true; queue.clear(); },
  };
}
const variants = [
  { name: "production", phases: false, deliveries: 1, compactPages: false },
  { name: "phases-1", phases: true, deliveries: 1, compactPages: false },
  { name: "phases-2", phases: true, deliveries: 2, compactPages: false },
  { name: "phases-2-pages", phases: true, deliveries: 2, compactPages: true },
];
const cases = [
  { name: "han256", text: Array.from({ length: 256 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join(""), size: 16 },
  { name: "large128", text: "AV你好", size: 128 },
  { name: "editing", text: "AV office 你好", size: 16, edits: 10 },
];
const argument = (key: string) => Bun.argv.find(x => x.startsWith(key + "="))?.slice(key.length + 1);
const repeats = Number(argument("--repeats") ?? 3);
const output = argument("--output") ?? ".pocket-build/validation/font-optimization/pipeline/result.json";
const core = await Bun.file("hosts/web/pocketjs.wasm").arrayBuffer();
const referencePath = argument("--reference");
const referenceHashes: Record<string, string> | undefined = referencePath
  ? (await Bun.file(referencePath).json()).pixelHashes : undefined;
if (referencePath && !referenceHashes) throw Error("Reference report has no pixel hashes");
const digest = (bytes: ArrayBuffer) => createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
const identity = {
  revision: Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim(),
  bun: Bun.version,
  platform: `${process.platform}/${process.arch}`,
  sha256: Object.fromEntries(await Promise.all([
    "hosts/web/pocketjs.wasm", "hosts/web/pocket_text.wasm", "hosts/web/pocket_freetype.wasm",
    "framework/src/offload.ts", "framework/src/services.ts", "framework/src/runtime-fonts.ts",
    "tools/runtime-pipeline-profile.ts", "tools/runtime-profile-worker.ts",
    "assets/fonts/Inter-Regular.ttf", "assets/fonts/JetBrainsMono-Regular.ttf",
    "tests/fixtures/runtime-font/NotoSansSC-Test.ttf", "tests/fixtures/runtime-font/NotoSans-Ligature.ttf",
  ].map(async path => [path, digest(await Bun.file(path).arrayBuffer())]))),
};
const results: any[] = [], hashes = new Map<string, string>();
for (const variant of variants.filter(v => !argument("--variant") || v.name === argument("--variant"))) {
  for (const scenario of cases.filter(c => !argument("--case") || c.name === argument("--case"))) for (let repeat = 0; repeat < repeats; repeat++) {
    const worker = new Worker(new URL("./runtime-profile-worker.ts", import.meta.url), { type: "module" });
    const replies: string[] = [], trace: any[] = [];
    let frame = 0, workerMs = 0, wireBytes = 0, requests = 0, completed = 0, engineCalls = 0;
    const submittedAt = new Map<number, { frame: number; time: number; method: string }>();
    await new Promise<void>((resolve, reject) => {
      worker.onerror = event => reject(Error(event.message));
      worker.onmessage = ({ data }) => {
        if (data.ready) { resolve(); return; }
        const result = JSON.parse(data.record), sent = submittedAt.get(result.id);
        wireBytes += Buffer.byteLength(data.record); workerMs += data.workerMs; engineCalls += data.calls; completed++;
        trace.push({ kind: "reply", frame, ...sent, arrivedFrame: frame, workerMs: data.workerMs, roundtripMs: sent ? performance.now() - sent.time : null });
        replies.push(data.record);
      };
      worker.postMessage({ init: true, compactPages: variant.compactPages });
    });
    const wasm = await createWasmUi(core);
    const ops: OffloadOps = { session: () => 1, take: () => replies.shift(), submit(raw) {
      const r = JSON.parse(raw); requests++; wireBytes += Buffer.byteLength(raw);
      submittedAt.set(r.id, { frame, time: performance.now(), method: r.method });
      trace.push({ kind: "submit", frame, method: r.method }); worker.postMessage({ record: raw }); return true;
    } };
    const client = variant.phases ? phaseClient(ops, variant.deliveries) : createOffloadClient(ops);
    const font = createRuntimeFont({ family: "Inter", size: scenario.size, fallback: ["Pocket CJK Test"] }, wasm.ops, client);
    const node = wasm.ops.createNode(NODE_TYPE.text); wasm.ops.setProp(node, PROP.textColor, 0xffffffff); wasm.ops.insertBefore(1, node, 0);
    let batch = font.prepareText(scenario.text, { width: 460 });
    let painted: any;
    const latencies: number[] = [], work: number[] = [];
    let geometryMs: number | undefined;
    const run = async () => {
      const start = performance.now();
      for (let n = 0; n < 1200; n++) {
        const before = performance.now(); frame++;
        client.step(); runServicePumps();
        // Explicit clients use the same receive/work/submit order as the
        // service pumps that offload() registers for applications.
        if ("flush" in client) client.flush();
        if (batch.layout() && geometryMs == null) geometryMs = performance.now() - start;
        const state = batch.state();
        if (state.status === "error") throw state.error;
        if (state.status === "ready") { painted = state.value; painted.paint(node); }
        wasm.tick(); const pixels = wasm.render(); work.push(performance.now() - before);
        if (state.status === "ready") {
          latencies.push(performance.now() - start);
          const hash = createHash("sha256").update(pixels).digest("hex"), key = `${scenario.name}:${latencies.length}`;
          if (hashes.has(key) && hashes.get(key) !== hash) throw Error(`Variant pixel mismatch: ${key}/${variant.name}`);
          if (referenceHashes && referenceHashes[key] !== hash) throw Error(`Reference pixel mismatch: ${key}/${variant.name}`);
          hashes.set(key, hash); return;
        }
        await Bun.sleep(Math.max(0, 1000 / 60 - (performance.now() - before)));
      }
      throw Error("Profile frame deadline exceeded");
    };
    try {
      await run();
      for (let edit = 0; edit < (scenario.edits ?? 0); edit++) {
        painted.clear(node); batch.dispose(); batch = font.prepareText(scenario.text + "x".repeat(edit + 1), { width: 460 }); await run();
      }
      const sorted = [...work].sort((a, b) => a - b);
      const r = { variant: variant.name, case: scenario.name, repeat, frames: frame, firstVisibleMs: latencies[0], geometryMs,
        editMs: latencies.slice(1), workerMs, requests, completed, engineCalls, wireBytes,
        frameP95Ms: sorted[Math.floor(sorted.length * .95)], frameMaxMs: sorted.at(-1), resources: font.stats(), trace };
      results.push(r); console.log(JSON.stringify({ ...r, trace: undefined }));
    } finally { batch.dispose(); font.dispose(); client.dispose(); worker.terminate(); }
  }
}
await mkdir(dirname(output), { recursive: true });
await Bun.write(output, JSON.stringify({ note: "Production client and experimental phase/page variants; same rendering hashes, bounded queues and no UI-thread font work. Two deliveries require matching host budgets.",
  identity, pixelHashes: Object.fromEntries(hashes), reference: referencePath ?? null, results }, null, 2));
