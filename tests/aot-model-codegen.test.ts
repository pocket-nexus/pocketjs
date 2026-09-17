import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const output = resolve(".pocket-build/validation/model-aot/codegen");
const protocol = resolve("tests/fixtures/aot-model/protocol");

test("memo protocol keeps render borrows and existing immutable implementations", () => {
  mkdirSync(output, { recursive: true });
  const binary = `${output}/read-only-render`;
  const check = Bun.spawnSync(["rustc", "--edition=2021", "--test", `${protocol}/read-only-render.rs`, "-o", binary]);
  expect(check.exitCode, check.stderr.toString()).toBe(0);
  const run = Bun.spawnSync([binary]);
  expect(run.exitCode, run.stderr.toString()).toBe(0);
});

test.each([
  ["mutable-render-rejected", "E0502"],
  ["legacy-receiver-rejected", "E0053"],
])("rejected memo protocol alternative %s retains its compiler diagnostic", (fixture, code) => {
  mkdirSync(output, { recursive: true });
  const check = Bun.spawnSync(["rustc", "--edition=2021", "--crate-type=lib", `${protocol}/${fixture}.rs`, "--out-dir", output]);
  expect(check.exitCode).not.toBe(0);
  expect(check.stderr.toString()).toContain(code);
});

import type { ModelExpr, ModelModule, ModelProgram } from "../vapor/compiler/aot-model-ir.ts";
import { emptyLedger } from "../vapor/compiler/aot-model-ir.ts";
import { generateModelRust } from "../vapor/compiler/aot-model-codegen.ts";
import { I32, STRING, type AotType } from "../vapor/compiler/aot-ir.ts";
const loc = { file: "counter.ts", line: 1, column: 1, offset: 0 };
const lit = (value: number | string, type: AotType = typeof value === "string" ? STRING : I32): ModelExpr => ({ kind: "literal", value, type, ledger: emptyLedger(), loc });
const access = (kind: "signal" | "memo" | "local", id: number, type: AotType = I32): ModelExpr => ({ kind, id, type, ledger: { ...emptyLedger(), reads: [id] }, loc });
const plus = (left: ModelExpr, right: ModelExpr): ModelExpr => ({ kind: "binary", operator: "+", left, right, type: left.type, ledger: emptyLedger(), loc });
function counter(): ModelProgram {
  const model: ModelModule = {
    name: "Counter", file: "counter.ts", kind: "root", params: [], fields: [], refs: [], tasks: [],
    signals: [
      { id: 1, name: "count", exported: true, type: I32, seed: lit(0) },
      { id: 2, name: "history", exported: true, type: STRING, seed: lit("seed") },
      { id: 3, name: "runs", exported: true, type: I32, seed: lit(0) },
    ],
    memos: [{ id: 4, name: "double", exported: true, type: I32, inputs: [1], body: plus(access("signal", 1), access("signal", 1)) }],
    effects: [{ id: 5, subscriptions: [1], declared: true, defer: true, ledger: emptyLedger(), body: { stmts: [
      { kind: "set", signal: 3, pre: { id: 6, name: "old", type: I32, owned: true }, value: plus(access("local", 6), lit(1)) },
      { kind: "set", signal: 2, pre: { id: 7, name: "previous", type: STRING, owned: true }, value: plus(access("local", 7, STRING), lit("x")) },
    ] } }],
    functions: [{ id: 8, name: "press", exported: true, async: false, params: [], returns: { kind: "void" }, ledger: { ...emptyLedger(), writes: [1] }, body: { stmts: [{ kind: "set", signal: 1, pre: { id: 9, name: "before", type: I32, owned: true }, value: plus(access("local", 9), lit(1)) }] } }],
    schedule: [4, 5],
  };
  return { version: 1, modules: [model], types: [], diagnostics: [], recursionLimit: 256 };
}

export function checkModelRust(name: string, source: string, harness: string) {
  const directory = `${output}/${name}`;
  mkdirSync(`${directory}/src`, { recursive: true });
  writeFileSync(`${directory}/Cargo.toml`, `[package]\nname = "model-aot-${name}"\nversion = "0.0.0"\nedition = "2021"\n[workspace]\n[dependencies]\npocket_vapor = { path = ${JSON.stringify(resolve("engine/crates/pocket-vapor"))}, features = ["std"] }\n`);
  writeFileSync(`${directory}/src/model.rs`, source);
  writeFileSync(`${directory}/src/lib.rs`, `mod model;\nuse model::*;\nuse pocket_vapor::{Cmd, Ready};\n${harness}`);
  const result = Bun.spawnSync(["cargo", "test", "--quiet", "--manifest-path", `${directory}/Cargo.toml`], { stdout: "pipe", stderr: "pipe", env: { ...process.env, CARGO_TARGET_DIR: `${output}/target` } });
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
}

test("generated model implements seeds, once-per-reaction pre, on-demand memo and wrapping i32", () => {
  checkModelRust("counter", generateModelRust(counter()), `
#[test] fn counter_contract() {
    let mut m = CounterModel::default(); let mut cmds = Vec::new();
    assert_eq!(m.history(), "seed"); assert_eq!(m.double(), 0);
    m.react(true, &mut cmds); m.settle(); assert_eq!(m.runs(), 0);
    m.press(); m.press(); assert_eq!(m.double_now(), 4);
    m.react(false, &mut cmds); m.settle();
    assert_eq!(m.count(), 2); assert_eq!(m.double(), 4);
    assert_eq!(m.runs(), 1); assert_eq!(m.history(), "seedx");
    m.react(false, &mut cmds); m.settle(); assert_eq!(m.runs(), 1);
    m.set_count(i32::MAX); m.press(); assert_eq!(m.count(), i32::MIN);
}
`);
}, 120_000);

test("Rust emission is deterministic and rustfmt is idempotent", () => {
  const first = generateModelRust(counter());
  expect(generateModelRust(counter())).toBe(first);
  const file = `${output}/determinism.rs`;
  mkdirSync(output, { recursive: true }); writeFileSync(file, first);
  const format = () => Bun.spawnSync(["rustfmt", "--edition", "2021", file]);
  expect(format().exitCode).toBe(0);
  const once = readFileSync(file, "utf8"); expect(format().exitCode).toBe(0);
  expect(readFileSync(file, "utf8")).toBe(once);
});

test("generated task resumes after the boundary, restarts and keeps earlier writes", () => {
  const program = counter(), module = program.modules[0]!;
  module.functions.push({ id: 20, name: "blink", exported: true, async: true, params: [], returns: { kind: "void" }, ledger: emptyLedger(), body: { stmts: [] } });
  module.tasks.push({ id: 20, fn: 20, fields: [], states: [
    { id: 0, body: { stmts: [{ kind: "set", signal: 1, value: lit(1) }] }, suspend: { kind: "frames", count: lit(2) }, next: 1 },
    { id: 1, body: { stmts: [{ kind: "set", signal: 1, value: lit(7) }] } },
  ] });
  checkModelRust("task", generateModelRust(program), `
#[test] fn task_contract() {
    let mut m = CounterModel::default(); let mut cmds = Vec::new();
    m.react(true, &mut cmds);
    m.blink(); assert_eq!(m.count(), 1);
    m.resume(&Ready { frame: 1, ..Default::default() }, &mut cmds);
    assert_eq!(m.count(), 1);
    m.blink(); m.react(false, &mut cmds);
    assert!(cmds.iter().any(|c| matches!(c, Cmd::Cancel { .. })));
    m.resume(&Ready { frame: 2, ..Default::default() }, &mut cmds); assert_eq!(m.count(), 1);
    m.resume(&Ready { frame: 3, ..Default::default() }, &mut cmds); assert_eq!(m.count(), 7);
    assert!(m.model_changed()); m.react(false, &mut cmds); m.settle(); assert!(!m.model_changed());
}
`);
}, 120_000);

import { analyzeModel } from "../vapor/compiler/aot-model-frontend.ts";
const virtualEntry = resolve("tests/fixtures/aot-model/generated/app.ts");
const standardImports = `import { createSignal } from "solid-js";\nimport { createMemo, createEffect, on } from "@pocketjs/framework/solid/reactive";\nimport { copy, equals, len, map, filter, some, find, frames, after, until, all, any, join, cancel, type i32, type Cap } from "@pocketjs/framework/solid/std";\n`;
function compileSource(source: string) { return generateModelRust(analyzeModel(virtualEntry, { sources: new Map([[virtualEntry, standardImports + source]]) })); }

test("analyzed sources preserve helper returns, shadowing, argument evaluation and recursion", () => {
  checkModelRust("functions", compileSource(`
export const [count, setCount] = createSignal(0);
export const [result, setResult] = createSignal(0);
function recursive(n: i32): i32 { if (n === 0) return 1; return n * recursive(n - 1); }
function helper(value: i32): i32 { let count = 90; setCount(7); if (value > 0) return value; return count; }
export function press() { let count = 3; const value = helper(count + 1); setResult(value + recursive(5)); }
`), `#[test] fn semantics() { let mut m = AppModel::default(); m.press(); assert_eq!(m.count(), 7); assert_eq!(m.result(), 124); }`);
}, 120_000);

test("analyzed arrays copy owned values and distinguish write-back from replacement", () => {
  checkModelRust("owned", compileSource(`
export const [items, setItems] = createSignal<i32[]>([1]);
export const [trigger, setTrigger] = createSignal(0);
export const [runs, setRuns] = createSignal(0);
createEffect(on([items], () => setRuns(r => r + 1), { defer: true }));
export function unchanged() { const view = items(); setItems(view); }
export function replace() { const owned = copy(items()); setItems(owned); owned[0] = 4; setTrigger(1); }
`), `#[test] fn semantics() { let mut m = AppModel::default(); let mut commands = Vec::new(); m.react(true, &mut commands); m.unchanged(); m.react(false, &mut commands); assert_eq!(m.runs(), 0); m.replace(); m.react(false, &mut commands); assert_eq!(m.runs(), 1); assert_eq!(m.items(), &[1]); }`);
}, 120_000);

test("analyzed task branches and task results compile and resume in start order", () => {
  checkModelRust("task-source", compileSource(`
export const [value, setValue] = createSignal(0);
async function child(n: i32): Promise<i32> { await frames(1); return n + 1; }
export async function run(): Promise<void> { const x = await child(3); if (x > 0) { await frames(1); setValue(x); } }
`), `#[test] fn semantics() { let mut m = AppModel::default(); let mut cmds = Vec::new(); m.run(); for f in 1..=4 { m.resume(&Ready { frame: f, ..Default::default() }, &mut cmds); m.react(false, &mut cmds); } assert_eq!(m.value(), 4); }`);
}, 120_000);

test("tagged UTF-8 storage and primitive reactions allocate nothing after mount", () => {
  checkModelRust("bounded", compileSource(`
export const [text, setText] = createSignal<Cap<string, 32>>("é");
export const [count, setCount] = createSignal(0);
export const double = createMemo(() => count() * 2);
export function press() { setCount(n => n + 1); setText(s => s + "é"); }
`), `
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
struct CountAlloc; static ACTIVE: AtomicBool = AtomicBool::new(false); static ALLOCS: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for CountAlloc { unsafe fn alloc(&self, l: Layout) -> *mut u8 { if ACTIVE.load(Ordering::SeqCst) { ALLOCS.fetch_add(1, Ordering::SeqCst); } System.alloc(l) } unsafe fn dealloc(&self, p: *mut u8, l: Layout) { System.dealloc(p,l) } }
#[global_allocator] static ALLOC: CountAlloc = CountAlloc;
#[test] fn bounded() { let mut m = AppModel::default(); let mut cmds = Vec::new(); m.react(true, &mut cmds); ACTIVE.store(true, Ordering::SeqCst); m.press(); m.react(false, &mut cmds); m.settle(); ACTIVE.store(false, Ordering::SeqCst); assert_eq!(ALLOCS.load(Ordering::SeqCst), 0); assert_eq!(m.text(), "éé"); assert_eq!(m.double(), 2); }
`);
}, 120_000);

test("contract structs, map/filter/find and enum discriminants produce owned values", () => {
  checkModelRust("records", compileSource(`
interface Row { id: i32; name: string; enabled: boolean }
export const [rows, setRows] = createSignal<Row[]>([{ id: 1, name: "a", enabled: true }, { id: 2, name: "b", enabled: false }]);
export const enabled = createMemo(() => len(filter(rows(), r => r.enabled)));
export function toggle() { setRows(map(rows(), r => ({ id: r.id, name: r.name, enabled: !r.enabled }))); }
`), `#[test] fn records() { let mut m = AppModel::default(); assert_eq!(m.enabled(), 1); m.toggle(); m.settle(); assert_eq!(m.enabled(), 1); assert!(!m.rows()[0].enabled); }`);
}, 120_000);
