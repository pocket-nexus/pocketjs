import { expect,test } from "bun:test";
import ts from "typescript";
import { readdirSync,readFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeModel } from "../microts/compiler/aot-model-frontend.ts";
import { emptyLedger,type ModelProgram,type ModelExpr } from "../microts/compiler/aot-model-ir.ts";
import { interpretModel } from "../microts/compiler/model-interp.ts";
import { assertModelObservations,executeModelJavaScript,executeModelRust,observeModelFrames,type ModelObservation } from "../microts/compiler/model-harness.ts";
import { generateModelCase,MODEL_FUZZ_SEEDS } from "../microts/compiler/model-fuzz.ts";

function walk(value:any,visit:(node:any)=>void):void{
  if(!value||typeof value!=="object")return;visit(value);
  for(const[key,child]of Object.entries(value))if(!["type","loc","ledger"].includes(key))Array.isArray(child)?child.forEach(value=>walk(value,visit)):walk(child,visit);
}
function transform(program:ModelProgram):ModelProgram{
  const changed=structuredClone(program),root=changed.modules.find(module=>module.kind==="root")!;
  let next=1;walk(changed,node=>{if(typeof node.id==="number")next=Math.max(next,node.id+1);});
  const calls=new Map<number,Set<number>>();
  for(const module of changed.modules)for(const fn of module.functions){const edges=new Set<number>();walk(fn.body,node=>{if(node.kind==="call"||node.kind==="invoke")edges.add(node.callee);if(node.kind==="start")edges.add(node.task);});calls.set(fn.id,edges);}
  const reachesRecursion=(id:number,path=new Set<number>()):boolean=>path.has(id)||[...(calls.get(id)??[])].some(child=>reachesRecursion(child,new Set([...path,id])));
  const recursive=new Set([...calls.keys()].filter(id=>reachesRecursion(id)));
  for(const module of changed.modules){
    for(const fn of [...module.functions]){
      const binders:any[]=[...fn.params];walk(fn.body,node=>{if(node.binder)binders.push(node.binder);});
      const outer=[...module.signals,...module.fields,...(module.constants??[])].map(value=>value.name);
      const shadow=outer.find(name=>!binders.some(binder=>binder.name===name));
      if(shadow&&binders.length)binders[0].name=shadow;
      if(!fn.async){
        // Copy only a view that is read locally and never escapes into a write or call.
        walk(fn.body,node=>{if(node.kind!=="let"||node.binder.owned||!["array","named"].includes(node.binder.type.kind))return;
          let escapes=false,expanded=true;const aliases=new Set([node.binder.id]);
          while(expanded){expanded=false;walk(fn.body,owner=>{if(owner.kind==="let"&&owner.init.kind==="local"&&aliases.has(owner.init.id)&&!["number","boolean","string"].includes(owner.binder.type.kind)&&!aliases.has(owner.binder.id)){aliases.add(owner.binder.id);expanded=true;}});}
          walk(fn.body,owner=>{if(["set","assign","call","invoke","start","return"].includes(owner.kind))walk(owner,value=>{if(value.kind==="local"&&aliases.has(value.id))escapes=true;});});
          if(!escapes){node.init={kind:"copy",value:node.init,type:node.init.type,ledger:node.init.ledger,loc:node.init.loc};node.binder.owned=true;delete node.binder.viewOf;}
        });
        fn.body={stmts:[{kind:"batch",body:fn.body}]};
        if(fn.exported&&fn.returns.kind==="void"&&!recursive.has(fn.id)){
          const parameters=fn.params.map(parameter=>({...parameter,id:next++}));
          const ids=new Map(fn.params.map((parameter,index)=>[parameter.id,parameters[index]!.id]));
          walk(fn.body,node=>{if(node.kind==="local"&&ids.has(node.id))node.id=ids.get(node.id);});
          const helper={...fn,id:next++,name:`lifted_${fn.name}`,exported:false,params:parameters};
          const loc=fn.loc??{file:module.file,line:1,column:1,offset:0};
          fn.body={stmts:[{kind:"call",callee:helper.id,args:fn.params.map(parameter=>({kind:"local",id:parameter.id,type:parameter.type,loc,ledger:emptyLedger()} as ModelExpr))}]};
          module.functions.push(helper);
        }
      }
    }
    for(const effect of module.effects)effect.declared=true;
  }
  const helpers=root.functions.filter(fn=>!fn.exported&&!fn.async&&!fn.ledger.external&&!fn.ledger.reads.length&&!fn.ledger.writes.length);
  if(helpers.length){root.functions=root.functions.filter(fn=>!helpers.includes(fn));changed.modules.push({name:"PureHelpers",file:"metamorphic-pure.ts",kind:"pure",params:[],signals:[],fields:[],memos:[],effects:[],functions:helpers,schedule:[],refs:[],tasks:[]});}
  return changed;
}
function reorder(program:ModelProgram):ModelProgram|undefined{
  const changed=structuredClone(program),module=changed.modules.find(module=>module.kind==="root")!;
  for(let index=0;index+1<module.schedule.length;index++){
    const left=module.effects.find(effect=>effect.id===module.schedule[index]),right=module.effects.find(effect=>effect.id===module.schedule[index+1]);
    if(!left||!right||left.ledger.external||right.ledger.external)continue;
    if(left.ledger.writes.some(id=>right.ledger.writes.includes(id)||right.ledger.reads.includes(id))||right.ledger.writes.some(id=>left.ledger.reads.includes(id)))continue;
    [module.schedule[index],module.schedule[index+1]]=[module.schedule[index+1]!,module.schedule[index]!];return changed;
  }
}
function explicitEffects(program:ModelProgram,entry:string,sources:Map<string,string>):ModelProgram|undefined{
  const module=program.modules.find(module=>module.kind==="root")!,source=sources.get(entry)!;
  const ast=ts.createSourceFile(entry,source,ts.ScriptTarget.Latest,true),edits:{start:number;end:number;text:string}[]=[];
  for(const effect of module.effects.filter(effect=>!effect.declared)){
    const find=(node:ts.Node):void=>{
      if(ts.isCallExpression(node)&&node.getStart(ast)===effect.loc?.offset&&ts.isIdentifier(node.expression)&&node.expression.text==="createEffect"){
        const callback=node.arguments[0]!;
        const names=effect.subscriptions.map(id=>[...module.signals,...module.memos].find(value=>value.id===id)!.name);
        edits.push({start:callback.getStart(ast),end:callback.end,text:`on([${names.join(",")}],${callback.getText(ast)})`});
      }
      ts.forEachChild(node,find);
    };find(ast);
  }
  if(!edits.length)return;
  let changed=source;for(const edit of edits.sort((a,b)=>b.start-a.start))changed=changed.slice(0,edit.start)+edit.text+changed.slice(edit.end);
  return analyzeModel(entry,{sources:new Map([...sources,[entry,changed]])});
}
const states=(frames:ModelObservation[])=>frames.map(frame=>({...frame,trace:[]}));
test("eligible source laws preserve traces, including state-only independent effect reordering",async()=>{
  const folder=resolve("tests/fixtures/aot-model/core");
  const fixtures=readdirSync(folder).sort().map(name=>{const entry=resolve(folder,name,"App.ts");return{name,entry,sources:new Map([[entry,readFileSync(entry,"utf8")]]),program:analyzeModel(entry),tape:JSON.parse(readFileSync(resolve(folder,name,"tape.json"),"utf8")),vue:name==="vue-watch"};});
  // CI runs the maintained corpus; generated seed variants remain local checks.
  if(!process.env.CI) for(const seed of [...MODEL_FUZZ_SEEDS,4]){const fixture=generateModelCase(seed,{weights:{task:0}});fixtures.push({name:`seed-${seed}`,entry:fixture.entry,sources:fixture.sources,program:analyzeModel(fixture.entry,{sources:fixture.sources}),tape:fixture.tape,vue:false});}
  const source='import{createSignal}from"solid-js";import type{i32}from"@pocketjs/framework/solid/std";export const[items,setItems]=createSignal<i32[]>([2,3]);export const[result,setResult]=createSignal<i32>(0);export function press(){const view=items();const n=view[0];setResult(n);}';
  fixtures.push({name:"read-only-copy",entry:resolve(folder,"virtual-copy/App.ts"),sources:new Map([[resolve(folder,"virtual-copy/App.ts"),source]]),program:analyzeModel(resolve(folder,"virtual-copy/App.ts"),{source}),tape:[{dispatch:[{fn:"press"}]}],vue:false});
  const independentSource=`import {createSignal} from "solid-js";
    import {createEffect,on} from "@pocketjs/framework/solid/reactive";
    export const [trigger,setTrigger]=createSignal(0);
    export const [left,setLeft]=createSignal(0); export const [right,setRight]=createSignal(0);
    createEffect(()=>{setLeft(trigger()+1);}); createEffect(()=>{setRight(trigger()+2);});
    export function press(){setTrigger(value=>value+1);}`;
  const independentEntry=resolve(folder,"virtual-independent/App.ts");
  fixtures.push({name:"independent-effects",entry:independentEntry,sources:new Map([[independentEntry,independentSource]]),program:analyzeModel(independentEntry,{source:independentSource}),tape:[{dispatch:[{fn:"press"}]}],vue:false});
  const variants=fixtures.flatMap(fixture=>{const ordered=reorder(fixture.program),declared=explicitEffects(fixture.program,fixture.entry,fixture.sources);return[{...fixture,name:`${fixture.name}-values`,program:transform(fixture.program),original:fixture.program,statesOnly:false},...(ordered?[{...fixture,name:`${fixture.name}-order`,program:ordered,original:fixture.program,statesOnly:true}]:[]),...(declared?[{...fixture,name:`${fixture.name}-declared`,program:declared,original:fixture.program,statesOnly:false}]:[])];});
  const native=await executeModelRust(variants);
  for(const fixture of variants){
    const expected=observeModelFrames(interpretModel(fixture.original,fixture.tape));
    const compare=(name:string,actual:ModelObservation[])=>assertModelObservations(`${fixture.name}: ${name}`,fixture.statesOnly?states(expected):expected,fixture.statesOnly?states(actual):actual,fixture.tape);
    compare("transformed interpreter",observeModelFrames(interpretModel(fixture.program,fixture.tape)));
    compare("transformed JavaScript",await executeModelJavaScript(fixture,fixture.vue));compare("transformed Rust",native.get(fixture.name)!);
  }
  expect(variants.some(fixture=>fixture.statesOnly)).toBe(true);
  expect(variants.some(fixture=>fixture.name.endsWith("-declared"))).toBe(true);
  expect(fixtures.length).toBeGreaterThanOrEqual(34);
},120_000);

test("f64 display uses the same decimal text at precision, exponent, subnormal and nonfinite boundaries",async()=>{
  const cases=[
    ["-0.0","0"],["1e-6","0.000001"],["1e-7","1e-7"],["1e20","100000000000000000000"],["1e21","1e+21"],
    ["9007199254740992.0","9007199254740992"],["9007199254740993.0","9007199254740992"],["9223372036854775808.0","9223372036854776000"],
    ["5e-324","5e-324"],["1.7976931348623157e308","1.7976931348623157e+308"],["0.0/0.0","NaN"],["1.0/0.0","Infinity"],["-1.0/0.0","-Infinity"],
  ];
  const fixtures=cases.map(([expression,text],index)=>({name:`f64-${index}`,text,program:analyzeModel(resolve("tests/fixtures/aot-model/numbers/App.ts"),{source:`import{createSignal}from"solid-js";export const[result,setResult]=createSignal("");export function press(){setResult(String(${expression}));}`}),tape:[{dispatch:[{fn:"press"}]}]}));
  const native=await executeModelRust(fixtures);
  for(const fixture of fixtures){const expected=observeModelFrames(interpretModel(fixture.program,fixture.tape));expect(expected[0]!.state.result).toBe(fixture.text);assertModelObservations(fixture.name,expected,await executeModelJavaScript(fixture),fixture.tape);assertModelObservations(fixture.name,expected,native.get(fixture.name)!,fixture.tape);}
},120_000);

test("equal signed-zero memo recomputation retains the cached primitive value",async()=>{
 const source=`import{createSignal}from"solid-js";import{createMemo}from"@pocketjs/framework/solid/reactive";import type{f64}from"@pocketjs/framework/solid/std";
 export const[trigger,setTrigger]=createSignal(false);export const zero=createMemo<f64>(()=>trigger()?-0.0:0.0);export const[result,setResult]=createSignal("");
 export function press(){setTrigger(true);setResult(String(1.0/zero()));}`;
 const fixture={name:"signed-zero",program:analyzeModel(resolve("tests/fixtures/aot-model/numbers/App.ts"),{source}),tape:[{dispatch:[{fn:"press"}]}]};
 const expected=observeModelFrames(interpretModel(fixture.program,fixture.tape));expect(expected[0]!.state.result).toBe("Infinity");expect(Object.is(expected[0]!.state.zero,0)).toBe(true);
 assertModelObservations(fixture.name,expected,await executeModelJavaScript(fixture),fixture.tape);const native=await executeModelRust([fixture]);assertModelObservations(fixture.name,expected,native.get(fixture.name)!,fixture.tape);
},120_000);
