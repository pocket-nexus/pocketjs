import { expect,test } from "bun:test";
import { resolve } from "node:path";
import { analyzeModel } from "../microts/compiler/aot-model-frontend.ts";
import { interpretModel } from "../microts/compiler/model-interp.ts";
import { assertModelObservations, executeModelJavaScript, executeModelRust, observeModelFrames } from "../microts/compiler/model-harness.ts";

test("aggregate wait arguments observe an earlier child segment's writes in source order",async()=>{
  const fixtures=["count()","read()"].map((argument,index)=>{
    const source=`import {createSignal} from "solid-js";import {frames,after,all,type i32} from "@pocketjs/framework/solid/std";
    export const [count,setCount]=createSignal<i32>(5);export const [result,setResult]=createSignal<i32>(0);
    function read():i32{return count();}
    async function child():Promise<void>{setCount(100);await frames(1);}
    export async function press():Promise<void>{await all([child(),after(${argument})]);setResult(count());}`;
    return {name:`order-${index}`,program:analyzeModel(resolve(`tests/fixtures/aot-model/await-order/App.ts`),{source}),tape:[{clock:0,dispatch:[{fn:"press"}]},{clock:50},{clock:75},{clock:100}]};
  });
  const native=await executeModelRust(fixtures);
  for(const fixture of fixtures){const expected=observeModelFrames(interpretModel(fixture.program,fixture.tape));
    expect(expected.map(frame=>frame.state.result)).toEqual([0,0,0,100]);
    assertModelObservations(fixture.name,expected,await executeModelJavaScript(fixture),fixture.tape);
    assertModelObservations(fixture.name,expected,native.get(fixture.name)!,fixture.tape);
  }
},120_000);


test("restarting an awaited child during wait construction cancels the parent in that segment",async()=>{
  const source=`import{createSignal}from"solid-js";import{frames,all,cancel,type i32}from"@pocketjs/framework/solid/std";
    export const[n,setN]=createSignal<i32>(0);async function child():Promise<void>{setN(v=>v+1);await frames(2);}
    async function parent():Promise<void>{await all([child(),child()]);setN(99);}
    export function press():void{parent();cancel(parent);}`;
  const fixture={name:"cancel-register",program:analyzeModel(resolve("tests/fixtures/aot-model/await-order/App.ts"),{source}),tape:[{dispatch:[{fn:"press"}]},{},{},{}]};
  const expected=observeModelFrames(interpretModel(fixture.program,fixture.tape));
  const parent=fixture.program.modules[0]!.functions.find(fn=>fn.name==="parent")!;
  expect(expected[0]!.trace.filter(event=>event.kind==="task-cancel"&&event.task.fn===parent.id)).toMatchObject([{reason:"awaited task cancelled"}]);
  expect(expected.map(frame=>frame.state.n)).toEqual([2,2,2,2]);
  assertModelObservations(fixture.name,expected,await executeModelJavaScript(fixture),fixture.tape);
  const native=await executeModelRust([fixture]);assertModelObservations(fixture.name,expected,native.get(fixture.name)!,fixture.tape);
},120_000);

test("inclusive coroutine loops stop at i32 MAX before the induction variable wraps",async()=>{
  const source=`import{createSignal}from"solid-js";import{frames,type i32}from"@pocketjs/framework/solid/std";
  export const[n,setN]=createSignal<i32>(0);export async function press():Promise<void>{for(let i=2147483647;i<=2147483647;i++){await frames(1);setN(v=>v+1);}}`;
  const fixture={name:"inclusive-max",program:analyzeModel(resolve("tests/fixtures/aot-model/await-order/App.ts"),{source}),tape:[{dispatch:[{fn:"press"}]},{},{},{}]};
  const expected=observeModelFrames(interpretModel(fixture.program,fixture.tape));expect(expected.map(frame=>frame.state.n)).toEqual([0,1,1,1]);
  assertModelObservations(fixture.name,expected,await executeModelJavaScript(fixture),fixture.tape);
  const native=await executeModelRust([fixture]);assertModelObservations(fixture.name,expected,native.get(fixture.name)!,fixture.tape);
},120_000);

test("until predicates retain captured locals while waiting without hoisting dead locals or predicate temporaries", async () => {
  const fixtures = ["count() > limit", "above(limit)"].map((predicate, index) => {
    const source = `import {createSignal} from "solid-js";
      import {until,type i32} from "@pocketjs/framework/solid/std";
      export const [count,setCount]=createSignal<i32>(5);
      export const [done,setDone]=createSignal<i32>(0);
      function above(value:i32):boolean{return count()>value;}
      export function raise():void{setCount(value=>value+1);}
      export async function waitForChange():Promise<void>{
        const unused=count()+99;
        const limit=count();
        await until(()=>${predicate});
        setDone(1);
      }`;
    return {name:`until-capture-${index}`,program:analyzeModel(resolve("tests/fixtures/aot-model/await-order/App.ts"),{source}),tape:[{dispatch:[{fn:"waitForChange"}]},{},{dispatch:[{fn:"raise"}]},{}]};
  });
  const native=await executeModelRust(fixtures);
  for(const fixture of fixtures){
    const task=fixture.program.modules[0]!.tasks[0]!;
    expect(task.fields.map(field=>field.name)).toEqual(["limit"]);
    const expected=observeModelFrames(interpretModel(fixture.program,fixture.tape));
    expect(expected.map(frame=>frame.state.done)).toEqual([0,0,0,1]);
    assertModelObservations(fixture.name,expected,await executeModelJavaScript(fixture),fixture.tape);
    assertModelObservations(fixture.name,expected,native.get(fixture.name)!,fixture.tape);
  }
},120_000);
