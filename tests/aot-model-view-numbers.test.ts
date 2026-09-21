import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { buildAot } from "../microts/compiler/aot-build.ts";
import { jsxPlugin } from "../framework/compiler/jsx-plugin.ts";
import { normalizeSolidAotSemantics } from "../microts/compiler/aot-solid-semantics.ts";
import { normalizeVueAotSemantics } from "../microts/compiler/aot-browser-semantics.ts";

test.each(["solid", "vue-vapor"] as const)("compiled %s view arithmetic agrees with native integer wrapping and f32 rounding", async framework => {
  const run = resolve(".pocket-build/validation/model-aot/view-numbers", `${framework}-${Date.now()}`), fixture = resolve(run, "app");
  await mkdir(resolve(run, "src"), { recursive: true }); await mkdir(fixture);
  const extension = framework === "solid" ? "tsx" : "vue";
  const model = framework === "solid"
    ? 'import {createSignal} from "solid-js";import type {i32,f32} from "@pocketjs/framework/solid/std";export const[count,setCount]=createSignal<i32>(2147483647);export const[minimum,setMinimum]=createSignal<i32>(-2147483648);export const[floating,setFloating]=createSignal<f32>(1.0);'
    : 'import {ref} from "vue";import type {i32,f32} from "@pocketjs/framework/vue-vapor/std";export const count=ref<i32>(2147483647);export const minimum=ref<i32>(-2147483648);export const floating=ref<f32>(1.0);';
  const source = framework === "solid"
    ? 'import {View,Text,ActionHandler} from "@pocketjs/framework/solid/components";import {idiv} from "@pocketjs/framework/solid/std";import {BTN} from "@pocketjs/framework/input";import {count,setCount,minimum,floating,count as Math,count as __pocketAotNumber} from "./App";export default function App(){const squared=()=>count()*count();return <View><ActionHandler button={BTN.CROSS} onPress={()=>setCount(count()*count())}/><Text>{count()+1}|{squared()}|{-count()}|{idiv(minimum(),-1)}|{floating()+16777217}|{(floating()+16777217)-16777216}</Text></View>;}'
    : '<script setup lang="ts">import {View,Text,ActionHandler} from "@pocketjs/framework/vue-vapor/components";import {idiv} from "@pocketjs/framework/vue-vapor/std";import {BTN} from "@pocketjs/framework/vue-vapor/input";import {count,minimum,floating,count as Math,count as __pocketAotNumber} from "./App";</script><template><View><ActionHandler :button="BTN.CROSS" @press="count=count*count"/><Text>{{count+1}}|{{count*count}}|{{-count}}|{{idiv(minimum,-1)}}|{{floating+16777217}}|{{(floating+16777217)-16777216}}</Text></View></template>';
  await Bun.write(resolve(fixture, "pocket.json"), JSON.stringify({ app: { framework, aot: true, model: "compiled", entry: `App.${extension}` } }));
  await Bun.write(resolve(fixture, "App.ts"), model); await Bun.write(resolve(fixture, `App.${extension}`), source);
  const result = await buildAot(resolve(fixture, `App.${extension}`), { outDir: resolve(run, "src/gen"), format: false });
  const normalize = framework === "solid" ? normalizeSolidAotSemantics : normalizeVueAotSemantics;
  const normalized = normalize(source, resolve(fixture, `App.${extension}`), result.program);
  expect(normalized).toContain("__modelMultiply as __pocketAotMultiply");
  expect(normalized).toContain("__modelNumber as __pocketAotNumber1");
  expect(normalize(source, resolve(fixture, `App.${extension}`), { ...result.program, modelProtocol: undefined })).toBe(source);
  const wasmBuild = Bun.spawnSync([process.execPath, "tools/wasm.ts"], { stdout: "pipe", stderr: "pipe" });
  expect(wasmBuild.exitCode, wasmBuild.stderr.toString()).toBe(0);
  const oracle = resolve(run, "oracle.ts");
  await Bun.write(oracle, `
import {render} from ${JSON.stringify(resolve(framework === "solid" ? "framework/src/index.ts" : "framework/src/index-vue-vapor.ts"))};
import {rootMirror} from ${JSON.stringify(resolve(framework === "solid" ? "framework/src/renderer-solid.ts" : "framework/src/renderer-vue-vapor.ts"))};
import {createWasmUi} from ${JSON.stringify(resolve("hosts/web/wasm-ops.js"))};
import App from ${JSON.stringify(resolve(fixture, `App.${extension}`))};
const wasm=await createWasmUi(await Bun.file(${JSON.stringify(resolve("hosts/web/pocketjs.wasm"))}).arrayBuffer());
wasm.ops.loadStyles(new Uint8Array(${JSON.stringify(result.program.styles.bytes)}));
const dispose=render(${framework === "solid" ? "()=>App()" : "App"},{ops:wasm.ops,styles:${JSON.stringify(result.program.styles.ids)}});
const root=rootMirror.children[0].id;const text=id=>{const node=wasm.inspectNode(id);return node.text+node.children.map(text).join("");};
export function check(){const frames=[text(root)];globalThis.frame(16384,0,[],[],[],0,[]);wasm.tick();frames.push(text(root));dispose();return frames;}
`);
  const build = await Bun.build({ entrypoints: [oracle], target: "bun", format: "esm", conditions: ["browser"], plugins: [jsxPlugin(framework)] });
  expect(build.success, build.logs.join("\n")).toBe(true);
  const bundle = resolve(run, "oracle.mjs"); await Bun.write(bundle, build.outputs[0]!);
  const javascript = (await import(bundle)).check();
  expect(javascript).toEqual(["-2147483648|1|-2147483647|-2147483648|16777216|0", "2|1|-1|-2147483648|16777216|0"]);
  await Bun.write(resolve(run, "Cargo.toml"), `[package]\nname="model-view-numbers"\nversion="0.0.0"\nedition="2021"\n[workspace]\n[dependencies]\nmicrots={path=${JSON.stringify(resolve("engine/crates/microts"))},features=["std"]}\nserde_json="1"\n`);
  await Bun.write(resolve(run, "src/main.rs"), `mod gen;use gen::*;use microts::{Host,Ui,Input};struct Native(Ui);impl Host for Native{fn ui(&self)->&Ui{&self.0}fn ui_mut(&mut self)->&mut Ui{&mut self.0}fn into_ui(self)->Ui{self.0}}impl<const B:u32>microts::HasButton<B> for Native{}fn text(ui:&Ui,id:i32)->String{let mut s=ui.core().node_text(id).unwrap_or("").to_owned();for child in ui.core().node_children(id){s.push_str(&text(ui,*child));}s}fn main(){let mut ui=Ui::new();ui.load_styles(include_bytes!("gen/styles.bin"));let mut app=AppApp::new(Native(ui),AppProps{},AppModel::default());let mut frames=vec![text(app.ui(),1)];app.frame(&Input::buttons(16384));frames.push(text(app.ui(),1));app.unmount();println!("{}",serde_json::json!(frames));}`);
  const child = Bun.spawn(["cargo", "run", "--quiet", "--manifest-path", resolve(run, "Cargo.toml")], { stdout: "pipe", stderr: "pipe", env: { ...process.env, CARGO_TARGET_DIR: resolve(".pocket-build/validation/model-aot/view-numbers/target") } });
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await Bun.write(resolve(run, "native.log"), stderr); expect(status, stderr).toBe(0); expect(JSON.parse(stdout)).toEqual(javascript);
}, 120_000);
