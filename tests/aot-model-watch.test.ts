import{expect,test}from"bun:test";
import{resolve}from"node:path";
import{analyzeModel}from"../microts/compiler/aot-model-frontend.ts";
import{interpretModel}from"../microts/compiler/model-interp.ts";
import{assertModelObservations,executeModelJavaScript,executeModelRust,observeModelFrames}from"../microts/compiler/model-harness.ts";

test("Vue watch previous values start at seeds, while immediate watch starts with None",async()=>{
 const fixtures=[false,true].map(immediate=>({name:immediate?"immediate":"deferred",program:analyzeModel(resolve("tests/fixtures/aot-model/watch/App.ts"),{source:`import{ref}from"vue";import{watch}from"@pocketjs/framework/vue-vapor/reactive";import type{i32}from"@pocketjs/framework/vue-vapor/std";
 export const n=ref<i32>(2);export const text=ref("");watch(n,(value,previous)=>{text.value=String(${immediate?"previous??-1":"previous"})+":"+String(value);}${immediate?",{immediate:true}":""});
 export function press(){n.value=3;n.value=4;}`}),tape:[{},{dispatch:[{fn:"press"}]},{},{dispatch:[{fn:"press"}]}],values:immediate?["-1:2","2:4","2:4","4:4"]:["","2:4","2:4","4:4"]}));
 const native=await executeModelRust(fixtures);
 for(const fixture of fixtures){const expected=observeModelFrames(interpretModel(fixture.program,fixture.tape));expect(expected.map(frame=>frame.state.text)).toEqual(fixture.values);assertModelObservations(fixture.name,expected,await executeModelJavaScript(fixture,true),fixture.tape);assertModelObservations(fixture.name,expected,native.get(fixture.name)!,fixture.tape);}
},120_000);
