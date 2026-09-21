import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { executeModelView } from "../microts/compiler/model-view-harness.ts";
import { emitAot } from "../microts/compiler/aot-codegen.ts";

test("async Promise<T> view handlers and hooks use explicit command sinks with ordered child callbacks",async()=>{
  const directory=resolve(".pocket-build/validation/model-aot/async-view",String(Date.now()));mkdirSync(directory,{recursive:true});
  const files={
    "pocket.json":JSON.stringify({app:{framework:"solid",aot:true,model:"compiled",entry:"App.tsx"}}),
    "App.ts":'import {createSignal} from "solid-js";import {frames,type i32} from "@pocketjs/framework/solid/std";export const[n,setN]=createSignal<i32>(0);export async function load(value:i32):Promise<i32>{setN(value);console.log("root:start"+value);await frames(1);setN(value*2);console.log("root:end"+value);return value;}export async function mountTask():Promise<void>{console.log("root:mount");await frames(1);console.log("root:mounted");}',
    "App.tsx":'import {View,Text,ActionHandler} from "@pocketjs/framework/solid/components";import {onMount} from "@pocketjs/framework/solid/lifecycle";import {BTN} from "@pocketjs/framework/input";import {n,load,mountTask} from "./App";import Child from "./Child.tsx";export default function App(){onMount(()=>mountTask());return <View><ActionHandler button={BTN.CROSS} onPress={()=>load(7)}/><Text>{n()}</Text><Child onSaved={value=>load(value)}/></View>}',
    "Child.ts":'import {createSignal} from "solid-js";import {frames,type i32} from "@pocketjs/framework/solid/std";export function createChild(){const[n,setN]=createSignal<i32>(0);async function fire():Promise<i32>{setN(1);console.log("child:start");await frames(1);setN(2);console.log("child:end");return 9;}async function mountTask():Promise<void>{console.log("child:mount");await frames(1);console.log("child:mounted");}return {n,fire,mountTask};}',
    "Child.tsx":'import {View,Text,ActionHandler} from "@pocketjs/framework/solid/components";import {onMount} from "@pocketjs/framework/solid/lifecycle";import {BTN} from "@pocketjs/framework/input";import type {i32} from "@pocketjs/framework/solid/std";import {createChild} from "./Child";export default function Child(props:{onSaved:(value:i32)=>void}){const{n,fire,mountTask}=createChild();onMount(()=>mountTask());return <View><ActionHandler button={BTN.CROSS} onPress={()=>{fire();props.onSaved(8);}}/><Text>{n()}</Text></View>}',
    "tape.json":JSON.stringify([{buttons:16384},{buttons:0}]),
  };
  for(const[name,source]of Object.entries(files))writeFileSync(resolve(directory,name),source);
  const result=await executeModelView(directory);
  expect(result.program.components.find(component=>component.root)!.functions.find(fn=>fn.name==="load")).toMatchObject({async:true,returns:{kind:"void"},handler:true});
  expect(result.javascript.frames).toEqual([
    {text:["8","1"],commands:["root:mount","child:mount","root:mounted","child:mounted","root:start7","child:start","root:start8"]},
    {text:["16","2"],commands:["root:end8","child:end"]},
  ]);
  expect(emitAot(result.program).files["app.rs"]).toContain("cmds: &mut Vec<microts::Cmd>");
},120_000);
