import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { buildAot } from "../microts/compiler/aot-build.ts";
import { jsxPlugin } from "../framework/compiler/jsx-plugin.ts";

test("compiled mount completes before first input without advancing frames or virtual time", async () => {
  const run=resolve(".pocket-build/validation/model-aot/startup",String(Date.now())),fixture=resolve(run,"app");
  await mkdir(fixture,{recursive:true});await mkdir(resolve(run,"src"));
  const files={
    "pocket.json":JSON.stringify({app:{framework:"solid",aot:true,model:"compiled",entry:"App.tsx"}}),
    "App.ts":`import {createSignal} from "solid-js";import {createEffect} from "@pocketjs/framework/solid/reactive";import {frames,after,type i32} from "@pocketjs/framework/solid/std";
export const[count,setCount]=createSignal(0);export const[seen,setSeen]=createSignal(0);export const[framed,setFramed]=createSignal(0);export const[timed,setTimed]=createSignal(0);export const[visible,setVisible]=createSignal(true);
createEffect(()=>{setCount(5);setVisible(false);});async function byFrame():Promise<void>{await frames(1);setFramed(1);}async function byTime():Promise<void>{await after(16);setTimed(1);}createEffect(()=>{byFrame();byTime();});export function press():void{setSeen(count());}`,
    "App.tsx":`import {Show} from "solid-js";import {View,Text,ActionHandler} from "@pocketjs/framework/solid/components";import {BTN} from "@pocketjs/framework/input";import {count,seen,framed,timed,visible,press} from "./App";import Child from "./Child.tsx";export default function App(){return <View><ActionHandler button={BTN.CROSS} onPress={press}/><Text>{count()}:{seen()}:{framed()}:{timed()}</Text><Show when={visible()}><Child/></Show></View>}`,
    "Child.ts":`import {createSignal} from "solid-js";import {createEffect} from "@pocketjs/framework/solid/reactive";import type {i32} from "@pocketjs/framework/solid/std";export function createChild(){const[n,setN]=createSignal(0);createEffect(()=>console.log("child-initial"));function mount():void{console.log("child-mount");}function cleanup():void{console.log("child-unmount");}return {n,mount,cleanup};}`,
    "Child.tsx":`import {Text} from "@pocketjs/framework/solid/components";import {onMount,onCleanup} from "@pocketjs/framework/solid/lifecycle";import {createChild} from "./Child";export default function Child(){const{n,mount,cleanup}=createChild();onMount(()=>mount());onCleanup(()=>cleanup());return <Text>{n()}</Text>;}`,
  };
  for(const[name,source]of Object.entries(files))await Bun.write(resolve(fixture,name),source);
  const result=await buildAot(fixture,{outDir:resolve(run,"src/gen"),format:false});
  const wasmBuild=Bun.spawnSync([process.execPath,"tools/wasm.ts"],{stdout:"pipe",stderr:"pipe"});expect(wasmBuild.exitCode,wasmBuild.stderr.toString()).toBe(0);
  const oracle=resolve(run,"oracle.ts");await Bun.write(oracle,`
import {render} from ${JSON.stringify(resolve("framework/src/index.ts"))};import {rootMirror} from ${JSON.stringify(resolve("framework/src/renderer-solid.ts"))};import {createWasmUi} from ${JSON.stringify(resolve("hosts/web/wasm-ops.js"))};import App from ${JSON.stringify(resolve(fixture,"App.tsx"))};
const commands=[];const log=console.log;console.log=(...x)=>commands.push(x.join(" "));
const wasm=await createWasmUi(await Bun.file(${JSON.stringify(resolve("hosts/web/pocketjs.wasm"))}).arrayBuffer());wasm.ops.loadStyles(new Uint8Array(${JSON.stringify(result.program.styles.bytes)}));const dispose=render(()=>App(),{ops:wasm.ops,styles:${JSON.stringify(result.program.styles.ids)}});const root=rootMirror.children[0].id;
const text=id=>{const n=wasm.inspectNode(id);return n.text+n.children.map(text).join("")};
export function check(){try{const frames=[text(root)];for(const buttons of [16384,0]){globalThis.frame(buttons,0,[],[],[],0,[]);wasm.tick();frames.push(text(root));}dispose();return {frames,commands};}finally{console.log=log;}}
`);
  const build=await Bun.build({entrypoints:[oracle],target:"bun",format:"esm",conditions:["browser"],plugins:[jsxPlugin("solid")]});expect(build.success,build.logs.join("\n")).toBe(true);const bundle=resolve(run,"oracle.mjs");await Bun.write(bundle,build.outputs[0]!);const previousLog=console.log;let javascript:any;try{javascript=(await import(bundle)).check();}finally{console.log=previousLog;}
  expect(javascript.frames).toEqual(["5:0:0:0","5:5:1:0","5:5:1:1"]);
  expect(javascript.commands).toEqual(["child-initial","child-mount","child-unmount"]);
  await Bun.write(resolve(run,"Cargo.toml"),`[package]\nname="model-startup"\nversion="0.0.0"\nedition="2021"\n[workspace]\n[dependencies]\nmicrots={path=${JSON.stringify(resolve("engine/crates/microts"))},features=["std"]}\nserde_json="1"\n`);
  await Bun.write(resolve(run,"src/main.rs"),`mod gen;use gen::*;use microts::{Host,Ui,Input,Cmd};use std::cell::RefCell;
thread_local!{static COMMANDS:RefCell<Vec<String>>=const{RefCell::new(Vec::new())};}struct Native(Ui);impl Host for Native{fn ui(&self)->&Ui{&self.0}fn ui_mut(&mut self)->&mut Ui{&mut self.0}fn into_ui(self)->Ui{self.0}fn model_command(&mut self,c:Cmd){if let Cmd::Log(s)=&c{COMMANDS.with(|v|v.borrow_mut().push(s.clone()));}self.0.model_command(c);}}impl<const B:u32>microts::HasButton<B> for Native{}
fn text(ui:&Ui,id:i32)->String{let mut s=ui.core().node_text(id).unwrap_or("").to_owned();for c in ui.core().node_children(id){s.push_str(&text(ui,*c));}s}
fn main(){let mut app=AppApp::new(Native(Ui::new()),AppProps{},AppModel::default());let mut frames=vec![text(app.ui(),1)];for buttons in [16384,0]{app.frame(&Input::buttons(buttons));frames.push(text(app.ui(),1));}app.unmount();let commands=COMMANDS.with(|v|std::mem::take(&mut *v.borrow_mut()));println!("{}",serde_json::json!({"frames":frames,"commands":commands}));}`);
  const child=Bun.spawn(["cargo","run","--quiet","--manifest-path",resolve(run,"Cargo.toml")],{stdout:"pipe",stderr:"pipe",env:{...process.env,CARGO_TARGET_DIR:resolve(".pocket-build/validation/model-aot/startup/target")}});const [status,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);await Bun.write(resolve(run,"native.log"),stderr);expect(status,stderr).toBe(0);expect(JSON.parse(stdout)).toEqual(javascript);
},120_000);
