// One browser AppInstance. A same-origin hidden iframe loads this module so
// every Pocket package receives an independent JavaScript Realm and wasm Ui.
// The parent System host owns scheduling and composition through this narrow
// object; package code never receives another realm or framebuffer.

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
  const textWorker=createWorkerOffload({workerUrl:new URL("./text-worker.js",import.meta.url),wasmUrl:new URL("./pocket_text.wasm",import.meta.url),pak:globalThis.__pak});
  globalThis.offload=textWorker.ops;
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
    step(buttons = 0, touches, hits, touchSurfaces) {
      textWorker.beginFrame();
      globalThis.frame(buttons, 0x8080, touches, hits, touchSurfaces);
      wasm.tick();
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
