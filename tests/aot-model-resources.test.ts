import { expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { buildAot } from "../microts/compiler/aot-build.ts";

test("the compiled Solid lab model and view stay below the 24 MiB allocation cap", async () => {
  await buildAot("solid-aot-lab", { strict: true });
  const run=resolve(".pocket-build/validation/model-aot/resources",String(Date.now()));await mkdir(resolve(run,"src"),{recursive:true});
  await Bun.write(resolve(run,"Cargo.toml"),`[package]\nname="model-resource-lab"\nversion="0.0.0"\nedition="2021"\n[workspace]\n[dependencies]\npocket-solid-aot-lab={path=${JSON.stringify(resolve("apps/solid-aot-lab"))},features=["std"]}\nmicrots={path=${JSON.stringify(resolve("engine/crates/microts"))},features=["std"]}\nserde_json="1"\n`);
  await Bun.write(resolve(run,"src/main.rs"),`
use std::alloc::{GlobalAlloc,Layout,System};use std::sync::atomic::{AtomicUsize,Ordering};use std::time::Instant;
use pocket_solid_aot_lab::{LabApp,AppModel,AppViewModel};use microts::{Ui,Input,NodeId};
const LIMIT:usize=24*1024*1024;static LIVE:AtomicUsize=AtomicUsize::new(0);static PEAK:AtomicUsize=AtomicUsize::new(0);struct Capped;
unsafe impl GlobalAlloc for Capped {unsafe fn alloc(&self,layout:Layout)->*mut u8{let used=LIVE.fetch_add(layout.size(),Ordering::SeqCst)+layout.size();if used>LIMIT{LIVE.fetch_sub(layout.size(),Ordering::SeqCst);return core::ptr::null_mut();}let ptr=System.alloc(layout);if ptr.is_null(){LIVE.fetch_sub(layout.size(),Ordering::SeqCst);}else{PEAK.fetch_max(used,Ordering::SeqCst);}ptr}unsafe fn dealloc(&self,ptr:*mut u8,layout:Layout){System.dealloc(ptr,layout);LIVE.fetch_sub(layout.size(),Ordering::SeqCst);}}
#[global_allocator]static ALLOC:Capped=Capped;
fn find(ui:&Ui,id:NodeId,name:&str)->NodeId{if ui.debug_name(id)==Some(name){return id;}for child in ui.core().node_children(id.0){let found=find(ui,NodeId(*child),name);if found!=NodeId::NONE{return found;}}NodeId::NONE}
fn main(){let mut app=LabApp::new(Ui::new());app.frame(Input::default());let increment=find(app.ui(),NodeId::ROOT,"ModelButton");let toggle=find(app.ui(),NodeId::ROOT,"FeatureToggle");assert_ne!(increment,NodeId::NONE);assert_ne!(toggle,NodeId::NONE);
let mut frames=Vec::with_capacity(2048);let mut models=Vec::with_capacity(2048);let mut model=AppModel::default();let mut commands=Vec::new();model.react(true,&mut commands);model.settle();
for frame in 0..2048 {let input=match frame%8{0=>Input::press(increment),2|3=>Input::default().with_axis(0,7500),4|6=>Input::press(toggle),7=>Input::buttons(microts::spec::btn::CROSS),_=>Input::default()};let started=Instant::now();std::hint::black_box(&mut app).frame(input);frames.push(started.elapsed().as_nanos()as u64);
let started=Instant::now();std::hint::black_box(&mut model);model.adjustCount(15000);model.react(false,&mut commands);model.settle();model.resetCount();model.react(false,&mut commands);model.settle();std::hint::black_box(&mut model);models.push(started.elapsed().as_nanos()as u64);}
assert_eq!(app.model.count(),0);assert!(app.model.features().iter().all(|row|row.enabled));assert_eq!(model.count(),0);let peak=PEAK.load(Ordering::SeqCst);assert!(peak<=LIMIT);let live=LIVE.load(Ordering::SeqCst);app.unmount();println!("{}",serde_json::json!({"frames":frames.len(),"limitBytes":LIMIT,"peakBytes":peak,"liveBytes":live,"frameNanoseconds":frames,"modelNanoseconds":models}));}
`);
  const child=Bun.spawn(["cargo","run","--release","--quiet","--manifest-path",resolve(run,"Cargo.toml")],{stdout:"pipe",stderr:"pipe",env:{...process.env,CARGO_TARGET_DIR:resolve(".pocket-build/validation/model-aot/resources/target")}});
  const[status,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);await Bun.write(resolve(run,"build.log"),stderr);expect(status,stderr).toBe(0);const receipt=JSON.parse(stdout);
  expect(receipt.frames).toBe(2048);expect(receipt.peakBytes).toBeLessThanOrEqual(24*1024*1024);
  const quantiles=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);return{p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.floor(sorted.length*.95)],max:sorted.at(-1)}};
  receipt.timingUnit="nanoseconds";receipt.frameSummary=quantiles(receipt.frameNanoseconds);receipt.modelSummary=quantiles(receipt.modelNanoseconds);receipt.timingAcceptance="Recorded for comparison; no device timing budget asserted";
  receipt.generatedModelSha256=createHash("sha256").update(await readFile(resolve("apps/solid-aot-lab/gen/app_model.rs"))).digest("hex");
  await Bun.write(resolve(run,"receipt.json"),JSON.stringify(receipt,null,2)+"\n");
},120_000);
