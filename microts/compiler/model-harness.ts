/** Executes compiler output in the JS runtime and one batched native harness. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateModelJavaScript } from "./aot-model-js.ts";
import { rustIdentifier } from "./rust-printer.ts";
import { generateModelRust } from "./aot-model-codegen.ts";
import type { ModelProgram } from "./aot-model-ir.ts";
import { interpretModel, type ModelFrameInput, type ModelTraceEvent, type ModelWorkCounts } from "./model-interp.ts";
import { deliverModelResult, drainModelCommands, registerModelCommandHandler, registerModelService, resetModelTaskClock, resumeModelTasks } from "../../framework/src/model-tasks.ts";

export interface ModelHarnessCase { name: string; program: ModelProgram; tape: ModelFrameInput[]; services?: Record<string, {available?: boolean; capacity?: number}>; development?: boolean }
export interface ModelObservation { frame: number; state: Record<string, unknown>; trace: ModelTraceEvent[]; counts?:ModelWorkCounts }
let generation = 0;
const output = resolve(".pocket-build/validation/model-aot/differential");

/** None is null in the JSON transport; runtime optional values remain undefined. */
function transportValue(value:unknown):unknown {
  if(value===undefined)return null;
  if(Array.isArray(value))return value.map(transportValue);
  if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([key,value])=>[key,transportValue(value)]));
  return value;
}
/** Runtime region ids identify instances; independent executions each start at one. */
export function normalizeModelTrace(trace: ModelTraceEvent[], region = 1): ModelTraceEvent[] {
  const task = (id: any) => ({ region: id.region === region ? 1 : id.region, fn: id.fn ?? id.function, generation: id.generation ?? id.call });
  return trace.map(event => {
    const value = { ...event };
    if(["set","memo","delivery"].includes(value.kind))value.value=transportValue(value.value);
    if (value.region === region) value.region = 1;
    if (value.task) { value.task = task(value.task); delete value.region; }
    if (value.request) { const r = value.request; value.request = { task: task(r.task), generation: r.generation ?? r.wait, member: r.member }; if (value.kind !== "command") delete value.region; }
    return value;
  });
}
export function observeModelFrames(frames: readonly ModelObservation[]): ModelObservation[] {
  return frames.map(({ frame, state, trace }) => ({ frame, state:transportValue(state) as Record<string,unknown>, trace: normalizeModelTrace(trace) }));
}
export function assertModelObservations(name: string, expected: readonly ModelObservation[], actual: readonly ModelObservation[], tape: ModelFrameInput[]): void {
  const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  const observable=(value:ModelObservation|undefined)=>value&&{frame:value.frame,state:transportValue(value.state),trace:normalizeModelTrace(value.trace)};
  const first = expected.findIndex((frame, i) => stable(observable(frame)) !== stable(observable(actual[i])));
  if (first >= 0 || expected.length !== actual.length) throw new Error(`${name} first differs at frame ${first + 1}:\n${JSON.stringify({ expected: expected[first], actual: actual[first], tape }, null, 2)}`);
}

export async function executeModelJavaScript(fixture: ModelHarnessCase, vue = false, transform?: (source: string) => string): Promise<ModelObservation[]> {
  resetModelTaskClock();
  const root = fixture.program.modules.find(module => module.kind === "root")!;
  const source = generateModelJavaScript(fixture.program, root, {
    vue, development:fixture.development, runtimeImport: resolve(vue ? "framework/src/reactive-vue-vapor.ts" : "framework/src/reactive-solid.ts"),
    stdImport: resolve("framework/src/std-microts.ts"), tasksImport: resolve("framework/src/model-tasks.ts"),
  });
  const file = resolve(output, `js-${process.pid}-${generation++}.mjs`);
  await Bun.write(file, transform ? transform(source) : source);
  const cleanups = Object.entries(fixture.services ?? {}).map(([name, service]) => registerModelService(name, { capacity: service.capacity ?? 4, available: () => service.available !== false, validate: () => true, request: () => {} }));
  const module = await import(file), region = module.__modelRegion;
  cleanups.push(registerModelCommandHandler(() => {}));
  region.react(true); region.settle(); region.trace = [];
  try {
    return fixture.tape.map((input, index) => {
      region.trace = [];
      for (const delivery of input.deliveries ?? []) deliverModelResult({ task: { region: region.instance, function: delivery.request.task.fn, call: delivery.request.task.generation }, wait: delivery.request.generation, member: delivery.request.member }, delivery.value);
      resumeModelTasks(index + 1, input.clock ?? 0);
      for (const dispatch of input.dispatch ?? []) {
        const fn = root.functions.find(fn => fn.name === dispatch.fn || fn.id === dispatch.fn)!;
        region.emit("handler", { fn: fn.id, name: fn.name, args: structuredClone(dispatch.args ?? []) });
        module[fn.name](...(dispatch.args ?? []));
      }
      if (region.dirty || input.dispatch?.length || input.invalidate) { region.react(); region.settle(); }
      drainModelCommands();
      if ([...region.cells.values()].some((cell: any) => cell.changed)) throw new Error(`${fixture.name}: changed flag survived frame ${index + 1}`);
      return { frame: index + 1, state: region.state(), trace: normalizeModelTrace(structuredClone(region.trace), region.instance) };
    });
  } finally { region.dispose(); resumeModelTasks(fixture.tape.length + 1, 0); cleanups.forEach(cleanup => cleanup()); }
}

const rustHarness = `
use microts::model::{ModelValue, ModelTrace, Value, take_trace, reset_trace};
use serde_json::{json, Value as Json};
fn encode(value: Value) -> Json { match value { Value::Unit => Json::Null, Value::Bool(v)=>json!(v), Value::I32(v)=>json!(v), Value::Number(v)=>json!(v), Value::String(v)=>json!(v), Value::Array(v)=>Json::Array(v.into_iter().map(encode).collect()), Value::Object(v)=>Json::Object(v.into_iter().map(|(k,v)|(k,encode(v))).collect()) } }
fn decode(value: Json) -> Value { match value { Json::Null=>Value::Unit, Json::Bool(v)=>Value::Bool(v), Json::Number(v)=>if let Some(i)=v.as_i64().and_then(|n|i32::try_from(n).ok()) {Value::I32(i)} else {Value::Number(v.as_f64().unwrap())}, Json::String(v)=>Value::String(v), Json::Array(v)=>Value::Array(v.into_iter().map(decode).collect()), Json::Object(v)=>Value::Object(v.into_iter().map(|(k,v)|(k,decode(v))).collect()) } }
fn task(t: microts::model::TaskId) -> Json { json!({"region":t.region,"fn":t.function,"generation":t.call}) }
fn request(r: microts::model::RequestId) -> Json { json!({"task":task(r.task),"generation":r.wait,"member":r.member}) }
fn counts() -> Json { let c=microts::model::take_counts(); json!({"scheduledMemos":c.scheduled_memos,"demandMemos":c.demand_memos,"effects":c.effects,"taskSegments":c.task_segments,"loopIterations":c.loop_iterations}) }
fn event(t: ModelTrace) -> Json { match t.kind {
 "handler"=>json!({"kind":t.kind,"region":t.region,"fn":t.id,"name":t.name,"args":encode(t.value)}),
 "effect"=>json!({"kind":t.kind,"region":t.region,"id":t.id,"initial":t.initial}),
 "memo"=>json!({"kind":t.kind,"region":t.region,"id":t.id,"name":t.name,"mode":t.mode,"value":encode(t.value),"changed":t.changed,"version":t.version}),
 "set"=>json!({"kind":t.kind,"region":t.region,"id":t.id,"name":t.name,"value":encode(t.value),"changed":t.changed,"version":t.version}),
 "task-start"|"task-resume"=>json!({"kind":t.kind,"task":task(t.task.unwrap()),"state":t.state}),
 "task-cancel"=>json!({"kind":t.kind,"task":task(t.task.unwrap()),"reason":t.reason}),
 "task-complete"=> { let mut result=json!({"kind":t.kind,"task":task(t.task.unwrap())}); if !matches!(t.value,Value::Unit) { result["value"]=encode(t.value); } result },
 "wait"=>json!({"kind":t.kind,"request":request(t.request.unwrap()),"awaitable":t.awaitable}),
 "request"=>json!({"kind":t.kind,"request":request(t.request.unwrap()),"module":t.module,"call":t.call,"args":encode(t.value)}),
 "command"=>{let mut result=json!({"kind":t.kind,"region":t.region,"op":t.name,"args":encode(t.value)});if let Some(r)=t.request {result["request"]=request(r);} result},
 "delivery"=>json!({"kind":t.kind,"request":request(t.request.unwrap()),"value":encode(t.value)}),
 "delivery-drop"=>json!({"kind":t.kind,"request":request(t.request.unwrap())}),
 "request-cancel"=>json!({"kind":t.kind,"request":request(t.request.unwrap()),"service":t.module}),
 _=>panic!("unrecognized model trace {}",t.kind)
} }
`;
/** Every fixture is included in one crate, so native compilation is paid once. */
export async function executeModelRust(fixtures: readonly ModelHarnessCase[], options: { release?: boolean } = {}): Promise<Map<string, ModelObservation[]>> {
  const identity = `${process.pid}-${generation++}`;
  const directory = resolve(output, `native-${identity}`);
  mkdirSync(resolve(directory, "src"), { recursive: true });
  // Cargo releases the build lock before launching the binary. Give concurrent
  // runs separate executables while sharing their compiled dependencies.
  writeFileSync(resolve(directory, "Cargo.toml"), `[package]\nname="model-aot-differential-${identity}"\nversion="0.0.0"\nedition="2021"\n[workspace]\n[dependencies]\nmicrots={path=${JSON.stringify(resolve("engine/crates/microts"))},features=["std","model-trace"]}\nserde_json="1"\n`);
  const modules: string[] = [], invocations: string[] = [];
  fixtures.forEach((fixture, index) => {
    const root = fixture.program.modules.find(module => module.kind === "root")!;
    writeFileSync(resolve(directory, `src/case_${index}.rs`), generateModelRust(fixture.program));
    modules.push(`mod case_${index};`);
    const body = fixture.tape.map((input, frame) => {
      const dispatch = (input.dispatch ?? []).map(call => {
        const fn = root.functions.find(fn => fn.name === call.fn || fn.id === call.fn)!;
        return `m.${rustIdentifier(fn.name)}(${[...(call.args ?? []).map(value => typeof value === "string" ? `${JSON.stringify(value)}.into()` : JSON.stringify(value)), ...(fn.async ? ["&mut commands"] : [])].join(",")});`;
      }).join("\n");

      const services = Object.entries(fixture.services ?? {}).filter(([, service]) => service.available !== false).map(([name]) => `${JSON.stringify(name)}.into()`).join(",");
      const deliveries = (input.deliveries ?? []).map(({ request: r, value }) => `microts::model::Delivery {request:microts::model::RequestId{task:microts::model::TaskId{region:${r.task.region},function:${r.task.fn},call:${r.task.generation}},wait:${r.generation},member:${r.member}},result:microts::model::Completion::Value(decode(serde_json::from_str(${JSON.stringify(JSON.stringify(value))}).unwrap()))}`).join(",");
      return `m.resume(&microts::Ready {frame:${frame + 1},now_ms:${Number(input.clock ?? 0).toString()}f64,services:vec![${services}],deliveries:vec![${deliveries}],..Default::default()}, &mut commands);\n${dispatch}\nif m.model_changed() || ${!!input.dispatch?.length || !!input.invalidate} { m.react(false,&mut commands); m.settle(); }\nassert!(!m.model_changed(),"changed flag survived frame");\nframes.push(json!({"frame":${frame + 1},"state":encode(m.model_state()),"trace":take_trace().into_iter().map(event).collect::<Vec<_>>(),"counts":counts() }));`;
    }).join("\n");
    invocations.push(`for _replay in 0..2 { use case_${index}::*; reset_trace(); let mut m=${root.name}Model::default(); let mut commands=Vec::new(); m.react(true,&mut commands);m.settle();take_trace();microts::model::reset_counts();let mut frames=Vec::<Json>::new(); ${body}\nprintln!("{}",json!({"name":${JSON.stringify(fixture.name)},"frames":frames})); }`);
  });
  writeFileSync(resolve(directory, "src/main.rs"), `#![recursion_limit="512"]\n${modules.join("\n")}\n${rustHarness}\nfn main(){${invocations.join("\n")}}\n`);
  const child = Bun.spawn(["cargo", "run", "--quiet", ...(options.release ? ["--release"] : []), "--manifest-path", resolve(directory, "Cargo.toml")], { stdout: "pipe", stderr: "pipe", env: { ...process.env, CARGO_TARGET_DIR: resolve(output, "target") } });
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  writeFileSync(resolve(directory, "build.log"), stderr);
  if (status !== 0) throw new Error(`Model Rust harness failed (${status}):\n${stderr}`);
  const results = new Map<string, ModelObservation[]>();
  for (const line of stdout.trim().split("\n").filter(Boolean)) {
    const row = JSON.parse(line), prior = results.get(row.name);
    if (prior) assertModelObservations(`${row.name}: Rust replay`, prior, row.frames, fixtures.find(fixture => fixture.name === row.name)!.tape);
    results.set(row.name, row.frames);
  }
  for(const fixture of fixtures){
    const reference=interpretModel(fixture.program,fixture.tape,{development:fixture.development??!options.release,services:fixture.services});
    const frames=results.get(fixture.name)!;
    for(let index=0;index<reference.length;index++){
      const expected=reference[index]!.counts,actual=frames[index]!.counts;
      if(!actual||Object.entries(expected).some(([key,value])=>actual[key as keyof ModelWorkCounts]!==value))throw new Error(`${fixture.name} work counts differ at frame ${index+1}: ${JSON.stringify({expected,actual,tape:fixture.tape})}`);
    }
  }
  return results;
}
