// site/playground/runtime-entry.ts — the ONE PocketJS runtime bundle the
// playground loads. Bun bundles it (browser, ESM, conditions:["browser"]) into
// site/dist/pg/runtime.js, and the playground import-map points EVERY PocketJS
// specifier at that one file:
//
//   "@pocketjs/framework"            -> /pg/runtime.js
//   "@pocketjs/framework/components" -> /pg/runtime.js   (etc.)
//   "@pocketjs/framework/renderer"   -> /pg/runtime.js   (babel `moduleName` target)
//
// The playground maps `solid-js` to its own dependency bundle, so app code uses
// the same Solid import path it would use outside the docs site.
//
// Because all specifiers resolve to the SAME module URL, the compiled app and
// its bootstrap share ONE runtime instance — one renderer mirror tree, one
// style registry, one wasm-backed host. That singleton is exactly what we want,
// but it means we must reset it between live-recompiles (see __resetAll).
//
// The facade re-exports each public name once (curated to avoid the collisions
// a bare `export *` would hit, e.g. app-`render` vs universal-`render`).

// ---- public app surface -----------------------------------------------------
export { frameworkName, mount, registerTexture, render } from "../../framework/src/index.ts";
export {
  View,
  Text,
  Image,
  Sprite,
  Screen,
  Focusable,
  FocusScope,
  FocusGrid,
  ActionHandler,
  Portal,
  Modal,
  ActionBar,
  Grid,
  Lazy,
  Gallery,
} from "../../framework/src/components.ts";
export {
  animate,
  spring,
  cancelAnim,
  jump,
  createJumpBatch,
} from "../../framework/src/animation.ts";
export {
  onFrame,
  onButtonPress,
  createSpriteAnimation,
  pushButtonHandlerBlock,
} from "../../framework/src/lifecycle.ts";
export {
  BTN,
  enableCursor,
  focusNode,
  getFocused,
  pushFocusGrid,
  pushFocusScope,
  touches,
} from "../../framework/src/input-api.ts";
export { createWavPlayer } from "../../framework/src/audio-api.ts";
export { createMusicPlayer, createSfxBank } from "../../framework/src/game2d/music.ts";
export { TICKS_PER_SECOND, ticksPerFrame } from "../../framework/src/clock.ts";
export { getOps, hostViewport } from "../../framework/src/host.ts";
export { appTable, frozenShot, launchApp } from "../../framework/src/launcher.ts";

// ---- universal-renderer surface (what babel-preset-solid imports from the
// `moduleName` specifier — must exist under this one module) ------------------
export {
  effect,
  memo,
  createComponent,
  createElement,
  createTextNode,
  insertNode,
  insert,
  spread,
  setProp,
  mergeProps,
  use,
} from "../../framework/src/renderer.ts";

// ---- reset between live-recompiles -----------------------------------------
import { resetRendererState, resetSprites, resetTextures } from "../../framework/src/renderer.ts";
import { resetStyles } from "../../framework/src/styles.ts";
import { resetPack } from "../../framework/src/pak.ts";

/** Wipe every runtime singleton so the NEXT mount() starts from a blank slate:
 *  the renderer mirror tree, retained/sweep sets, the class→styleId registry,
 *  the texture registry, and the cached pak. The wasm core is reset
 *  separately by the host (ui_init). Call BEFORE each recompiled mount(). */
export function __resetAll(): void {
  resetRendererState();
  resetTextures();
  resetSprites();
  resetStyles();
  resetPack();
  // A fresh run installs a new globalThis.frame via installFrameHandler; drop
  // the previous one so a failed compile can't leave a stale handler ticking.
  (globalThis as { frame?: unknown }).frame = undefined;
}
