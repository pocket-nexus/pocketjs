import { afterEach, expect, test } from "bun:test";
import "../framework/src/net-model.ts";
import { ModelRegion } from "../framework/src/model-reactive.ts";
import { ModelTasks, disposeModelTasks, drainModelCommands, resumeModelTasks } from "../framework/src/model-tasks.ts";
import { runServicePumps } from "../framework/src/services.ts";
import { type NetOps } from "../framework/src/net-api.ts";
import { createSimNetHost } from "../hosts/sim/net.ts";

const storage=<T>(value:T):[()=>T,(next:T)=>void]=>[()=>value,next=>{value=next;}];
const regions:ModelRegion[]=[];
function request(url:string){
  const region=new ModelRegion(storage);region.signal(1,"result",{kind:"waiting"},undefined,false);region.finish([]);regions.push(region);
  const tasks=new ModelTasks(region);tasks.resetClock();
  const task=tasks.start(1,[],(state,locals)=>state===0?{next:1,bind:2,suspend:{kind:"service",service:"@pocketjs/framework/net/model",call:"get",args:[url]}}:(region.write(1,locals[2]),{done:true}));
  drainModelCommands();return {region,tasks,task};
}
afterEach(()=>{for(const region of regions.splice(0)){disposeModelTasks(region);region.dispose();}drainModelCommands();delete (globalThis as {net?:NetOps}).net;});

test("a model resumes in the same boundary that the net host completion is polled",()=>{
  const host=createSimNetHost({"https://example.test/model":{status:200,body:"same-frame",delayTicks:3}});
  (globalThis as {net?:NetOps}).net=host.ns;const {region,task}=request("https://example.test/model");
  for(let frame=1;frame<3;frame++){host.tick();runServicePumps();resumeModelTasks(frame,frame*16);expect(region.read(1)).toEqual({kind:"waiting"});}
  host.tick();runServicePumps();expect(region.read(1)).toEqual({kind:"waiting"});
  // No Promise/microtask yield between polling and this frame's resume phase.
  resumeModelTasks(3,48);
  expect(task.status).toBe("done");expect(region.read(1)).toEqual({kind:"ok",status:200,body:"same-frame"});
  const polls=host.pollCalls();runServicePumps();expect(host.pollCalls()).toBe(polls);
});

test("model cancellation releases the actual net handle and cannot deliver a late result",()=>{
  const host=createSimNetHost({"https://example.test/cancel":{body:"late",delayTicks:2}});
  (globalThis as {net?:NetOps}).net=host.ns;const {region,tasks,task}=request("https://example.test/cancel");
  tasks.cancel(1);drainModelCommands();expect(host.log.filter(line=>line.startsWith("cancel "))).toHaveLength(1);
  host.tick();host.tick();runServicePumps();resumeModelTasks(2,32);
  expect(task.status).toBe("cancelled");expect(region.read(1)).toEqual({kind:"waiting"});expect(host.log.some(line=>line.startsWith("take "))).toBe(false);
});

test("malformed transport results become malformed at that boundary",()=>{
  let polled=false,takes=0,cancels=0;
  (globalThis as {net?:NetOps}).net={start:()=>42,take:()=>{takes++;return 0;},cancel:()=>{cancels++;},lastError:()=>"",poll:()=>{if(polled)return;polled=true;return JSON.stringify([{t:"done",h:42,status:999,url:"https://example.test/bad",headers:{},bytes:0}]);}};
  const {region}=request("https://example.test/bad");runServicePumps();resumeModelTasks(1,16);
  expect(region.read(1)).toEqual({kind:"malformed"});expect(takes).toBe(0);expect(cancels).toBe(1);
});
