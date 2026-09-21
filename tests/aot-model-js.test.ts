import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { analyzeModel } from "../microts/compiler/aot-model-frontend.ts";
import { generateModelJavaScript } from "../microts/compiler/aot-model-js.ts";
import { ModelRegion, capacity } from "../framework/src/model-reactive.ts";
import { ModelTasks, resumeModelTasks, resetModelTaskClock } from "../framework/src/model-tasks.ts";

const storage = <T>(value: T): [() => T, (next: T) => void] => [() => value, next => { value = next; }];
const prelude = `import {createSignal} from "solid-js";
import {createMemo,createEffect,on} from "@pocketjs/framework/solid/reactive";
import {frames, copy, type i32} from "@pocketjs/framework/solid/std";\n`;
let sequence = 0;
async function compile(source: string) {
  resetModelTaskClock();
  const entry = resolve("tests/fixtures/aot-model/js/app.ts");
  const program = analyzeModel(entry, { source: prelude + source });
  const output = generateModelJavaScript(program, program.modules[0], {
    runtimeImport: resolve("framework/src/reactive-solid.ts"), stdImport: resolve("framework/src/std-microts.ts"), tasksImport: resolve("framework/src/model-tasks.ts"),
  });
  const path = resolve(`.pocket-build/validation/model-aot/js/${process.pid}-${sequence++}.mjs`);
  await Bun.write(path, output);
  const module = await import(path);
  module.__modelRegion.react(true); module.__modelRegion.settle(); module.__modelRegion.trace = [];
  return { module, program, output };
}
test("JS model executes wrapping arithmetic and on-demand memo reads", async () => {
  const { module } = await compile(`export const [count,setCount]=createSignal<i32>(2147483647);
export const [seen,setSeen]=createSignal<i32>(0);
export const double=createMemo<i32>(()=>count()*2);
export function press():void {setCount(c=>c+1);setSeen(double());}`);
  module.press(); module.__modelRegion.react(); module.__modelRegion.settle();
  expect(module.count()).toBe(-2147483648); expect(module.seen()).toBe(0);
});
test("JS model preserves call-by-value, shadowing and helper return", async () => {
  const { module } = await compile(`export const [count,setCount]=createSignal<i32>(1);
function helper(n:i32):i32 {setCount(9);if(n>0)return n;return 0;}
export function press():void {const count=helper(count()+1);setCount(count+1);}`.replace("const count=helper(count()+1);setCount(count+1)", "const value=helper(count()+1);setCount(value+1)"));
  module.press(); expect(module.count()).toBe(3);
});
test("framework schedule retains memo read timing and equal primitive gating", () => {
  for (const readBetween of [false, true]) {
    const region = new ModelRegion(storage);
    region.signal(1, "trigger", 0); region.signal(2, "a", 0); region.signal(3, "runs", 0);
    region.memo(4, "memo", [2], () => region.read(2));
    region.effect(5, [1], () => {region.write(2,1); if(readBetween) region.read(4); region.write(2,0);}, true);
    region.effect(6, [4], () => region.write(3, Number(region.read(3))+1), true);
    region.finish([5,4,6]); region.react(true); region.write(1,1); region.react(); region.settle();
    expect(region.read(3)).toBe(readBetween ? 1 : 0);
  }
});
test("JS lowering emits coroutine state transitions without native async or Promise", async () => {
  const {module, output} = await compile(`export const [n,setN]=createSignal<i32>(0);
export async function blink():Promise<void> {setN(1);await frames(2);setN(0);}`);
  expect(output).not.toMatch(/async function|new Promise|await /);
  module.blink(); expect(module.n()).toBe(1);
  resumeModelTasks(1, 16); expect(module.n()).toBe(1);
  resumeModelTasks(2, 32); expect(module.n()).toBe(0);
});
test("all task readiness is sampled before any segment runs", () => {
  resetModelTaskClock();
  const r = new ModelRegion(storage); r.signal(1,"n",0);r.finish([]); const tasks = new ModelTasks(r);
  tasks.start(10,[],state=>state===0 ? {next:1,suspend:{kind:"frames",count:1}} : (r.write(1,1),{done:true}));
  tasks.start(11,[],state=>state===0 ? {next:1,suspend:{kind:"until",predicate:()=>r.read(1)===1}} : (r.write(1,2),{done:true}));
  resumeModelTasks(1,16);expect(r.read(1)).toBe(1);
  resumeModelTasks(2,32);expect(r.read(1)).toBe(2);
});
test("capacity counts UTF-8 bytes and truncates only at character boundaries", () => {
  expect(capacity("é雪x",4,"name",false)).toBe("é");
  expect(()=>capacity("é雪",4,"name",true)).toThrow("name");
});
test("generated JS keeps exported constants and source names separate from compiler bindings", async () => {
  const { module } = await compile(`export const STEP:i32=3;
export const [__r,setR]=createSignal<i32>(0);
export function f1():void {setR(STEP);}`);
  expect(module.STEP).toBe(3); module.f1(); expect(module.__r()).toBe(3);
});
