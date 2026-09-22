import { afterEach, beforeEach, expect, test } from "bun:test";
import { resetClock } from "../framework/src/clock.ts";
import { ModelRegion } from "../framework/src/model-reactive.ts";
import { ModelTasks, resumeModelTasks, registerModelService as installModelService, deliverModelResult, drainModelCommands, disposeModelTasks, registerModelCommandHandler as installModelCommandHandler, resetModelTaskClock } from "../framework/src/model-tasks.ts";
const storage = <T>(value: T): [() => T, (next: T) => void] => [() => value, next => { value = next; }];
const regions: ModelRegion[] = [];
const registrations: (() => void)[] = [];
function setup(development = true) { const region = new ModelRegion(storage, development); regions.push(region); region.signal(1,"n",0); region.finish([]); return { region, tasks: new ModelTasks(region) }; }
function registerModelService(...args: Parameters<typeof installModelService>) {
  const unregister = installModelService(...args); registrations.push(unregister); return unregister;
}
function registerModelCommandHandler(...args: Parameters<typeof installModelCommandHandler>) {
  const unregister = installModelCommandHandler(...args); registrations.push(unregister); return unregister;
}
beforeEach(() => {
  // Each test drives a fresh application from boundary 1, even after view tests.
  resetClock();
  resetModelTaskClock();
});
afterEach(() => {
  for (const region of regions.splice(0)) { disposeModelTasks(region); region.dispose(); }
  // Deliver queued cancellations while the owning test's host is installed.
  drainModelCommands();
  for (const unregister of registrations.splice(0).reverse()) unregister();
  resetClock();
  resetModelTaskClock();
});

test("JS all latches an until member before another member completes", () => {
  const { region, tasks } = setup(); let predicate = true;
  tasks.start(1, [], state => state === 0 ? { next: 1, suspend: { kind: "all", members: [{ kind: "until", predicate: () => predicate }, { kind: "frames", count: 2 }] } } : (region.write(1, 1), { done: true }));
  resumeModelTasks(1, 16); predicate = false; resumeModelTasks(2, 32);
  expect(region.read(1)).toBe(1); region.dispose();
});

test("JS cancelled queued service requests retain their issued command and drop late results", () => {
  const { region, tasks } = setup(); const calls: unknown[] = []; let cancelled = 0;
  const unregister = registerModelService("queued", { capacity: 1, available: () => true, validate: () => true, request: (call,args,id,deliver) => {
    calls.push({call,args,id}); deliver({kind:"ok"}); return () => { cancelled++; };
  } });
  const args = ["original"];
  const task = tasks.start(1, [], state => state === 0 ? { next: 1, suspend: { kind: "service", service: "queued", call: "get", args } } : (region.write(1,9),{done:true}));
  args[0] = "changed";
  expect(calls).toHaveLength(0); tasks.cancel(1); expect(cancelled).toBe(0); drainModelCommands();
  expect(calls).toMatchObject([{call:"get",args:["original"]}]); expect(cancelled).toBe(1); expect(task.status).toBe("cancelled");
  resumeModelTasks(1,16); expect(region.read(1)).toBe(0); expect(region.trace.filter(event=>event.kind==="delivery-drop")).toHaveLength(1);
  region.dispose(); disposeModelTasks(region); unregister();
});

test("JS nested service members reserve capacity and completion does not cancel host", () => {
  const { region, tasks } = setup(); const calls: unknown[] = []; let cancelled = 0;
  registerModelService("bounded", { capacity: 1, available: () => true, validate: () => true, request: (_call, _args, id) => { calls.push(id); return () => { cancelled++; }; } });
  tasks.start(1, [], state => state === 0 ? { next: 1, bind: 1, suspend: { kind: "all", members: [{ kind: "service", service: "bounded", call: "get", args: [] }, { kind: "service", service: "bounded", call: "get", args: [] }] } } : { done: true });
  drainModelCommands(); expect(calls).toHaveLength(1);
  const id = calls[0] as any; deliverModelResult(id, { kind: "ok" }); resumeModelTasks(1,16);
  expect(cancelled).toBe(0); expect(region.trace.filter(x => x.kind === "request")).toHaveLength(1);
  expect(region.trace.filter(x => x.kind === "wait").map(x => (x.request as any).member)).toEqual([0,1]); region.dispose();
});

test("JS bare join cancellation propagates at cancellation and wrapped join continues next boundary", () => {
  const { region, tasks } = setup();
  const child = tasks.start(1, [], () => ({ next: 1, suspend: { kind: "frames", count: 8 } }));
  const bare = tasks.start(2, [], state => state === 0 ? { next: 1, suspend: { kind: "join", task: child, wrapped: false } } : { done: true });
  const wrapped = tasks.start(3, [], state => state === 0 ? { next: 1, suspend: { kind: "join", task: child, wrapped: true } } : (region.write(1, 1), { done: true }));
  tasks.cancel(1); expect(bare.status).toBe("cancelled"); expect(wrapped.status).toBe("live"); resumeModelTasks(1,16);
  expect(wrapped.status).toBe("done"); expect(region.read(1)).toBe(1); region.dispose();
});

test("JS late any delivery is dropped while its task has another live wait", () => {
  const { region, tasks } = setup(); let request: any;
  registerModelService("late", { capacity: 1, available: () => true, validate: () => true, request: (_call, _args, id) => { request = id; } });
  tasks.start(1, [], state => state === 0 ? { next: 1, suspend: { kind: "any", members: [{ kind: "service", service: "late", call: "get", args: [] }, { kind: "frames", count: 1 }] } } : { next: 2, suspend: { kind: "frames", count: 8 } });
  drainModelCommands(); resumeModelTasks(1,16); deliverModelResult(request, { kind: "ok" }); resumeModelTasks(2,32);
  expect(region.trace.some(x => x.kind === "delivery-drop")).toBe(true); region.dispose();
});


test("JS region disposal queues host cancellation without waiting for another frame", () => {
  const { region, tasks } = setup(); let cancelled = 0;
  registerModelService("dispose", { capacity: 1, available: () => true, validate: () => true, request: () => () => { cancelled++; } });
  const task = tasks.start(1, [], () => ({ next: 1, suspend: { kind: "service", service: "dispose", call: "get", args: [] } }));
  drainModelCommands(); disposeModelTasks(region);
  expect(task.status).toBe("cancelled"); expect(cancelled).toBe(0); drainModelCommands(); expect(cancelled).toBe(1);
  expect(region.trace.filter(event => event.kind === "task-cancel")).toMatchObject([{ reason: "unmount" }]);
  disposeModelTasks(region); expect(cancelled).toBe(1); region.dispose();
});


test("JS external commands reach host only when the post-update queue drains", () => {
  const { region, tasks } = setup(); const calls: unknown[] = [];
  registerModelCommandHandler((owner, op, args) => { calls.push({ owner, op, args }); });
  const values = [1]; tasks.command("log", [values]); values[0] = 9;
  expect(calls).toEqual([]); expect(region.trace.at(-1)).toMatchObject({ kind: "command", op: "log", args: [[1]] });
  drainModelCommands(); expect(calls).toEqual([{ owner: region, op: "log", args: [[1]] }]);
  region.dispose(); disposeModelTasks(region);
});

test("JS awaited animation queues the command and cancellation removes only result interest", () => {
  const { region, tasks } = setup(); let started = 0, detached = 0;
  registerModelCommandHandler((_owner, op, _args, request) => { expect(op).toBe("animate"); expect(request).toBeDefined(); started++; return () => { detached++; }; });
  tasks.start(1, [], () => ({ next: 1, suspend: {kind:"animate",args:[3,{x:4}]} }));
  tasks.cancel(1); expect(started).toBe(0); drainModelCommands();
  expect(started).toBe(1); expect(detached).toBe(1);
  region.dispose(); disposeModelTasks(region);
});

test("JS release mode excludes logging commands", () => {
  const { region, tasks } = setup(false); let calls = 0;
  registerModelCommandHandler(() => { calls++; }); tasks.command("log", [1]); drainModelCommands();
  expect(calls).toBe(0); expect(region.trace).toEqual([]); region.dispose(); disposeModelTasks(region);
});


test("JS newly mounted task region starts waits from the current frame boundary", () => {
  const parent = setup(); resumeModelTasks(100, 1_600);
  const child = setup();
  const task = child.tasks.start(1, [], state => state === 0 ? { next: 1, suspend: {kind:"all",members:[{kind:"frames",count:2},{kind:"after",ms:30}]} } : {done:true});
  resumeModelTasks(101,1_616); expect(task.status).toBe("live");
  resumeModelTasks(102,1_632); expect(task.status).toBe("done");
  for (const {region} of [parent,child]) { region.dispose(); disposeModelTasks(region); }
});


test("JS nested any releases losing service while its enclosing all remains pending", () => {
  const { region, tasks } = setup(); let request: any, cancelled = 0;
  registerModelService("nested", {capacity:1,available:()=>true,validate:()=>true,request:(_call,_args,id)=>{request=id;return()=>{cancelled++;};}});
  const task = tasks.start(1, [], state => state===0 ? {next:1,suspend:{kind:"all",members:[{kind:"any",members:[{kind:"frames",count:1},{kind:"service",service:"nested",call:"get",args:[]}]},{kind:"frames",count:4}]}} : {done:true});
  drainModelCommands(); resumeModelTasks(1,16);
  expect(task.status).toBe("live"); expect(cancelled).toBe(0); drainModelCommands(); expect(cancelled).toBe(1);
  deliverModelResult(request,{kind:"ok"}); resumeModelTasks(2,32);
  expect(region.trace.filter(event=>event.kind==="delivery-drop")).toHaveLength(1);
  resumeModelTasks(4,64); expect(task.status).toBe("done"); expect(cancelled).toBe(1);
  region.dispose(); disposeModelTasks(region);
});


for (const alreadyIssued of [false,true]) test(`JS request, intervening log and cancellation drain in order: host request already issued=${alreadyIssued}`, () => {
  const {region,tasks}=setup(); const issued:string[]=[];
  const unregister=registerModelService("ordered",{capacity:1,available:()=>true,validate:()=>true,request:()=>{issued.push("request");return()=>{issued.push("cancel");};}});
  const restore=registerModelCommandHandler((_region,op)=>{issued.push(op);});
  tasks.start(1,[],()=>({next:1,suspend:{kind:"service",service:"ordered",call:"get",args:[]}}));
  if(alreadyIssued)drainModelCommands();
  tasks.command("log",["between"]);tasks.cancel(1);
  expect(issued).toEqual(alreadyIssued?["request"]:[]);
  drainModelCommands();expect(issued).toEqual(["request","log","cancel"]);
  region.dispose();disposeModelTasks(region);unregister();restore();
});

test("JS restarting a task preserves the first request before its cancellation and replacement",()=>{
  const {region,tasks}=setup(); const issued:string[]=[];
  const unregister=registerModelService("restart-ordered",{capacity:1,available:()=>true,validate:()=>true,request:(_call,_args,id)=>{issued.push(`request:${id.task.call}`);return()=>{issued.push(`cancel:${id.task.call}`);};}});
  const step=()=>({next:1,suspend:{kind:"service" as const,service:"restart-ordered",call:"get",args:[]}});
  tasks.start(1,[],step);tasks.start(1,[],step);drainModelCommands();
  expect(issued).toEqual(["request:1","cancel:1","request:2"]);
  region.dispose();disposeModelTasks(region);drainModelCommands();unregister();
});

test("JS animation result detachment keeps its position after intervening commands",()=>{
  const {region,tasks}=setup();const issued:string[]=[];
  const restore=registerModelCommandHandler((_region,op)=>{issued.push(op);return op==="animate"?()=>{issued.push("detach");}:undefined;});
  tasks.start(1,[],()=>({next:1,suspend:{kind:"animate",args:[3,{x:4}]}}));
  tasks.command("log",["between"]);tasks.cancel(1);expect(issued).toEqual([]);drainModelCommands();
  expect(issued).toEqual(["animate","log","detach"]);
  region.dispose();disposeModelTasks(region);restore();
});
