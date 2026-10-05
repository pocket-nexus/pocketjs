// One browser AppInstance. A same-origin hidden iframe loads this module so
// every Pocket package receives an independent JavaScript Realm and wasm Ui.
// The parent System host owns scheduling and composition through this narrow
// object; package code never receives another realm or framebuffer.
//
// `options.text: false` starts the instance without the text worker and its
// pocket_text.wasm: the guest then has no `offload` global, as on a host
// with no text provider. A guest whose glyphs are all baked needs neither
// (a Pocket3D game's interface over its scene, devices/web/pocket-web-wgpu).

import { createWasmUi } from "./wasm-ops.js";
import { createWorkerOffload } from "./offload-worker.js";

async function requiredFetch(url, kind) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${kind} not found at ${url} (${response.status})`);
  return response;
}

export async function create(options) {
  const viewport = [...(options.viewport ?? [480, 272])];
  const density = options.rasterDensity ?? 1;
  const wasmBytes = await (await requiredFetch(options.wasmUrl, "PocketJS wasm")).arrayBuffer();
  const wasm = await createWasmUi(wasmBytes, {
    width: viewport[0],
    height: viewport[1],
    rasterDensity: density,
    auxiliary: options.auxiliary,
  });

  const incoming = [];
  const outgoing = [];
  const companions = new Set(options.companions ?? []);
  wasm.ops.svcOpen = (name) => companions.has(name);
  wasm.ops.svcPoll = () => {
    if (incoming.length === 0) return null;
    const batch = incoming.splice(0).join("\n");
    return `${batch}\n`;
  };
  wasm.ops.svcSend = (line) => {
    if (typeof line === "string" && outgoing.length < 1024) outgoing.push(line);
  };
  if (options.surfaces) wasm.ops.__surfaces = { ...options.surfaces };

  globalThis.ui = wasm.ops;
  globalThis.frame = undefined;
  globalThis.__simHz = options.simHz ?? 60;
  globalThis.__pocketApp = options.packageId;
  const pak = await fetch(options.pakUrl);
  globalThis.__pak = pak.ok ? await pak.arrayBuffer() : undefined;
  const textWorker = options.text === false
    ? { beginFrame() {}, dispose() {} }
    : createWorkerOffload({workerUrl:new URL("./text-worker.js",import.meta.url),wasmUrl:new URL("./pocket_text.wasm",import.meta.url),pak:globalThis.__pak});
  if (options.text !== false) globalThis.offload=textWorker.ops;
  const source = await (await requiredFetch(options.bundleUrl, "Pocket app bundle")).text();
  new Function(`${source}\n//# sourceURL=${options.packageId}.js`)();
  if (typeof globalThis.frame !== "function") {
    throw new Error(`${options.packageId} evaluated but installed no frame()`);
  }

  return {
    packageId: options.packageId,
    viewport,
    // The guest frame signature is positional (framework/src/index.ts):
    // frame(buttons, analog, touches?, hits?, touchSurfaces?). A parent that
    // passes only buttons keeps the button-only contract — `undefined`
    // touches clear the contact snapshot, exactly as a host with no panel.
    // `ticks` is the sixtieths of a second the core advances after the guest's
    // frame: a parent that turns the guest less often than the display
    // refreshes passes the refreshes since the last turn, as the native
    // runtime does (engine/quickjs-c/pocket_runtime.c).
    step(buttons = 0, touches, hits, touchSurfaces, ticks = 1) {
      textWorker.beginFrame();
      globalThis.frame(buttons, 0x8080, touches, hits, touchSurfaces);
      for (let i = 0; i < ticks; i++) wasm.tick();
    },
    /**
     * Bounds hit query (spec op 42) against the committed frame, so the parent
     * can resolve a contact's DOWN-edge hit fact before the next step().
     * Falls back to the ink query (op 27) and finally to 0 on a pocketjs.wasm
     * predating either, which leaves the gesture layer on its rect fallback.
     */
    hitTestBounds(x, y, surface = "primary") {
      const query = surface === "auxiliary"
        ? wasm.ops.hitTestBoundsAuxiliary
        : wasm.ops.hitTestBounds ?? wasm.ops.hitTest;
      return query ? query(x, y) : 0;
    },
    render(scale = 1) {
      return scale === 1 ? wasm.render() : wasm.renderScaled(scale);
    },
    renderAuxiliary() {
      return wasm.renderAuxiliary();
    },
    /**
     * The primary surface with coverage: premultiplied RGBA8 whose alpha is 0
     * where the guest draws nothing, for a parent that lays the guest over a
     * scene of its own. One rasterization; null on a pocketjs.wasm that
     * predates it.
     */
    renderPremultiplied(scale = 1) {
      return wasm.renderPremultiplied ? wasm.renderPremultiplied(scale) : null;
    },
    renderComposited() {
      return wasm.renderComposited();
    },
    resize(width, height) {
      wasm.resizeViewport(width, height);
      viewport[0] = width;
      viewport[1] = height;
      if (typeof globalThis.__pocketResizeViewport === "function") {
        globalThis.__pocketResizeViewport(width, height);
      }
    },
    drawHash() {
      return wasm.drawHash ? wasm.drawHash() : 0n;
    },
    /** The auxiliary surface's draw hash; null on a pocketjs.wasm that predates it. */
    drawHashAuxiliary() {
      return wasm.drawHashAuxiliary ? wasm.drawHashAuxiliary() : null;
    },
    bindings() {
      return wasm.compositorBindings();
    },
    frames() {
      return wasm.compositorFrames();
    },
    uploadSurface(handle, pixels, width, height) {
      return wasm.uploadCompositorSurface(handle, pixels, width, height);
    },
    freeSurface(handle) {
      wasm.freeCompositorSurface(handle);
    },
    sendService(line) {
      incoming.push(typeof line === "string" ? line : JSON.stringify(line));
    },
    drainService() {
      return outgoing.splice(0);
    },
    dispose() {
      textWorker.dispose();
      incoming.length = 0;
      outgoing.length = 0;
      globalThis.frame = undefined;
      globalThis.ui = undefined;
      globalThis.__pak = undefined;
    },
  };
}

globalThis.PocketAppInstance = { create };
