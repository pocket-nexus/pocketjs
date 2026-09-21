import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { analyzeSolidAot } from "../microts/compiler/aot-solid-frontend.ts";
import { analyzeVueAot } from "../microts/compiler/aot-frontend.ts";
import { analyzeModel } from "../microts/compiler/aot-model-frontend.ts";
import { generateModelRust } from "../microts/compiler/aot-model-codegen.ts";
import { emitAot } from "../microts/compiler/aot-codegen.ts";
import { analyzeAot } from "../microts/compiler/aot-build.ts";
import { mkdirSync, writeFileSync } from "node:fs";

const folder = resolve(import.meta.dir, "fixtures/aot-model/factory-virtual");
test("private model contract types retain value traits when absent from the view", () => {
  const directory = resolve(".pocket-build/validation/model-aot/private-types");
  mkdirSync(resolve(directory, "src"), { recursive: true });
  writeFileSync(resolve(directory, "pocket.json"), JSON.stringify({ app: { framework: "solid", aot: true, model: "compiled" } }));
  writeFileSync(resolve(directory, "App.ts"), `import {createSignal} from "solid-js";import {copy,equals,type i32} from "@pocketjs/framework/solid/std";
interface Hidden { n:i32; label:string }const[hidden,setHidden]=createSignal<Hidden>({n:1,label:"seed"});export const[count,setCount]=createSignal<i32>(0);
export function press():void {const old=copy(hidden());if(equals(old,hidden()))setCount(old.n);setHidden({n:old.n+1,label:old.label+"!"});}`);
  writeFileSync(resolve(directory, "App.tsx"), 'import {View,Text} from "@pocketjs/framework/solid/components";import {count,press} from "./App";export default function App(){return <View focusable onPress={press}><Text>{count()}</Text></View>}');
  const program = analyzeAot(resolve(directory, "App.tsx"), { strict: true });
  writeFileSync(resolve(directory, "src/view.rs"), emitAot(program).files["app.rs"]!);
  writeFileSync(resolve(directory, "src/model.rs"), generateModelRust(program.model!, program));
  writeFileSync(resolve(directory, "Cargo.toml"), `[package]\nname="model-private-types"\nversion="0.0.0"\nedition="2021"\n[workspace]\n[dependencies]\nmicrots={path=${JSON.stringify(resolve("engine/crates/microts"))},features=["std"]}\n`);
  writeFileSync(resolve(directory, "src/lib.rs"), 'mod view;use view::*;mod model;use model::*;#[test]fn values(){let mut m=AppModel::default();m.press();assert_eq!(m.count(),1);m.press();assert_eq!(m.count(),2);}');
  const result = Bun.spawnSync(["cargo", "test", "--quiet", "--manifest-path", resolve(directory, "Cargo.toml")], { env: { ...process.env, CARGO_TARGET_DIR: resolve(".pocket-build/validation/model-aot/factory/target") } });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
});
test.each(["solid","vue-vapor"])("%s view contracts use model inference before expression checking", framework => {
  const directory=resolve(".pocket-build/validation/model-aot/inference",framework);
  mkdirSync(directory,{recursive:true});
  const solid=framework==="solid",extension=solid?"tsx":"vue";
  writeFileSync(resolve(directory,"pocket.json"),JSON.stringify({app:{framework,aot:true,model:"compiled",entry:`App.${extension}`}}));
  writeFileSync(resolve(directory,"App.ts"),solid?'import {createSignal} from "solid-js";import {createMemo} from "@pocketjs/framework/solid/reactive";export const[n,setN]=createSignal(0);export const[f,setF]=createSignal(1.0);export const twice=createMemo(()=>n()*2);export function read(){return n();}':'import {ref,computed} from "vue";export const n=ref(0);export const f=ref(1.0);export const twice=computed(()=>n.value*2);export function read(){return n.value;}');
  writeFileSync(resolve(directory,`App.${extension}`),solid?'import {View,Text} from "@pocketjs/framework/solid/components";import {n,setN,f,twice,read} from "./App";export default function App(){return <View focusable onPress={()=>setN(read())}><Text>{n()}:{f()}:{twice()}</Text></View>}':'<script setup lang="ts">import {View,Text} from "@pocketjs/framework/vue-vapor/components";import {n,f,twice,read} from "./App";</script><template><View focusable @press="n=read()"><Text>{{n}}:{{f}}:{{twice}}</Text></View></template>');
  const p=analyzeAot(resolve(directory,`App.${extension}`),{strict:true}),root=p.components.find(c=>c.root)!;
  expect(root.values.map(value=>[value.name,value.type])).toEqual([["n",{kind:"number",name:"i32"}],["f",{kind:"number",name:"f64"}],["twice",{kind:"number",name:"i32"}]]);
  expect(root.functions[0]!.returns).toEqual({kind:"number",name:"i32"});
  expect(p.model!.types).toBe(p.types);
  const serialized = JSON.parse(JSON.stringify(p));
  expect(serialized.model).toBeUndefined();
  expect(serialized.modelProtocol).toBe(true);
  expect(emitAot(serialized).files).toEqual(emitAot(p).files);
});
test("compiled views inline explicitly typed model constants",()=>{
  const directory=resolve(".pocket-build/validation/model-aot/inference/constants");mkdirSync(directory,{recursive:true});
  writeFileSync(resolve(directory,"pocket.json"),JSON.stringify({app:{framework:"solid",aot:true,model:"compiled",entry:"App.tsx"}}));
  writeFileSync(resolve(directory,"App.ts"),'import type {i32} from "@pocketjs/framework/solid/std";export const STEP:i32=2;');
  writeFileSync(resolve(directory,"App.tsx"),'import {Text} from "@pocketjs/framework/solid/components";import {STEP} from "./App";export default function App(){return <Text>{STEP}</Text>}');
  const p=analyzeAot(resolve(directory,"App.tsx"),{strict:true});expect(p.components[0]!.constants).toMatchObject([{name:"STEP",value:2,type:{kind:"number",name:"i32"}}]);expect(p.components[0]!.values).toHaveLength(0);
});
test("Solid factory arguments retain mount-time props and checked parameter types", () => {
  const entry = resolve(folder, "App.tsx");
  const sources = new Map(Object.entries({
    "App.tsx": 'import Row from "./Row.tsx"; export default function App() { return <Row seed={7} />; }',
    "Row.tsx": 'import { Text } from "@pocketjs/framework/solid/components"; import type { i32 } from "@pocketjs/framework/solid/std"; import { createRow } from "./Row"; export default function Row(props: { seed: i32 }) { const { n } = createRow(props.seed); return <Text>{n()}</Text>; }',
    "Row.d.ts": 'import type { Accessor } from "solid-js"; import type { i32 } from "@pocketjs/framework/solid/std"; export declare function createRow(seed: i32): { n: Accessor<i32> };',
  }).map(([name, text]) => [resolve(folder, name), text]));
  const factory = analyzeSolidAot(entry, { sources, strict: true }).components.find(c => c.factory)!.factory!;
  expect(factory.params).toEqual([{ name: "seed", type: { kind: "number", name: "i32" } }]);
  expect(factory.arguments).toMatchObject([{ kind: "binding", scope: "prop", name: "seed", type: { kind: "number", name: "i32" } }]);
  sources.set(resolve(folder, "Row.tsx"), sources.get(resolve(folder, "Row.tsx"))!.replace("createRow(props.seed)", "createRow()"));
  expect(() => analyzeSolidAot(entry, { sources, strict: true })).toThrow("expects 1 mount-time arguments");
});

test("Vue factory arguments retain mount-time props and checked parameter types", () => {
  const entry = resolve(folder, "App.vue");
  const sources = new Map(Object.entries({
    "App.vue": '<script setup lang="ts">import Row from "./Row.vue";</script><template><Row :seed="7" /></template>',
    "Row.vue": '<script setup lang="ts">import { Text } from "@pocketjs/framework/vue-vapor/components"; import type { i32 } from "@pocketjs/framework/vue-vapor/std"; import { createRow } from "./Row"; const props = defineProps<{ seed: i32 }>(); const { n } = createRow(props.seed);</script><template><Text>{{ n }}</Text></template>',
    "Row.d.ts": 'import type { Ref } from "vue"; import type { i32 } from "@pocketjs/framework/vue-vapor/std"; export declare function createRow(seed: i32): { n: Ref<i32> };',
  }).map(([name, text]) => [resolve(folder, name), text]));
  const factory = analyzeVueAot(entry, { sources, strict: true }).components.find(c => c.factory)!.factory!;
  expect(factory.params).toEqual([{ name: "seed", type: { kind: "number", name: "i32" } }]);
  expect(factory.arguments).toMatchObject([{ kind: "binding", scope: "prop", name: "seed", type: { kind: "number", name: "i32" } }]);
});

test.each(["solid", "vue"])("%s refs preserve imported NodeSlot identity", framework => {
  const file = resolve(folder, framework === "solid" ? "Ref.tsx" : "Ref.vue");
  const model = 'import { createNodeRef } from "@pocketjs/framework/animation"; export const bar = createNodeRef();';
  const source = framework === "solid"
    ? 'import { View } from "@pocketjs/framework/solid/components"; import { bar as target } from "./Ref"; export default function Ref() { return <View ref={target} />; }'
    : '<script setup lang="ts">import { View } from "@pocketjs/framework/vue-vapor/components"; import { bar as target } from "./Ref";</script><template><View :ref="target" /></template>';
  const sources = new Map([[file, source], [resolve(folder, "Ref.ts"), model]]);
  const program = framework === "solid" ? analyzeSolidAot(file, { sources }) : analyzeVueAot(file, { sources });
  expect(program.components[0]!.refs).toEqual([{ name: "target", sourceName: "bar" }]);
  expect(program.components[0]!.nodes[0]).toMatchObject({ kind: "element", ref: "target" });
});

test("compiled factories seed two instances once, reset at remount, and clear refs at unmount", () => {
  const entry = resolve(folder, "App.tsx"), root = resolve(folder, "App.ts"), row = resolve(folder, "Row.ts");
  const sources = new Map(Object.entries({
    "App.tsx": 'import { Show } from "solid-js"; import { View } from "@pocketjs/framework/solid/components"; import { seed, setSeed, visible, setVisible, bar } from "./App"; import Row from "./Row.tsx"; export default function App() { return <View><View focusable debugName="seed" onPress={() => setSeed(seed()+1)} /><View focusable debugName="toggle" onPress={() => setVisible(!visible())} /><Show when={visible()}><View ref={bar} /><Row seed={seed()} /><Row seed={9} /></Show></View>; }',
    "App.ts": 'import { createSignal } from "solid-js"; import { createNodeRef } from "@pocketjs/framework/animation"; import type { i32 } from "@pocketjs/framework/solid/std"; export const [seed,setSeed]=createSignal<i32>(3); export const [visible,setVisible]=createSignal(true); export const bar=createNodeRef();',
    "Row.tsx": 'import { Text } from "@pocketjs/framework/solid/components"; import type { i32 } from "@pocketjs/framework/solid/std"; import { createRow } from "./Row"; export default function Row(props: {seed:i32}) { const {n,inc}=createRow(props.seed); return <Text>{n()}</Text>; }',
    "Row.ts": 'import { createSignal } from "solid-js"; import { createEffect } from "@pocketjs/framework/solid/reactive"; import { frames, type i32 } from "@pocketjs/framework/solid/std"; export function createRow(seed:i32) { const [n,setN]=createSignal<i32>(seed); function inc() { setN(x=>x+1); } async function late(): Promise<void> { await frames(2); setN(seed+100); } createEffect(() => late()); return {n,inc}; }',
  }).map(([name,text]) => [resolve(folder,name),text]));
  const program=analyzeSolidAot(entry,{sources,strict:true});
  program.model=analyzeModel(root,{sources,factories:[row],name:"App"});
  const directory=resolve(".pocket-build/validation/model-aot/factory");
  mkdirSync(resolve(directory,"src"),{recursive:true});
  writeFileSync(resolve(directory,"src/view.rs"),emitAot(program).files["app.rs"]!);
  writeFileSync(resolve(directory,"src/model.rs"),generateModelRust(program.model,program));
  writeFileSync(resolve(directory,"Cargo.toml"),`[package]\nname="model-aot-factory"\nversion="0.0.0"\nedition="2021"\n[workspace]\n[dependencies]\nmicrots={path=${JSON.stringify(resolve("engine/crates/microts"))},features=["std"]}\n`);
  writeFileSync(resolve(directory,"src/lib.rs"),`mod view; use view::*; mod model; use model::*;
fn text(ui:&microts::Ui,node:i32)->String {let mut s=ui.core().node_text(node).unwrap_or("").to_owned();for c in ui.core().node_children(node){s.push_str(&text(ui,*c));}s}
#[test] fn lifecycle(){
let mut app=AppApp::new(microts::Ui::new(),AppProps{},AppModel::default());
app.frame(&Default::default()); assert_eq!(text(app.ui(),1),"39");
let slot=app.model.bar().clone(); let first=slot.get().expect("mounted ref");
app.model.set_seed(7);app.invalidate();app.frame(&Default::default());assert_eq!(text(app.ui(),1),"103109");
app.model.set_visible(false);app.invalidate();app.frame(&Default::default());assert_eq!(text(app.ui(),1),"");assert!(slot.get().is_none());
app.model.set_visible(true);app.invalidate();app.frame(&Default::default());assert_eq!(text(app.ui(),1),"79");assert_ne!(slot.get(),Some(first));
app.frame(&Default::default());assert_eq!(text(app.ui(),1),"79");
app.frame(&Default::default());assert_eq!(text(app.ui(),1),"107109");
app.unmount();assert!(slot.get().is_none());
}
`);
  const run=Bun.spawnSync(["cargo","test","--quiet","--manifest-path",resolve(directory,"Cargo.toml")],{stdout:"pipe",stderr:"pipe",env:{...process.env,CARGO_TARGET_DIR:resolve(".pocket-build/validation/model-aot/factory-target")}});
  expect(run.exitCode,run.stdout.toString()+run.stderr.toString()).toBe(0);
},120_000);

test("compiled Cap values retain fixed storage through view getters and setter handlers", () => {
  const directory=resolve(".pocket-build/validation/model-aot/cap-view"),entry=resolve(folder,"App.tsx"),root=resolve(folder,"App.ts");
  const sources=new Map([
    [entry,'import { View, Text, For } from "@pocketjs/framework/solid/components"; import {name,setName,rows,setRows} from "./App"; export default function App(){return <View><View focusable onPress={()=>{setName("xyz");setRows(rows());}}/><Text>{name()}</Text><For each={rows()} by={n=>n}>{n=><Text>{n()}</Text>}</For></View>;}'],
    [root,'import {createSignal} from "solid-js";import type {Cap,i32} from "@pocketjs/framework/solid/std";export const [name,setName]=createSignal<Cap<string,8>>("abc");export const [rows,setRows]=createSignal<Cap<i32[],4>>([1,2]);'],
  ]);
  const program=analyzeSolidAot(entry,{sources,strict:true});program.model=analyzeModel(root,{sources,name:"App"});
  mkdirSync(resolve(directory,"src"),{recursive:true});
  writeFileSync(resolve(directory,"src/view.rs"),emitAot(program).files["app.rs"]!);
  writeFileSync(resolve(directory,"src/model.rs"),generateModelRust(program.model,program));
  writeFileSync(resolve(directory,"Cargo.toml"),`[package]\nname="model-aot-cap-view"\nversion="0.0.0"\nedition="2021"\n[workspace]\n[dependencies]\nmicrots={path=${JSON.stringify(resolve("engine/crates/microts"))},features=["std"]}\n`);
  writeFileSync(resolve(directory,"src/lib.rs"),`mod view;use view::*;mod model;use model::*;
use std::alloc::{GlobalAlloc,Layout,System};use std::sync::atomic::{AtomicBool,AtomicUsize,Ordering};
static ACTIVE:AtomicBool=AtomicBool::new(false);static ALLOCS:AtomicUsize=AtomicUsize::new(0);struct Counter;
unsafe impl GlobalAlloc for Counter {unsafe fn alloc(&self,l:Layout)->*mut u8{if ACTIVE.load(Ordering::Relaxed){ALLOCS.fetch_add(1,Ordering::Relaxed);}System.alloc(l)}unsafe fn dealloc(&self,p:*mut u8,l:Layout){System.dealloc(p,l)}}
#[global_allocator]static ALLOC:Counter=Counter;
fn text(ui:&microts::Ui,node:i32)->String {let mut s=ui.core().node_text(node).unwrap_or("").to_owned();for c in ui.core().node_children(node){s.push_str(&text(ui,*c));}s}
#[test]fn cap_storage(){let mut app=AppApp::new(microts::Ui::new(),AppProps{},AppModel::default());app.frame(&Default::default());assert_eq!(text(app.ui(),1),"abc12");
let parent=app.ui().core().node_children(1)[0];let target=app.ui().core().node_children(parent)[0];app.frame(&microts::Input::press(microts::NodeId(target)));assert_eq!(text(app.ui(),1),"xyz12");
let mut cmds=Vec::new();ACTIVE.store(true,Ordering::Relaxed);for _ in 0..100{app.model.set_name(microts::model::bounded_string::<8>("abc","name"));app.model.set_rows(microts::model::bounded_array::<i32,4>([1,2],"rows"));app.model.react(false,&mut cmds);app.model.settle();}ACTIVE.store(false,Ordering::Relaxed);assert_eq!(ALLOCS.load(Ordering::Relaxed),0);}
`);
  const run=Bun.spawnSync(["cargo","test","--quiet","--manifest-path",resolve(directory,"Cargo.toml")],{stdout:"pipe",stderr:"pipe",env:{...process.env,CARGO_TARGET_DIR:resolve(".pocket-build/validation/model-aot/factory-target")}});
  expect(run.exitCode,run.stdout.toString()+run.stderr.toString()).toBe(0);
},120_000);
