import { expect,test } from "bun:test";
import { resolve } from "node:path";
import { analyzeModel } from "../microts/compiler/aot-model-frontend.ts";
import { interpretModel } from "../microts/compiler/model-interp.ts";
import { assertModelObservations, executeModelJavaScript, executeModelRust, observeModelFrames } from "../microts/compiler/model-harness.ts";

const prelude='import {createSignal} from "solid-js";import {len,map,filter,type i32,type Cap} from "@pocketjs/framework/solid/std";';
const cases=[
 {name:"local-array",source:'export const [result,setResult]=createSignal<i32>(0);export function press(){const values:Cap<i32[],1>=[1,2];setResult(len(values));}',expected:1},
 {name:"struct-string",source:'interface Row{label:Cap<string,4>}export const[result,setResult]=createSignal("");export function press(){const row:Row={label:"é雪"};setResult(row.label);}',expected:"é"},
 {name:"map-array",source:'export const [rows,setRows]=createSignal<Cap<i32[],2>>([]);export const [result,setResult]=createSignal<i32>(0);export function press(){const values:i32[]=[1,2,3];setRows(map(values,value=>value));setResult(len(rows()));}',expected:2},
 {name:"filter-array",source:'export const [rows,setRows]=createSignal<Cap<i32[],2>>([]);export const [result,setResult]=createSignal<i32>(0);export function press(){const values:i32[]=[1,2,3];setRows(filter(values,value=>value>0));setResult(len(rows()));}',expected:2},
];
test("local and nested contract capacities trap in development and truncate in release",async()=>{
 const fixtures=cases.map(row=>({...row,program:analyzeModel(resolve("tests/fixtures/aot-model/capacity/App.ts"),{source:prelude+row.source}),tape:[{dispatch:[{fn:"press"}]}]}));
 for(const fixture of fixtures){expect(()=>interpretModel(fixture.program,fixture.tape)).toThrow(/capacity/i);await expect(executeModelJavaScript(fixture)).rejects.toThrow(/capacity/i);}
 const release=fixtures.map(fixture=>({...fixture,development:false}));const native=await executeModelRust(release,{release:true});
 for(const fixture of release){const expected=observeModelFrames(interpretModel(fixture.program,fixture.tape,{development:false}));expect(expected[0]!.state.result).toBe(fixture.expected);assertModelObservations(fixture.name,expected,await executeModelJavaScript(fixture),fixture.tape);assertModelObservations(fixture.name,expected,native.get(fixture.name)!,fixture.tape);}
},120_000);
