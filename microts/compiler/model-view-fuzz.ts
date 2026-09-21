/** Seeded generated views exercise factory lifetimes through the full input bridge. */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { executeModelView } from "./model-view-harness.ts";
import { ModelTapeInterpreter, type ModelTapeFrame } from "./aot-model-tape.ts";

export const MODEL_VIEW_FUZZ_COVERAGE = ["component-region","mount-arguments","remount-reset","multiple-regions","first-update-memo","atomic-show"] as const;
let sequence=0;
export function generateModelViewCase(seed:number) {
  const initial=(seed>>>0)%17,step=1+((seed>>>3)%3);
  const files:Record<string,string>={
    "pocket.json":JSON.stringify({pocket:2,id:"test.model.view-fuzz",name:"Generated regions",app:{entry:"App.tsx",framework:"solid",aot:true,model:"compiled"}}),
    "App.ts":`import{createSignal}from"solid-js";import{createEffect,on}from"@pocketjs/framework/solid/reactive";import type{i32}from"@pocketjs/framework/solid/std";
      export const[count,setCount]=createSignal<i32>(0);export const[mid,setMid]=createSignal<i32>(0);export const[end,setEnd]=createSignal<i32>(0);export const[open,setOpen]=createSignal(true);
      createEffect(on([count],()=>setMid(count()),{defer:true}));createEffect(on([mid],()=>setEnd(mid()),{defer:true}));
      export function press():void{setCount(v=>v+${step});console.log("root:"+count());}export function toggle():void{setOpen(v=>!v);}
      export function load():void{console.log("root-mount");}export function release():void{console.log("root-unmount");}`,
    "App.tsx":`import{Show}from"solid-js";import{View,Text,ActionHandler}from"@pocketjs/framework/solid/components";import{onMount,onCleanup}from"@pocketjs/framework/solid/lifecycle";import{BTN}from"@pocketjs/framework/input";import{count,mid,end,open,press,toggle,load,release}from"./App";import Row from"./Row.tsx";
      export default function App(){onMount(()=>load());onCleanup(()=>release());return <View><Text>{count()}:{mid()}:{end()}</Text><ActionHandler button={BTN.CROSS} onPress={press}/><ActionHandler button={BTN.SELECT} onPress={toggle}/><Show when={mid()!==end()}><Row seed={999} label="transient"/></Show><Show when={open()}><Row seed={${initial}} label="left"/><Row seed={${initial+1}} label="right"/></Show></View>;}`,
    "Row.ts":`import{createSignal}from"solid-js";import{createMemo}from"@pocketjs/framework/solid/reactive";import type{i32}from"@pocketjs/framework/solid/std";
      export function createRow(seed:i32,label:string){const[value,setValue]=createSignal<i32>(seed);const doubled=createMemo<i32>(()=>value()*2);function press():void{setValue(v=>v+1);console.log(label+":"+value());}function load():void{console.log("mount:"+label);}function release():void{console.log("unmount:"+label);}return{value,doubled,press,load,release};}`,
    "Row.tsx":`import{View,Text,ActionHandler}from"@pocketjs/framework/solid/components";import{onMount,onCleanup}from"@pocketjs/framework/solid/lifecycle";import{BTN}from"@pocketjs/framework/input";import type{i32}from"@pocketjs/framework/solid/std";import{createRow}from"./Row";
      export default function Row(props:{seed:i32;label:string}){const{value,doubled,press,load,release}=createRow(props.seed,props.label);onMount(()=>load());onCleanup(()=>release());return <View><Text>{props.label}:{value()}:{doubled()}</Text><ActionHandler button={BTN.CROSS} onPress={press}/></View>;}`,
  };
  const tape:ModelTapeFrame[]=[0,16384,0,1,0,1,0,16384,0,seed%2?1:16384].map(buttons=>({buttons}));
  files["tape.json"]=JSON.stringify(tape);
  return{seed,files,tape,coverage:[...MODEL_VIEW_FUZZ_COVERAGE]};
}
export async function runModelViewFuzz(seeds:readonly number[]):Promise<{programs:number;coverage:string[]}>{
  for(const seed of seeds){
    const fixture=generateModelViewCase(seed),folder=resolve(".pocket-build/validation/model-aot/view-fuzz",`${process.pid}-${sequence++}-${seed}`);
    await mkdir(folder,{recursive:true});await Promise.all(Object.entries(fixture.files).map(([file,source])=>writeFile(resolve(folder,file),source)));
    const actual=await executeModelView(folder),interpreter=new ModelTapeInterpreter(actual.program);
    const commands=(trace:any[])=>trace.filter(event=>event.kind==="command"&&event.op==="log").map(event=>event.args.map(String).join(" "));
    const initial=commands(interpreter.model.trace);
    const reference=fixture.tape.map((input,index)=>{
      const frame=interpreter.frame({...input,clock:index*1000/60});
      if(frame.state.mid!==frame.state.end)throw new Error(`Generated effect chain did not settle at seed ${seed} frame ${index}`);
      const children=Object.entries(frame.regions).filter(([id])=>id!=="1");
      if(children.length!==(frame.state.open?2:0))throw new Error(`Transient or missing region at seed ${seed} frame ${index}`);
      return{text:[`${frame.state.count}:${frame.state.mid}:${frame.state.end}`,...children.map(([,state],index)=>`${index===0?"left":"right"}:${state.value}:${state.doubled}`)],commands:[...(index===0?initial:[]),...commands(frame.trace)]};
    });
    interpreter.model.trace=[];interpreter.dispose();const expected={frames:reference,cleanup:commands(interpreter.model.trace)};
    if(!isDeepStrictEqual(actual.javascript,expected))throw new Error(`Generated region seed ${seed} differs: ${JSON.stringify({expected,actual:actual.javascript,folder},null,2)}`);
  }
  return{programs:seeds.length,coverage:seeds.length?[...MODEL_VIEW_FUZZ_COVERAGE]:[]};
}
