import { expect, test } from "bun:test";
import { createWasmUi, createWasmUiSync, contactFacts } from "../platforms/web/wasm-ops.js";
import { POCKET_BINDING_GENERATION } from "../engine/guest-web/src/generated-ui.js";
import { PROP, abgr } from "../contracts/spec/spec.ts";

const module = WebAssembly.compile(await Bun.file(new URL("../platforms/web/pocketjs.wasm",import.meta.url)).arrayBuffer());
const make = async (options = {}) => createWasmUi(await module,{width:32,height:24,...options});
const source = `const n=ui.createNode(0);ui.insertBefore(1,n,0);ui.setProp(n,${PROP.width},12);ui.setProp(n,${PROP.height},10);ui.setProp(n,${PROP.bgColor},${abgr(240,20,40)});globalThis.frame=(...args)=>{globalThis.lastFrame=args;globalThis.calls=(globalThis.calls||0)+1;};`;
function evaluator(realm: Record<string,any>) {return (code:string)=>new Function("globalThis","ui",code)(realm,realm.ui);}

test("binding generation rejects before Wasm creation or guest boot side effects",async()=>{
  const rejected=[...Array.from({length:12},(_,i)=>i),POCKET_BINDING_GENERATION+1,0xffffffff];
  for(const hostAbi of rejected){
    expect(()=>createWasmUiSync(new Uint8Array(),{hostAbi})).toThrow("Unsupported UI binding generation");
    await expect(createWasmUi(new Uint8Array(),{hostAbi})).rejects.toThrow("Unsupported UI binding generation");
  }
  const wasm=await make(),realm:Record<string,any>={};let evaluations=0;
  const retained=wasm.ops.createNode;
  for(const hostAbi of rejected){
    expect(()=>wasm.boot("",{hostAbi,global:realm,evaluate(){evaluations++;}})).toThrow("Unsupported UI binding generation");
    expect(wasm.ops.createNode).toBe(retained);
    expect(wasm.booted).toBe(false);expect(wasm.disposed).toBe(false);
    expect(Reflect.ownKeys(realm)).toEqual([]);
  }
  await expect(wasm.bootAsync("",{hostAbi:0,global:realm})).rejects.toThrow("Unsupported UI binding generation");
  expect(wasm.disposed).toBe(false);expect(evaluations).toBe(0);expect(retained(0)).toBeGreaterThan(0);
  const aux=wasm.createAuxiliarySurface(8,6);expect(aux).toBeGreaterThan(0);
  wasm.boot(source,{hostAbi:POCKET_BINDING_GENERATION,global:realm,evaluate:evaluator(realm)});
  expect(wasm.ops.__hostAbi).toBe(POCKET_BINDING_GENERATION);wasm.advance();wasm.present();wasm.dispose();
});

test("full browser Runtime owns boot, facts, DOWN capture, and terminal presentation",async()=>{
  const wasm=await make(),realm:Record<string,any>={};
  wasm.boot(source,{global:realm,evaluate:evaluator(realm)});
  const retained=wasm.ops.createNode;
  expect(wasm.booted).toBe(true); expect(()=>wasm.tick()).toThrow("InvalidState");
  const first=wasm.present().slice();expect([...first.slice(0,4)]).toEqual([240,20,40,255]);
  const id=wasm.ops.hitTestBounds!(3,3);
  wasm.advance({buttons:17,analog:0x4020,rightAnalog:0x9070,contacts:[{surface:0,id:77,x:3,y:3}],axisDeltas:[{axis:9,delta:-30}]},2);
  expect(realm.lastFrame[0]).toBe(17);expect(realm.lastFrame[1]).toBe(0x4020);expect(realm.lastFrame[5]).toBe(0x9070);expect(realm.lastFrame[3]).toEqual([id]);expect(realm.calls).toBe(1);expect(realm.lastFrame[6]).toEqual([{axis:9,delta:-30}]);
  wasm.ops.setProp(id,PROP.width,1);
  wasm.present();
  wasm.advance({contacts:[{surface:0,id:77,x:20,y:20}]});expect(realm.lastFrame[3]).toEqual([id]);
  wasm.present();wasm.advance({contacts:[]});wasm.present();wasm.advance({contacts:[{surface:0,id:77,x:20,y:20}]});expect(realm.lastFrame[3]).toEqual([wasm.ops.hitTestBounds!(20,20)]);
  wasm.dispose();expect(()=>retained(0)).toThrow("shut down");expect(()=>wasm.render()).toThrow("disposed");
});

test("instances keep independent runtime, buffers and auxiliary viewports through resize",async()=>{
  const a=await make({auxiliary:[8,6]}),b=await make();const ra:Record<string,any>={},rb:Record<string,any>={};
  a.boot(source,{global:ra,evaluate:evaluator(ra)});b.boot("globalThis.frame=()=>{}",{global:rb,evaluate:evaluator(rb)});
  const aux=a.ops.__auxiliarySurface!;const n=a.ops.createNode(0);a.ops.insertBefore(aux.root,n,0);a.ops.setProp(n,PROP.width,4);a.ops.setProp(n,PROP.height,4);a.ops.setProp(n,PROP.bgColor,abgr(0,255,0));
  a.advance();b.advance();expect([...a.present().slice(0,4)]).toEqual([240,20,40,255]);expect([...b.present().slice(0,4)]).toEqual([0,0,0,255]);
  expect([...a.renderAuxiliary().slice(0,4)]).toEqual([0,255,0,255]);
  a.resizeViewport(40,30);expect(a.ops.__viewport).toEqual({w:40,h:30});expect(a.present().length).toBe(40*30*4);expect(b.present().length).toBe(32*24*4);expect(a.renderAuxiliary().length).toBe(8*6*4);
  expect(()=>a.resizeViewport(32000,32000)).toThrow();expect(a.ops.__viewport).toEqual({w:40,h:30});a.dispose();b.dispose();
});

test("guest callbacks cannot reenter lifecycle and failed frames retain shutdown ownership",async()=>{
  const wasm=await make(),realm:Record<string,any>={};let attempts=0;
  wasm.boot(source,{global:realm,evaluate:evaluator(realm),beforeFrame(){for(const f of [()=>wasm.dispose(),()=>wasm.init(),()=>wasm.advance()]){expect(f).toThrow("guest callback");attempts++;}}});
  wasm.advance();expect(attempts).toBe(3);wasm.present();
  realm.frame=()=>{throw new Error("guest failed")};expect(()=>wasm.advance()).toThrow("guest failed");expect(()=>wasm.advance()).toThrow("InvalidState");wasm.init();wasm.boot("globalThis.frame=()=>{}",{global:realm,evaluate:evaluator(realm)});wasm.advance();wasm.present();wasm.dispose();
});

test("canonical generated argument transport survives allocation growth and copies byte results",async()=>{
  const wasm=await make();const n=wasm.ops.createNode(1);wasm.ops.setText(n,"😀a\ud800");expect(wasm.inspectNode(n)?.text).toBe("😀a���");
  const source=new Uint8Array(wasm.exports.memory.buffer,0,4);const saved=source.slice();
  const texture=wasm.ops.uploadTexture(source,1,1,3);expect(texture).toBeGreaterThanOrEqual(0);expect(new Uint8Array(wasm.exports.memory.buffer,0,4)).toEqual(saved);
  wasm.dispose();
});

test("contact transport yields device facts without using caller supplied hit ownership",()=>{
  expect(contactFacts([(9<<18)|(8<<9)|7],[1])).toEqual([{surface:1,id:9,x:7,y:8,cancelled:false}]);
  expect(contactFacts([(0x80000000|(22<<20)|(700<<10)|900)>>>0])).toEqual([{surface:0,id:22,x:900,y:700,cancelled:false}]);
  expect(contactFacts([(0x40000000|(9<<18))>>>0])).toEqual([{surface:0,id:9,x:0,y:0,cancelled:true}]);
});

test("async browser evaluation gates frames/captures and late imports cannot revive disposed runtimes",async()=>{
  const wasm=await make(),realm:Record<string,any>={};let finish!:()=>void;
  const ready=new Promise<void>(resolve=>{finish=resolve});
  const boot=wasm.bootAsync(source,{global:realm,async evaluate(code:string){await ready;evaluator(realm)(code);}});
  expect(()=>wasm.advance()).toThrow("pending");expect(()=>wasm.present()).toThrow("pending");expect(()=>wasm.drawHash!()).toThrow("pending");expect(()=>wasm.renderPremultiplied!()).toThrow("pending");
  finish();await boot;expect([...wasm.present().slice(0,4)]).toEqual([240,20,40,255]);wasm.advance();wasm.dispose();
  const cancelled=await make(),other:Record<string,any>={};let release!:()=>void;
  const pending=new Promise<void>(resolve=>{release=resolve});
  const late=cancelled.bootAsync("",{global:other,async evaluate(){await pending;other.frame=()=>{};}});
  const old=cancelled.ops.createNode;cancelled.dispose();release();await expect(late).rejects.toThrow("disposed");expect(()=>old(0)).toThrow("shut down");expect(()=>cancelled.advance()).toThrow("disposed");
  const failed=await make();await expect(failed.bootAsync("",{global:{},async evaluate(){throw new Error("module import failed")}})).rejects.toThrow("module import failed");expect(()=>failed.render()).toThrow("disposed");
});

test("two native handles within the same linear memory never share a Ui",async()=>{
  const wasm=await make();const ex=wasm.exports as any;
  const second=ex.web_create(4,4,1,2,2),root=ex.web_auxiliary_root(second);expect(root).toBeGreaterThan(1);
  wasm.init();expect(ex.web_auxiliary_root(second)).toBe(root);expect(ex.web_destroy(second)).toBe(0);wasm.dispose();
});

test("registered public services use generated dispatch and explicit host identity",async()=>{
  const wasm=await make(),realm:Record<string,any>={},sent:string[]=[];
  expect(wasm.ops.__host).toBeUndefined();expect(wasm.ops.svcOpen).toBeUndefined();
  wasm.boot(`if(!ui.svcOpen("allowed") || ui.svcOpen("denied"))throw Error("grant");if(ui.svcPoll()!=="hello")throw Error("poll");globalThis.frame=()=>ui.svcSend("reply");`,{
    host:"web-app",hostAbi:POCKET_BINDING_GENERATION,global:realm,evaluate:evaluator(realm),providers:{svcOpen:(name:string)=>name==="allowed",svcPoll:()=>"hello",svcSend:(text:string)=>sent.push(text)},
  });
  expect(wasm.ops.__host).toBe("web-app");expect(wasm.ops.__hostAbi).toBe(POCKET_BINDING_GENERATION);expect(wasm.ops.svcOpen!.name).toBe("svcOpen");
  wasm.advance();expect(sent).toEqual(["reply"]);wasm.present();wasm.init();
  wasm.boot("globalThis.frame=()=>{}",{global:realm,evaluate:evaluator(realm)});expect(wasm.ops.svcOpen).toBeUndefined();wasm.dispose();
  const guarded=await make(),g:Record<string,any>={};
  guarded.boot("globalThis.frame=()=>ui.svcOpen('x')",{global:g,evaluate:evaluator(g),providers:{svcOpen:()=>guarded.ops.createNode(0)>0}});
  expect(()=>guarded.advance()).toThrow("Busy");guarded.dispose();
});
