import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { analyzeModel } from "../microts/compiler/aot-model-frontend.ts";
import { AotCompileError } from "../microts/compiler/aot-ir.ts";
import { ModelInterpreter } from "../microts/compiler/model-interp.ts";

const entry = resolve(import.meta.dir, "fixtures/aot-model/virtual/app.ts");
const prelude = 'import { createSignal, untrack, batch } from "solid-js";\nimport { createMemo, createEffect, on } from "@pocketjs/framework/solid/reactive";\nimport { copy, equals, type i32 } from "@pocketjs/framework/solid/std";\n';
const analyze = (source: string, extra: Record<string, string> = {}) => analyzeModel(entry, { sources: new Map([[entry, prelude + source], ...Object.entries(extra).map(([name, value]) => [resolve(entry, "..", name), value] as [string, string])]) });
const names = (module: ReturnType<typeof analyze>["modules"][number], ids: number[]) => ids.map(id => [...module.signals, ...module.fields, ...module.memos, ...module.functions].find(x => x.id === id)?.name ?? `effect:${id}`);

describe("Model AOT source admission and lowering", () => {
  test.each([
    ["1", "i32"], ["1.0", "f64"], ["1e3", "f64"], ["2.50", "f64"], ["0x10", "i32"], ["1_000", "i32"], [".5", "f64"], ["-0", "i32"],
  ] as const)("classifies source literal %s as %s", (literal, name) => {
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
  test.each([false,true])("Vue watch previous is seed-typed unless immediate=%s", immediate => {
    const source=`import {ref} from "vue";import {watch} from "@pocketjs/framework/vue-vapor/reactive";import type {i32} from "@pocketjs/framework/solid/std";export const count=ref<i32>(1);export const result=ref<i32>(0);watch(count,(value,previous)=>{result.value=${immediate?"previous===undefined?0:previous+value":"value+previous"};}${immediate?",{immediate:true}":""});export function change(){count.value=3;}`;
    const p=analyzeModel(entry,{source}),effect=p.modules[0]!.effects[0]!;
    expect(effect.watch!.previous!.type).toEqual(immediate?{kind:"option",value:{kind:"number",name:"i32"}}:{kind:"number",name:"i32"});
    expect(new ModelInterpreter(p).frame({dispatch:[{fn:"change"}]}).state.result).toBe(4);
  });
});

describe("Model AOT admitted module shapes", () => {
  test.each([
    ['import {createSignal} from "solid-js";export const[count,setCount]=createSignal(0);\nexport function use(){const alias=count;console.log(alias);}',"Solid accessors",2,35],
    ['import {createSignal} from "solid-js";import {createMemo} from "@pocketjs/framework/solid/reactive";export const[count,setCount]=createSignal(0);\nexport const derived=createMemo(()=>count);',"Solid accessors",2,37],
    ['import {ref} from "vue";export const count=ref(0);\nexport function use(){const alias=count;console.log(alias);}',"through .value",2,35],
    ['import {ref,computed} from "vue";export const count=ref(0);\nexport const derived=computed(()=>count);',"through .value",2,35],
  ] as const)("reactive bindings cannot escape into model value expressions",(source,message,line,column)=>{
    try{analyzeModel(entry,{source});throw new Error("accepted");}catch(error){expect(error).toBeInstanceOf(AotCompileError);const diagnostic=(error as AotCompileError).diagnostics[0]!;expect(diagnostic.message).toContain(message);expect([diagnostic.file,diagnostic.line,diagnostic.column]).toEqual([entry,line,column]);}
  });
  test("scalar newtypes and enum members preserve nominal types and Color spelling", () => {
    const p=analyze('import type {Px,Color} from "@pocketjs/framework/solid/std";enum Mode{Idle="idle",Ready="ready"};type UserId=i32&{readonly __newtype?:"UserId"};export const[mode,setMode]=createSignal<Mode>(Mode.Idle);export const[width,setWidth]=createSignal<Px>(2);export const[ink,setInk]=createSignal<Color>("#F00");export const[id,setId]=createSignal<UserId>(1);export function run(){setMode(Mode.Ready);setWidth(width()+2);setInk("#ff0000");setId(id()+1);const equal=mode()===Mode.Ready;const leading=2<width();}');
    const module=p.modules[0]!;
    expect(module.signals.map(signal=>signal.type.kind)).toEqual(["named","named","named","named"]);
    expect(module.signals[2]!.seed).toMatchObject({kind:"literal",value:"#ff0000ff"});
    expect(p.types.find(type=>type.kind==="newtype"&&type.name==="Px")).toMatchObject({base:{kind:"number",name:"f32"}});
    expect(module.functions[0]!.body.stmts.filter(s=>s.kind==="set").map(s=>s.value.type)).toEqual(module.signals.map(signal=>signal.type));
  });
  test.each([
    ['import type {Color} from "@pocketjs/framework/solid/std";export const[c,setC]=createSignal<Color>("#xyz");','Color literals'],
    ['import type {Color} from "@pocketjs/framework/solid/std";export const[c,setC]=createSignal<Color>("#fff");export function compare(){return c()>"#000";}','Color arithmetic'],
    ['import type {Px,Ms} from "@pocketjs/framework/solid/std";export const[x,setX]=createSignal<Px>(1);export const[t,setT]=createSignal<Ms>(1);export function mix(){setX(x()+t());}','expected'],
  ])("scalar contract violations retain source diagnostics: %s",(source,message)=>{
    try{analyze(source);throw new Error("accepted");}catch(error){expect(error).toBeInstanceOf(AotCompileError);expect(String(error)).toContain(message);expect((error as AotCompileError).diagnostics[0]!.file).toBe(entry);}
  });
  test("setter early returns are scoped to their callback and use its result type", () => {
    const p=analyze("export const[n,setN]=createSignal(1);export const[seen,setSeen]=createSignal(0);export function press():boolean{setN(previous=>{if(previous>0)return 5;return 2;});setSeen(1);return false;}");
    expect(new ModelInterpreter(p).frame({dispatch:[{fn:"press"}]}).state).toMatchObject({n:5,seen:1});
  });
  test("effects admit early returns and memos admit local assignments", () => {
    const p=analyze("export const[n,setN]=createSignal(1);export const[seen,setSeen]=createSignal(0);export const memo=createMemo(()=>{let total:i32=0;total+=1;return total;});createEffect(on([n],()=>{if(n()===1)return;setSeen(2);}));");
    expect(new ModelInterpreter(p).state()).toMatchObject({n:1,seen:0,memo:1});
  });
  test("union construction and narrowed field reads retain their variants", () => {
    const module=analyze("type Flag={kind:'off'}|{kind:'on';value:i32};export const[flag,setFlag]=createSignal<Flag>({kind:'off'});export function read():i32{const current=flag();if(current.kind==='on')return current.value;return 0;}").modules[0]!;
    expect(module.signals[0]!.seed).toMatchObject({kind:"struct",variant:"off"});
    const members:unknown[]=[];
    const visit=(value:unknown):void=>{if(!value||typeof value!=="object")return;if((value as any).kind==="member"&&(value as any).name==="value")members.push(value);for(const [key,item]of Object.entries(value))if(key!=="ledger")visit(item);};visit(module.functions[0]!.body);
    expect(members).toEqual([expect.objectContaining({kind:"member",name:"value",variant:"on"})]);
  });
  test("inline type-only imports do not admit a declaration module as runtime code", () => {
    expect(analyze('import {type Row} from "./Types";export const[rows,setRows]=createSignal<Row[]>([]);', {"Types.d.ts":"export interface Row { id: number }"}).modules).toHaveLength(1);
  });
  test("root constant exports retain source visibility", () => {
    const module=analyze("export const STEP:i32=2;const PRIVATE:i32=3;").modules[0]!;
    expect(module.constants!.map(value => [value.name,value.exported])).toEqual([["STEP",true],["PRIVATE",false]]);
  });
  test("model type names cannot collide with generated model classes", () => {
    const p=analyze("interface AppModel{value:i32}export const[item,setItem]=createSignal<AppModel>({value:1});");
    expect(p.types.find(t=>t.kind==="struct")!.name).not.toBe("AppModel");
    expect(p.modules[0]!.signals[0]!.type).toEqual({kind:"named",name:p.types.find(t=>t.kind==="struct")!.name});
  });
  test("joined tasks with distinct result types receive distinct union definitions", () => {
    const p=analyze('import {join,type f64} from "@pocketjs/framework/solid/std";async function integer():Promise<i32>{return 1;}async function float():Promise<f64>{return 1.5;}export async function run():Promise<void>{const a=await join(integer());const b=await join(float());}');
    const unions=p.types.filter(t=>t.kind==="union"&&t.discriminant==="kind");
    expect(unions).toHaveLength(2);expect(unions[0]!.name).not.toBe(unions[1]!.name);
    expect(unions.map(t=>t.kind==="union"?t.variants[0]!.fields[0]!.type:undefined)).toEqual([{kind:"number",name:"i32"},{kind:"number",name:"f64"}]);
  });
  test("mixed any results preserve optional typed service results", () => {
    const p=analyze('import {any,after} from "@pocketjs/framework/solid/std";import {net} from "@pocketjs/framework/net/model";export const[result,setResult]=createSignal("");export async function run():Promise<void>{const response=await any([net.get("/x"),after(1)]);if(response!==undefined)setResult(response.kind);}');
    const statement=p.modules[0]!.functions[0]!.body.stmts.find(s=>s.kind==="await");
    expect(statement).toMatchObject({kind:"await",binder:{type:{kind:"option",value:{kind:"named"}}}});
  });
  test("string literal unions adopt enum storage and retain primitive equality", () => {
    const module=analyze("export function choose():boolean{const property:'width'|'height'='width';return property==='width';}").modules[0]!;
    expect(module.functions[0]!.body.stmts[0]).toMatchObject({kind:"let",init:{kind:"literal",value:"width",type:{kind:"named"}}});
  });
  test("for initializers snapshot private fields before bound calls", () => {
    const module=analyze("let begin:i32=0;function limit():i32{begin=2;return 3;}export function run(){for(let i=begin;i<limit();i++){console.log(i);}}").modules[0]!;
    const body=module.functions.find(fn=>fn.name==="run")!.body.stmts;
    expect(body[0]).toMatchObject({kind:"let",init:{kind:"field",id:module.fields[0]!.id}});
    expect(body.at(-1)).toMatchObject({kind:"for",start:{kind:"local"},bound:{kind:"invoke"}});
  });
  test("compound array assignments evaluate their target once before the right side", () => {
    const module = analyze(`export const [calls,setCalls]=createSignal(0);export const [items,setItems]=createSignal<i32[]>([10,20]);function next():i32{setCalls(c=>c+1);return calls()-1;}export function press(){const a=copy(items());a[next()]+=1;setItems(a);}`).modules[0]!;
    const body = module.functions.find(fn => fn.name === "press")!.body;
    const invocations: number[] = [];
    const visit = (value: unknown): void => { if (!value || typeof value !== "object") return; if ((value as any).kind === "invoke") invocations.push((value as any).callee); for (const [key, item] of Object.entries(value)) if (key !== "ledger") visit(item); };
    visit(body);
    expect(invocations).toEqual([module.functions.find(fn => fn.name === "next")!.id]);
    const assignment = body.stmts.find(s => s.kind === "assign")!;
    expect(assignment).toMatchObject({ kind: "assign", target: { kind: "element", index: { kind: "local" } }, value: { kind: "binary", left: { kind: "local" } } });
  });
  test.each([
    "const a=[1]; a[9]=2;",
    "const a=[1]; const b=a[1];",
    "const a=[1]; a[-1]=2;",
    "const a: Cap<i32[], 2>=[1]; a[2]=2;",
  ])("rejects a constant index outside a known array bound: %s", body => {
    expect(() => analyze(`import type { Cap } from "@pocketjs/framework/solid/std";export function press(){${body}}`)).toThrow("constant array index is outside the array");
  });
  test("local and private field capacity metadata survives aliases and async captures", () => {
    const module=analyze('import { frames, type Cap } from "@pocketjs/framework/solid/std";type Tiny=Cap<i32[],1>;let field:Tiny=[1];export async function run():Promise<void>{const a:Tiny=[1,2];await frames(1);field=a;}').modules[0]!;
    expect(module.fields[0]).toMatchObject({ type: { kind: "array", capacity: 1 }, capacity: 1 });
    expect(module.functions[0]!.body.stmts[0]).toMatchObject({ kind: "let", binder: { type: { kind: "array", capacity: 1 }, capacity: 1 } });
    expect(module.tasks[0]!.fields.find(field => field.name === "a")).toMatchObject({ capacity: 1 });
  });
  test.each([["-0x10", -16], ["+0b10", 2], ["-0o10", -8]])("preserves signed radix literal %s", (raw, value) => {
    expect(analyze(`export const [n, setN] = createSignal<i32>(${raw});`).modules[0]!.signals[0]!.seed).toMatchObject({ kind: "literal", value, type: { kind: "number", name: "i32" } });
  });
  test("unannotated integer literals retain the i32 range check", () => {
    expect(() => analyze("export const [n, setN] = createSignal(2147483648);")).toThrow("outside i32");
  });
  test.each([
    "const row = rows()[0]; row.id = 2;",
    "const values = derived(); values[0] = { id: 2 };",
  ])("keeps nested signal and memo reads immutable: %s", body => {
    expect(() => analyze(`interface Row { id: i32 }; export const [rows, setRows] = createSignal<Row[]>([{ id: 1 }]); const derived = createMemo(() => rows()); export function change() { ${body} }`)).toThrow("write through a view");
  });
  test("collection callback reads may subscribe when the source can be empty", () => {
    expect(() => analyze('import { some } from "@pocketjs/framework/solid/std"; export const [rows, setRows] = createSignal<i32[]>([]); export const [limit, setLimit] = createSignal(0); createEffect(() => { console.log(some(rows(), n => n > limit())); });')).toThrow("dependencies of this effect depend on control flow");
  });
  test("write-back detection accounts for helper writes, conditional writes and await snapshots", () => {
    const p = analyze(`import { frames } from "@pocketjs/framework/solid/std";
export const [rows, setRows] = createSignal<i32[]>([1]);
function replace() { setRows([2]); }
export function throughHelper() { const view = rows(); replace(); setRows(view); }
export function throughBranch(flag: boolean) { const view = rows(); if (flag) setRows([2]); setRows(view); }
export function unchanged() { const view = rows(); setRows(view); setRows(c => c); }
export async function snapshot() { const view = rows(); await frames(1); setRows(view); }`);
    const writes = (name: string) => p.modules[0]!.functions.find(f => f.name === name)!.body.stmts.filter(s => s.kind === "set");
    expect(writes("throughHelper").map(s => !!s.writeBack)).toEqual([false]);
    expect(writes("throughBranch").map(s => !!s.writeBack)).toEqual([false]);
    expect(writes("unchanged").map(s => !!s.writeBack)).toEqual([true, true]);
    expect(p.modules[0]!.tasks[0]!.states.flatMap(s => s.body.stmts).filter(s => s.kind === "set").map(s => !!s.writeBack)).toEqual([false]);
  });
  test("expression-body untrack and batch lower setter statements", () => {
    const m = analyze("export const [tick, setTick] = createSignal(0); export const [result, setResult] = createSignal(0); createEffect(on([tick], () => { untrack(() => setResult(tick())); batch(() => setResult(2)); }));").modules[0]!;
    expect(m.effects[0]!.body.stmts.map(s => s.kind)).toEqual(["untrack", "batch"]);
    expect(m.effects[0]!.ledger.writes).toEqual([m.signals[1]!.id]);
  });
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
  test("declared factories may contain private fields and tasks without signals", () => {
    const file=resolve(entry,"../Fields.ts");
    const p=analyzeModel(entry,{factories:[file],sources:new Map([[entry,"export const ROOT=1;"],[file,prelude+'import {frames} from "@pocketjs/framework/solid/std";export function createFields(){let n:i32=0;function inc(){n+=1;}async function later():Promise<void>{await frames(1);n+=1;}return {inc,later};}']])});
    expect(p.modules[1]).toMatchObject({kind:"factory",factory:"createFields",signals:[]});
    expect(p.modules[1]!.fields).toHaveLength(1);expect(p.modules[1]!.tasks).toHaveLength(1);
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
