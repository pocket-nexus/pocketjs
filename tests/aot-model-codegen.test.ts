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

import type { ModelExpr, ModelModule, ModelProgram } from "../microts/compiler/aot-model-ir.ts";
import { emptyLedger } from "../microts/compiler/aot-model-ir.ts";
import { generateModelRust } from "../microts/compiler/aot-model-codegen.ts";
import { I32, STRING, type AotType } from "../microts/compiler/aot-ir.ts";
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
  writeFileSync(`${directory}/Cargo.toml`, `[package]\nname = "model-aot-${name}"\nversion = "0.0.0"\nedition = "2021"\n[workspace]\n[dependencies]\nmicrots = { path = ${JSON.stringify(resolve("engine/crates/microts"))}, features = ["std"] }\n`);
  writeFileSync(`${directory}/src/model.rs`, source);
  writeFileSync(`${directory}/src/lib.rs`, `mod model;\nuse model::*;\nuse microts::{Cmd, Ready};\n${harness}`);
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
    m.blink(&mut cmds); assert_eq!(m.count(), 1);
    m.resume(&Ready { frame: 1, ..Default::default() }, &mut cmds);
    assert_eq!(m.count(), 1);
    m.blink(&mut cmds); m.react(false, &mut cmds);
    assert!(cmds.is_empty());
    m.resume(&Ready { frame: 2, ..Default::default() }, &mut cmds); assert_eq!(m.count(), 1);
    m.resume(&Ready { frame: 3, ..Default::default() }, &mut cmds); assert_eq!(m.count(), 7);
    assert!(m.model_changed()); m.react(false, &mut cmds); m.settle(); assert!(!m.model_changed());
}
`);
}, 120_000);

import { analyzeModel } from "../microts/compiler/aot-model-frontend.ts";
const virtualEntry = resolve("tests/fixtures/aot-model/generated/app.ts");
const standardImports = `import { createSignal } from "solid-js";\nimport { createMemo, createEffect, on } from "@pocketjs/framework/solid/reactive";\nimport { copy, equals, len, map, filter, some, find, frames, after, until, all, any, join, cancel, type i32, type Cap } from "@pocketjs/framework/solid/std";\n`;
function compileSource(source: string) { return generateModelRust(analyzeModel(virtualEntry, { sources: new Map([[virtualEntry, standardImports + source]]) })); }
test("division promotes integer operands and preserves explicitly floating precision", () => {
  const source = compileSource(`import type {f32,f64} from "@pocketjs/framework/solid/std";
export const [ratio,setRatio]=createSignal<f64>(0);export const [single,setSingle]=createSignal<f32>(0);
export function press():void {setRatio(1/2);const value:f32=1;setSingle(value/2);}`);
  checkModelRust("division-promotion", source, '#[test]fn division(){let mut m=AppModel::default();m.press();assert_eq!(m.ratio(),0.5f64);assert_eq!(m.single(),0.5f32);}');
});

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
`), `#[test] fn semantics() { let mut m = AppModel::default(); let mut cmds = Vec::new(); m.run(&mut cmds); for f in 1..=4 { m.resume(&Ready { frame: f, ..Default::default() }, &mut cmds); m.react(false, &mut cmds); } assert_eq!(m.value(), 4); }`);
}, 120_000);

test("tagged UTF-8 storage and primitive reactions allocate nothing after mount", () => {
  checkModelRust("bounded", compileSource(`
export const [text, setText] = createSignal<Cap<string, 32>>("é");
export const [count, setCount] = createSignal(0);
export const [numbers,setNumbers] = createSignal<Cap<i32[],4>>([1,2]);
export const double = createMemo(() => count() * 2);
export function press() { setCount(n => n + 1); setText(s => s + "é"); setNumbers(map(numbers(),n=>n+1)); }
`), `
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
struct CountAlloc; thread_local! { static ACTIVE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; } static ALLOCS: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for CountAlloc { unsafe fn alloc(&self, l: Layout) -> *mut u8 { if ACTIVE.try_with(|active| active.get()).unwrap_or(false) { ALLOCS.fetch_add(1, Ordering::SeqCst); } System.alloc(l) } unsafe fn dealloc(&self, p: *mut u8, l: Layout) { System.dealloc(p,l) } }
#[global_allocator] static ALLOC: CountAlloc = CountAlloc;
#[test] fn bounded() { let mut m = AppModel::default(); let mut cmds = Vec::new(); m.react(true, &mut cmds); ACTIVE.with(|active| active.set(true)); m.press(); m.react(false, &mut cmds); m.settle(); ACTIVE.with(|active| active.set(false)); assert_eq!(ALLOCS.load(Ordering::SeqCst), 0); assert_eq!(m.text(), "éé"); assert_eq!(m.double(), 2); }
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

test("task readiness uses one snapshot and nested waits retain earlier completions", () => {
  checkModelRust("task-snapshot", compileSource(`
export const [gate, setGate] = createSignal(0);
export const [seen, setSeen] = createSignal(0);
export async function writer(): Promise<void> { await frames(1); setGate(1); }
export async function reader(): Promise<void> { await until(() => gate() > 0); setSeen(1); }
export async function nested(): Promise<void> { await all([any([frames(1), frames(9)]), frames(2)]); setSeen(2); }
`), `#[test] fn snapshot() { let mut m = AppModel::default(); let mut cmds = Vec::new(); m.writer(&mut cmds); m.reader(&mut cmds); m.resume(&Ready { frame: 1, ..Default::default() }, &mut cmds); assert_eq!(m.gate(), 1); assert_eq!(m.seen(), 0); m.resume(&Ready { frame: 2, ..Default::default() }, &mut cmds); assert_eq!(m.seen(), 1); m.nested(&mut cmds); m.resume(&Ready { frame: 3, ..Default::default() }, &mut cmds); assert_eq!(m.seen(), 1); m.resume(&Ready { frame: 4, ..Default::default() }, &mut cmds); assert_eq!(m.seen(), 2); assert!(cmds.is_empty()); }`);
}, 120_000);

test("typed services enforce capability, region capacity, boundary validation and late-result dropping", () => {
  checkModelRust("task-service", compileSource(`
import { net } from "@pocketjs/framework/net/model";
export const [result, setResult] = createSignal("idle");
export async function load(): Promise<void> { const r = await net.get("/resource"); setResult(r.kind); }
export async function crowded(): Promise<void> { const r = await all([net.get("/1"), net.get("/2"), net.get("/3"), net.get("/4"), net.get("/5")]); }
export async function nested(): Promise<void> { const r = await all([any([net.get("/first"), net.get("/loser")]), net.get("/last")]); }
`), `
use microts::model::{Value, Completion, Delivery};
fn ready(frame: u64) -> Ready { Ready { frame, services: vec!["@pocketjs/framework/net/model".into()], ..Default::default() } }
#[test] fn services() {
 let mut m = AppModel::default(); let mut cmds = Vec::new(); m.load(&mut cmds); assert_eq!(m.result(), "idle"); m.resume(&Ready { frame: 1, ..Default::default() }, &mut cmds); assert_eq!(m.result(), "unavailable"); assert!(cmds.is_empty());
 m.prepare_resume(&ready(2)); m.load(&mut cmds); m.react(false, &mut cmds); let old = match cmds.pop().unwrap() { Cmd::Request { request, .. } => request, _ => panic!() };
 m.load(&mut cmds); m.react(false, &mut cmds); let current = match cmds.pop().unwrap() { Cmd::Request { request, .. } => request, _ => panic!() }; assert_ne!(old, current);
 let mut boundary = ready(3); boundary.deliveries.push(Delivery { request: old, result: Completion::Value(Value::String("late".into())) }); m.resume(&boundary, &mut cmds); assert_eq!(m.result(), "unavailable");
 boundary.frame = 4; boundary.deliveries = vec![Delivery { request: current, result: Completion::Value(Value::Object(vec![("kind".into(), Value::String("ok".into())), ("status".into(), Value::I32(900)), ("body".into(), Value::String("bad".into()))])) }]; m.resume(&boundary, &mut cmds); assert_eq!(m.result(), "malformed");
 cmds.clear(); m.crowded(&mut cmds); m.react(false, &mut cmds); assert_eq!(cmds.iter().filter(|cmd| matches!(cmd, Cmd::Request { .. })).count(), 4);
 m.cancel_tasks(&mut cmds); assert_eq!(cmds.iter().filter(|cmd| matches!(cmd, Cmd::Cancel { .. })).count(), 4);
 cmds.clear(); m.nested(&mut cmds); m.react(false, &mut cmds); let pending: Vec<_> = cmds.iter().filter_map(|cmd| match cmd { Cmd::Request { request, .. } => Some(*request), _ => None }).collect(); assert_eq!(pending.len(), 3);
 cmds.clear(); let mut boundary = ready(5); boundary.deliveries.push(Delivery { request: pending[0], result: Completion::Value(Value::Object(vec![("kind".into(), Value::String("failed".into())), ("message".into(), Value::String("failure".into()))])) }); m.resume(&boundary, &mut cmds);
 assert_eq!(cmds, vec![Cmd::Cancel { request: pending[1] }]);
 cmds.clear(); m.crowded(&mut cmds); m.react(false, &mut cmds); assert_eq!(cmds.iter().filter(|cmd| matches!(cmd, Cmd::Request { .. })).count(), 3);
}`);
}, 120_000);

test("awaited animation emits a tracked command and decodes all track outcomes", () => {
  checkModelRust("task-animation", compileSource(`
import { createNodeRef, animate, jump } from "@pocketjs/framework/animation";
export const bar = createNodeRef();
export const [result, setResult] = createSignal("idle");
export async function run(): Promise<void> { const property: "width" | "height" = "width"; const end = await animate(bar, property, 200, { dur: 15_000, easing: "out" }); setResult(end); }
export function move() { jump(bar, "bgColor", "#010203"); }
`), `
use microts::model::{Completion, Delivery, AnimationResult};
#[test] fn animation() { let mut m = AppModel::default(); let mut cmds = Vec::new(); m.run(&mut cmds); m.react(false, &mut cmds); let request = match cmds.pop().unwrap() { Cmd::Animate { node, prop, to, dur, easing, request: Some(request), .. } => { assert_eq!(node, None); assert_eq!(prop, 1); assert_eq!(to, 200.0); assert_eq!(dur, 15000); assert_eq!(easing, 2); request }, _ => panic!() }; m.resume(&Ready { frame: 1, deliveries: vec![Delivery { request, result: Completion::Animation(AnimationResult::Dropped) }], ..Default::default() }, &mut cmds); assert_eq!(m.result(), "dropped"); m.r#move(); m.react(false, &mut cmds); assert!(matches!(cmds.pop(), Some(Cmd::Jump { value, .. }) if value == 0xff030201_u32 as f64)); }
`);
}, 120_000);

test("primitive task segments and bounded completion retention allocate nothing after mount", () => {
  checkModelRust("task-allocation", compileSource(`
export const [count, setCount] = createSignal(0);
async function child(): Promise<i32> { await frames(1); return 7; }
export async function run(): Promise<void> { const value = await child(); setCount(value); }
`), `
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
struct CountAlloc; thread_local! { static ACTIVE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; } static ALLOCS: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for CountAlloc { unsafe fn alloc(&self, l: Layout) -> *mut u8 { if ACTIVE.try_with(|active| active.get()).unwrap_or(false) { ALLOCS.fetch_add(1, Ordering::SeqCst); } System.alloc(l) } unsafe fn dealloc(&self, p: *mut u8, l: Layout) { System.dealloc(p,l) } }
#[global_allocator] static ALLOC: CountAlloc = CountAlloc;
#[test] fn allocation() { let mut m = AppModel::default(); let mut cmds = Vec::new(); m.react(true, &mut cmds); ACTIVE.with(|active| active.set(true)); for cycle in 0..100 { m.run(&mut cmds); m.run(&mut cmds); for frame in (cycle*3 + 1)..=(cycle*3 + 3) { m.resume(&Ready { frame, ..Default::default() }, &mut cmds); m.react(false, &mut cmds); m.settle(); } } ACTIVE.with(|active| active.set(false)); assert_eq!(ALLOCS.load(Ordering::SeqCst), 0); assert_eq!(m.count(), 7); }
`);
}, 120_000);

test("all wait tuples have no runtime trait arity limit", () => {
  checkModelRust("task-many-members", compileSource(`
export const [count,setCount]=createSignal(0);
export async function run():Promise<void>{const results=await all([${Array.from({ length: 17 }, () => "frames(1)").join(",")}]);await frames(1);setCount(1);}
`), `#[test] fn many(){let mut m=AppModel::default();let mut commands=Vec::new();m.run(&mut commands);for frame in 1..=2{m.resume(&Ready{frame,..Default::default()},&mut commands);}assert_eq!(m.count(),1);}`);
}, 120_000);

test("binding helper variants read cached memos while handler calls refresh on demand", () => {
  checkModelRust("render-helper", compileSource(`
export const [count,setCount]=createSignal(0);
export const [result,setResult]=createSignal("");
export const double=createMemo(()=>count()*2);
function part():string{return String(double());}
export function caption():string{return part();}
export function press(){setCount(3);setResult(caption());}
`), `#[test]fn helper(){let mut m=AppModel::default();m.set_count(4);assert_eq!(m.caption(),"0");m.press();assert_eq!(m.result(),"6");m.settle();assert_eq!(m.caption(),"6");}`);
}, 120_000);

test("owned array writes drop dynamic bounds and indexed builtins bind scalar indices", () => {
  checkModelRust("array-boundaries", compileSource(`
interface Row { id:i32; name:string }
export const [items,setItems]=createSignal<i32[]>([10,20]);
export const [result,setResult]=createSignal(0);
export const [label,setLabel]=createSignal("");
export function write(index:i32){const values=copy(items());values[index]=99;setItems(values);}
export function visit(){setItems(map(items(),(value,index)=>value+index));setResult(len(filter(items(),(value,index)=>index===1))+ (some(items(),(value,index)=>index===0)?1:0)+(find(items(),(value,index)=>index===1)??0));}
export function readRow(index:i32){const values:Row[]=[{id:7,name:"known"}];const row=values[index];setLabel(row.name);}
`), `#[test]fn arrays(){let mut m=AppModel::default();m.write(-1);m.write(99);assert_eq!(m.items(),&[10,20]);m.visit();assert_eq!(m.items(),&[10,21]);assert_eq!(m.result(),23);m.readRow(100);assert_eq!(m.label(),"");}`);
}, 120_000);

test("setter returns stay inside their expression and wait arguments observe prior child starts", () => {
  checkModelRust("callback-wait-order", compileSource(`
export const [count,setCount]=createSignal(1);export const [seen,setSeen]=createSignal(0);
export function press(){setCount(previous=>{if(previous>0)return 5;return 2;});setSeen(1);}
function argument():i32{setCount(n=>n+1);return count();}
async function child(n:i32):Promise<void>{setCount(n+10);await frames(1);}
export async function run():Promise<void>{await all([child(argument()),frames(argument())]);setSeen(9);}
`), `#[test]fn order(){let mut m=AppModel::default();let mut commands=Vec::new();m.press();assert_eq!(m.count(),5);assert_eq!(m.seen(),1);m.run(&mut commands);assert_eq!(m.count(),17);for frame in 1..17{m.resume(&Ready{frame,..Default::default()},&mut commands);}assert_eq!(m.seen(),1);m.resume(&Ready{frame:17,..Default::default()},&mut commands);assert_eq!(m.seen(),9);}`);
}, 120_000);

test("capacity traps name the destination field", () => {
  checkModelRust("capacity-name", compileSource(`
export const [label,setLabel]=createSignal<Cap<string,4>>("");
export function press(){setLabel("abcde");}
`), `#[test]#[should_panic(expected="model capacity exceeded in label")]fn destination(){let mut m=AppModel::default();m.press();}`);
}, 120_000);

test("tagged task results and ignored or typed all completions remain allocation-free", () => {
  checkModelRust("typed-task-allocation", compileSource(`
export const [items,setItems]=createSignal<Cap<i32[],2>>([]);
export const [count,setCount]=createSignal(0);
async function tagged():Promise<Cap<i32[],2>>{return [1,2];}
async function first():Promise<i32>{await frames(1);return 3;}
async function second():Promise<i32>{await frames(1);return 4;}
export async function run():Promise<void>{const value=await tagged();setItems(value);await all([frames(1),frames(1)]);const values=await all([first(),second()]);setCount(n=>n+1);}
`), `
use std::alloc::{GlobalAlloc, Layout, System};use std::sync::atomic::{AtomicUsize, Ordering};
struct CountAlloc;thread_local!{static ACTIVE:std::cell::Cell<bool>=const{std::cell::Cell::new(false)};}static ALLOCS:AtomicUsize=AtomicUsize::new(0);
unsafe impl GlobalAlloc for CountAlloc{unsafe fn alloc(&self,layout:Layout)->*mut u8{if ACTIVE.try_with(|active|active.get()).unwrap_or(false){ALLOCS.fetch_add(1,Ordering::SeqCst);}System.alloc(layout)}unsafe fn dealloc(&self,pointer:*mut u8,layout:Layout){System.dealloc(pointer,layout)}}
#[global_allocator]static ALLOC:CountAlloc=CountAlloc;
#[test]fn bounded_tasks(){let mut model=AppModel::default();let mut commands=Vec::new();model.react(true,&mut commands);ACTIVE.with(|active|active.set(true));for cycle in 0..100{model.run(&mut commands);for frame in cycle*4+1..=cycle*4+4{model.resume(&Ready{frame,..Default::default()},&mut commands);model.react(false,&mut commands);model.settle();}}ACTIVE.with(|active|active.set(false));assert_eq!(ALLOCS.load(Ordering::SeqCst),0);assert_eq!(model.count(),100);assert_eq!(model.items(),&[1,2]);}
`);
}, 120_000);

test("public async entry returns unit and drains commands through its explicit sink in issue order", () => {
  checkModelRust("async-command-sink", compileSource(`
export function before():void{console.log("before");}
export async function load(cmds:i32):Promise<i32>{console.log("start",cmds);await frames(1);return cmds;}
`), `#[test]fn signature(){let mut model=AppModel::default();let mut commands=vec![Cmd::Log("existing".into())];model.before();let result:()=model.load(7,&mut commands);assert_eq!(result,());assert_eq!(commands,vec![Cmd::Log("existing".into()),Cmd::Log("before".into()),Cmd::Log("start 7".into())]);model.resume(&Ready{frame:1,..Default::default()},&mut commands);model.react(false,&mut commands);assert_eq!(commands.len(),3);}`);
}, 120_000);
