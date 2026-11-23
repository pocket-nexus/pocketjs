import { expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeAot } from "../microts/compiler/aot-build.ts";
import { AotCompileError } from "../microts/compiler/aot-ir.ts";
import { executeModelView } from "../microts/compiler/model-view-harness.ts";
import { registerModelFixture } from "./app-fixtures.ts";

test.each(["view-frame","negative/04-region-reset"])("generated model and view %s preserve frame atomicity, dispatch memo reads, command order and remount reset", async name => {
  const fixture=resolve("tests/fixtures/aot-model",name);
  registerModelFixture(fixture);
  const expected=JSON.parse(readFileSync(resolve(fixture,"expected.json"),"utf8"));
  const {javascript,rust}=await executeModelView(fixture);
  expect(javascript.frames).toEqual(expected.frames??expected);
  expect(rust).toEqual(javascript);
},120_000);

// Issue #727's view: a compiled model counts presses down on onPress and up on
// onRelease, tests a CROSS+CIRCLE combination with the held mask and repeats a
// held CIRCLE. Both builds run the same tape at 60 Hz.
test("compiled models receive release, hold and the held mask from ActionHandler in both builds", async () => {
  const directory=resolve(".pocket-build/validation/model-aot/action-events",String(Date.now()));mkdirSync(directory,{recursive:true});
  const files={
    "App.ts":'import {createSignal} from "solid-js";import type {i32} from "@pocketjs/framework/solid/std";import {BTN} from "@pocketjs/framework/input";export const [presses,setPresses]=createSignal<i32>(0);export const [chords,setChords]=createSignal<i32>(0);export function down():void{setPresses(presses()+1);}export function up():void{setPresses(presses()-1);}export function chord(buttons:i32):void{if((buttons&BTN.CROSS)!==0)setChords(chords()+1);}export function repeat():void{console.log("repeat");}',
    "App.tsx":'import {ActionHandler,Text,View} from "@pocketjs/framework/solid/components";import {BTN} from "@pocketjs/framework/input";import {chord,chords,down,presses,repeat,up} from "./App";export default function App(){return <View class="w-full h-full p-4 bg-slate-100"><ActionHandler button={BTN.CROSS} onPress={() => down()} onRelease={() => up()} /><ActionHandler button={BTN.CIRCLE} holdMs={40} repeatMs={40} onPress={(pressed, buttons) => chord(buttons)} onHold={repeat} /><Text class="text-lg text-slate-900">{presses()}</Text><Text>{chords()}</Text></View>;}',
    "tape.json":JSON.stringify([16384,16384,24576,24576,24576,24576,24576,0,8192,0].map(buttons=>({buttons}))),
  };
  for(const[name,source]of Object.entries(files))writeFileSync(resolve(directory,name),source);
  registerModelFixture(directory);
  const {javascript}=await executeModelView(directory);
  expect(javascript.frames).toEqual([
    {text:["1","0"],commands:[]},{text:["1","0"],commands:[]},{text:["1","1"],commands:[]},{text:["1","1"],commands:[]},{text:["1","1"],commands:[]},
    {text:["1","1"],commands:["repeat"]},{text:["1","1"],commands:[]},{text:["0","1"],commands:[]},{text:["0","1"],commands:[]},{text:["0","1"],commands:[]},
  ]);
},120_000);

// A project is a directory under .pocket-build with a symbolic link beside it.
const lookup=resolve(".pocket-build/validation/model-source-lookup");
function project(name:string,files:Record<string,string>|string){
  const base=resolve(lookup,name),real=resolve(base,"real"),link=resolve(base,"link");
  rmSync(base,{recursive:true,force:true});mkdirSync(base,{recursive:true});
  if(typeof files==="string")cpSync(files,real,{recursive:true});
  else{mkdirSync(real);for(const [file,text] of Object.entries(files))writeFileSync(resolve(real,file),text);}
  symlinkSync(real,link,"dir");
  return {real,link};
}
const analysis=(entry:string)=>{const program=analyzeAot(entry,{strict:true});return JSON.stringify({program,model:program.model});};
const diagnostic=(run:()=>unknown)=>{try{run();}catch(error){if(error instanceof AotCompileError)return error.diagnostics[0]!;throw error;}throw new Error("accepted");};

test("a project reached through a symbolic link analyzes its root and factory models as from its real path", () => {
  const {real,link}=project("solid-link",resolve("tests/fixtures/aot-model/view-frame"));
  registerModelFixture(link);
  expect(analyzeAot(resolve(link,"App.tsx"),{strict:true}).model!.modules.map(module=>module.file).sort()).toEqual([resolve(link,"App.ts"),resolve(link,"Row.ts")]);
  expect(analysis(resolve(link,"App.tsx")).replaceAll(link,real)).toBe(analysis(resolve(real,"App.tsx")));
});

test("a Vue project reached through a symbolic link analyzes its model as from its real path", () => {
  const {real,link}=project("vue-link",{
    "App.vue":'<script setup lang="ts">import {View,Text} from "@pocketjs/framework/vue-vapor/components";import {n,read} from "./App";</script><template><View focusable @press="n=read()"><Text>{{n}}</Text></View></template>',
    "App.ts":'import {ref} from "vue";export const n=ref(0);export function read(){return n.value+1;}',
  });
  registerModelFixture(link,{framework:"vue-vapor",entry:"App.vue"});
  expect(analysis(resolve(link,"App.vue")).replaceAll(link,real)).toBe(analysis(resolve(real,"App.vue")));
});

test.each([
  ["solid","App.tsx",'import {View,Text} from "@pocketjs/framework/solid/components";export default function App(){return <View><Text>Hello</Text></View>}'],
  ["vue-vapor","App.vue",'<script setup lang="ts">import {View,Text} from "@pocketjs/framework/vue-vapor/components";</script><template><View><Text>Hello</Text></View></template>'],
])("%s: a root view that does not import its model is rejected at the view", (framework,view,source) => {
  const {real}=project(`unimported-${framework}`,{[view]:source,"App.ts":'import {createSignal} from "solid-js";export const [count,setCount]=createSignal(0);'});
  registerModelFixture(real,{framework,entry:view});
  expect(diagnostic(()=>analyzeAot(resolve(real,view),{strict:true}))).toMatchObject({file:resolve(real,view),line:1,column:1,message:`${view} does not import its model App.ts`});
});

// apps/hero: the root model holds contract types only, and the view imports them as types.
test.each([
  ["solid","App.tsx",'import {View,Text} from "@pocketjs/framework/solid/components";import type {AppProps} from "./App";export default function App(props:AppProps){return <View><Text>Hello</Text></View>}'],
  ["vue-vapor","App.vue",'<script setup lang="ts">import {View,Text} from "@pocketjs/framework/vue-vapor/components";import type {AppProps} from "./App";const props=defineProps<AppProps>();</script><template><View><Text>Hello</Text></View></template>'],
])("%s: a root view that imports only types from a type-only model compiles", (framework,view,source) => {
  const {real}=project(`type-only-${framework}`,{[view]:source,"App.ts":'export interface AppProps { label?: string }'});
  registerModelFixture(real,{framework,entry:view});
  const program=analyzeAot(resolve(real,view),{strict:true});
  expect(program.model!.modules.map(module=>[module.kind,module.file])).toEqual([["root",resolve(real,"App.ts")]]);
});

test("a compiled view without a basename model reports the missing module", () => {
  const {real}=project("no-model",{"App.tsx":'import {View,Text} from "@pocketjs/framework/solid/components";export default function App(){return <View><Text>Hello</Text></View>}'});
  registerModelFixture(real);
  expect(diagnostic(()=>analyzeAot(resolve(real,"App.tsx"),{strict:true}))).toMatchObject({file:resolve(real,"App.ts"),line:1,column:1,message:"model module does not exist"});
});

test("a factory module no view imports is rejected at the module", () => {
  const {real}=project("unimported-factory",{
    "App.tsx":'import {View,Text} from "@pocketjs/framework/solid/components";import {count} from "./App";import Row from "./Row.tsx";export default function App(){return <View><Text>{count()}</Text><Row/></View>}',
    "App.ts":'import {createSignal} from "solid-js";export const [count,setCount]=createSignal(0);export function createRow(){const [n,setN]=createSignal(0);return {n};}',
    "Row.tsx":'import {Text} from "@pocketjs/framework/solid/components";import {createRow} from "./App";export default function Row(){const {n}=createRow();return <Text>{n()}</Text>}',
    "Row.ts":'import {createSignal} from "solid-js";export function createRow(){const [n,setN]=createSignal(0);return {n};}',
  });
  registerModelFixture(real);
  expect(diagnostic(()=>analyzeAot(resolve(real,"App.tsx"),{strict:true}))).toMatchObject({file:resolve(real,"Row.ts"),line:1,column:1,message:"no view imports this model module, directly or through another module"});
});
