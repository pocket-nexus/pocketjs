// Instance transport for the generated guest UI and the canonical Runtime.
// Compiler/pixel harnesses can use the same OpContext without booting a guest.
import { mountUi, encodeUiString, POCKET_BINDING_GENERATION } from "./generated-ui.js";
export const FB_W = 480;
export const FB_H = 272;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${name} must be ${min} through ${max}`);
  return value;
}
function bindingGeneration(value) {
  if (value !== POCKET_BINDING_GENERATION) throw new TypeError(`Unsupported UI binding generation; expected ${POCKET_BINDING_GENERATION}`);
  return value;
}
function bytesOf(value) {
  if (value == null) return new Uint8Array();
  return ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array(value);
}
export async function createWasmUi(wasm, options = {}) {
  bindingGeneration(options.hostAbi === undefined ? POCKET_BINDING_GENERATION : options.hostAbi);
  const module = wasm instanceof WebAssembly.Module ? wasm : await WebAssembly.compile(wasm);
  return createWasmUiSync(module, options);
}
/** Synchronous entry for the compiler's layout solver. */
export function createWasmUiSync(wasm, options = {}) {
  const hostAbi = bindingGeneration(options.hostAbi === undefined ? POCKET_BINDING_GENERATION : options.hostAbi);
  const module = wasm instanceof WebAssembly.Module ? wasm : new WebAssembly.Module(wasm);
  let ex, handle = 0, mounted, ops, booted = false, pending = false, disposed = false, callbackDepth = 0;
  let callbacks = {}, callbackError, realm, evaluation;
  let bootPending = false;
  let width = integer(options.width ?? FB_W, "width", 1, 32000);
  let height = integer(options.height ?? FB_H, "height", 1, 32000);
  let density = integer(options.rasterDensity ?? 1, "rasterDensity", 1, 255);
  let auxiliary = options.auxiliary?.map(n => integer(n, "auxiliary dimension", 1, 4096));
  if (auxiliary && auxiliary.length !== 2) throw new RangeError("auxiliary requires two dimensions");
  let renderScale = 1;
  const bindings = new Map();
  let providers = {};
  const copy = (p, n) => new Uint8Array(ex.memory.buffer, p, n).slice();
  const resultText = () => decoder.decode(copy(ex.web_result_ptr(handle), ex.web_result_len(handle)));
  const assertLive = () => { if (disposed) throw new Error("Wasm host has been disposed"); };
  const control = (duringBoot = false) => { assertLive(); if (bootPending && !duringBoot) throw new Error("Guest evaluation is pending"); if (callbackDepth) throw new Error("Wasm lifecycle operation during a guest callback"); };
  function check(status) {
    if (status !== 0) { const error = callbackError ?? new Error(`Pocket Runtime: ${resultText()}`); callbackError = undefined; throw error; }
  }
  function withBytes(input, call) {
    // A caller may pass a wasm view. Copy before allocation can grow memory.
    const value = bytesOf(input).slice(), p = ex.web_alloc(value.length);
    if (!p) throw new Error("Wasm allocation failed");
    try { new Uint8Array(ex.memory.buffer,p,value.length).set(value); return call(p,value.length); }
    finally { ex.web_free(p,value.length); }
  }
  function wrapBindings(ui) {
    const destroy = ui.destroyNode, set = ui.setCompositorSurface;
    ui.destroyNode = id => { const result=destroy(id); bindings.delete(id); return result; };
    if (set) ui.setCompositorSurface = (id,surface,focused) => { const result=set(id,surface,focused); if(surface<0) bindings.delete(id); else bindings.set(id,{handle:surface,focused:!!focused}); return result; };
    return ui;
  }
  function mount(environment, global = {}) {
    bindingGeneration(environment.hostAbi);
    mounted?.dispose(); mounted=mountUi(transport,environment,global); ops=wrapBindings(mounted.ui); return ops;
  }
  const instance = new WebAssembly.Instance(module, { pocket_web: { guest_call(kind, nativeHandle, p, n, pak, pakLength) {
    callbackDepth++;
    try {
      if (nativeHandle !== handle) throw new Error("Foreign guest handle");
      if (kind === 0) {
        const environment=JSON.parse(decoder.decode(copy(p,n))); environment.pak=copy(pak,pakLength);
        mount(environment,realm); callbacks.beforeEvaluate?.(ops,environment);
      } else if (kind === 1) {
        const source=decoder.decode(copy(p,n));
        const outcome = callbacks.evaluate ? callbacks.evaluate(source) : new Function(`${source}\n//# sourceURL=${callbacks.sourceName ?? "pocket-web-guest.js"}`)();
        if(outcome && typeof outcome.then === "function") {
          if(!callbacks.async) { Promise.resolve(outcome).catch(()=>{}); throw new Error("Use bootAsync for asynchronous evaluation"); }
          evaluation=Promise.resolve(outcome);
          evaluation.catch(()=>{});
        } else if(typeof realm.frame !== "function") throw new Error("Guest did not install frame()");
      } else if (kind === 2) {
        const frame=JSON.parse(decoder.decode(copy(p,n)));
        callbacks.beforeFrame?.(); realm.frame(...frame); callbacks.afterFrame?.();
      } else if (kind === 5) {
        const request=JSON.parse(decoder.decode(copy(p,n)));
        const callback=providers[request.name];
        if(typeof callback!=="function")throw new Error(`Missing provider ${request.name}`);
        const value=callback(...request.args);
        if(value && typeof value.then==="function"){Promise.resolve(value).catch(()=>{});throw new Error("Public operation providers must return synchronously");}
        let result;
        if(request.result==="None" || (value==null && request.result.startsWith("Optional"))) result={kind:"none"};
        else if(request.result==="Boolean" || request.result==="Integer") result={kind:"integer",value:Number(value)};
        else if(request.result==="Real") result={kind:"real",value:Number(value)};
        else if(request.result==="String" || request.result==="OptionalString") result={kind:"bytes",value:Array.from(encodeUiString(value))};
        else result={kind:"bytes",value:Array.from(bytesOf(value))};
        withBytes(encoder.encode(JSON.stringify(result)),(resultPointer,resultLength)=>check(ex.web_provider_result(handle,resultPointer,resultLength)));
      } else if (kind === 4) { const owned=mounted && realm?.ui===mounted.ui; mounted?.dispose(); mounted=undefined; if(owned) realm.frame=undefined; }
      return 0;
    } catch(error) { callbackError=error; return -1; }
    finally { callbackDepth--; }
  } } });
  ex=instance.exports;
  if (!ex.web_create) throw new Error("Rebuild pocketjs.wasm: bun tools/wasm.ts");
  handle=ex.web_create(width,height,density,...(auxiliary ?? [0,0]));
  if (!handle) throw new Error("Invalid Wasm viewport or memory budget");
  const a=Array.from({length:19},(_,i)=>ex.web_abi(i));
  const transport={ supportsOp(id){assertLive();return !!ex.web_supports(handle,id);}, dispatch(id,args) {
    assertLive();
    const payloads=args.map(arg=>arg.kind==="bytes" ? bytesOf(arg.value).slice() : null);
    const records=args.length*a[0], output=records, payloadStart=output+a[6];
    const total=payloads.reduce((n,b)=>n+(b?.length ?? 0),payloadStart);
    const p=ex.web_alloc(total);if(!p)throw new Error("Wasm allocation failed");
    try {
      new Uint8Array(ex.memory.buffer,p,total).fill(0);
      const view=new DataView(ex.memory.buffer);let at=p+payloadStart;
      args.forEach((arg,i)=>{const r=p+i*a[0];view.setUint32(r,a[0],true);
        if(arg.kind==="integer"){view.setUint32(r+a[1],a[12],true);view.setBigInt64(r+a[2],BigInt(arg.value),true);}
        else if(arg.kind==="real"){view.setUint32(r+a[1],a[13],true);view.setFloat64(r+a[3],arg.value,true);}
        else {const b=payloads[i];view.setUint32(r+a[1],a[14],true);view.setUint32(r+a[4],at,true);view.setUint32(r+a[5],b.length,true);new Uint8Array(ex.memory.buffer,at,b.length).set(b);at+=b.length;}
      });
      check(ex.web_dispatch(handle,id,p,records,p+output));
      const result=new DataView(ex.memory.buffer),r=p+output,tag=result.getUint32(r+a[7],true);
      if(tag===a[15])return {kind:"none"};
      if(tag===a[16])return {kind:"integer",value:Number(result.getBigInt64(r+a[8],true))};
      if(tag===a[17])return {kind:"real",value:result.getFloat64(r+a[9],true)};
      if(tag===a[18])return {kind:"bytes",value:copy(result.getUint32(r+a[10],true),result.getUint32(r+a[11],true))};
      throw new Error("Unknown UI result tag");
    } finally {ex.web_free(p,total);}
  }};
  function mountHarness() { mount({host:options.host,hostAbi,tickHz:60,viewport:{w:width,h:height},...(auxiliary ? {auxiliary:{root:ex.web_auxiliary_root(handle),w:auxiliary[0],h:auxiliary[1]}} : {})}); }
  mountHarness();
  function capture(scale,mode) {
    control();scale=integer(scale,"render scale",1,4);
    if(booted && pending) present();
    const p=ex.web_capture(handle,scale,mode);if(!p)throw new Error(`Wasm capture: ${resultText()}`);
    const [w,h]=mode===4 ? auxiliary : [width,height];return new Uint8Array(ex.memory.buffer,p,w*h*scale*scale*4);
  }
  function present() {
    control();if(!booted) return capture(renderScale,1);
    // Re-presenting is allowed: compositor uploads and guest inspection can
    // change resources after advance without creating another guest turn.
    check(ex.web_present(handle));pending=false;
    return new Uint8Array(ex.memory.buffer,ex.web_pixels(handle),ex.web_pixels_len(handle));
  }
  const api={
    get ops(){return ops;}, exports:ex,get booted(){return booted;},get disposed(){return disposed;},
    boot(source,bootOptions={}) {
      control();if(booted)throw new Error("Reset before booting another guest");
      const generation=bindingGeneration(bootOptions.hostAbi === undefined ? hostAbi : bootOptions.hostAbi);
      const host=bootOptions.host ?? options.host ?? "web";
      callbacks=bootOptions;realm=bootOptions.global ?? globalThis;renderScale=integer(bootOptions.renderScale ?? 1,"render scale",1,4);
      mounted.dispose();mounted=undefined;
      // Harness callers may have assigned its ops to the same realm.
      if(realm.ui===ops)delete realm.ui;
      callbackError=undefined;
      withBytes(encoder.encode(host),(p,n)=>check(ex.web_set_identity(handle,p,n,generation)));
      providers={...(bootOptions.providers ?? {})};
      for(const [name,callback] of Object.entries(providers)){
        if(typeof callback!=="function")throw new TypeError(`Invalid provider ${name}`);
        withBytes(encoder.encode(name),(p,n)=>check(ex.web_register_provider(handle,p,n)));
      }
      withBytes(encoder.encode(source),(code,length)=>withBytes(bootOptions.pak,(pak,pakLength)=>check(ex.web_boot(handle,code,length,pak,pakLength,bootOptions.tickHz ?? 60,renderScale))));
      booted=true;pending=false;return ops;
    },
    /** Browser imports settle between JS tasks. The Runtime is retained while
     * evaluate's promise is pending; pixels and frame advancement stay gated. */
    async bootAsync(source,bootOptions={}) {
      bindingGeneration(bootOptions.hostAbi === undefined ? hostAbi : bootOptions.hostAbi);
      try {
        api.boot(source,{...bootOptions,async:true});
        bootPending=true;
        await evaluation;
        assertLive();
        if(typeof realm.frame!=="function") throw new Error("Guest did not install frame()");
        bootPending=false;
        present();
        return ops;
      } catch(error) {
        bootPending=false;
        if(!disposed) api.dispose();
        throw error;
      } finally {evaluation=undefined;}
    },
    advance(facts={},ticks=1) {control();if(!booted)throw new Error("Boot the Runtime first");withBytes(encoder.encode(JSON.stringify(facts)),(p,n)=>check(ex.web_advance(handle,p,n,integer(ticks,"ticks",1,60))));pending=true;},
    present,
    init(nextDensity=density){control();check(ex.web_reset(handle,integer(nextDensity,"density",1,255)));density=nextDensity;booted=false;pending=false;bindings.clear();mountHarness();},
    dispose(){if(disposed)return;control(true);check(ex.web_destroy(handle));mounted?.dispose();disposed=true;handle=0;},
    resizeViewport(w,h){control();w=integer(w,"width",1,32000);h=integer(h,"height",1,32000);check(ex.web_resize(handle,w,h));width=w;height=h;ops.__viewport.w=w;ops.__viewport.h=h;},
    createAuxiliarySurface(w,h){control();w=integer(w,"auxiliary width",1,4096);h=integer(h,"auxiliary height",1,4096);const root=ex.web_auxiliary(handle,w,h);if(!root)throw new Error("Auxiliary changes require an unbooted host");auxiliary=[w,h];const added=mountUi(transport,{host:options.host,hostAbi,tickHz:60,auxiliary:{root,w,h},viewport:{w:width,h:height}},{}).ui;Object.assign(ops, {hitTestAuxiliary:added.hitTestAuxiliary,hitTestBoundsAuxiliary:added.hitTestBoundsAuxiliary,__auxiliarySurface:added.__auxiliarySurface});return root;},
    tick(){control();check(ex.web_tick(handle));},
    focused(){control();return ex.web_focused(handle);},
    inspectNode(id){control();check(ex.web_inspect(handle,id));return JSON.parse(resultText());},
    layout(id){control();return withBytes(new Uint8Array(32),p=>{if(!ex.web_layout(handle,id,p))throw new Error(`Missing node ${id}`);return Array.from(new Float32Array(ex.memory.buffer,p,8));});},
    setLayoutMode(id,mode,x,y,w,h){control();ex.web_layout_mode(handle,id,mode,x,y,w,h);},
    drawHash(){control();return ex.web_draw_hash(handle,0);},drawHashAuxiliary(){control();return ex.web_draw_hash(handle,1);},
    compositorBindings(){control();return Array.from(bindings.values(),v=>({...v}));},
    compositorFrames(){control();check(ex.web_compositor_frames(handle));return JSON.parse(resultText());},
    uploadCompositorSurface(id,pixels,w,h){control();return withBytes(pixels,(p,n)=>ex.web_upload_surface(handle,id,p,n,w,h));},
    freeCompositorSurface(id){control();ex.web_free_surface(handle,id);},
    render(){return booted&&renderScale===1 ? present() : capture(1,0);},renderScaled(scale){return booted&&renderScale===scale ? present() : capture(scale,0);},renderIncremental(){return booted&&renderScale===1 ? present() : capture(1,1);},renderScaledIncremental(scale){return booted&&renderScale===scale ? present() : capture(scale,1);},
    renderPremultiplied(scale=1){return capture(scale,2);},renderComposited(scale=1){return capture(scale,3);},renderAuxiliary(){if(!auxiliary)throw new Error("No auxiliary display");return capture(1,4);},
  };
  return api;
}

/** Decode upstream pointer transport into device facts. DOWN hit ownership
 * remains in Runtime; the upstream hit array is intentionally not an input. */
export function contactFacts(touches, surfaces) {
  return (touches ?? []).map((word,index)=>{
    word >>>= 0;const cancelled=!!(word & 0x40000000),wide=!!(word & 0x80000000),bits=wide ? 10 : 9,mask=(1<<bits)-1;
    return {surface:surfaces?.[index] ?? 0,id:(word >>> (cancelled ? 18 : bits*2)) & 255,x:word&mask,y:(word>>>bits)&mask,cancelled};
  });
}

/**
 * Upload every `ui:img.*` pak entry through ops.uploadTexture and return a
 * Map of image name (the JSX `src` key) -> texture handle. Blob layout is the
 * framework/compiler/pak.ts IMG entry: 8-byte header {u16 w, u16 h, u8 psm, 3B pad} +
 * raw pixels. `getEntry(key)` / `listEntries(prefix)` come from the runtime's
 * pak reader (or any equivalent).
 */
export function uploadPackImages(ops, listEntries, getEntry) {
  const IMG_PREFIX = "ui:img.";
  const handles = new Map();
  for (const key of listEntries(IMG_PREFIX)) {
    const blob = getEntry(key);
    const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const w = dv.getUint16(0, true);
    const h = dv.getUint16(2, true);
    const psm = blob[4];
    const handle = ops.uploadTexture(blob.subarray(8), w, h, psm);
    if (handle >= 0) handles.set(key.slice(IMG_PREFIX.length), handle);
  }
  return handles;
}
