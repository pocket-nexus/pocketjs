/** Seeded typed grammar generation, semantic invariants and failure reduction. */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { AotCompileError } from "./aot-ir.ts";
import { analyzeModel } from "./aot-model-frontend.ts";
import type { ModelBlock, ModelProgram } from "./aot-model-ir.ts";
import { lowerModelTasks } from "./aot-model-tasks.ts";
import { assertModelObservations, executeModelJavaScript, executeModelRust, observeModelFrames, type ModelObservation } from "./model-harness.ts";
import { interpretModel, type ModelFrame, type ModelFrameInput } from "./model-interp.ts";

export interface ModelFuzzOptions { size?: number; frames?: number; invalid?: boolean; weights?: Partial<Record<"arithmetic" | "conditional" | "memo" | "array" | "task" | "struct" | "helper" | "loop" | "capacity" | "field" | "service" | "join" | "animation", number>> }
export interface GeneratedModelCase { seed: number; entry: string; sources: Map<string, string>; tape: ModelFrameInput[]; coverage: string[]; diagnostic?: string;
  services?: Record<string,{available?:boolean;capacity?:number}>;
  deliveries?: {frame:number;fn:string;member:number;value:unknown}[];
}
export interface ModelFuzzAdapter { name: string; execute(program: ModelProgram, tape: ModelFrameInput[], fixture: GeneratedModelCase): Promise<ModelObservation[]> | ModelObservation[] }
export const MODEL_FUZZ_INTEGER_BOUNDARIES = [-2147483648,-1,0,1,2147483647] as const;
export const MODEL_FUZZ_SEEDS = [1, 431, 0x12345678, 0x7fffffff] as const;
export const MODEL_FUZZ_DIAGNOSTICS = ["cycle", "dependencies of this effect depend on control flow", "private field", "write through a view", "fractional literal", "cycle of task starts", "while"] as const;
/** Every generated grammar family has a fixed probe; random seeds vary its typed holes. */
export const MODEL_FUZZ_PROBES = [0,1,2,3,4,5,6,7,8,9,10,11] as const;
export const MODEL_FUZZ_COVERAGE = ["after","all","animate","any","batch","bounded-for","capacity-array","capacity-string","color","conditional","copy","declared-effect","f64-operation","filter","for-of","frames","handler","helper","i32-operation","if","inferred-effect","integer-boundary","join","len","literal","map","member","memo","memo-between-writes","node-ref","option-change","owned-array","pre","primitive-enum","private-field","pure-module","return","scripted-delivery","service","shadowing","signal","struct","switch","tagged-union","task","task-result","template","unary","unit-number","until","untrack","wrapped-join","write-back"] as const;
class Random {
  constructor(private value: number) { if (!this.value) this.value = 0x9e3779b9; }
  next(): number { let x = this.value | 0; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.value = x; return x >>> 0; }
  int(max: number): number { return this.next() % max; }
  choose<T>(items: readonly T[]): T { return items[this.int(items.length)]!; }
  weighted(options: [string, number][]): string { const sum = options.reduce((n, [, w]) => n + Math.max(0, w), 0); let choice = this.int(Math.max(1, sum)); for (const [name, weight] of options) { choice -= weight; if (choice < 0) return name; } return options[0]![0]; }
}
const imports = `import { createSignal, batch, untrack } from "solid-js";
import { createMemo, createEffect, on } from "@pocketjs/framework/solid/reactive";
import { copy, equals, imod, len, map, filter, some, find, frames, after, until, all, any, join, cancel, type i32, type f64, type Px, type Color, type Cap } from "@pocketjs/framework/solid/std";
`;

/** Generate the dependency graph first, then fill only holes of the requested type. */
export function generateModelCase(seed: number, options: ModelFuzzOptions = {}): GeneratedModelCase {
  const random = new Random(seed), entry = resolve("tests/fixtures/aot-model/generated/App.ts");
  const coverage = new Set<string>(["signal", "handler", "literal", "pre"]);
  if (options.invalid) {
    const violations = [
      `export const [n, setN] = createSignal(0); createEffect(on([n], () => setN(v => v + 1)));`,
      `export const [armed, setArmed] = createSignal(false); export const [tick, setTick] = createSignal(0); createEffect(() => { if (armed()) console.log(tick()); });`,
      `let privateField = 1; export const bad = createMemo(() => privateField);`,
      `export const [items, setItems] = createSignal<i32[]>([1]); export function press(): void { const view = items(); view[0] = 3; }`,
      `export const [n, setN] = createSignal<i32>(1.0);`,
      `export async function first(): Promise<void> { second(); await frames(1); } export async function second(): Promise<void> { first(); await frames(1); }`,
      `export function press(): void { while (true) {} }`,
    ];
    const index = (seed >>> 0) % violations.length;
    return { seed, entry, sources: new Map([[entry, imports + violations[index]]]), tape: [], coverage: [`diagnostic:${MODEL_FUZZ_DIAGNOSTICS[index]}`], diagnostic: MODEL_FUZZ_DIAGNOSTICS[index] };
  }
  const size = Math.max(1, Math.min(options.size ?? 6, 64)), leaves = ["count()"];
  const extraSources = new Map<string,string>(), family = (seed >>> 0) % 6;
  let services: GeneratedModelCase["services"], deliveries: GeneratedModelCase["deliveries"];
  const integer = (depth: number): string => {
    if (depth === 0) {
      const literal=random.int(5)===0?random.choose(MODEL_FUZZ_INTEGER_BOUNDARIES):random.int(17);
      const selected=random.choose([...leaves,String(literal)]);
      if(selected===String(literal)&&MODEL_FUZZ_INTEGER_BOUNDARIES.includes(literal as any))coverage.add("integer-boundary");
      return selected;
    }
    const form = random.weighted([["arithmetic", options.weights?.arithmetic ?? 5], ["conditional", options.weights?.conditional ?? 2], ["leaf", 3]]);
    if (form === "arithmetic") { coverage.add("i32-operation"); return `(${integer(depth - 1)} ${random.choose(["+", "-", "*"])} ${integer(depth - 1)})`; }
    if (form === "conditional") { coverage.add("conditional"); return `(count() > ${random.int(5)} ? ${integer(depth - 1)} : ${integer(depth - 1)})`; }
    return integer(0);
  };
  const declarations = [`export const [count, setCount] = createSignal<i32>(${random.int(4)});`, `export const [runs, setRuns] = createSignal<i32>(0);`, `export const [observed, setObserved] = createSignal<i32>(0);`];
  const memoCount = options.weights?.memo === 0 ? 0 : Math.max(1, random.int(size));
  for (let i = 0; i < memoCount; i++) { declarations.push(`export const memo${i} = createMemo<i32>(() => ${integer(2)});`); leaves.push(`memo${i}()`); coverage.add("memo"); }
  const dependency = memoCount ? `memo${memoCount - 1}` : "count";
  declarations.push(`createEffect(on([${dependency}], () => { setRuns(v => v + 1); }, { defer: true }));`); coverage.add("declared-effect");
  const body = [`setCount(v => v + ${1 + random.int(3)});`, `setObserved(${memoCount ? `memo${memoCount - 1}()` : "count()"});`];
  if (options.weights?.array !== 0) {
    declarations.push(`export const [items, setItems] = createSignal<i32[]>([1, 2]);`);
    body.push(`const owned = copy(items()); owned[0] = count(); setItems(owned); setItems(owned); setItems(items());`);
    coverage.add("owned-array"); coverage.add("write-back"); coverage.add("copy");
  }
  if (family === 0 && options.weights?.struct !== 0) {
    declarations.push(`type Flag={kind:"off"}|{kind:"on";value:i32};export const[flag,setFlag]=createSignal<Flag>({kind:"off"});`, `interface Row { value:i32; enabled:boolean }`, `export const [rows,setRows]=createSignal<Row[]>([{value:1,enabled:true},{value:2,enabled:false}]);`);
    body.push(`const rowsOwned=copy(rows());const row:Row={value:count(),enabled:true};row.value=row.value+1;rowsOwned[0]=row;setRows(map(rowsOwned,row=>({value:row.value+1,enabled:!row.enabled})));setObserved(len(filter(rows(),row=>row.enabled)));`);
    declarations.push(`type Mode="left"|"right";export const[mode,setMode]=createSignal<Mode>("left");export const[maybe,setMaybe]=createSignal<i32|undefined>(undefined);`);
    body.push(`setFlag({kind:"on",value:count()});setMode("left");setMaybe(count());setMaybe(maybe());setMaybe(undefined);setMaybe(undefined);`);coverage.add("tagged-union");coverage.add("primitive-enum");coverage.add("option-change");
    coverage.add("struct");coverage.add("member");coverage.add("map");coverage.add("filter");coverage.add("len");
  }
  if (family === 1 && options.weights?.helper !== 0) {
    const file = resolve(entry,"..","math.ts");
    extraSources.set(file,`import type {i32} from "@pocketjs/framework/solid/std";export function twice(n:i32):i32{return n*2;}`);
    declarations.push(`import {twice} from "./math";function helper(n:i32):i32{let count=n;if(count<0)return 0;return twice(count)+1;}`);
    body.push(`const observed=helper(count());setObserved(observed);`);
    coverage.add("helper");coverage.add("pure-module");coverage.add("return");coverage.add("shadowing");coverage.add("if");
  }
  if (family === 2 && options.weights?.loop !== 0) {
    body.push(`for(let i=0;i<${1+random.int(4)};i++){setObserved(v=>v+i);}const values:i32[]=[2,3];for(const value of values){setObserved(v=>v+value);}let mode:i32=imod(count(),3);switch(mode){case 0:setObserved(v=>v+10);break;case 1:setObserved(v=>v-1);break;default:setObserved(v=>-v);break;}`);
    coverage.add("bounded-for");coverage.add("for-of");coverage.add("switch");coverage.add("unary");
  }
  if (family === 3 && options.weights?.capacity !== 0) {
    declarations.push(`export const [label,setLabel]=createSignal<Cap<string,48>>("é");export const [bounded,setBounded]=createSignal<Cap<i32[],4>>([1,2]);`);
    body.push('setLabel(`雪:${count()}`);const boundedOwned=copy(bounded());boundedOwned[1]=count();setBounded(boundedOwned);');
    declarations.push(`export const[fraction,setFraction]=createSignal<f64>(1.0);export const[distance,setDistance]=createSignal<Px>(0.1);export const[color,setColor]=createSignal<Color>("#fff");`);body.push(`setFraction(value=>value+0.25);setDistance(distance()+(0.2 as Px));setColor(count()>2?"#ffffff":"#fff");`);coverage.add("f64-operation");coverage.add("unit-number");coverage.add("color");
    coverage.add("capacity-string");coverage.add("capacity-array");coverage.add("template");
  }
  if (family === 4 && options.weights?.field !== 0) {
    declarations.push(`let privateField:i32=0;export const [observations,setObservations]=createSignal<i32>(0);createEffect(()=>{count();untrack(()=>setObservations(privateField));});`);
    body.push(`privateField=privateField+1;setCount(v=>v+1);setObserved(${memoCount ? `memo${memoCount-1}()` : "count()"});setCount(v=>v-1);`);
    coverage.add("private-field");coverage.add("inferred-effect");coverage.add("untrack");coverage.add("memo-between-writes");
  }
  if (family === 5 && options.weights?.task !== 0 && options.weights?.service !== 0) {
    declarations.push(`import {net} from "@pocketjs/framework/net/model";export const [serviceResult,setServiceResult]=createSignal("idle");export async function fetchData():Promise<void>{const response=await net.get("/generated");setServiceResult(response.kind);}`);
    services={"@pocketjs/framework/net/model":{capacity:4}};deliveries=[{frame:2,fn:"fetchData",member:0,value:{kind:"ok",status:200,body:"generated"}}];
    coverage.add("service");coverage.add("scripted-delivery");
  }
  if (family === 5 && options.weights?.task !== 0 && options.weights?.join !== 0) {
    declarations.push(`export const [joined,setJoined]=createSignal<i32>(0);async function child(n:i32):Promise<i32>{await frames(1);return n+1;}export async function parent():Promise<void>{const value=await child(count());setJoined(value);}`);
    declarations.push(`export async function wrapped():Promise<void>{const result=await join(child(count()));if(result.kind==="done")setJoined(result.value);}`);
    coverage.add("join");coverage.add("task-result");coverage.add("wrapped-join");
  }
  if (family === 3 && options.weights?.task !== 0 && options.weights?.animation !== 0) {
    declarations.push(`import {createNodeRef,animate} from "@pocketjs/framework/animation";export const bar=createNodeRef();export const[motion,setMotion]=createSignal("idle");export async function move():Promise<void>{const outcome=await animate(bar,"width",10,{dur:20});setMotion(outcome);}`);
    deliveries=[{frame:2,fn:"move",member:0,value:"ended"}];coverage.add("animate");coverage.add("node-ref");
  }
  if ((seed >>> 0)%2===0) { body.splice(0,body.length,`batch(()=>{${body.join(" ")}});`);coverage.add("batch"); }
  declarations.push(`export function press(): void { ${body.join(" ")} }`);
  if (options.weights?.task !== 0) {
    declarations.push(`export const [completed, setCompleted] = createSignal<i32>(0);`);
    const awaitable = [`frames(${1 + random.int(3)})`, `after(${1 + random.int(20)})`, `until(() => count() > 1)`, `any([frames(1), after(5)])`, `all([frames(1), frames(2)])`][(seed>>>0)%5]!;
    declarations.push(`export async function load(): Promise<void> { const old = count(); await ${awaitable}; setCompleted(old); }`, `export function stop(): void { cancel(load); }`);
    coverage.add("task"); coverage.add(awaitable.slice(0, awaitable.indexOf("(")));
  }
  const tape: ModelFrameInput[] = [];
  for (let frame = 0; frame < (options.frames ?? 12); frame++) {
    const dispatch = frame === 0 || random.int(3) === 0 ? [{ fn: "press" }] : [];
    if(frame===0 && family===3 && options.weights?.task!==0 && options.weights?.animation!==0)dispatch.push({fn:"move"});
    if (frame===0 && services) dispatch.push({fn:"fetchData"});
    if (frame===0 && family===5 && options.weights?.task!==0 && options.weights?.join!==0) dispatch.push({fn:"parent"},{fn:"wrapped"});
    if (options.weights?.task !== 0 && frame % 4 === 0) dispatch.push({ fn: "load" });
    if (options.weights?.task !== 0 && frame % 7 === 6) dispatch.push({ fn: "stop" });
    tape.push({ clock: frame * (1000 / 60), dispatch });
  }
  return { seed, entry, sources: new Map([[entry, imports + declarations.join("\n")],...extraSources]), tape, coverage: [...coverage].sort(), services, deliveries };
}

export function assertModelTraceInvariants(program: ModelProgram, tape: ModelFrameInput[], frames: ModelFrame[]): void {
  for (let frame = 0; frame < frames.length; frame++) {
    const actual = frames[frame]!, effects = new Set<string>(), currentRequests = new Set<string>();
    for (const event of actual.trace) {
      if (event.kind === "effect") { const key = `${event.region}:${event.id}:${event.initial}`; if (effects.has(key)) throw new Error(`Effect ${key} ran twice in frame ${frame}`); effects.add(key); }
      if (event.kind === "wait") currentRequests.add(JSON.stringify(event.request));
      if (event.kind === "request" && !currentRequests.has(JSON.stringify(event.request))) throw new Error(`Request has no current wait in frame ${frame}`);
    }
    for (const module of program.modules) for (const memo of module.memos) {
      const demand = actual.trace.filter(event => event.kind === "memo" && event.id === memo.id && event.mode === "demand").length;
      const writes = actual.trace.filter(event => (event.kind === "set" || event.kind === "memo") && event.changed && memo.inputs.includes(event.id)).length;
      if (demand > writes) throw new Error(`Memo ${memo.name} recomputed ${demand} times after ${writes} input writes in frame ${frame}`);
    }
    if (actual.counts.taskSegments !== actual.trace.filter(event=>event.kind==="task-start"||event.kind==="task-resume").length) throw new Error(`Task segment count exceeded starts and resumes in frame ${frame}`);
    for (const [name,value] of Object.entries(actual.counts)) if(!Number.isInteger(value)||value<0)throw new Error(`Invalid ${name} work count in frame ${frame}`);
    if (actual.counts.scheduledMemos > program.modules.reduce((n, m) => n + m.memos.length, 0) * Object.keys(actual.regions).length) throw new Error(`Scheduled memo bound exceeded in frame ${frame}`);
    if (!tape[frame]?.dispatch?.length && !tape[frame]?.invalidate && !tape[frame]?.deliveries?.length && !actual.trace.some(e => e.kind === "task-resume" || e.kind === "task-cancel") && actual.trace.length) throw new Error(`Idle frame ${frame} has observable work`);
  }
}

/** Delta debugging reaches a fixed point over statements, reactive nodes, tasks and tape entries. */
export async function shrinkModelFailure(program: ModelProgram, tape: ModelFrameInput[], fails: (program: ModelProgram, tape: ModelFrameInput[]) => boolean | Promise<boolean>): Promise<{ program: ModelProgram; tape: ModelFrameInput[] }> {
  let reduced = structuredClone(program), samples = structuredClone(tape), changed = true;
  while (changed) {
    changed = false;
    for (let i = samples.length - 1; i >= 0; i--) { const next = samples.filter((_, j) => j !== i); if (await fails(reduced, next)) { samples = next; changed = true; } }
    const paths: (string | number)[][] = [];
    for (let mi = 0; mi < reduced.modules.length; mi++) {
      const module = reduced.modules[mi]!;
      for (const collection of ["effects", "functions"] as const) for (let ni = 0; ni < module[collection].length; ni++) {
        const path: (string | number)[] = ["modules", mi, collection, ni]; paths.push(path);
        const gather = (block: ModelBlock, prefix: (string | number)[]) => { for (let si = block.stmts.length - 1; si >= 0; si--) { const stmt = block.stmts[si]!, location = [...prefix, "stmts", si]; paths.push(location); if (stmt.kind === "if") { gather(stmt.then, [...location, "then"]); if (stmt.else) gather(stmt.else, [...location, "else"]); } else if ("body" in stmt) gather(stmt.body, [...location, "body"]); } };
        gather(module[collection][ni]!.body, [...path, "body"]);
      }
    }
    for (const path of paths) {
      const candidate = structuredClone(reduced); let owner: any = candidate;
      for (const key of path.slice(0, -1)) owner = owner?.[key];
      if (!Array.isArray(owner)) continue;
      const removed = owner.splice(path.at(-1) as number, 1)[0];
      for (const module of candidate.modules) module.schedule = module.schedule.filter(id => id !== removed?.id);
      try { lowerModelTasks(candidate); if (await fails(candidate, samples)) { reduced = candidate; changed = true; break; } } catch { /* An invalid candidate is not a smaller reproduction. */ }
    }
  }
  return { program: reduced, tape: samples };
}

export async function saveModelFailure(directory: string, fixture: GeneratedModelCase, program: ModelProgram, tape: ModelFrameInput[], traces: Record<string, ModelObservation[]>): Promise<string> {
  const hash = createHash("sha256").update(JSON.stringify({ program, tape })).digest("hex").slice(0, 16), target = resolve(directory, hash);
  const receipt=resolve(".pocket-build/validation/model-aot/fuzz-failure",hash);
  await Promise.all([mkdir(target,{recursive:true}),mkdir(receipt,{recursive:true})]);
  const relativePaths=(key:string,value:unknown)=>key==="file"&&typeof value==="string"?relative(process.cwd(),value):value;
  // Only the minimized IR and passing oracle are consumed as maintained fixtures.
  await Promise.all([
    writeFile(resolve(target,"model.json"),JSON.stringify(program,relativePaths,2)+"\n"),
    writeFile(resolve(target,"tape.json"),JSON.stringify(tape,null,2)+"\n"),
    writeFile(resolve(target,"expected.json"),JSON.stringify({reference:traces.reference},null,2)+"\n"),
    writeFile(resolve(target,"options.json"),JSON.stringify({services:fixture.services},null,2)+"\n"),
    writeFile(resolve(receipt,"traces.json"),JSON.stringify(traces,null,2)+"\n"),
    writeFile(resolve(receipt,"sources.json"),JSON.stringify(Object.fromEntries(fixture.sources),null,2)+"\n"),
  ]);
  return target;
}

export async function runModelFuzz(seeds: readonly number[], options: ModelFuzzOptions & { adapters?: ModelFuzzAdapter[]; requiredCoverage?: string[] } = {}): Promise<{ programs: number; coverage: string[] }> {
  const coverage = new Set<string>();
  const seedList = options.invalid || options.requiredCoverage ? seeds : [...new Set([...MODEL_FUZZ_PROBES,...seeds])];
  const requiredCoverage = options.requiredCoverage ?? (options.invalid ? MODEL_FUZZ_DIAGNOSTICS.map(row=>`diagnostic:${row}`) : MODEL_FUZZ_COVERAGE);
  const accepted: { name: string; program: ModelProgram; tape: ModelFrameInput[]; fixture: GeneratedModelCase; expected: ModelObservation[];services?:GeneratedModelCase["services"] }[] = [];
  for (const seed of seedList) {
    const fixture = generateModelCase(seed, options); fixture.coverage.forEach(row => coverage.add(row));
    let program: ModelProgram;
    try { program = analyzeModel(fixture.entry, { sources: fixture.sources }); }
    catch (error) { if (fixture.diagnostic && error instanceof AotCompileError && error.message.includes(fixture.diagnostic)) continue; throw error; }
    if (fixture.diagnostic) throw new Error(`Fuzz seed ${seed} accepted ${fixture.diagnostic}`);
    for (const delivery of fixture.deliveries ?? []) {
      const fn = program.modules.find(module=>module.kind==="root")!.functions.find(fn=>fn.name===delivery.fn)!;
      const frame = fixture.tape[delivery.frame];
      if (frame) (frame.deliveries ??= []).push({request:{task:{region:1,fn:fn.id,generation:1},generation:1,member:delivery.member},value:delivery.value});
    }
    const expected = interpretModel(program, fixture.tape, {services:fixture.services}), replay = interpretModel(program, fixture.tape, {services:fixture.services});
    if (JSON.stringify(expected) !== JSON.stringify(replay)) throw new Error(`Fuzz seed ${seed} replay differs`);
    assertModelTraceInvariants(program, fixture.tape, expected);
    accepted.push({ name: String(seed), program, tape: fixture.tape, fixture, services:fixture.services, expected: observeModelFrames(expected) });
    for (const adapter of options.adapters ?? [{ name: "JavaScript", execute: (program, tape, fixture) => executeModelJavaScript({ name: String(fixture.seed), program, tape, services:fixture.services }) }]) {
      const actual = await adapter.execute(program, fixture.tape, fixture);
      try { assertModelObservations(`Fuzz seed ${seed} ${adapter.name}`, observeModelFrames(expected), actual, fixture.tape); }
      catch (failure) {
        const reduced = await shrinkModelFailure(program, fixture.tape, async (candidate, tape) => {
          try {
            const reference = observeModelFrames(interpretModel(candidate, tape, {services:fixture.services}));
            const result = await adapter.execute(candidate, tape, fixture);
            try { assertModelObservations("shrink", reference, result, tape); return false; } catch { return true; }
          } catch { return false; }
        });
        const reference = observeModelFrames(interpretModel(reduced.program, reduced.tape, {services:fixture.services}));
        const result = await adapter.execute(reduced.program, reduced.tape, fixture);
        const saved = await saveModelFailure("tests/fixtures/aot-model/found", fixture, reduced.program, reduced.tape, { reference, [adapter.name]: result });
        throw new Error(`${String(failure)}\nReduced regression: ${saved}`);
      }
    }
  }
  if (options.adapters === undefined && accepted.length) {
    const native = await executeModelRust(accepted);
    for (const fixture of accepted) {
      const actual = native.get(fixture.name)!;
      try { assertModelObservations(`Fuzz seed ${fixture.name} Rust`, fixture.expected, actual, fixture.tape); }
      catch (failure) {
        const reduced = await shrinkModelFailure(fixture.program, fixture.tape, async (program, tape) => {
          try {
            const reference = observeModelFrames(interpretModel(program, tape, {services:fixture.services}));
            const result = (await executeModelRust([{ name: fixture.name, program, tape, services:fixture.services }])).get(fixture.name)!;
            try { assertModelObservations("shrink", reference, result, tape); return false; } catch { return true; }
          } catch { return false; }
        });
        const reference = observeModelFrames(interpretModel(reduced.program, reduced.tape, {services:fixture.services}));
        const result = (await executeModelRust([{ name: fixture.name, ...reduced, services:fixture.services }])).get(fixture.name)!;
        const saved = await saveModelFailure("tests/fixtures/aot-model/found", fixture.fixture, reduced.program, reduced.tape, { reference, Rust: result });
        throw new Error(`${String(failure)}\nReduced regression: ${saved}`);
      }
    }
  }
  for (const row of requiredCoverage) if (!coverage.has(row)) throw new Error(`Model fuzz coverage missing ${row}`);
  return { programs: seedList.length, coverage: [...coverage].sort() };
}

if (import.meta.main) {
  const argument = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
  const count = Number(argument("--count") ?? process.env.MODEL_FUZZ_COUNT ?? 64), initial = Number(argument("--seed") ?? process.env.MODEL_FUZZ_SEED ?? Date.now()) >>> 0;
  if (!Number.isInteger(count) || count < 1) throw new Error("--count must be a positive integer");
  const seeds = Array.from({ length: count }, (_, i) => (initial + i) >>> 0);
  console.log(await runModelFuzz(seeds));
  console.log(await runModelFuzz(Array.from({ length: 7 }, (_, i) => i), { invalid: true, requiredCoverage: MODEL_FUZZ_DIAGNOSTICS.map(d => `diagnostic:${d}`) }));
  const {runModelViewFuzz}=await import("./model-view-fuzz.ts");
  console.log(await runModelViewFuzz([initial,(initial^0x9e3779b9)>>>0]));
}
