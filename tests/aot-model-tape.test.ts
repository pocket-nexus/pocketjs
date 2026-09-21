import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { BTN } from "../contracts/spec/spec.ts";
import { analyzeSolidAot } from "../microts/compiler/aot-solid-frontend.ts";
import { analyzeModel } from "../microts/compiler/aot-model-frontend.ts";
import { ModelTapeInterpreter, replayModelTape } from "../microts/compiler/aot-model-tape.ts";

const directory = resolve("tests/fixtures/aot-model/tape-virtual");
function program(files: Record<string, string>) {
  const sources = new Map(Object.entries(files).map(([name, text]) => [resolve(directory, name), text]));
  const view = analyzeSolidAot(resolve(directory, "App.tsx"), { sources, strict: true });
  view.model = analyzeModel(resolve(directory, "App.ts"), { sources, name: "App", factories: view.components.filter(component => component.factory).map(component => resolve(directory, component.factory!.module + (component.factory!.module.endsWith(".ts") ? "" : ".ts"))) });
  for (const component of view.components) {
    const region = view.model.modules.find(module => component.root ? module.kind === "root" : component.factory && module.factory === component.factory.sourceName);
    if (region) region.name = component.name;
  }
  return view;
}
const imports = 'import {createSignal} from "solid-js"; import {createMemo,createEffect} from "@pocketjs/framework/solid/reactive"; import {frames,type i32} from "@pocketjs/framework/solid/std";';

test("button tape dispatch refreshes active memos and later handler arguments before reaction", () => {
  const view = program({
    "App.ts": imports + 'export const [count,setCount]=createSignal<i32>(0);export const [recorded,setRecorded]=createSignal<i32>(0);export const double=createMemo<i32>(()=>count()*2);export function record(n:i32){setRecorded(n);}export function adjust(delta:i32){setCount(n=>n+delta);}',
    "App.tsx": 'import {ActionHandler,AxisHandler,View} from "@pocketjs/framework/solid/components";import {BTN} from "@pocketjs/framework/input";import {setCount,double,record,adjust} from "./App";export default function App(){return <View><ActionHandler button={BTN.CROSS} onPress={()=>setCount(1)}/><ActionHandler button={BTN.CROSS} active={double()>0} onPress={()=>record(double())}/><AxisHandler axis="primary" onDelta={adjust}/></View>;}',
  });
  const frames = replayModelTape(view, [{ buttons: 0 }, { buttons: BTN.CROSS }, { buttons: BTN.CROSS }, { buttons: 0, axis: 3 }]);
  expect(frames[1]!.state).toEqual({ count: 1, recorded: 2, double: 2 });
  expect(frames[2]!.trace.filter(event => event.kind === "handler")).toEqual([]);
  expect(frames[3]!.state).toEqual({ count: 4, recorded: 2, double: 8 });
});

test("factory tape regions retain seeds and cancel at unmount, then restart deadlines at remount", () => {
  const view = program({
    "App.ts": imports + 'export const [visible,setVisible]=createSignal(true);export const [seed,setSeed]=createSignal<i32>(3);export function toggle(){setVisible(!visible());}export function increment(){setSeed(n=>n+1);}',
    "App.tsx": 'import {Show} from "solid-js";import {View,ActionHandler} from "@pocketjs/framework/solid/components";import {BTN} from "@pocketjs/framework/input";import {visible,seed,toggle,increment} from "./App";import Row from "./Row.tsx";export default function App(){return <View><ActionHandler button={BTN.SELECT} onPress={toggle}/><ActionHandler button={BTN.CROSS} onPress={increment}/><Show when={visible()}><Row seed={seed()}/></Show></View>;}',
    "Row.ts": imports + 'export function createRow(seed:i32){const [count,setCount]=createSignal<i32>(seed);async function late():Promise<void>{await frames(2);setCount(seed+100);}createEffect(()=>late());return {count};}',
    "Row.tsx": 'import {Text} from "@pocketjs/framework/solid/components";import type {i32} from "@pocketjs/framework/solid/std";import {createRow} from "./Row";export default function Row(props:{seed:i32}){const {count}=createRow(props.seed);return <Text>{count()}</Text>;}',
  });
  const runtime = new ModelTapeInterpreter(view);
  const hidden = runtime.frame({ buttons: BTN.SELECT | BTN.CROSS });
  expect(hidden.regions).toEqual({ 1: { visible: false, seed: 4 } });
  expect(hidden.trace.some(event => event.kind === "task-cancel" && event.reason === "unmount")).toBe(true);
  runtime.frame({ buttons: 0 });
  const mounted = runtime.frame({ buttons: BTN.SELECT });
  expect(mounted.regions[3]).toEqual({ count: 4 });
  expect(runtime.frame({ buttons: 0 }).regions[3]).toEqual({ count: 4 });
  expect(runtime.frame({ buttons: 0 }).regions[3]).toEqual({ count: 104 });
});

test("keyed dispatch retains mounted order and rereads changed row values between handlers", () => {
  const view = program({
    "App.ts": imports + 'import {map} from "@pocketjs/framework/solid/std";interface Row{id:i32;label:string}export const [rows,setRows]=createSignal<Row[]>([{id:1,label:"a"},{id:2,label:"b"}]);export const [log,setLog]=createSignal("");export function rename(id:i32){setRows(map(rows(),r=>({id:r.id,label:r.id===id?r.label+"!":r.label})));}export function record(label:string){setLog(s=>s+label);}',
    "App.tsx": 'import {View,ActionHandler,For} from "@pocketjs/framework/solid/components";import {BTN} from "@pocketjs/framework/input";import {rows,rename,record} from "./App";export default function App(){return <View><For each={rows()} by={row=>row.id}>{row=><View><ActionHandler button={BTN.CROSS} onPress={()=>rename(row().id)}/><ActionHandler button={BTN.CROSS} onPress={()=>record(row().label)}/></View>}</For></View>;}',
  });
  const [result] = replayModelTape(view, [{ buttons: BTN.CROSS }]);
  expect(result!.state.log).toBe("a!b!");
});

test("focus activation requires an explicit host target and routes unique debugName", () => {
  const view = program({
    "App.ts": imports + 'export const [count,setCount]=createSignal<i32>(0);export function increment(){setCount(n=>n+1);}',
    "App.tsx": 'import {View} from "@pocketjs/framework/solid/components";import {increment} from "./App";export default function App(){return <View focusable debugName="counter" onPress={increment}/>;}',
  });
  expect(() => replayModelTape(view, [{ buttons: BTN.CIRCLE }])).toThrow("requires target");
  expect(replayModelTape(view, [{ buttons: BTN.CIRCLE, target: "counter" }])[0]!.state.count).toBe(1);
});

test("mount rounds run the child's queued hook before a parent-hidden branch is destroyed", () => {
  const view = program({
    "App.ts": imports + 'export const [visible,setVisible]=createSignal(true);export function hide(){setVisible(false);}',
    "App.tsx": 'import {Show} from "solid-js";import {View} from "@pocketjs/framework/solid/components";import {onMount} from "@pocketjs/framework/solid/lifecycle";import {visible,hide} from "./App";import Row from "./Row.tsx";export default function App(){onMount(hide);return <View><Show when={visible()}><Row/></Show></View>;}',
    "Row.ts": imports + 'export function createRow(){const [count,setCount]=createSignal<i32>(0);function load(){setCount(7);}function release(){setCount(9);}return {count,load,release};}',
    "Row.tsx": 'import {Text} from "@pocketjs/framework/solid/components";import {onMount,onCleanup} from "@pocketjs/framework/solid/lifecycle";import {createRow} from "./Row";export default function Row(){const {count,load,release}=createRow();onMount(load);onCleanup(release);return <Text>{count()}</Text>;}',
  });
  const runtime = new ModelTapeInterpreter(view);
  expect(runtime.model.trace.filter(event => event.kind === "handler").map(event => event.name)).toEqual(["hide", "load", "release"]);
  expect(runtime.frame().regions).toEqual({ 1: { visible: false } });
});

test("child callbacks and supplied slots read current parent props in document order", () => {
  const view = program({
    "App.ts": imports + 'export const [count,setCount]=createSignal<i32>(0);export const [recorded,setRecorded]=createSignal<i32>(0);export function record(n:i32){setRecorded(x=>x+n);}',
    "App.tsx": 'import {View,ActionHandler} from "@pocketjs/framework/solid/components";import {BTN} from "@pocketjs/framework/input";import {count,setCount,record} from "./App";import Box from "./Box.tsx";export default function App(){return <View><ActionHandler button={BTN.START} onPress={()=>setCount(2)}/><Box value={count()} onSave={record}><ActionHandler button={BTN.START} onPress={()=>record(count())}/></Box></View>;}',
    "Box.tsx": 'import type {JSX} from "solid-js";import type {i32} from "@pocketjs/framework/solid/std";import {View,ActionHandler} from "@pocketjs/framework/solid/components";import {BTN} from "@pocketjs/framework/input";export default function Box(props:{value:i32;onSave:(n:i32)=>void;children:JSX.Element}){return <View><ActionHandler button={BTN.START} onPress={()=>props.onSave(props.value)}/>{props.children}</View>;}',
  });
  const [result] = replayModelTape(view, [{ buttons: BTN.START }]);
  expect(result!.state).toEqual({ count: 2, recorded: 4 });
});

test("startup timers see zero milliseconds at the first numbered instant", () => {
  const view = program({
    "App.ts": imports + 'import {after} from "@pocketjs/framework/solid/std";export const [count,setCount]=createSignal<i32>(0);async function later():Promise<void>{await after(16);setCount(1);}createEffect(()=>later());',
    "App.tsx": 'import {Text} from "@pocketjs/framework/solid/components";import {count} from "./App";export default function App(){return <Text>{count()}</Text>;}',
  });
  const frames = replayModelTape(view, { hz: 60, frames: [{}, {}] });
  expect(frames.map(frame => frame.frame)).toEqual([1, 2]);
  expect(frames.map(frame => frame.state.count)).toEqual([0, 1]);
});
