import { expect,test } from "bun:test";
import { resolve } from "node:path";
import { analyzeModel } from "../microts/compiler/aot-model-frontend.ts";
import { interpretModel } from "../microts/compiler/model-interp.ts";
import { assertModelObservations,executeModelJavaScript,executeModelRust,observeModelFrames } from "../microts/compiler/model-harness.ts";

const prelude=`import{createSignal}from"solid-js";import{createMemo,createEffect,on}from"@pocketjs/framework/solid/reactive";import type{i32,Px,Ms,Deg,Color}from"@pocketjs/framework/solid/std";`;
const cases=[
 {name:"enum",source:`type Mode="off"|"on";export const[mode,setMode]=createSignal<Mode>("off");export const[runs,setRuns]=createSignal<i32>(0);createEffect(on([mode],()=>setRuns(v=>v+1),{defer:true}));export function press(){setMode("off");setMode("on");setMode("on");}`,state:{mode:"on",runs:1},cell:"mode",changes:[false,true,false]},
 {name:"color",source:`export const[color,setColor]=createSignal<Color>("#fff");export const[text,setText]=createSignal("");export function press(){setColor("#ffffff");setColor("#fff");setText(String(color()));}`,state:{color:"#ffffffff",text:"#ffffffff"},cell:"color",changes:[false,false]},
 {name:"units",source:`export const[x,setX]=createSignal<Px>(0.1);export const[delay,setDelay]=createSignal<Ms>(10);export const[angle,setAngle]=createSignal<Deg>(90);export const[text,setText]=createSignal("");export function press(){setX(x()+(0.2 as Px));setDelay(delay()+(5 as Ms));setAngle(angle()+(5 as Deg));setText(String(x()));}`,state:{x:0.30000001192092896,delay:15,angle:95,text:"0.30000001192092896"},cell:"x",changes:[true]},
 {name:"unit-rounding",source:`export const[x,setX]=createSignal<Px>(16777216);export function press(){setX(x()+(1 as Px));}`,state:{x:16777216},cell:"x",changes:[false]},
 {name:"option",source:`export const[maybe,setMaybe]=createSignal<i32|undefined>(undefined);export const[runs,setRuns]=createSignal<i32>(0);createEffect(on([maybe],()=>setRuns(v=>v+1),{defer:true}));export function press(){setMaybe(1);setMaybe(1);const view=maybe();setMaybe(view);setMaybe(undefined);setMaybe(undefined);}`,state:{maybe:null,runs:1},cell:"maybe",changes:[true,true,false,true,true]},
 {name:"option-memo",source:`export const[trigger,setTrigger]=createSignal<i32>(0);export const optional=createMemo<i32|undefined>(()=>trigger()>0?undefined:undefined);export const[runs,setRuns]=createSignal<i32>(0);createEffect(on([optional],()=>setRuns(v=>v+1),{defer:true}));export function press(){setTrigger(1);}`,state:{trigger:1,optional:null,runs:1},cell:"trigger",changes:[true]},
];
test("enum, Color, unit numbers and Option preserve their static change rules on all classes",async()=>{
 const fixtures=cases.map(row=>({...row,program:analyzeModel(resolve("tests/fixtures/aot-model/scalars/App.ts"),{source:prelude+row.source}),tape:[{dispatch:[{fn:"press"}]},{}]}));
 const native=await executeModelRust(fixtures);
 for(const fixture of fixtures){const expected=observeModelFrames(interpretModel(fixture.program,fixture.tape));expect(expected[0]!.state).toEqual(fixture.state);expect(expected[0]!.trace.filter(event=>event.kind==="set"&&event.name===fixture.cell).map(event=>event.changed)).toEqual(fixture.changes);assertModelObservations(fixture.name,expected,await executeModelJavaScript(fixture),fixture.tape);assertModelObservations(fixture.name,expected,native.get(fixture.name)!,fixture.tape);}
},120_000);
