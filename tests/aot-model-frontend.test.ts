import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { analyzeModel } from "../vapor/compiler/aot-model-frontend.ts";
import { AotCompileError } from "../vapor/compiler/aot-ir.ts";

const entry = resolve(import.meta.dir, "fixtures/aot-model/virtual/app.ts");
const prelude = 'import { createSignal, untrack, batch } from "solid-js";\nimport { createMemo, createEffect, on } from "@pocketjs/framework/solid/reactive";\nimport { copy, equals, type i32 } from "@pocketjs/framework/solid/std";\n';
const analyze = (source: string, extra: Record<string, string> = {}) => analyzeModel(entry, { sources: new Map([[entry, prelude + source], ...Object.entries(extra).map(([name, value]) => [resolve(entry, "..", name), value] as [string, string])]) });
const names = (module: ReturnType<typeof analyze>["modules"][number], ids: number[]) => ids.map(id => [...module.signals, ...module.fields, ...module.memos, ...module.functions].find(x => x.id === id)?.name ?? `effect:${id}`);

describe("Model AOT front end: MODEL_AOT §§2–5", () => {
  test.each([
    ["1", "i32"], ["1.0", "f64"], ["1e3", "f64"], ["2.50", "f64"], ["0x10", "i32"], ["1_000", "i32"], [".5", "f64"], ["-0", "i32"],
  ])("classifies source literal %s as %s", (literal, name) => {
    expect(analyze(`export const [n, setN] = createSignal(${literal});`).modules[0]!.signals[0]!.type).toEqual({ kind: "number", name });
  });
  test.each(["1.0", "1e3", "2.50", ".5"])("rejects %s in an i32 position at the literal", literal => {
    try { analyze(`export const [n, setN] = createSignal<i32>(${literal});`); throw new Error("accepted"); }
    catch (error) {
      expect(error).toBeInstanceOf(AotCompileError);
      const diagnostic = (error as AotCompileError).diagnostics[0]!;
      expect(diagnostic.message).toContain("fractional literal");
      expect([diagnostic.file, diagnostic.line, diagnostic.column]).toEqual([entry, 4, 44]);
    }
  });
  test("keeps pre reads separate from subscriptions and orders the writer before its reader", () => {
    const m = analyze(`export const [trigger, setTrigger] = createSignal(0);
export const [count, setCount] = createSignal(0);
export const double = createMemo(() => count() * 2);
createEffect(on([double], () => { console.log(double()); }));
createEffect(on([trigger], () => { setCount(c => c + 1); }));`).modules[0]!;
    expect(names(m, m.effects[1]!.ledger.reads)).toEqual(["count"]);
    expect(names(m, m.effects[1]!.ledger.writes)).toEqual(["count"]);
    expect(names(m, m.effects[1]!.subscriptions)).toEqual(["trigger"]);
    expect(m.schedule).toEqual([m.effects[1]!.id, m.memos[0]!.id, m.effects[0]!.id]);
  });
  test("records reads under untrack without subscriptions", () => {
    const m = analyze(`export const [count, setCount] = createSignal(0);
export const [tick, setTick] = createSignal(0);
createEffect(() => { count(); untrack(() => { console.log(tick()); }); });`).modules[0]!;
    expect(names(m, m.effects[0]!.ledger.reads)).toEqual(["count", "tick"]);
    expect(names(m, m.effects[0]!.subscriptions)).toEqual(["count"]);
  });
  test.each([
    ['export const [n, setN] = createSignal(0); createEffect(() => setN(n() + 1));', "cycle"],
    ['export const [n, setN] = createSignal(0); createEffect(on([n], () => setN(x => x + 1)));', "cycle"],
    ['export const [a, setA] = createSignal(false); export const [n, setN] = createSignal(0); createEffect(() => { if (a()) console.log(n()); });', "dependencies of this effect depend on control flow"],
    ['let field = 1; export const memo = createMemo(() => field);', "private field"],
    ['export function go() { while (true) {} }', "while"],
    ['export function go() { let x = 1; x = x / 2; }', "numeric type"],
    ['export const [items, setItems] = createSignal<i32[]>([1]); export function go() { const a = items(); a[0] = 2; }', "write through a view"],
    ['export const [items, setItems] = createSignal<i32[]>([1]); export function go() { return items() === items(); }', "non-primitive"],
    ['export const [n, setN] = createSignal(0); createEffect(() => { setN(x => x + n()); });', "cycle"],
  ])("rejects a specified semantic violation: %s", (source, message) => expect(() => analyze(source)).toThrow(message));
  test("checks a reached module even when importing only a constant", () => {
    expect(() => analyze('import { LIMIT } from "./pure"; export const [n, setN] = createSignal(LIMIT);', { "pure.ts": "export const LIMIT = 3;\nconsole.log(1);" })).toThrow("pure.ts:2:1");
  });
  test("rejects state from another model region", () => {
    expect(() => analyze('import { n } from "./other"; export function read() { return n(); }', { "other.ts": 'import { createSignal } from "solid-js"; export const [n, setN] = createSignal(0);' })).toThrow("model");
  });
  test("binds shadowing hygienically and normalizes call arguments in source order", () => {
    const p = analyze(`export const [count, setCount] = createSignal(0);
function helper(n: i32): i32 { let count = n; return count; }
export function press(): i32 { let count = 9; return helper(count + 1); }`);
    const m = p.modules[0]!;
    const local = m.functions[1]!.body.stmts[0]!;
    expect(local.kind).toBe("let");
    expect(JSON.stringify(p)).toBe(JSON.stringify(analyze(`export const [count, setCount] = createSignal(0);
function helper(n: i32): i32 { let count = n; return count; }
export function press(): i32 { let count = 9; return helper(count + 1); }`)));
    expect(m.functions[1]!.body.stmts.length).toBeGreaterThan(2);
  });
  test("marks only a current immutable view write as a write-back", () => {
    const m = analyze(`export const [items, setItems] = createSignal<i32[]>([1]);
export function press() { const view = items(); setItems(view); const own = copy(items()); setItems(own); setItems(own); }`).modules[0]!;
    const writes = m.functions[0]!.body.stmts.filter(x => x.kind === "set");
    expect(writes.map(x => x.writeBack === true)).toEqual([true, false, false]);
  });
  test("Vue ref/computed and framework watch use the same model boundary", () => {
    const p = analyzeModel(entry, { sources: new Map([[entry, `import { ref, computed } from "vue";
import { watch } from "@pocketjs/framework/vue-vapor/reactive";
export const count = ref(0);
export const double = computed(() => count.value * 2);
watch(count, () => { console.log(double.value); });
export function increment() { count.value += 1; }`]]) });
    const m = p.modules[0]!;
    expect(m.signals.map(x => x.name)).toEqual(["count"]);
    expect(m.memos.map(x => x.name)).toEqual(["double"]);
    expect(m.effects[0]!.defer).toBe(true);
    expect(m.effects[0]!.subscriptions).toEqual([m.signals[0]!.id]);
    expect(m.functions[0]!.ledger.writes).toEqual([m.signals[0]!.id]);
  });
});

describe("Model AOT admitted module shapes", () => {
  test("pure helpers import through checker symbols, including import aliases", () => {
    const p = analyze('import { twice as double, LIMIT } from "./math"; export const [n, setN] = createSignal(LIMIT); export function press(): i32 { return double(n()); }', { "math.ts": 'import type { i32 } from "@pocketjs/framework/solid/std"; export const LIMIT = 3; export function twice(n: i32): i32 { return n * 2; }' });
    expect(p.modules.map(m => m.kind)).toEqual(["root", "pure"]);
    expect(p.modules[0]!.signals[0]!.seed).toMatchObject({ kind: "literal", value: 3 });
    expect(p.modules[0]!.functions[0]!.ledger.reads).toEqual([p.modules[0]!.signals[0]!.id]);
  });
  test("factory parameters seed separate region fields and returned members become public", () => {
    const file = resolve(entry, "../Row.ts");
    const p = analyzeModel(entry, { factories: [file], sources: new Map([[entry, prelude + "export const [n, setN] = createSignal(0);"], [file, prelude + "export function createRow(seed: i32) { const [n, setN] = createSignal(seed); function inc() { setN(x => x + 1); } return { n, inc }; }"]]) });
    const m = p.modules[1]!;
    expect(m.kind).toBe("factory");
    expect(m.signals[0]!.seed).toMatchObject({ kind: "local", id: m.params[0]!.id });
    expect(m.signals[0]!.exported).toBe(true);
    expect(m.functions[0]!.exported).toBe(true);
  });
  test("async lowering records bounded loop continuations and captured owned locals", () => {
    const p = analyze('import { frames } from "@pocketjs/framework/solid/std"; export const [n, setN] = createSignal(0); export async function load(): Promise<void> { const before = n(); for (let i = 0; i < 2; i++) { await frames(1); setN(before + i); } }');
    const task = p.modules[0]!.tasks[0]!;
    expect(task.states.some(s => s.suspend?.kind === "frames")).toBe(true);
    expect(task.fields.some(f => f.name === "before" && f.owned)).toBe(true);
    expect(task.fields.some(f => f.name === "i" && f.owned)).toBe(true);
  });
  test("capacity metadata survives signal types and nested struct fields", () => {
    const p = analyze('import type { Cap } from "@pocketjs/framework/solid/std"; interface Row { title: Cap<string, 16> } export const [rows, setRows] = createSignal<Cap<Row[], 4>>([]);');
    expect(p.modules[0]!.signals[0]!.type).toMatchObject({ kind: "array", capacity: 4 });
    expect(p.types.find(t => t.kind === "struct" && t.name === "Row")).toMatchObject({ fields: [{ name: "title", type: { kind: "string", capacity: 16 } }] });
  });
  test("collection arrows retain symbol binding and capture subscriptions", () => {
    const p = analyze('import { map, some } from "@pocketjs/framework/solid/std"; export const [items, setItems] = createSignal<i32[]>([1, 2]); export const [n, setN] = createSignal(1); export const active = createMemo(() => some(items(), x => x > n())); export function press() { setItems(map(items(), x => x + 1)); }');
    const m = p.modules[0]!;
    expect(m.memos[0]!.inputs).toEqual(m.signals.map(s => s.id));
    expect(m.functions[0]!.body.stmts.at(-1)).toMatchObject({ kind: "set", value: { kind: "builtin", name: "map" } });
  });
  test.each([
    ['import { createMemo } from "solid-js"; export const x = createMemo(() => 1);', "framework reactive"],
    ['import { shallowRef } from "vue"; export const x = shallowRef(1);', "outside"],
    [prelude + 'export async function load(): Promise<void> { await fetch("url"); }', "closed model set"],
    [prelude + 'export async function load(): Promise<void> { load(); }', "cycle of task starts"],
    [prelude + 'export function f() { return (() => 1); }', "outside"],
  ])("rejects unavailable import, awaitable or closure: %s", (text, message) => expect(() => analyzeModel(entry, { source: text })).toThrow(message));
});
