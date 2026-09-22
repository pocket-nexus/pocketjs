/** Full input bridge and generated-view comparison for compiler tests and grammar probes. */
import { isDeepStrictEqual } from "node:util";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { buildAot } from "./aot-build.ts";
import { jsxPlugin } from "../../framework/compiler/jsx-plugin.ts";

export async function executeModelView(directory: string) {
  const fixture=resolve(directory), run=resolve(".pocket-build/validation/model-aot/view-frame",String(Date.now()));
  await mkdir(resolve(run,"src"),{recursive:true});
  const result=await buildAot(fixture,{strict:true,outDir:resolve(run,"src/gen"),format:false});
  const wasmBuild=Bun.spawnSync([process.execPath,"tools/wasm.ts"],{stdout:"pipe",stderr:"pipe"});
  await Bun.write(resolve(run,"wasm-build.log"),wasmBuild.stdout.toString()+wasmBuild.stderr.toString());
  if(wasmBuild.exitCode!==0)throw new Error(wasmBuild.stderr.toString());
  const oracle=resolve(run,"oracle.ts");
  await Bun.write(oracle,`
import { render } from ${JSON.stringify(resolve("framework/src/index.ts"))};
import { rootMirror } from ${JSON.stringify(resolve("framework/src/renderer-solid.ts"))};
import { createWasmUi } from ${JSON.stringify(resolve("hosts/web/wasm-ops.js"))};
import App from ${JSON.stringify(resolve(fixture,"App.tsx"))};
import tape from ${JSON.stringify(resolve(fixture,"tape.json"))};
const commands=[];const log=console.log;console.log=(...values)=>commands.push(values.join(" "));
const wasm=await createWasmUi(await Bun.file(${JSON.stringify(resolve("hosts/web/pocketjs.wasm"))}).arrayBuffer());
wasm.ops.loadStyles(new Uint8Array(${JSON.stringify(result.program.styles.bytes)}));
const dispose=render(()=>App(),{ops:wasm.ops,styles:${JSON.stringify(result.program.styles.ids)}});
const root=rootMirror.children[0].id;
const content=id=>{const n=wasm.inspectNode(id);return n.text+n.children.map(content).join("");};
const text=id=>{const n=wasm.inspectNode(id);if(!n||n.display===1)return [];return n.type===1?[content(id)]:n.children.flatMap(text);};
export function check(){try{const frames=[];for(const sample of tape){globalThis.frame(sample.buttons,0,[],[],[],0,[]);wasm.tick();frames.push({text:text(root),commands:commands.splice(0)});}dispose();return {frames,cleanup:commands.splice(0)};}finally{console.log=log;}}
`);
  const build=await Bun.build({entrypoints:[oracle],target:"bun",format:"esm",conditions:["browser"],plugins:[jsxPlugin("solid")]});
  if(!build.success)throw new Error(build.logs.join("\n"));const bundle=resolve(run,"oracle.mjs");await Bun.write(bundle,build.outputs[0]!);
  const javascript=(await import(bundle)).check();
  await Bun.write(resolve(run,"javascript.json"),JSON.stringify(javascript,null,2));
  await Bun.write(resolve(run,"Cargo.toml"),`[package]\nname="model-view-frame"\nversion="0.0.0"\nedition="2021"\n[workspace]\n[dependencies]\nmicrots={path=${JSON.stringify(resolve("engine/crates/microts"))},features=["std"]}\nserde_json="1"\n`);
  await Bun.write(resolve(run,"src/main.rs"),`
mod gen; use gen::*; use microts::{Host,Ui,Input,NodeId,Cmd}; use serde_json::{json,Value}; use std::cell::RefCell;
thread_local!{static COMMANDS:RefCell<Vec<String>>=const{RefCell::new(Vec::new())};}
struct Native(Ui);impl Host for Native{fn ui(&self)->&Ui{&self.0}fn ui_mut(&mut self)->&mut Ui{&mut self.0}fn into_ui(self)->Ui{self.0}fn model_command(&mut self,c:Cmd){if let Cmd::Log(s)=&c{COMMANDS.with(|v|v.borrow_mut().push(s.clone()));}self.0.model_command(c);}}
impl<const B:u32> microts::HasButton<B> for Native{}
fn text(ui:&Ui,id:i32)->Vec<String>{if let Some(style)=ui.core().resolved_style(id){if style.display==microts::spec::Display::None as u8{return vec![];}}if ui.core().node_type(id)==Some(1){return vec![ui.core().node_text(id).unwrap().into()];}ui.core().node_children(id).iter().flat_map(|id|text(ui,*id)).collect()}
fn commands()->Vec<String>{COMMANDS.with(|v|std::mem::take(&mut *v.borrow_mut()))}
fn main(){let mut ui=Ui::new();ui.load_styles(include_bytes!("gen/styles.bin"));let mut app=AppApp::new(Native(ui),AppProps{},AppModel::default());let tape:Value=serde_json::from_str(include_str!(${JSON.stringify(resolve(fixture,"tape.json"))})).unwrap();let mut frames=vec![];for frame in tape.as_array().unwrap(){app.frame(&Input::buttons(frame["buttons"].as_u64().unwrap() as u32));frames.push(json!({"text":text(app.ui(),NodeId::ROOT.0),"commands":commands()}));}app.unmount();println!("{}",json!({"frames":frames,"cleanup":commands()}));}
`);
  const native=Bun.spawn(["cargo","run","--quiet","--manifest-path",resolve(run,"Cargo.toml")],{stdout:"pipe",stderr:"pipe",env:{...process.env,CARGO_TARGET_DIR:resolve(".pocket-build/validation/model-aot/view-frame/target")}});
  const [status,stdout,stderr]=await Promise.all([native.exited,new Response(native.stdout).text(),new Response(native.stderr).text()]);await Bun.write(resolve(run,"native.log"),stderr);
  if(status!==0)throw new Error(stderr);const rust=JSON.parse(stdout);await Bun.write(resolve(run,"native.json"),JSON.stringify(rust,null,2));
  if(!isDeepStrictEqual(rust,javascript))throw new Error(`Generated view differs: ${JSON.stringify({javascript,rust,run},null,2)}`);
  return {javascript,rust,program:result.program,run};
}
