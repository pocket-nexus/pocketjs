import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeAot } from "../microts/compiler/aot-build.ts";
import { AotCompileError } from "../microts/compiler/aot-ir.ts";
import { executeModelView } from "../microts/compiler/model-view-harness.ts";

function fixture(name:string,framework:"solid"|"vue-vapor",body:string){
  const directory=resolve(".pocket-build/validation/model-aot/private-fields",`${process.pid}-${name}-${framework}`);mkdirSync(directory,{recursive:true});
  writeFileSync(resolve(directory,"pocket.json"),JSON.stringify({app:{framework,aot:true,model:"compiled",entry:framework==="solid"?"App.tsx":"App.vue"}}));
  writeFileSync(resolve(directory,"App.ts"),'import type {i32} from "@pocketjs/framework/solid/std";\n'+body);
  writeFileSync(resolve(directory,framework==="solid"?"App.tsx":"App.vue"),framework==="solid"?'import {View,Text,ActionHandler} from "@pocketjs/framework/solid/components";import {BTN} from "@pocketjs/framework/input";import {read,press} from "./App";export default function App(){return <View><ActionHandler button={BTN.CROSS} onPress={press}/><Text>{read()}</Text></View>}':'<script setup lang="ts">import {View,Text,ActionHandler} from "@pocketjs/framework/vue-vapor/components";import {BTN} from "@pocketjs/framework/vue-vapor/input";import {read,press} from "./App";</script><template><View><ActionHandler :button="BTN.CROSS" @press="press()"/><Text>{{read()}}</Text></View></template>');
  return directory;
}

test("a private field read by the view updates after a model handler",async()=>{
  const directory=fixture("render","solid","let n:i32=0;export function read():i32{return n;}export function press():void{n+=1;}");
  writeFileSync(resolve(directory,"tape.json"),JSON.stringify([{buttons:16384},{buttons:0}]));
  const result=await executeModelView(directory);
  expect(result.javascript.frames).toEqual([{text:["1"],commands:[]},{text:["1"],commands:[]}]);
},120_000);

test.each(["solid","vue-vapor"] as const)("%s rejects writes or external commands in render binding functions",framework=>{
  for(const [name,body]of Object.entries({write:"let n:i32=0;export function read():i32{n+=1;return n;}export function press():void{}",external:'export function read():i32{console.log("render");return 1;}export function press():void{}'})){
    const directory=fixture(name,framework,body);
    try{analyzeAot(resolve(directory,framework==="solid"?"App.tsx":"App.vue"),{strict:true});throw new Error("accepted");}catch(error){expect(error).toBeInstanceOf(AotCompileError);expect(String(error)).toContain("view binding function read must be synchronous and pure");expect((error as AotCompileError).diagnostics[0]).toMatchObject({file:resolve(directory,"App.ts"),line:2});}
  }
  const directory=fixture("handler",framework,'let n:i32=0;export function read():i32{return n;}export function press():void{n+=1;console.log(n);}');
  expect(()=>analyzeAot(resolve(directory,framework==="solid"?"App.tsx":"App.vue"),{strict:true})).not.toThrow();
});
