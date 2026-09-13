// Input: button edge-detection + the focus manager.
//
// Focus model (v1, no layout access from JS [R]):
//   - Default traversal order = DOCUMENT ORDER over the mirror tree, derived
//     lazily (a DFS per navigation press — cheap for UI-sized trees, always
//     correct after <For> reorders).
//   - FocusGrid can override traversal inside a subtree with row/column d-pad
//     semantics; outside a grid, DOWN/RIGHT → next and UP/LEFT → previous.
//   - CIRCLE fires onPress of the focused node, bubbling up to the nearest
//     ancestor with a handler.
//   - Focus loss on removal [R]: next sibling subtree → previous sibling
//     subtree → nearest focusable ancestor → none. Computed BEFORE the mirror
//     unlink (renderer calls notifyDetached first).
//   - Every focus change calls ops.setFocus so the native core applies the
//     `focus:` style variant with zero further JS.
//   - While CIRCLE is held, the focused node carries the `active:` variant
//     (ops.setActive, spec op 26) — pressed visuals with zero per-frame JS.
//     Cleared on release, and on any focus change (d-pad while held, scope
//     push/pop, removal repair) so the pressed look never sticks.
//
// Virtual cursor mode (input.cursor capability, opt-in via enableCursor):
//   - The analog nub steers a core-drawn pointer sprite (spec ops 28/29 —
//     topmost, never laid out, never hit-tested). Position integrates at
//     `speed` px per VIRTUAL second over ticksPerFrame() sub-steps, so tapes
//     replay identically at every simulationHz.
//   - Each frame the pointer hit-tests the tree (spec op 27), resolves the
//     nearest FOCUSABLE ancestor inside the active focus scope, and focuses
//     it — hover IS focus, so every `focus:` style doubles as the hover
//     style and modals stay inert without extra rules.
//   - The press button (CIRCLE by default) arms the hovered node and holds
//     `active:` while held OVER it (leave to pop back up, re-enter to
//     re-press — classic button affordance); releasing over the armed node
//     fires its onPress. Releasing elsewhere cancels.
//   - While the cursor is enabled, d-pad focus traversal and the CIRCLE
//     press of the classic model are suppressed; onButtonPress hooks are
//     untouched (they run in frame.ts before this module).

import { BTN, IMG_FLAG_RLE, PSM, SCREEN_H, SCREEN_W } from "../../contracts/spec/spec.ts";
import { ticksPerFrame, TICKS_PER_SECOND } from "./clock.ts";
import { analogX, analogY } from "./frame.ts";
import { getHost, getOps, hostViewport, type HostOps } from "./host.ts";
import { get as pakGet } from "./pak.ts";
import type { NodeMirror } from "./renderer.ts";
import type { SurfaceId } from "./display.ts";

let root: NodeMirror | null = null;
let focused: NodeMirror | null = null;
let pressedNode: NodeMirror | null = null;
let prevButtons = 0;
const focusScopeStack: NodeMirror[] = [];
const focusGridStack: FocusGridRegistration[] = [];
const focusControllerStack: FocusControllerRegistration[] = [];

/** Bind the focus manager to a mirror tree root (index.ts render()). The
 *  cursor SURVIVES a rebind (enableCursor at module top runs before mount);
 *  its sprite is released and re-arms so the next frame re-uploads. The
 *  release also covers a PERSISTENT core (render disposer → re-mount on
 *  web/test hosts): without it the old arrow would keep painting and its
 *  texture slot would leak; on a genuinely fresh core the stale handle
 *  no-ops (generation-tagged). */
export function setInputRoot(r: NodeMirror | null): void {
  root = r;
  focused = null;
  pressedNode = null;
  prevButtons = 0;
  focusScopeStack.length = 0;
  focusGridStack.length = 0;
  focusControllerStack.length = 0;
  if (cursor) {
    cursor.pressTarget = null;
    cursor.target = null;
    cursor.spriteDirty = true;
    cursor.fresh = true;
    cursor.vw = 0;
    if (cursor.tex >= 0) {
      const ops = getOps();
      ops.setCursor?.(-1, 0, 0, 0, 0);
      ops.freeTexture?.(cursor.tex);
      cursor.tex = -1;
    }
  }
}

/** Tests: forget focus + edge + cursor state (drops the cursor WITHOUT
 *  touching host ops — the host may already be a different instance). */
export function resetInput(): void {
  cursor = null;
  setInputRoot(null);
}

// ---- registries (renderer setProperty dispatch targets) --------------------

export function registerPress(
  node: NodeMirror,
  fn: (() => void) | undefined | null,
): void {
  node.onPress = fn ?? undefined;
}

export function registerFocusable(node: NodeMirror, on: boolean): void {
  node.focusable = on;
  __notifyTreeMutation(); // hover resolution depends on focusable flags
  if (!on && focused === node) {
    focusNode(null);
  }
}

// ---- focus ------------------------------------------------------------------

/** Programmatic focus (also used internally). null clears. */
export function focusNode(node: NodeMirror | null): void {
  if (pressedNode && pressedNode !== node) setPressedNode(null);
  focused = node;
  getOps().setFocus(node ? node.id : 0);
}

/** Hold/clear the `active:` variant on a node (stale ids no-op core-side). */
function setPressedNode(node: NodeMirror | null): void {
  if (pressedNode === node) return;
  const ops = getOps();
  if (pressedNode) ops.setActive?.(pressedNode.id, 0);
  pressedNode = node;
  if (node) ops.setActive?.(node.id, 1);
}

export function getFocused(): NodeMirror | null {
  return focused;
}

function activeFocusRoot(): NodeMirror | null {
  return focusScopeStack.length > 0 ? focusScopeStack[focusScopeStack.length - 1] : root;
}

function collectFocusables(node: NodeMirror, out: NodeMirror[]): void {
  if (!node) return;
  if (node.focusable) out.push(node);
  if (!Array.isArray(node.children)) return;
  for (let i = 0; i < node.children.length; i++) {
    collectFocusables(node.children[i], out);
  }
}

function focusables(): NodeMirror[] {
  const out: NodeMirror[] = [];
  const r = activeFocusRoot();
  if (r) collectFocusables(r, out);
  return out;
}

export type FocusDirection = "up" | "down" | "left" | "right";

function linearDirection(direction: FocusDirection): 1 | -1 {
  return direction === "down" || direction === "right" ? 1 : -1;
}

function moveLinearFocus(direction: FocusDirection): void {
  const dir = linearDirection(direction);
  const list = focusables();
  if (list.length === 0) {
    if (focused) focusNode(null);
    return;
  }
  const i = focused ? list.indexOf(focused) : -1;
  if (i < 0) {
    // Nothing (validly) focused: enter the order from the direction's end.
    focusNode(dir === 1 ? list[0] : list[list.length - 1]);
    return;
  }
  const j = i + dir;
  if (j < 0 || j >= list.length) return; // clamp at the ends
  focusNode(list[j]);
}

export interface FocusGridOptions {
  columns: number;
  wrap?: boolean;
}

interface FocusGridRegistration {
  node: NodeMirror;
  columns: number;
  wrap: boolean;
}

function activeGrid(): FocusGridRegistration | null {
  if (!focused) return null;
  const active = activeFocusRoot();
  if (active && !isWithin(focused, active)) return null;
  for (let i = focusGridStack.length - 1; i >= 0; i--) {
    const grid = focusGridStack[i];
    if (active && !isWithin(grid.node, active) && !isWithin(active, grid.node)) continue;
    if (isWithin(focused, grid.node)) return grid;
  }
  return null;
}

function moveGridFocus(direction: FocusDirection): boolean {
  const grid = activeGrid();
  if (!grid) return false;

  const list: NodeMirror[] = [];
  collectFocusables(grid.node, list);
  if (list.length === 0) {
    if (focused) focusNode(null);
    return true;
  }

  const columns = grid.columns;
  const i = focused ? list.indexOf(focused) : -1;
  if (i < 0) {
    focusNode(linearDirection(direction) === 1 ? list[0] : list[list.length - 1]);
    return true;
  }

  let j = i;
  switch (direction) {
    case "right":
      if (i + 1 < list.length && i % columns < columns - 1) j = i + 1;
      else if (grid.wrap) j = Math.floor(i / columns) * columns;
      break;
    case "left":
      if (i % columns > 0) j = i - 1;
      else if (grid.wrap) j = Math.min(list.length - 1, Math.floor(i / columns) * columns + columns - 1);
      break;
    case "down":
      if (i + columns < list.length) j = i + columns;
      else if (grid.wrap) j = i % columns;
      break;
    case "up":
      if (i - columns >= 0) j = i - columns;
      else if (grid.wrap) {
        const col = i % columns;
        j = col;
        while (j + columns < list.length) j += columns;
      }
      break;
  }

  if (j !== i) focusNode(list[j]);
  return true;
}

interface FocusControllerRegistration {
  node: NodeMirror;
  move: (direction: FocusDirection) => boolean;
}

function activeController(): FocusControllerRegistration | null {
  if (!focused) return null;
  const active = activeFocusRoot();
  if (active && !isWithin(focused, active)) return null;
  for (let i = focusControllerStack.length - 1; i >= 0; i--) {
    const ctl = focusControllerStack[i];
    if (active && !isWithin(ctl.node, active) && !isWithin(active, ctl.node)) continue;
    if (isWithin(focused, ctl.node)) return ctl;
  }
  return null;
}

/**
 * Give a subtree fully custom d-pad traversal (the OSK's variable-width key
 * rows can't be expressed as a FocusGrid). While the focused node is inside
 * `node`, each navigation press calls `move` INSTEAD of grid/linear
 * traversal; return false to fall through to the default behaviors.
 */
export function pushFocusController(
  node: NodeMirror,
  move: (direction: FocusDirection) => boolean,
): () => void {
  const registration: FocusControllerRegistration = { node, move };
  focusControllerStack.push(registration);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const i = focusControllerStack.lastIndexOf(registration);
    if (i >= 0) focusControllerStack.splice(i, 1);
  };
}

function moveFocus(direction: FocusDirection): void {
  const ctl = activeController();
  if (ctl && ctl.move(direction)) return;
  if (moveGridFocus(direction)) return;
  moveLinearFocus(direction);
}

function firePress(): void {
  firePressFrom(focused);
}

function firePressFrom(start: NodeMirror | null): void {
  let n: NodeMirror | null = start;
  while (n) {
    if (n.onPress) {
      n.onPress();
      return;
    }
    n = n.parent;
  }
}

/** Hold/clear the `active:` pressed variant from touch/gesture code. All
 *  writers (d-pad, cursor, touch) route through the same internal latch, so
 *  a pressed look can never strand across input modes. */
export function setActiveNode(node: NodeMirror | null): void {
  setPressedNode(node);
}

/** Focus a node and fire its onPress (bubbling to the nearest ancestor
 *  handler) — the touch-tap equivalent of the CIRCLE press, so taps, d-pad,
 *  and cursor clicks all land in the same handler. */
export function pressNode(node: NodeMirror): void {
  focusNode(node);
  firePressFrom(node);
}

// ---- removal repair [R] ------------------------------------------------------

function isWithin(node: NodeMirror, ancestor: NodeMirror): boolean {
  if (!node || !ancestor) return false;
  let n: NodeMirror | null = node;
  while (n) {
    if (n === ancestor) return true;
    n = n.parent;
  }
  return false;
}

export interface FocusScopeOptions {
  autoFocus?: boolean;
  restoreFocus?: boolean;
}

function firstFocusable(node: NodeMirror): NodeMirror | null {
  if (!node) return null;
  if (node.focusable) return node;
  if (!Array.isArray(node.children)) return null;
  for (let i = 0; i < node.children.length; i++) {
    const f = firstFocusable(node.children[i]);
    if (f) return f;
  }
  return null;
}

/** Temporarily restrict d-pad traversal and CIRCLE press to a subtree. */
export function pushFocusScope(node: NodeMirror, opts: FocusScopeOptions = {}): () => void {
  const previous = focused;
  focusScopeStack.push(node);
  __notifyTreeMutation(); // hover resolution depends on the active scope
  if (opts.autoFocus !== false && (!focused || !isWithin(focused, node))) {
    focusNode(firstFocusable(node));
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const i = focusScopeStack.lastIndexOf(node);
    if (i >= 0) focusScopeStack.splice(i, 1);
    __notifyTreeMutation();

    const active = activeFocusRoot();
    if (opts.restoreFocus !== false && previous && (!active || isWithin(previous, active))) {
      focusNode(previous);
      return;
    }
    if (active && (!focused || !isWithin(focused, active))) {
      focusNode(firstFocusable(active));
    } else if (!active && focused) {
      focusNode(null);
    }
  };
}

/** Temporarily give a subtree row/column d-pad traversal semantics. */
export function pushFocusGrid(node: NodeMirror, opts: FocusGridOptions): () => void {
  const registration: FocusGridRegistration = {
    node,
    columns: Math.max(1, Math.floor(opts.columns)),
    wrap: opts.wrap ?? false,
  };
  focusGridStack.push(registration);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const i = focusGridStack.lastIndexOf(registration);
    if (i >= 0) focusGridStack.splice(i, 1);
  };
}

/**
 * Called by the renderer's removeNode BEFORE the mirror unlink. If the focused
 * node is inside the removed subtree, refocus: next sibling subtree → previous
 * sibling subtree → nearest focusable ancestor → none.
 */
export function notifyDetached(node: NodeMirror): void {
  if (!focused || !isWithin(focused, node)) return;
  const parent = node.parent;
  if (parent) {
    const idx = parent.children.indexOf(node);
    for (let i = idx + 1; i < parent.children.length; i++) {
      const f = firstFocusable(parent.children[i]);
      if (f) {
        focusNode(f);
        return;
      }
    }
    for (let i = idx - 1; i >= 0; i--) {
      const f = firstFocusable(parent.children[i]);
      if (f) {
        focusNode(f);
        return;
      }
    }
    let a: NodeMirror | null = parent;
    while (a) {
      if (a.focusable) {
        focusNode(a);
        return;
      }
      a = a.parent;
    }
  }
  focusNode(null);
}

// ---- virtual cursor (input.cursor capability; spec ops 27..29) ----------------

export interface CursorOptions {
  /** Sprite: a pak IMG entry key, or a raw IMG entry blob. Default: a
   *  built-in monochrome arrow (16x16, hotspot at its tip). */
  image?: string | Uint8Array;
  /** Sprite pixel the position points at. Default [0, 0]. */
  hotspot?: [number, number];
  /** Logical draw size; omit to draw at the texture's own pixel size. */
  size?: [number, number];
  /** Travel speed in px per virtual second at full nub deflection —
   *  hz-invariant, so 240 (the default) is exactly 4 px per frame at the
   *  stock 60 Hz (tape authors: N frames of full deflection = N*4 px). */
  speed?: number;
  /** Also steer with the d-pad at this px/s while the nub is centered
   *  (0, the default, leaves the d-pad to the app). */
  dpadSpeed?: number;
  /** Button mask that presses/clicks the hovered node. Default CIRCLE. */
  button?: number;
  /** Starting position. Default: viewport center. */
  start?: [number, number];
}

interface CursorState {
  /** Position; -1 until the first frame centers it in the viewport. */
  x: number;
  y: number;
  /** Cached logical viewport (0 until the first frame reads the host). */
  vw: number;
  vh: number;
  speed: number;
  dpadSpeed: number;
  button: number;
  /** Armed by the press edge; fires on release while still hovered. */
  pressTarget: NodeMirror | null;
  /** Uploaded sprite texture (-1 until the lazy first-frame init). */
  tex: number;
  /** Current sprite config + whether it still needs uploading/binding. */
  sprite: CursorSprite;
  spriteDirty: boolean;
  /** Cached hover target — recomputed only when the cursor moved, the
   *  press button edged, or `inputGen` ticked (see below). */
  target: NodeMirror | null;
  gen: number;
  /** Force position push + re-hit on the next frame (enable, root rebind). */
  fresh: boolean;
}

interface CursorSprite {
  image?: string | Uint8Array;
  hotspot: [number, number];
  size: [number, number];
}

let cursor: CursorState | null = null;

// Change counter for everything JS can observe that affects hover
// resolution: mirror-tree mutations (native-tree.ts pings on insert/remove/
// class/style/text), focusable toggles, and focus-scope pushes/pops. While
// it holds still and the cursor doesn't move, the per-frame hit test is
// skipped entirely — the hover can only be stale for core-side animation
// (baked timelines moving a box under a parked pointer), and every press
// edge forces a fresh hit so clicks always resolve against live geometry.
let inputGen = 0;

/** Ping from native-tree.ts on any mirror mutation (also exercised directly
 *  by tests that hand-build mirrors). */
export function __notifyTreeMutation(): void {
  inputGen++;
}

/** The built-in pointer: a classic 16x16 monochrome arrow (black outline,
 *  white fill), decoded from per-row bitmasks (bit N = pixel at x = N). */
const ARROW_OUTLINE = [
  0x001, 0x003, 0x005, 0x009, 0x011, 0x021, 0x041, 0x081,
  0x101, 0x201, 0x7c1, 0x049, 0x095, 0x093, 0x120, 0x1e0,
];
const ARROW_FILL = [
  0x000, 0x000, 0x002, 0x006, 0x00e, 0x01e, 0x03e, 0x07e,
  0x0fe, 0x1fe, 0x03e, 0x036, 0x062, 0x060, 0x0c0, 0x000,
];

function defaultArrowRGBA(): Uint8Array {
  const px = new Uint8Array(16 * 16 * 4);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const outline = (ARROW_OUTLINE[y] >> x) & 1;
      const fill = (ARROW_FILL[y] >> x) & 1;
      if (!outline && !fill) continue;
      const i = (y * 16 + x) * 4;
      const v = fill ? 255 : 0;
      px[i] = v;
      px[i + 1] = v;
      px[i + 2] = v;
      px[i + 3] = 255;
    }
  }
  return px;
}


/**
 * Enable the virtual cursor (input.cursor). Safe to call before mount —
 * sprite upload and the first setCursorPos run lazily on the next frame, so
 * plain top-level `enableCursor()` in an app entry file just works. Calling
 * again while enabled updates the options in place (theme switches swap the
 * sprite this way; an unchanged image/hotspot/size keeps the uploaded
 * texture). Returns a disposer that restores classic d-pad focus. Hosts
 * predating spec ops 27..29 keep the classic d-pad model — enabling the
 * cursor never takes input away.
 */
export function enableCursor(opts: CursorOptions = {}): () => void {
  const prev = cursor;
  // An in-flight press does not survive reconfiguration (the release edge
  // may be watching a different button afterwards — never strand `active:`).
  if (prev?.pressTarget) setPressedNode(null);
  const sprite: CursorSprite = {
    image: opts.image,
    hotspot: opts.hotspot ?? [0, 0],
    size: opts.size ?? [0, 0],
  };
  const sameSprite =
    prev !== null &&
    !prev.spriteDirty &&
    prev.sprite.image === sprite.image &&
    prev.sprite.hotspot[0] === sprite.hotspot[0] &&
    prev.sprite.hotspot[1] === sprite.hotspot[1] &&
    prev.sprite.size[0] === sprite.size[0] &&
    prev.sprite.size[1] === sprite.size[1];
  cursor = {
    x: opts.start ? opts.start[0] : prev ? prev.x : -1,
    y: opts.start ? opts.start[1] : prev ? prev.y : -1,
    vw: prev ? prev.vw : 0,
    vh: prev ? prev.vh : 0,
    speed: opts.speed ?? 240,
    dpadSpeed: opts.dpadSpeed ?? 0,
    button: opts.button ?? BTN.CIRCLE,
    pressTarget: null,
    tex: prev ? prev.tex : -1,
    sprite,
    spriteDirty: !sameSprite,
    target: null,
    gen: -1,
    fresh: true,
  };
  return disableCursor;
}

function disableCursor(): void {
  if (!cursor) return;
  const c = cursor;
  cursor = null;
  setPressedNode(null);
  if (focused) focusNode(null);
  if (c.tex >= 0) {
    const ops = getOps();
    ops.setCursor?.(-1, 0, 0, 0, 0);
    ops.freeTexture?.(c.tex);
  }
}

/** Cursor position (logical px); NaN while the cursor is disabled or not
 *  yet operating (before its first frame, or on a host without the ops). */
export function cursorX(): number {
  return cursor && cursor.x >= 0 ? cursor.x : NaN;
}

export function cursorY(): number {
  return cursor && cursor.y >= 0 ? cursor.y : NaN;
}

/** Lazy sprite init/swap: runs on the first frame after enableCursor (ops
 *  are guaranteed live here; enableCursor itself may run before mount). */
function cursorInitSprite(c: CursorState, ops: HostOps): void {
  const sprite = c.sprite;
  c.spriteDirty = false;
  const old = c.tex;
  let tex = -1;
  let blob: Uint8Array | null = null;
  if (typeof sprite.image === "string") {
    try {
      blob = pakGet(sprite.image);
    } catch (err) {
      if (getHost().strict) throw err;
      blob = null; // native hosts fall back to the built-in arrow
    }
  } else if (sprite.image) {
    blob = sprite.image;
  }
  if (blob) {
    tex = ops.uploadImgEntry ? ops.uploadImgEntry(blob) : uploadImgFallback(ops, blob);
    if (tex < 0 && getHost().strict) {
      throw new Error("enableCursor: cursor image rejected (malformed or RLE-only IMG entry)");
    }
  }
  if (tex < 0) {
    tex = ops.uploadTexture(defaultArrowRGBA(), 16, 16, PSM.PSM_8888);
  }
  c.tex = tex;
  ops.setCursor!(tex, sprite.hotspot[0], sprite.hotspot[1], sprite.size[0], sprite.size[1]);
  if (old >= 0 && old !== tex) ops.freeTexture?.(old);
}

/** Hosts without spec op 25: decode the 8-byte IMG header and upload the
 *  raw payload (index.ts's pak-image path). RLE payloads need the host-side
 *  decoder — report failure so the caller falls back to the arrow. */
function uploadImgFallback(ops: HostOps, blob: Uint8Array): number {
  if (blob.length < 8) return -1;
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  if (blob[5] & IMG_FLAG_RLE) return -1;
  return ops.uploadTexture(blob.subarray(8), dv.getUint16(0, true), dv.getUint16(2, true), blob[4]);
}

/** Mirror-tree lookup by native id (the hit-test result). O(subtree), but
 *  only runs once per frame on UI-sized trees. */
function findMirror(node: NodeMirror | null, id: number): NodeMirror | null {
  if (!node || id === 0) return null;
  if (node.id === id) return node;
  const kids = node.children;
  if (!Array.isArray(kids)) return null;
  for (let i = 0; i < kids.length; i++) {
    const found = findMirror(kids[i], id);
    if (found) return found;
  }
  return null;
}

/** Hit-test search space: the whole mirror tree (app + overlay layers).
 *  Injected by render() like the input root — overlay content (Portal
 *  menus, modals) paints above the app and must resolve under the cursor. */
let hitRoot: NodeMirror | null = null;
let auxiliaryHitRoot: NodeMirror | null = null;

export function setHitRoot(r: NodeMirror | null): void {
  hitRoot = r;
}

export function setAuxiliaryHitRoot(r: NodeMirror | null): void {
  auxiliaryHitRoot = r;
}

/** The interaction target for a raw hit: the nearest focusable ancestor
 *  the active focus scope can see. Only an explicitly pushed scope
 *  restricts (modal backgrounds stay inert while a Modal's FocusScope is
 *  up); with no scope pushed, overlay focusables resolve like any other. */
function cursorTarget(hit: NodeMirror | null): NodeMirror | null {
  const scope =
    focusScopeStack.length > 0 ? focusScopeStack[focusScopeStack.length - 1] : null;
  let n = hit;
  while (n) {
    if (n.focusable && (!scope || isWithin(n, scope))) return n;
    n = n.parent;
  }
  return null;
}

/**
 * Resolve a screen point to the nearest FOCUSABLE node inside the active
 * focus scope — the cursor's hover resolution, callable for touch input
 * (the system OSK maps contacts through this). Null when the host has no
 * hitTest op or nothing focusable is under the point.
 */
export function hitFocusable(x: number, y: number, surface: SurfaceId = "primary"): NodeMirror | null {
  return cursorTarget(hitNode(x, y, surface));
}

/**
 * Nearest activation target for a touch contact: the hit FACT (or its query
 * fallback) walked up to the closest focusable in scope — the exact filter
 * cursor hover uses, so "what a tap can press" and "what a click can press"
 * are one authority. Null when nothing pressable owns the point.
 */
export function touchFocusable(
  x: number,
  y: number,
  fact: number | undefined,
  surface: SurfaceId = "primary",
): NodeMirror | null {
  return cursorTarget(resolveTouchHit(x, y, fact, surface));
}

/**
 * Raw topmost-ink mirror under a screen point — hitFocusable without the
 * focusable/scope filter. The gesture layer resolves region ownership with
 * this (a pan region is rarely focusable itself). Null when the host has no
 * hitTest op or nothing painted claims the point.
 */
export function hitNode(x: number, y: number, surface: SurfaceId = "primary"): NodeMirror | null {
  const ops = getOps();
  const query = surface === "auxiliary" ? ops.hitTestAuxiliary : ops.hitTest;
  const searchRoot = surface === "auxiliary" ? auxiliaryHitRoot : hitRoot ?? root;
  if (!query || !searchRoot) return null;
  return findMirror(searchRoot, query(x, y));
}

/**
 * Touch-path hit authority (docs/TOUCH.md). The host-delivered FACT wins when
 * present (`TouchContact.hit` — resolved once at the contact's down edge and
 * carried); otherwise ONE cold query, preferring the bounds op (42) and
 * tolerating ink-only hosts (op 27). Null = nothing claimed / no channel at
 * all — region rects are the caller's last resort.
 */
export function resolveTouchHit(
  x: number,
  y: number,
  fact: number | undefined,
  surface: SurfaceId = "primary",
): NodeMirror | null {
  const searchRoot = surface === "auxiliary" ? auxiliaryHitRoot : hitRoot ?? root;
  if (!searchRoot) return null;
  if (fact !== undefined) {
    return fact === 0 ? null : findMirror(searchRoot, fact);
  }
  const ops = getOps();
  const query = surface === "auxiliary"
    ? ops.hitTestBoundsAuxiliary ?? ops.hitTestAuxiliary
    : ops.hitTestBounds ?? ops.hitTest;
  if (!query) return null;
  return findMirror(searchRoot, query(x, y));
}

/** One cursor-mode frame. Returns false when the host predates the cursor
 *  ops — the caller then falls through to the classic d-pad model, so a
 *  stale host never loses input. */
function cursorFrame(buttons: number, pressed: number, released: number): boolean {
  const c = cursor!;
  const ops = getOps();
  if (!ops.hitTest || !ops.setCursor || !ops.setCursorPos) return false;
  if (c.vw === 0) {
    // First frame: latch the logical viewport and center an unplaced cursor.
    const vp = hostViewport(ops);
    c.vw = vp ? vp.w : SCREEN_W;
    c.vh = vp ? vp.h : SCREEN_H;
    if (c.x < 0) {
      c.x = Math.floor(c.vw / 2);
      c.y = Math.floor(c.vh / 2);
    }
  }
  if (c.spriteDirty) cursorInitSprite(c, ops);

  // -- steer: px per VIRTUAL second, hz-invariant via the tick count -------
  let vx = analogX() * c.speed;
  let vy = analogY() * c.speed;
  if (c.dpadSpeed > 0 && vx === 0 && vy === 0) {
    if (buttons & BTN.LEFT) vx = -c.dpadSpeed;
    if (buttons & BTN.RIGHT) vx = c.dpadSpeed;
    if (buttons & BTN.UP) vy = -c.dpadSpeed;
    if (buttons & BTN.DOWN) vy = c.dpadSpeed;
  }
  let moved = c.fresh;
  if (vx !== 0 || vy !== 0) {
    const dt = ticksPerFrame() / TICKS_PER_SECOND;
    const nx = Math.min(Math.max(c.x + vx * dt, 0), c.vw - 1);
    const ny = Math.min(Math.max(c.y + vy * dt, 0), c.vh - 1);
    if (nx !== c.x || ny !== c.y) {
      c.x = nx;
      c.y = ny;
      moved = true;
    }
  }
  if (moved) ops.setCursorPos(c.x, c.y);

  // -- hover IS focus. The hit test (an FFI + core tree walk) only runs
  //    when it can have a new answer: the cursor moved, the press button
  //    edged (clicks always resolve against live geometry), or inputGen
  //    ticked (tree/style/focusable/scope changes). A parked cursor over a
  //    quiet tree costs nothing per frame. -----------------------------------
  const edges = (pressed | released) & c.button;
  const gen = inputGen;
  if (moved || edges !== 0 || gen !== c.gen) {
    c.gen = gen;
    c.fresh = false;
    c.target = cursorTarget(findMirror(hitRoot ?? root, ops.hitTest(c.x, c.y)));
  }
  const target = c.target;
  if (target !== focused) focusNode(target);

  // -- press/click on the configured button ---------------------------------
  if (pressed & c.button && target) {
    c.pressTarget = target;
  }
  if (c.pressTarget) {
    // Held: pressed visuals only while still over the armed node (leave to
    // pop back up, re-enter to re-press).
    setPressedNode(target === c.pressTarget ? c.pressTarget : null);
    if (released & c.button) {
      const fire = target === c.pressTarget;
      c.pressTarget = null;
      setPressedNode(null);
      if (fire) firePress();
    }
  } else if (released & c.button) {
    // A press that predates the cursor (classic-mode latch, or a press held
    // across enableCursor) still releases its `active:` visual.
    setPressedNode(null);
  }
  return true;
}

// ---- per-frame entry ----------------------------------------------------------

/**
 * Edge-detect the button bitmask (spec BTN) and run navigation/press. Called
 * once per frame from globalThis.frame (index.ts) before the renderer sweep.
 * With the virtual cursor enabled, the cursor state machine replaces d-pad
 * traversal and the CIRCLE press entirely.
 */
export function handleFrame(buttons: number): void {
  const pressed = buttons & ~prevButtons;
  const released = prevButtons & ~buttons;
  prevButtons = buttons;
  if (cursor && cursorFrame(buttons, pressed, released)) return;
  if (released & BTN.CIRCLE) setPressedNode(null);
  if (pressed === 0) return;
  if (pressed & BTN.DOWN) moveFocus("down");
  if (pressed & BTN.RIGHT) moveFocus("right");
  if (pressed & BTN.UP) moveFocus("up");
  if (pressed & BTN.LEFT) moveFocus("left");
  if (pressed & BTN.CIRCLE) {
    setPressedNode(focused);
    firePress();
  }
}
