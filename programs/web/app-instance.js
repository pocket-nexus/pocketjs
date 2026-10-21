// One browser AppInstance. A same-origin hidden iframe loads this module so
// every Pocket package receives an independent JavaScript Realm and wasm Ui.
// The parent System host owns scheduling and composition through this narrow
// object; package code never receives another realm or framebuffer.
// Runtime owns input encoding, guest turns and display presentation.
//
// `options.text: false` starts the instance without the text worker and its
// pocket_text.wasm: the guest then has no `offload` global, as on a host
// with no text provider. A guest whose glyphs are all baked needs neither
// (a Pocket3D game's interface over its scene, devices/web/pocket-web-wgpu).
//
// Text a guest sets at run time draws in every script the browser has a font
// for (text.glyphs.runtime, ./runtime-glyphs.js): a codepoint no baked atlas
// maps is drawn by the browser and added to the atlases before the core lays
// it out. `options.runtimeGlyphs: false` leaves the atlases as the build
// baked them; `options.glyphFamilies` names the CSS font families to draw
// with (default: the Japanese, Chinese and Korean faces of the common
// systems, then sans-serif).

import { createWasmUi, contactFacts } from "../../platforms/web/wasm-ops.js";
import { canvasRasterizer, installRuntimeGlyphs } from "../../platforms/web/runtime-glyphs.js";
import { createWorkerOffload } from "../../platforms/web/offload-worker.js";

async function requiredFetch(url, kind) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${kind} not found at ${url} (${response.status})`);
  return response;
}

let currentInstance;
globalThis.addEventListener?.("pagehide", () => currentInstance?.dispose());

export async function create(options) {
  currentInstance?.dispose();
  currentInstance = undefined;
  const viewport = [...(options.viewport ?? [480, 272])];
  const density = options.rasterDensity ?? 1;
  const wasmBytes = await (await requiredFetch(options.wasmUrl, "PocketJS wasm")).arrayBuffer();
  const wasm = await createWasmUi(wasmBytes, {
    width: viewport[0],
    height: viewport[1],
    rasterDensity: density,
    auxiliary: options.auxiliary,
  });

  let glyphs;
  const incoming = [], outgoing = [];
  const companions = new Set(options.companions ?? []);
  const pakResponse = await fetch(options.pakUrl);
  const pak = pakResponse.ok ? await pakResponse.arrayBuffer() : undefined;
  const textWorker = options.text === false
    ? { beginFrame() {}, dispose() {} }
    : createWorkerOffload({workerUrl:new URL("../../platforms/web/text-worker.js",import.meta.url),wasmUrl:new URL("../../platforms/web/pocket_text.wasm",import.meta.url),pak});
  const source = await (await requiredFetch(options.bundleUrl, "Pocket app bundle")).text();
  globalThis.frame = undefined;
  globalThis.__simHz = options.simHz ?? 60;
  globalThis.__pocketApp = options.packageId;
  if (options.text !== false) globalThis.offload = textWorker.ops;
  try {
    wasm.boot(source, {
      pak,
      sourceName: `${options.packageId}.js`,
      host: options.host, hostAbi: options.hostAbi,
      providers: {
        svcOpen: name => companions.has(name),
        svcPoll: () => incoming.length ? `${incoming.splice(0).join("\n")}\n` : undefined,
        svcSend: line => {if(typeof line==="string" && outgoing.length<1024)outgoing.push(line);},
      },
      beforeEvaluate(ops) {
        glyphs = options.runtimeGlyphs === false ? null : installRuntimeGlyphs(ops, {
          rasterize: canvasRasterizer(options.glyphFamilies ? {families:options.glyphFamilies} : {}),
        });
        if(options.surfaces) ops.__surfaces = {...options.surfaces};
      },
      beforeFrame() { textWorker.beginFrame(); },
      afterFrame() { glyphs?.flush(); },
    });
  } catch(error) { textWorker.dispose(); wasm.dispose(); throw error; }

  let disposed = false;
  const instance = {
    packageId: options.packageId,
    viewport,
    // The guest frame signature is positional (framework/src/index.ts):
    // frame(buttons, analog, touches?, hits?, touchSurfaces?). A parent that
    // passes only buttons supplies an empty contact snapshot. Runtime
    // computes each DOWN hit and emits the canonical frame arrays.
    // `ticks` is the sixtieths of a second the core advances after the guest's
    // frame: a parent that turns the guest less often than the display
    // refreshes passes the refreshes since the last turn, as the native
    // runtime does through advance_with_core_ticks.
    step(buttons = 0, touches, hits, touchSurfaces, ticks = 1) {
      wasm.advance({buttons, contacts: contactFacts(touches, touchSurfaces)}, ticks);
    },
    /** Native browser pointer facts retain full viewport coordinates. */
    stepInput(facts, ticks = 1) {
      wasm.advance(facts, ticks);
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
    /** What text.glyphs.runtime added: codepoints, cells, atlas reloads and the milliseconds spent; null when it is off. */
    glyphStats() {
      return glyphs ? glyphs.stats() : null;
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
      if (disposed) return;
      disposed = true;
      textWorker.dispose();
      incoming.length = 0;
      outgoing.length = 0;
      wasm.dispose();
      if (globalThis.offload === textWorker.ops) delete globalThis.offload;
    },
  };
  currentInstance = instance;
  return instance;
}

globalThis.PocketAppInstance = { create };
