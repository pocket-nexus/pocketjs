import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, Script } from "node:vm";
import { bindWorker, ByteView, FactKind, Inbox, ResourceStatus, type HostFact, type WorkerHost } from "../framework/src/worker.ts";
import { io, utf8 } from "../framework/src/io.ts";
import { bytes, encodeI2CScript, i16le, read, u8, write } from "../framework/src/io/i2c.ts";
import { worker } from "../framework/src/worker-channels.ts";
import { buildWorker } from "../tools/build-worker.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
import { POCKET_CAPABILITIES, POCKET_TARGETS } from "../contracts/spec/platforms.ts";
import { POCKET_SECTION, decodePocketPackage, encodePocketPackage, findSection } from "../contracts/spec/pocket-package.ts";
import { makeVariant } from "../tools/pocket-pack.ts";

const global = globalThis as any;
afterEach(() => { delete global.__pocketWorker; delete global.__pocketWorkerTurn; delete global.__pocketWorkerChannels; delete global.__POCKET_WORKER_DECLARATION__; });
function host(overrides: Partial<WorkerHost> = {}): WorkerHost {
  return { open: () => 1, submit: () => 2, cancel: () => 0, close: () => 0, write: () => 0,
    publish: () => 0, timer: () => 0, declareChannel: () => 0, ...overrides };
}
const context = { generation: 1, sequence: 1, nowMicros: 1000 };
const fact = (overrides: Partial<HostFact> = {}): HostFact => ({ kind: FactKind.complete, handle: 1, request: 2, status: 0, offset: 0, data: Uint8Array.of(0x34, 0x12), timer: 0, channel: 0, deadline: 0, missed: 0, ...overrides });

test("I2C scripts preserve repeated-start order and reserve the exact read capacity", () => {
  const encoded = encodeI2CScript([write(0x7e, 0xb6), read(0x00, [u8, i16le]), read(0x12, [bytes(6)])], 25);
  expect(Array.from(encoded.payload)).toEqual([1, 3, 25, 0, 2, 0x7e, 1, 0, 0xb6, 1, 0, 3, 0, 1, 0x12, 6, 0]);
  expect(encoded.resultBytes).toBe(9);
  expect(() => encodeI2CScript([read(0, [bytes(1024)]), read(1, [u8])])).toThrow(/limit/);
  expect(() => write(1, 256)).toThrow();
  expect(() => encodeI2CScript([], 1)).toThrow();
});

test("resources fail closed without a worker and normalize unaccepted submissions", () => {
  expect(() => io.i2c("i2c0").open({ address: 0x32 })).toThrow(/worker runtime/);
  let submits = 0;
  global.__pocketWorker = host({ submit() { ++submits; return ResourceStatus.busy; } });
  bindWorker(() => {}, { entry: "worker.ts", nodes: [{ name: "i2c0", kind: "i2c" }] });
  expect(() => io.i2c("missing").open({ address: 0x32 })).toThrow(/Undeclared/);
  const rtc = io.i2c("i2c0").open({ address: 0x32 });
  expect(rtc.submit([read(0, [u8])])).toBe(-1);
  expect(submits).toBe(1);
  rtc.close();
  expect(() => rtc.submit([read(0, [u8])])).toThrow(/closed/);
});

test("completion is taken once and views expire at the next turn", () => {
  global.__pocketWorker = host();
  let view: ByteView | undefined, saved: Uint8Array | undefined, prior: Inbox | undefined;
  bindWorker((_context, inbox) => {
    const completion = inbox.completion(2);
    if (completion) {
      prior = inbox; view = completion.data;
      expect(view.u16le(0)).toBe(0x1234);
      saved = completion.take(); expect(completion.take()).toBeUndefined();
    }
  });
  global.__pocketWorkerTurn(context, [fact()]);
  global.__pocketWorkerTurn({ ...context, sequence: 2 }, []);
  expect(() => view!.u8(0)).toThrow(/expired/);
  expect(() => prior!.completion(2)).toThrow(/expired/);
  expect(Array.from(saved!)).toEqual([0x34, 0x12]);
});

test("timer and channel facts carry their own ids beside the resource facts", () => {
  global.__pocketWorker = host();
  bindWorker((_turn, inbox) => {
    expect(inbox.events()).toHaveLength(4);
    expect(inbox.events(1).map(item => item.kind)).toEqual([FactKind.complete, FactKind.data]);
    expect(inbox.timer(1)?.deadline).toBe(500);
    expect(inbox.timer(1)?.missed).toBe(2);
    expect(inbox.channel("state")).toHaveLength(1);
  }, { entry: "worker.ts", nodes: [], channels: [{ name: "state", kind: "ring", direction: "ui-to-worker", recordBytes: 2, capacity: 1 }] });
  global.__pocketWorkerTurn(context, [fact(), fact({ kind: FactKind.timer, handle: 0, timer: 1, deadline: 500, missed: 2 }),
    fact({ kind: FactKind.channel, handle: 0, channel: 1 }), fact({ kind: FactKind.data })]);
});

test("UTF-8 request encoding works without browser globals", () => {
  for (const text of ["RTC", "温度 🎛️", "\ud800"]) expect(utf8(text)).toEqual(new TextEncoder().encode(text));
});

test("snapshot mirrors persist without new input and reject views from a previous turn", () => {
  global.__pocketWorker = host();
  let previous: ByteView | undefined;
  bindWorker((_context, inbox) => {
    if (previous) expect(() => previous!.u8(0)).toThrow(/expired/);
    const snapshot = inbox.snapshot("setpoint");
    expect(snapshot?.u8(0)).toBe(42); previous = snapshot;
  }, { entry: "worker.ts", nodes: [], channels: [{ name: "setpoint", kind: "snapshot", direction: "ui-to-worker", recordBytes: 1, capacity: 1 }] });
  global.__pocketWorkerTurn(context, [fact({ kind: FactKind.channel, handle: 0, channel: 1, data: Uint8Array.of(42) })]);
  global.__pocketWorkerTurn({ ...context, sequence: 2 }, []);
});

test("UI channel reads are frame mirrors and direction is enforced", () => {
  global.__POCKET_WORKER_DECLARATION__ = { entry: "worker.ts", nodes: [], channels: [{ name: "state", kind: "snapshot", direction: "worker-to-ui", recordBytes: 1, capacity: 1 }] };
  global.__pocketWorkerChannels = { configure: () => 0, observe: () => [Uint8Array.of(7)], publish: () => 0 };
  const channel = worker.channel("state");
  const view = channel.observe()[0];
  expect(view.u8(0)).toBe(7);
  expect(() => channel.publish(Uint8Array.of(8))).toThrow(/receive-only/);
  global.__pocketWorkerChannelFrame();
  expect(() => view.u8(0)).toThrow(/expired/);
});

test("worker manifest admission rejects hosts without a second runtime and duplicate node owners", async () => {
  const manifest = JSON.parse(readFileSync(resolve("tests/fixtures/manifests/portable-psp.json"), "utf8"));
  manifest.app.worker = { entry: "worker.ts", nodes: [] };
  expect(validateAndResolveBuildPlan(manifest, { target: "psp" }).ok).toBe(false);
  manifest.engine.capabilities.requires.push("runtime.worker");
  expect(validateAndResolveBuildPlan(manifest, { target: "psp" }).ok).toBe(false);
  const registry = { capabilities: POCKET_CAPABILITIES, targets: { test: { ...POCKET_TARGETS.psp, capabilities: [...POCKET_TARGETS.psp.capabilities, "runtime.worker", "io.i2c"] } } };
  const availabilityOnly = structuredClone(manifest);
  delete availabilityOnly.app.worker;
  availabilityOnly.engine.capabilities.requires = availabilityOnly.engine.capabilities.requires.filter((capability: string) => capability !== "runtime.worker");
  availabilityOnly.engine.capabilities.enhances = ["runtime.worker"];
  expect(validateAndResolveBuildPlan(availabilityOnly, { target: "test" }, registry).ok).toBe(true);
  const admitted = validateAndResolveBuildPlan(manifest, { target: "test" }, registry);
  expect(admitted.ok).toBe(true);
  if (!admitted.ok) return;
  const input = { target: "test", hostAbi: admitted.plan.target.hostAbi, planJson: JSON.stringify(admitted.plan), identity: { output: admitted.plan.app.output, id: admitted.plan.app.id, title: admitted.plan.app.title }, js: utf8("globalThis.frame=()=>{}"), pak: new Uint8Array() };
  expect(() => makeVariant(input)).toThrow(/worker declaration/);
  const variant = makeVariant({ ...input, workerJs: utf8("globalThis.__pocketWorkerTurn=()=>{}") });
  const decoded = decodePocketPackage(encodePocketPackage({ manifest: utf8(JSON.stringify(manifest)), variants: [variant] }));
  expect(findSection(decoded.variants[0], POCKET_SECTION.workerJs)?.at(-1)).toBe(0);
  manifest.app.worker.nodes = [{ name: "bus", kind: "i2c" }, { name: "bus", kind: "i2c" }];
  const invalid = validateAndResolveBuildPlan(manifest, { target: "test" }, registry);
  expect(invalid.ok).toBe(false);
  if (!invalid.ok) expect(invalid.diagnostics.some(d => d.code === "worker.duplicate")).toBe(true);
});

test("worker compiler emits an independently executable realm with no UI imports", async () => {
  const outdir = resolve(".pocket-build/validation/worker/sdk");
  mkdirSync(outdir, { recursive: true });
  const entry = resolve(outdir, "entry.ts");
  writeFileSync(entry, 'import { io } from "@pocketjs/framework/io";\nimport { read, u8 } from "@pocketjs/framework/io/i2c";\nconst device = io.i2c("i2c0").open({address:0x32});\nexport function turn(context, inbox) { if ((function(){ return this; })() !== undefined) throw new Error("module strictness lost"); if(context.sequence===1) device.submit([read(0,[u8])]); }');
  await buildWorker({ projectRoot: outdir, outdir, output: "smoke", declaration: { entry, nodes: [{ name: "i2c0", kind: "i2c" }] } });
  let calls = 0;
  const realm = createContext({ __pocketWorker: host({ submit: () => { ++calls; return 2; } }) });
  const source = readFileSync(resolve(outdir, "smoke.worker.js"), "utf8");
  const scanned = new Bun.Transpiler({ loader: "js" }).scan(source);
  expect(scanned.imports).toHaveLength(0); expect(scanned.exports).toHaveLength(0);
  expect(source.trimStart()).toStartWith('"use strict";');
  expect(source.replace(/^\s*"use strict";\s*/, "")).not.toMatch(/^\(\(\)\s*=>\s*\{/);
  new Script(source).runInContext(realm);
  realm.__pocketWorkerTurn(context, []);
  expect(calls).toBe(1); expect(realm.ui).toBeUndefined(); expect(realm.frame).toBeUndefined();
  writeFileSync(entry, 'import { render } from "@pocketjs/framework"; export function turn() { render(); }');
  await expect(buildWorker({ projectRoot: outdir, outdir, output: "bad", declaration: { entry, nodes: [] } })).rejects.toThrow();
  writeFileSync(entry, 'await Promise.resolve(); export function turn() {}');
  await expect(buildWorker({ projectRoot: outdir, outdir, output: "async-boot", declaration: { entry, nodes: [] } })).rejects.toThrow(/classic script/);
});

test("pocket check includes the independent worker entry", () => {
  const output = resolve(".pocket-build/validation/worker/sdk/typecheck-worker");
  mkdirSync(output, { recursive: true });
  const manifest = JSON.parse(readFileSync(resolve("apps/worker-http/pocket.json"), "utf8"));
  manifest.app.worker.entry = ".pocket-build/validation/worker/sdk/typecheck-worker/invalid.ts";
  writeFileSync(resolve(output, "invalid.ts"), "export function turn() { const value: number = 'incorrect'; return value; }\n");
  // The UI entry's imports map through the UI domain: a worker subpath is unresolvable there.
  manifest.app.entry = ".pocket-build/validation/worker/sdk/typecheck-worker/ui.tsx";
  writeFileSync(resolve(output, "ui.tsx"), 'import { io } from "@pocketjs/framework/io";\nvoid io;\n');
  const path = resolve(output, "pocket.json");
  writeFileSync(path, JSON.stringify(manifest));
  const checked = Bun.spawnSync([process.execPath, resolve("tools/pocket.ts"), "check", "--manifest", path, "--project-root", resolve("."), "--target", "3ds-dev"], { cwd: resolve("."), stdout: "pipe", stderr: "pipe" });
  expect(checked.exitCode).not.toBe(0);
  expect(checked.stderr.toString()).toContain("TS2322");
  expect(checked.stderr.toString()).toContain("invalid.ts");
  expect(checked.stderr.toString()).toContain("TS2306");
  expect(checked.stderr.toString()).toContain("not-in-domain.d.ts");
}, 120_000);
