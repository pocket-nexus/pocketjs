// PocketJS runtime entry: render(<App/>) / mount(<App/>).
//
// Frame contract (every host): once per vblank/rAF tick the host calls
// `globalThis.frame(buttons)` (spec BTN bitmask). render() installs that
// handler as app frame hooks, input edge-detection + focus + onPress, THEN the
// renderer's end-of-frame sweep [R] — so Solid effects triggered by input run
// before detached subtrees are destroyed.

// queueMicrotask polyfill (QuickJS lacks it; Solid's resource/transition paths
// reference it lazily, so installing at module-eval time is early enough).
if (typeof (globalThis as { queueMicrotask?: unknown }).queueMicrotask !== "function") {
  (globalThis as { queueMicrotask?: (fn: () => void) => void }).queueMicrotask = (
    fn: () => void,
  ) => {
    Promise.resolve().then(fn);
  };
}

import {
  detectHost,
  getOps,
  hostViewport,
  installFrameHandler,
  installHost,
  installResizeViewportHook,
  type HostOps,
} from "./host.ts";
import { initDevtools, wrapFrameHandler } from "./devtools.ts";
import {
  createElement,
  registerTexture as rendererRegisterTexture,
  registerSprite as rendererRegisterSprite,
  setProp,
  insertNode,
  render as rendererRender,
  rootMirror,
  runSweep,
  setStyleResolver,
  type NodeMirror,
} from "./renderer.ts";
import { setOverlayRoot } from "./overlay.ts";
import { mountAuxiliarySurface, unmountAuxiliarySurface } from "./display.ts";
import { registerStyles, resolveStyle } from "./styles.ts";
import { handleFrame, setAuxiliaryHitRoot, setHitRoot, setInputRoot, withDeferredPress } from "./input.ts";
import { __runGestures, resetGestures } from "./gesture.ts";
import { installTouchActivation } from "./touch-activation.ts";
import { __setAnalog, resetFrameHooks, runFrameHooks } from "./frame.ts";
import type { AxisDelta } from "./relative-axis.ts";
import type { MotionState } from "./motion.ts";
import { flushLifecycleHooks, flushUnmountedHooks, disposeRootModelRegions } from "./lifecycle-solid-aot.ts";
import { __resetTouches, __setTouches } from "./touch.ts";
import { __advanceClock, resetClock } from "./clock.ts";
import { __drainEffects, resetEffects } from "./effects.ts";
import { runServicePumps } from "./services.ts";
import { entries as pakEntries, get as pakGet, hasPack, loadPack } from "./pak.ts";
import { STYLE_IDS as DEFAULT_STYLE_IDS } from "./styles.generated.ts";
import { ENUMS, SCREEN_H, SCREEN_W } from "../../contracts/spec/spec.ts";

export interface RenderOptions {
  /** web/wasm/test hosts inject their ops here; omit on PSP (globalThis.ui). */
  ops?: HostOps;
  /** STYLE_IDS table (styles.generated.ts) — class literal → styleId. */
  styles?: Record<string, number>;
  /** App pack; defaults to globalThis.__pak when present. */
  pak?: ArrayBuffer;
}

export type MountOptions = RenderOptions;

/** pak entry keys the runtime understands when it loads a pack JS-side.
 * Must match framework/compiler/pak.ts (KEY_STYLES / keyFont). */
const STYLES_KEY = "ui:styles";
const FONT_PREFIX = "ui:font.";
const IMG_PREFIX = "ui:img.";
const SPRITE_PREFIX = "ui:sprite.";

export function frameworkName(): "Solid" {
  return "Solid";
}

function globalOps(): HostOps | undefined {
  return (globalThis as { ui?: HostOps }).ui;
}

function uploadPakImages(ops: HostOps): void {
  // PSP native pak.rs already uploaded pack images and exposed the handle
  // table through ui.__textures; web/wasm/test hosts need the JS-side upload.
  if ((ops as HostOps & { __textures?: unknown }).__textures) return;
  for (const key of pakEntries(IMG_PREFIX)) {
    const blob = pakGet(key);
    let handle: number;
    if (ops.uploadImgEntry) {
      handle = ops.uploadImgEntry(blob);
    } else {
      const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
      handle = ops.uploadTexture(
        blob.subarray(8),
        dv.getUint16(0, true),
        dv.getUint16(2, true),
        blob[4],
      );
    }
    if (handle >= 0) rendererRegisterTexture(key.slice(IMG_PREFIX.length), handle);
  }
}

/**
 * Upload every ui:sprite.<name> atlas and register its animation metadata.
 * Same as uploadPakImages but for the SPRITE ATLAS entry (framework/compiler/pak.ts
 * encodeSpriteEntry): 16-byte header {u16 atlasW, u16 atlasH, u8 psm, u8 pad,
 * u16 frameCount, u16 cols, u16 frameStep, 4B pad} + atlas pixels. The core
 * auto-plays the animation — nothing per-frame happens here.
 */
function uploadPakSprites(ops: HostOps): void {
  if ((ops as HostOps & { __sprites?: unknown }).__sprites) return; // PSP fed natively
  for (const key of pakEntries(SPRITE_PREFIX)) {
    const blob = pakGet(key);
    const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const w = dv.getUint16(0, true);
    const h = dv.getUint16(2, true);
    const psm = blob[4];
    const frames = dv.getUint16(6, true);
    const cols = dv.getUint16(8, true);
    const step = dv.getUint16(10, true);
    const handle = ops.uploadTexture(blob.subarray(16), w, h, psm);
    if (handle >= 0) {
      rendererRegisterSprite(key.slice(SPRITE_PREFIX.length), { handle, frames, cols, step });
    }
  }
}

function createLayer(style: Record<string, number>): NodeMirror {
  const layer = createElement("view");
  setProp(layer, "style", style, undefined);
  return layer;
}

// The mounted root layers, kept for hosts whose logical viewport can change.
let appLayer: NodeMirror | null = null;
let overlayLayer: NodeMirror | null = null;

/**
 * Live-resize the mounted app to a new logical viewport. The host resizes the
 * core with `Ui::set_viewport`, then calls the installed runtime hook so these
 * app + overlay root layers follow without remounting. This also
 * refreshes `ui.__viewport` so every later `hostViewport` read — cursor
 * clamping, OSK docking — sees the new size. Calling this without a mounted
 * app is a no-op.
 */
export function resizeViewport(w: number, h: number): void {
  if (!appLayer || !overlayLayer) return;
  setProp(appLayer, "style", { width: w, height: h, overflow: ENUMS.Overflow.Hidden }, undefined);
  setProp(
    overlayLayer,
    "style",
    {
      width: w,
      height: h,
      posType: ENUMS.PosType.Absolute,
      insetT: 0,
      insetR: 0,
      insetB: 0,
      insetL: 0,
      zIndex: 1000,
    },
    undefined,
  );
  const ops = getOps() as HostOps & { __viewport?: { w: number; h: number } };
  ops.__viewport = { w, h };
}

/**
 * Mount the app into the native root node and wire the frame loop. Returns a
 * disposer that unmounts and destroys the app subtree.
 *
 * On native hosts the device bin has already fed styles/atlases to the core from the
 * pak (zero QuickJS transit); on injected hosts (web/test) render() pushes
 * them through ops.loadStyles/loadFontAtlas here.
 */
export function render(code: () => unknown, opts: RenderOptions = {}): () => void {
  const host = detectHost(opts.ops);
  installHost(host);

  setStyleResolver(resolveStyle);
  if (opts.styles) registerStyles(opts.styles);

  const nativeTextureTable = host.kind === "native"
    ? (host.ops as HostOps & { __textures?: Record<string, number> }).__textures
    : undefined;
  if (host.kind === "native") {
    // Native host: its pak loader already fed styles/atlases to the
    // core and uploaded the pack's images at boot, leaving a name -> texture-
    // handle table on the ui namespace (ffi.rs). Bind it so <image src="name">
    // resolves through the renderer's texture registry.
    if (nativeTextureTable) {
      for (const key in nativeTextureTable) {
        rendererRegisterTexture(key, nativeTextureTable[key]);
      }
    }
    const spr = (
      host.ops as HostOps & {
        __sprites?: Record<string, { handle: number; frames: number; cols: number; step: number }>;
      }
    ).__sprites;
    if (spr) {
      for (const key in spr) rendererRegisterSprite(key, spr[key]);
    }
  }

  // A target-marked native host may intentionally omit the native resource
  // tables while a port is still using the portable `globalThis.__pak`
  // loader. That keeps target/ABI handshakes strict without requiring an
  // early C++ pak parser. Established console hosts publish `__textures`
  // (including an empty table) and retain their zero-copy native feed.
  if (host.kind === "injected" || nativeTextureTable === undefined) {
    if (opts.pak) loadPack(opts.pak);
    if (hasPack()) {
      for (const key of pakEntries()) {
        if (key === STYLES_KEY) {
          host.ops.loadStyles?.(pakGet(key));
        } else if (key.startsWith(FONT_PREFIX)) {
          host.ops.loadFontAtlas?.(pakGet(key));
        }
        // images: hosts upload + registerTexture() themselves (w/h/psm live
        // in host-specific metadata, not in the runtime).
      }
    }
  }

  const auxiliary = mountAuxiliarySurface(host.ops);

  // Live-viewport hosts publish their logical UI size as ui.__viewport (the
  // core root is already sized to it via Ui::set_viewport); PSP/web hosts omit
  // it and keep the 480x272 contract.
  const viewport = hostViewport(host.ops);
  const layerW = viewport?.w ?? SCREEN_W;
  const layerH = viewport?.h ?? SCREEN_H;
  const appRoot = createLayer({
    width: layerW,
    height: layerH,
    overflow: ENUMS.Overflow.Hidden,
  });
  const overlayRoot = createLayer({
    width: layerW,
    height: layerH,
    posType: ENUMS.PosType.Absolute,
    insetT: 0,
    insetR: 0,
    insetB: 0,
    insetL: 0,
    zIndex: 1000,
    // Self-transparent to hit testing (spec prop hitPass): the empty layer
    // must not swallow bounds hit facts aimed at app content beneath it —
    // portal/OSK content INSIDE it still claims normally.
    hitPass: 1,
  });
  insertNode(rootMirror, appRoot);
  insertNode(rootMirror, overlayRoot);
  setOverlayRoot(overlayRoot);
  appLayer = appRoot;
  overlayLayer = overlayRoot;

  setInputRoot(appRoot);
  setHitRoot(rootMirror); // hit tests see the overlay layer too
  setAuxiliaryHitRoot(auxiliary?.native ?? null);
  resetFrameHooks();
  resetGestures();
  // The default tap->press recognizer registers FIRST: every component
  // gesture mounted after it wins priority (docs/TOUCH.md §0).
  installTouchActivation();
  resetClock(); // latches the host's __simHz clock policy (docs/DETERMINISM.md)
  resetEffects();
  initDevtools(host.ops); // DevTools shim (docs/DEVTOOLS.md): flight recorder +
  // debug channel; one branch per frame when no transport is connected.
  installFrameHandler(
    wrapFrameHandler((
      buttons: number,
      analog: number,
      touches?: readonly number[],
      hits?: readonly number[],
      touchSurfaces?: readonly number[],
      rightAnalog?: number,
      axisDeltas?: readonly AxisDelta[],
      motion?: MotionState | null,
    ) => {
      __advanceClock(); // virtual frame++, fire due after() timers
      __setAnalog(analog, rightAnalog); // latch the nub before any app code reads it
      __setTouches(touches, hits, touchSurfaces); // latch contacts + surface-specific hit facts
      runServicePumps(); // only modules with pending async work register here
      __drainEffects(); // frame-boundary deliveries enter the world first
      runFrameHooks(buttons, axisDeltas,
        defer => handleFrame(buttons, defer),
        defer => withDeferredPress(defer, __runGestures), motion);
      runSweep(); // then destroy subtrees still detached [R]
    }),
  );

  const dispose = rendererRender(code as () => NodeMirror, appRoot);
  flushLifecycleHooks();
  const removeResizeViewportHook = installResizeViewportHook(resizeViewport);
  return () => {
    removeResizeViewportHook();
    __resetTouches();
    resetGestures();
    dispose(); // tears down reactivity only — universal keeps the nodes
    disposeRootModelRegions();
    flushUnmountedHooks();
    setInputRoot(null); // drops focus state (native focus dies with the nodes)
    setHitRoot(null);
    setAuxiliaryHitRoot(null);
    setOverlayRoot(null);
    appLayer = null;
    overlayLayer = null;
    for (const child of rootMirror.children.splice(0)) {
      child.parent = null;
      host.ops.destroyNode(child.id); // recursive native destroy
    }
    unmountAuxiliarySurface(host.ops);
    runSweep(); // anything already detached this frame is garbage too
  };
}

/**
 * App-level entry point for demo/application bundles. It mirrors a web-style
 * mount call: pick the current host, feed the current generated style table,
 * upload pak images for injected hosts, and mount the component. Per-frame
 * app behavior belongs in component lifecycle callbacks such as onFrame/onButtonPress.
 */
export function mount(code: () => unknown, opts: MountOptions = {}): () => void {
  const ops = opts.ops ?? globalOps();
  if (!ops) {
    throw new Error("PocketJS: mount() requires globalThis.ui or opts.ops");
  }
  if (opts.pak) loadPack(opts.pak);
  uploadPakImages(ops);
  uploadPakSprites(ops);
  const dispose = render(code, {
    ops,
    styles: opts.styles ?? DEFAULT_STYLE_IDS,
    pak: opts.pak,
  });
  return dispose;
}

// ---- runtime re-exports -------------------------------------------------------

export type { HostOps, Host } from "./host.ts";
export { detectHost, installHost, getOps } from "./host.ts";
export { expandTape, type Tape, type DevtoolsTransport } from "./devtools.ts";
export type { NodeMirror } from "./renderer.ts";
export { retain, release, runSweep, registerTexture, missCounters } from "./renderer.ts";
export { registerStyles, resolveStyle } from "./styles.ts";
export { entries as pakEntries, get as pakGet, loadPack, resetPack } from "./pak.ts";
