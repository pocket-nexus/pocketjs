import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, Script } from "node:vm";
import { bindWorker, FactKind, ResourceError, ResourceStatus, settle, sleep, type HostFact, type TimerTick, type WorkerHost } from "../framework/src/worker.ts";
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
/** The host runs the Promise jobs after the turn returns; a macrotask drains them here. */
const jobs = () => new Promise<void>(done => setTimeout(done, 0));
const turn = (sequence: number, facts: HostFact[] = [], nowMicros = 1000) => global.__pocketWorkerTurn({ generation: 1, sequence, nowMicros }, facts);

test("I2C scripts preserve repeated-start order and reserve the exact read capacity", () => {
  const encoded = encodeI2CScript([write(0x7e, 0xb6), read(0x00, [u8, i16le]), read(0x12, [bytes(6)])], 25);
  expect(Array.from(encoded.payload)).toEqual([1, 3, 25, 0, 2, 0x7e, 1, 0, 0xb6, 1, 0, 3, 0, 1, 0x12, 6, 0]);
  expect(encoded.resultBytes).toBe(9);
  expect(() => encodeI2CScript([read(0, [bytes(1024)]), read(1, [u8])])).toThrow(/limit/);
  expect(() => write(1, 256)).toThrow();
  expect(() => encodeI2CScript([], 1)).toThrow();
});

test("resources fail closed without a worker and reject unaccepted submissions", async () => {
  expect(() => io.i2c("i2c0").open({ address: 0x32 })).toThrow(/worker runtime/);
  let submits = 0;
  global.__pocketWorker = host({ submit() { ++submits; return ResourceStatus.busy; } });
  bindWorker({ entry: "worker.ts", nodes: [{ name: "i2c0", kind: "i2c" }] });
  expect(() => io.i2c("missing").open({ address: 0x32 })).toThrow(/Undeclared/);
  const rtc = io.i2c("i2c0").open({ address: 0x32 });
  expect(rtc.submit([read(0, [u8])])).toBe(-1);
  await expect(rtc.run([read(0, [u8])])).rejects.toMatchObject({ name: "ResourceError", status: ResourceStatus.busy, request: -1 });
  expect(submits).toBe(2);
  rtc.close();
  expect(() => rtc.submit([read(0, [u8])])).toThrow(/closed/);
});

test("probe submits an address-only opcode and resolves the acknowledgement", async () => {
  const submitted: [number, number[], number][] = [];
  global.__pocketWorker = host({ submit(_handle, opcode, payload, capacity) { submitted.push([opcode, Array.from(payload), capacity]); return 2; } });
  bindWorker({ entry: "worker.ts", nodes: [{ name: "i2c0", kind: "i2c" }] });
  const device = io.i2c("i2c0").open({ address: 0x32, timeoutMillis: 300 });
  let answered: boolean | undefined;
  void device.probe().then(value => { answered = value; });
  expect(submitted).toEqual([[2, [0x2c, 0x01], 0]]);
  turn(1, [fact({ data: new Uint8Array(0) })]); await jobs();
  expect(answered).toBe(true);
  void device.probe({ timeoutMillis: 10 }).then(value => { answered = value; });
  turn(2, [fact({ status: ResourceStatus.failed, data: new Uint8Array(0) })]); await jobs();
  expect(answered).toBe(false);
  await expect(device.probe({ timeoutMillis: 0 })).rejects.toThrow(/timeoutMillis/);
});

test("run resolves in the turn that carries the completion, with a retained copy", async () => {
  global.__pocketWorker = host();
  bindWorker({ entry: "worker.ts", nodes: [{ name: "i2c0", kind: "i2c" }] });
  const device = io.i2c("i2c0").open({ address: 0x68 });
  let result: Uint8Array | undefined;
  void device.run([read(0, [u8, u8])]).then(data => { result = data; });
  turn(1); await jobs();
  expect(result).toBeUndefined();
  const data = Uint8Array.of(0x34, 0x12);
  turn(2, [fact({ data })]); await jobs();
  data[0] = 0;
  expect(Array.from(result!)).toEqual([0x34, 0x12]);
  const failing = device.run([read(0, [u8])]);
  turn(3, [fact({ status: ResourceStatus.failed })]);
  await expect(failing).rejects.toMatchObject({ name: "ResourceError", status: ResourceStatus.failed, request: 2 });
  // A completion that arrives before anyone settles it waits for the call.
  turn(4, [fact({ request: 7, status: ResourceStatus.cancelled })]);
  expect((await settle(7)).status).toBe(ResourceStatus.cancelled);
  await expect(settle(-1)).rejects.toBeInstanceOf(ResourceError);
});

test("a timer fact ahead of the latched time re-arms the host timer for the same deadline", async () => {
  const timers: number[][] = [];
  global.__pocketWorker = host({ timer(id, deadline, period) { timers.push([id, deadline, period]); return 0; } });
  bindWorker({ entry: "worker.ts", nodes: [] });
  turn(1, [], 1000);
  let woke = 0;
  void sleep(500).then(() => { ++woke; });
  expect(timers.at(-1)).toEqual([1, 1500, 0]);
  // The host read its clock after the turn latched 1499: the timer fired and
  // is gone, while the alarm at 1500 is not due by the latched time.
  turn(2, [fact({ kind: FactKind.timer, handle: 0, timer: 1, deadline: 1500 })], 1499); await jobs();
  expect(woke).toBe(0);
  expect(timers.at(-1)).toEqual([1, 1500, 0]);
  expect(timers.length).toBe(2);
  turn(3, [fact({ kind: FactKind.timer, handle: 0, timer: 1, deadline: 1500 })], 1501); await jobs();
  expect(woke).toBe(1);
});

test("deadlines fire by the latched turn time through one host timer", async () => {
  const timers: number[][] = [];
  global.__pocketWorker = host({ timer(id, deadline, period) { timers.push([id, deadline, period]); return 0; } });
  bindWorker({ entry: "worker.ts", nodes: [] });
  let woke = 0;
  void sleep(500).then(() => { ++woke; }); // bootstrap: relative to the first turn
  expect(timers).toEqual([]);
  turn(1, [], 1000); await jobs();
  expect(timers).toEqual([[1, 1500, 0]]);
  void sleep(100).then(() => { ++woke; }); // an earlier deadline re-arms the host timer
  expect(timers.at(-1)).toEqual([1, 1100, 0]);
  turn(2, [], 1099); await jobs();
  expect(woke).toBe(0);
  turn(3, [fact({ kind: FactKind.timer, handle: 0, timer: 1, deadline: 1100 })], 1100); await jobs();
  expect(woke).toBe(1);
  expect(timers.at(-1)).toEqual([1, 1500, 0]);
  turn(4, [], 1500); await jobs();
  expect(woke).toBe(2);
  expect(timers.at(-1)).toEqual([1, 0, 0]);
  const ticks = io.timer(100);
  const seen: TimerTick[] = [];
  const reading = (async () => { for await (const tick of ticks) { seen.push(tick); if (seen.length === 2) break; } })();
  expect(timers.at(-1)).toEqual([1, 1600, 0]);
  turn(5, [], 1600); await jobs();
  expect(seen).toEqual([{ deadline: 1600, missed: 0 }]);
  expect(timers.at(-1)).toEqual([1, 1700, 0]);
  turn(6, [], 1950); await reading; // two periods passed: the deadline advances by whole periods
  expect(seen).toEqual([{ deadline: 1600, missed: 0 }, { deadline: 1700, missed: 2 }]);
  expect(timers.at(-1)).toEqual([1, 0, 0]);
  const slow = io.timer(100);
  turn(7, [], 2050); turn(8, [], 2150); // unread ticks coalesce
  expect((await slow.next()).value).toEqual({ deadline: 2150, missed: 1 });
  slow.close();
  expect(timers.at(-1)).toEqual([1, 0, 0]);
});

test("stream records buffer for a reading loop and the stream ends on close", async () => {
  let handles = 0;
  global.__pocketWorker = host({ open: () => ++handles });
  bindWorker({ entry: "worker.ts", nodes: [{ name: "uart1", kind: "uart" }] });
  const serial = io.uart("uart1").open({ baudRate: 115200 });
  turn(1, [fact({ kind: FactKind.data, data: Uint8Array.of(1) })]); // nobody reads: expires with the turn
  const kinds: number[] = [], payload: number[] = [];
  const reading = (async () => { for await (const record of serial.observe()) { kinds.push(record.kind); payload.push(...record.data); } })();
  await jobs();
  turn(2, [fact({ kind: FactKind.data, data: Uint8Array.of(2) }), fact({ kind: FactKind.gap, offset: 3, data: new Uint8Array() })]);
  await jobs();
  expect(kinds).toEqual([FactKind.data, FactKind.gap]);
  expect(payload).toEqual([2]);
  expect(() => serial.observe()[Symbol.asyncIterator]()).toThrow(/already has a reader/);
  serial.close();
  await reading;
  const other = io.uart("uart1").open({ baudRate: 9600 });
  void other.observe()[Symbol.asyncIterator]().next();
  expect(() => turn(3, Array.from({ length: 66 }, () => fact({ kind: FactKind.data, handle: 2 })))).toThrow(/fell behind/);
});

test("channel records reach their reader and inbound snapshots persist until the generation changes", async () => {
  global.__pocketWorker = host();
  bindWorker({ entry: "worker.ts", nodes: [], channels: [
    { name: "commands", kind: "ring", direction: "ui-to-worker", recordBytes: 4, capacity: 2 },
    { name: "setpoint", kind: "snapshot", direction: "ui-to-worker", recordBytes: 1, capacity: 1 },
    { name: "state", kind: "snapshot", direction: "worker-to-ui", recordBytes: 1, capacity: 1 }] });
  const commands = io.channel("commands");
  expect(() => commands.publish(Uint8Array.of(1))).toThrow(/receive-only/);
  expect(() => io.channel("state").observe()).toThrow(/publish-only/);
  expect(io.channel("setpoint").snapshot()).toBeUndefined();
  const received: number[] = [];
  const reading = (async () => { for await (const record of commands.observe()) { received.push(record[0]!); if (received.length === 2) break; } })();
  await jobs();
  turn(1, [fact({ kind: FactKind.channel, handle: 0, channel: 1, data: Uint8Array.of(5) }), fact({ kind: FactKind.channel, handle: 0, channel: 2, data: Uint8Array.of(42) })]);
  await jobs();
  expect(received).toEqual([5]);
  expect(io.channel("setpoint").snapshot()?.[0]).toBe(42);
  turn(2, [fact({ kind: FactKind.channel, handle: 0, channel: 1, data: Uint8Array.of(6) })]);
  await reading;
  expect(received).toEqual([5, 6]);
  turn(3);
  expect(io.channel("setpoint").snapshot()?.[0]).toBe(42);
  global.__pocketWorkerTurn({ generation: 2, sequence: 1, nowMicros: 2000 }, []);
  expect(io.channel("setpoint").snapshot()).toBeUndefined();
});

test("UTF-8 request encoding works without browser globals", () => {
  for (const text of ["RTC", "温度 🎛️", "\ud800"]) expect(utf8(text)).toEqual(new TextEncoder().encode(text));
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
  manifest.domains = { worker: { entry: "worker.ts", nodes: [] } };
  expect(validateAndResolveBuildPlan(manifest, { target: "psp" }).ok).toBe(false);
  manifest.engine.capabilities.requires.push("runtime.worker");
  expect(validateAndResolveBuildPlan(manifest, { target: "psp" }).ok).toBe(false);
  const registry = { capabilities: POCKET_CAPABILITIES, targets: { test: { ...POCKET_TARGETS.psp, capabilities: [...POCKET_TARGETS.psp.capabilities, "runtime.worker", "io.i2c"] } } };
  const availabilityOnly = structuredClone(manifest);
  delete availabilityOnly.domains;
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
  manifest.domains.worker.nodes = [{ name: "bus", kind: "i2c" }, { name: "bus", kind: "i2c" }];
  const invalid = validateAndResolveBuildPlan(manifest, { target: "test" }, registry);
  expect(invalid.ok).toBe(false);
  if (!invalid.ok) expect(invalid.diagnostics.some(d => d.code === "worker.duplicate")).toBe(true);
});

test("worker compiler emits an independently executable realm whose entry starts its tasks", async () => {
  const outdir = resolve(".pocket-build/validation/worker/sdk");
  mkdirSync(outdir, { recursive: true });
  const entry = resolve(outdir, "entry.ts");
  writeFileSync(entry, 'import { io } from "@pocketjs/framework/io";\nimport { read, u8 } from "@pocketjs/framework/io/i2c";\nimport { sleep } from "@pocketjs/framework/worker";\n' +
    'if ((function(){ return this; })() !== undefined) throw new Error("module strictness lost");\n' +
    'const device = io.i2c("i2c0").open({address:0x32});\n' +
    'async function main() { globalThis.result = await device.run([read(0,[u8])]); await sleep(10); globalThis.slept = true; }\nmain();\n');
  await buildWorker({ projectRoot: outdir, outdir, output: "smoke", declaration: { entry, nodes: [{ name: "i2c0", kind: "i2c" }] } });
  let calls = 0;
  const timers: number[] = [];
  const realm = createContext({ __pocketWorker: host({ submit: () => { ++calls; return 2; }, timer: (_id, deadline) => { timers.push(deadline); return 0; } }) });
  const source = readFileSync(resolve(outdir, "smoke.worker.js"), "utf8");
  const scanned = new Bun.Transpiler({ loader: "js" }).scan(source);
  expect(scanned.imports).toHaveLength(0); expect(scanned.exports).toHaveLength(0);
  expect(source.trimStart()).toStartWith('"use strict";');
  expect(source.replace(/^\s*"use strict";\s*/, "")).not.toMatch(/^\(\(\)\s*=>\s*\{/);
  new Script(source).runInContext(realm);
  expect(calls).toBe(1); // the entry's task submitted during bootstrap
  realm.__pocketWorkerTurn(context, [fact()]); await jobs();
  expect(Array.from(realm.result)).toEqual([0x34, 0x12]);
  expect(timers).toEqual([1010]);
  realm.__pocketWorkerTurn({ ...context, sequence: 2, nowMicros: 1010 }, []); await jobs();
  expect(realm.slept).toBe(true);
  expect(realm.ui).toBeUndefined(); expect(realm.frame).toBeUndefined();
  writeFileSync(entry, 'import { render } from "@pocketjs/framework"; render();');
  await expect(buildWorker({ projectRoot: outdir, outdir, output: "bad", declaration: { entry, nodes: [] } })).rejects.toThrow();
  writeFileSync(entry, 'await Promise.resolve();');
  await expect(buildWorker({ projectRoot: outdir, outdir, output: "async-boot", declaration: { entry, nodes: [] } })).rejects.toThrow(/classic script/);
});

test("pocket check includes the independent worker entry", () => {
  const output = resolve(".pocket-build/validation/worker/sdk/typecheck-worker");
  mkdirSync(output, { recursive: true });
  const manifest = JSON.parse(readFileSync(resolve("apps/worker-http/pocket.json"), "utf8"));
  manifest.domains.worker.entry = ".pocket-build/validation/worker/sdk/typecheck-worker/invalid.ts";
  writeFileSync(resolve(output, "invalid.ts"), "const value: number = 'incorrect';\nvoid value;\n");
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
