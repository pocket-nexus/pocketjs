// DeepZoom — a pan/zoom tiled-canvas component (the "map viewer" primitive).
//
// Renders a baked TILESET pyramid (spec.ts; produced by a cooker like
// apps/zoomlab/gen-assets.ts, or the Figma cooker in the
// github.com/pocket-nexus/pocket-figma repo) with smooth analog-nub panning
// and trigger zooming, streaming tiles on demand and freeing them on the way
// out.
//
// Structure (three nodes, same reasoning as Gallery's two):
//   - an untransformed overflow-hidden container (the scissor is taken from
//     the node's own world box — the clipping node must not move), painted
//     with the document background color;
//   - an "overview" world: the coarsest level, a handful of tiles, mounted
//     once and never evicted. It sits UNDER the active level, so a fine tile
//     that hasn't streamed in yet shows its low-res self instead of a hole;
//   - an "active" world: the level matching the current zoom. Tiles are
//     managed IMPERATIVELY (createElement/insertNode/removeNode) — a Solid
//     <For> would re-run reconciliation for every pan step, which a 333 MHz
//     interpreter cannot afford. Per-frame motion is three hot.prop writes
//     per world (translateX/translateY/scale — paint-only, native-ticked).
//
// Solid tiles (whitespace — most of a wireframe page) never load textures:
// the baked manifest says "uniform color", and they mount as plain Views.
// The view state (center/zoom/velocities) integrates in onFrame from the
// frame's button mask + analog value only, so a given input tape always
// reproduces the same trajectory (docs/DETERMINISM.md).

import { onCleanup, type JSX as SolidJSX } from "solid-js";
import { BTN, ENUMS, SCREEN_H, SCREEN_W } from "../../contracts/spec/spec.ts";
import { ticksPerFrame, TICKS_PER_SECOND } from "./clock.ts";
import { getOps, hostViewport } from "./host.ts";
import { analogX, analogY, onFrame } from "./frame.ts";
import * as hot from "./hot.ts";
import { platform } from "./platform.ts";
import {
  createElement,
  detachNode,
  insertNode,
  setProp,
  type NodeMirror,
} from "./renderer.ts";
import { freeTileTexture, loadTileTexture } from "./tiles.ts";

// ---------------------------------------------------------------------------
// Baked-manifest shape (what a cooker's generated tiles.ts exports)
// ---------------------------------------------------------------------------

export interface TileLevel {
  /** doc px -> level px factor (level pixels = doc pixels * scale). */
  scale: number;
  cols: number;
  rows: number;
  /** TILESET pak key (`ui:tile.<name>`). */
  key: string;
  /** Row-major tile grid, one char per tile:
   *  '.' = document background (nothing mounts), '#' = textured tile,
   *  'a'-'z'/'A'-'Z' = solid tile colored `solids[charIndex]`. */
  grid: string[];
  /** ABGR colors for the solid chars. */
  solids: number[];
}

export interface TileDoc {
  name: string;
  /** Content size in doc px (tile grids cover [0,w] x [0,h]). */
  w: number;
  h: number;
  /** ABGR background. */
  bg: number;
  /** Tile edge in level px (256 for the standard cooker). */
  tile: number;
  /** Ordered finest (largest scale) first; last level fits one screen. */
  levels: TileLevel[];
}

export interface DeepZoomView {
  zoom: number;
  minZoom: number;
  maxZoom: number;
  level: number;
  /** Current document-space center, useful for HUDs and deterministic input telemetry. */
  centerX: number;
  centerY: number;
}

/** One screen-space direct-manipulation step supplied by an app gesture
 * recognizer. Positive pan moves the document right/down; zoom is relative
 * and remains anchored under the supplied logical viewport coordinate. */
export interface DeepZoomGesture {
  readonly panX: number;
  readonly panY: number;
  readonly zoomFactor?: number;
  readonly anchorX?: number;
  readonly anchorY?: number;
}

export interface DeepZoomProps {
  doc: TileDoc;
  /**
   * Fixed viewport size. When both are omitted, DeepZoom follows the live
   * logical viewport published by the host and falls back to the PSP screen.
   */
  width?: number;
  height?: number;
  /** Textured-tile loads per frame (decode+upload budget; default 2). */
  loadBudget?: number;
  /** Extra tile ring mounted beyond the visible window (default 1). */
  prefetch?: number;
  /** Bind pan/zoom input internally (default true). */
  bindInput?: boolean;
  /** Optional per-frame direct manipulation. Returning null leaves the
   * controller integrator in charge; returning a gesture cancels its glide
   * for that frame and applies pan/pinch around the provided anchor. */
  gestureSource?: () => DeepZoomGesture | null;
  /** Called each frame after integration (HUD hookup — gate writes with
   *  hot.text/hot.prop on the receiving side). */
  onView?: (view: DeepZoomView) => void;
}

// Motion constants are PER TICK and scaled by the virtual-clock policy
// (ticksPerFrame = TICKS_PER_SECOND/simulationHz) each frame, so a one-second
// nub hold pans the same document distance at every simulationHz — DeepZoom
// trajectories obey the same subsampling property as core animations
// (docs/DETERMINISM.md). They are quoted for the spec 1/60 s tick and
// re-based once here for a realm that declared another rate, so a second of
// held input also travels the same distance at every tick rate.
const TICK_SCALE = 60 / TICKS_PER_SECOND;
const perTick = (at60: number) => (TICK_SCALE === 1 ? at60 : at60 ** TICK_SCALE);
// Screen-space pan speed at full nub tilt (px/tick) — zoom-invariant.
const PAN_SPEED = 7 * TICK_SCALE;
// D-pad pan speed (px/tick) for stickless hosts.
const DPAD_SPEED = 5 * TICK_SCALE;
// Zoom factor per tick while a trigger is held (~×2 in 20 ticks at 60 Hz).
const ZOOM_STEP = perTick(1.035);
// Velocity smoothing per tick: approach factor toward the input target, and
// the decay once input releases (momentum glide). The approach rebase runs
// through the complement, so its 60 path takes the early return explicitly —
// 1 - (1 - 0.35) recovering 0.35 exactly is float luck, not construction.
const VEL_APPROACH = TICK_SCALE === 1 ? 0.35 : 1 - perTick(1 - 0.35);
const VEL_DECAY = perTick(0.88);
// Switch mip level only when the ideal level differs this long (frames), so
// a zoom hovering at a boundary doesn't thrash mount/unmount.
const LEVEL_DEBOUNCE = 8;

interface MountedTile {
  node: NodeMirror;
  /** Texture handle (>= 0) once streamed; -1 for solid/pending. */
  handle: number;
  textured: boolean;
}

export function DeepZoom(props: DeepZoomProps): SolidJSX.Element {
  const fixedViewport = props.width !== undefined || props.height !== undefined;
  const initialViewport = fixedViewport ? null : hostViewport(getOps());
  let vw = props.width ?? initialViewport?.w ?? SCREEN_W;
  let vh = props.height ?? initialViewport?.h ?? SCREEN_H;
  const budget = props.loadBudget ?? 2;
  const prefetch = props.prefetch ?? 1;
  const bind = props.bindInput ?? true;

  // ---- nodes ---------------------------------------------------------------
  const container = createElement("view");
  setProp(container, "style", {
    width: vw,
    height: vh,
    overflow: ENUMS.Overflow.Hidden,
    bgColor: props.doc.bg,
  });
  const makeWorld = (): NodeMirror => {
    const world = createElement("view");
    setProp(world, "style", {
      posType: ENUMS.PosType.Absolute,
      insetT: 0,
      insetL: 0,
      width: 1, // real size set per doc/level below
      height: 1,
      originX: -0.5, // transform about the top-left corner, not the center
      originY: -0.5,
    });
    insertNode(container, world);
    return world;
  };
  const overviewWorld = makeWorld();
  const activeWorld = makeWorld();

  // ---- view state (integrated in onFrame; deterministic) --------------------
  let doc = props.doc;
  let zoom = 1;
  let minZoom = 0.01;
  let maxZoom = 1;
  let cx = 0;
  let cy = 0;
  let vx = 0; // doc px / frame
  let vy = 0;
  let level = -1; // index into doc.levels currently mounted in activeWorld
  let idealRun = 0; // debounce counter for level switches
  let lastIdeal = -1;

  // ---- imperative tile bookkeeping ------------------------------------------
  // key = (ty * cols + tx) within the CURRENT level.
  const mounted = new Map<number, MountedTile>();
  const overviewMounted: MountedTile[] = [];
  let queue: number[] = []; // textured tiles awaiting stream-in, near-first
  let win = { x0: 0, y0: 0, x1: -1, y1: -1 }; // mounted tile window (inclusive)

  const solidColor = (lv: TileLevel, ch: string): number | undefined => {
    const c = ch.charCodeAt(0);
    const idx =
      c >= 97 && c <= 122 ? c - 97 : c >= 65 && c <= 90 ? c - 65 + 26 : -1;
    return idx >= 0 && idx < lv.solids.length ? lv.solids[idx] : undefined;
  };

  const mountTile = (
    parent: NodeMirror,
    lv: TileLevel,
    tx: number,
    ty: number,
  ): MountedTile | null => {
    const ch = lv.grid[ty]?.[tx] ?? ".";
    if (ch === ".") return null;
    const t = doc.tile;
    if (ch === "#") {
      const node = createElement("image");
      setProp(node, "style", {
        posType: ENUMS.PosType.Absolute,
        insetL: tx * t,
        insetT: ty * t,
        width: t,
        height: t,
      });
      insertNode(parent, node);
      return { node, handle: -1, textured: true };
    }
    const color = solidColor(lv, ch);
    if (color === undefined) return null;
    const node = createElement("view");
    setProp(node, "style", {
      posType: ENUMS.PosType.Absolute,
      insetL: tx * t,
      insetT: ty * t,
      width: t,
      height: t,
      bgColor: color,
    });
    insertNode(parent, node);
    return { node, handle: -1, textured: false };
  };

  const unmountTile = (parent: NodeMirror, m: MountedTile): void => {
    detachNode(parent, m.node); // the end-of-frame sweep destroys it
    freeTileTexture(m.handle);
  };

  const clearActive = (): void => {
    for (const m of mounted.values()) unmountTile(activeWorld, m);
    mounted.clear();
    queue = [];
    win = { x0: 0, y0: 0, x1: -1, y1: -1 };
  };

  // ---- overview (coarsest level; streamed once, then pinned) -----------------
  const mountOverview = (): void => {
    const lv = doc.levels[doc.levels.length - 1];
    setProp(overviewWorld, "style", {
      width: lv.cols * doc.tile,
      height: lv.rows * doc.tile,
    });
    for (let ty = 0; ty < lv.rows; ty++) {
      for (let tx = 0; tx < lv.cols; tx++) {
        const m = mountTile(overviewWorld, lv, tx, ty);
        if (!m) continue;
        if (m.textured) {
          m.handle = loadTileTexture(lv.key, ty * lv.cols + tx);
          if (m.handle >= 0) getOps().setImage(m.node.id, m.handle);
        }
        overviewMounted.push(m);
      }
    }
  };

  const updateZoomBounds = (): void => {
    minZoom = Math.min(vw / doc.w, vh / doc.h);
    // Preserve the same physical sampling ceiling on every target. A
    // density-specific pyramid advertises proportionally larger level scales
    // and therefore keeps the same logical zoom range automatically.
    maxZoom = Math.max(minZoom, (doc.levels[0].scale * 2) / platform.pixelRatio);
  };

  const atFitZoom = (): boolean =>
    Math.abs(zoom - minZoom) <=
      Number.EPSILON * 8 * Math.max(1, Math.abs(zoom), Math.abs(minZoom));

  const syncLiveViewport = (): void => {
    if (fixedViewport) return;
    const viewport = hostViewport(getOps());
    if (
      !viewport ||
      !Number.isFinite(viewport.w) ||
      !Number.isFinite(viewport.h) ||
      viewport.w <= 0 ||
      viewport.h <= 0 ||
      (viewport.w === vw && viewport.h === vh)
    ) {
      return;
    }

    const followFit = atFitZoom();
    vw = viewport.w;
    vh = viewport.h;
    setProp(container, "style", { width: vw, height: vh });
    updateZoomBounds();
    zoom = followFit
      ? minZoom
      : Math.min(maxZoom, Math.max(minZoom, zoom));
  };

  // ---- doc (re)initialization -----------------------------------------------
  const initDoc = (d: TileDoc): void => {
    clearActive();
    for (const m of overviewMounted.splice(0)) unmountTile(overviewWorld, m);
    doc = d;
    setProp(container, "style", { bgColor: doc.bg });
    updateZoomBounds();
    zoom = minZoom;
    cx = doc.w / 2;
    cy = doc.h / 2;
    vx = 0;
    vy = 0;
    level = -1;
    lastIdeal = -1;
    idealRun = 0;
    mountOverview();
  };
  initDoc(props.doc);

  // ---- per-frame integration --------------------------------------------------
  const idealLevel = (): number => {
    // Finest level that still DOWNSCALES in physical pixels. DrawList zoom is
    // logical, so include the resolved target density when choosing a mip.
    const ls = doc.levels;
    const physicalZoom = zoom * platform.pixelRatio;
    for (let i = ls.length - 1; i >= 1; i--) {
      if (ls[i].scale >= physicalZoom) return i;
    }
    return 0;
  };

  const syncWindow = (): void => {
    const lv = doc.levels[level];
    const t = doc.tile;
    // Visible doc rect -> level tile range, plus the prefetch ring.
    const halfW = vw / 2 / zoom;
    const halfH = vh / 2 / zoom;
    const x0 = Math.max(0, Math.floor(((cx - halfW) * lv.scale) / t) - prefetch);
    const y0 = Math.max(0, Math.floor(((cy - halfH) * lv.scale) / t) - prefetch);
    const x1 = Math.min(lv.cols - 1, Math.floor(((cx + halfW) * lv.scale) / t) + prefetch);
    const y1 = Math.min(lv.rows - 1, Math.floor(((cy + halfH) * lv.scale) / t) + prefetch);
    if (x0 === win.x0 && y0 === win.y0 && x1 === win.x1 && y1 === win.y1) return;
    win = { x0, y0, x1, y1 };
    // Evict tiles that left the window…
    for (const [k, m] of mounted) {
      const tx = k % lv.cols;
      const ty = (k / lv.cols) | 0;
      if (tx < x0 || tx > x1 || ty < y0 || ty > y1) {
        unmountTile(activeWorld, m);
        mounted.delete(k);
      }
    }
    // …mount the new ones, queueing texture streams center-out.
    const fresh: number[] = [];
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const k = ty * lv.cols + tx;
        if (mounted.has(k)) continue;
        const m = mountTile(activeWorld, lv, tx, ty);
        if (!m) continue;
        mounted.set(k, m);
        if (m.textured) fresh.push(k);
      }
    }
    if (fresh.length) {
      queue = queue.filter((k) => mounted.has(k) && mounted.get(k)!.handle < 0);
      queue.push(...fresh);
      const ccx = ((cx * lv.scale) / t) - 0.5;
      const ccy = ((cy * lv.scale) / t) - 0.5;
      queue.sort((a, b) => {
        const ax = (a % lv.cols) - ccx;
        const ay = ((a / lv.cols) | 0) - ccy;
        const bx = (b % lv.cols) - ccx;
        const by = ((b / lv.cols) | 0) - ccy;
        return ax * ax + ay * ay - (bx * bx + by * by);
      });
    }
  };

  const switchLevel = (next: number): void => {
    clearActive();
    level = next;
    const lv = doc.levels[level];
    setProp(activeWorld, "style", {
      width: lv.cols * doc.tile,
      height: lv.rows * doc.tile,
    });
    syncWindow();
  };

  onFrame((buttons) => {
    syncLiveViewport();
    if (doc !== props.doc) initDoc(props.doc); // app swapped pages

    // Virtual-clock scaling: TICKS_PER_SECOND/simulationHz ticks elapse per
    // frame. The integrator runs ONCE PER TICK (not once per frame with a dt
    // factor) so a low-hz trajectory is the exact subsample of the full-rate
    // one — the same discrete recurrence, evaluated at the same tick indices,
    // from inputs held constant across the frame (docs/DETERMINISM.md).
    const dt = ticksPerFrame();

    const gesture = props.gestureSource?.() ?? null;
    if (gesture) {
      // Gesture deltas live in screen/logical pixels. Move the center in the
      // opposite document direction so the content tracks the finger.
      const oldZoom = zoom;
      cx -= gesture.panX / oldZoom;
      cy -= gesture.panY / oldZoom;

      const factor = gesture.zoomFactor ?? 1;
      if (Number.isFinite(factor) && factor > 0 && factor !== 1) {
        const anchorX = gesture.anchorX ?? vw / 2;
        const anchorY = gesture.anchorY ?? vh / 2;
        const anchorDocX = cx + (anchorX - vw / 2) / oldZoom;
        const anchorDocY = cy + (anchorY - vh / 2) / oldZoom;
        zoom = Math.min(maxZoom, Math.max(minZoom, oldZoom * factor));
        cx = anchorDocX - (anchorX - vw / 2) / zoom;
        cy = anchorDocY - (anchorY - vh / 2) / zoom;
      }
      vx = 0;
      vy = 0;
    } else if (bind) {
      // pan: nub (analog) or d-pad, at a zoom-invariant screen speed
      let ix = analogX();
      let iy = analogY();
      if (ix === 0 && iy === 0) {
        if (buttons & BTN.LEFT) ix = -DPAD_SPEED / PAN_SPEED;
        if (buttons & BTN.RIGHT) ix = DPAD_SPEED / PAN_SPEED;
        if (buttons & BTN.UP) iy = -DPAD_SPEED / PAN_SPEED;
        if (buttons & BTN.DOWN) iy = DPAD_SPEED / PAN_SPEED;
      }
      for (let t = 0; t < dt; t++) {
        const tx = (ix * PAN_SPEED) / zoom;
        const ty = (iy * PAN_SPEED) / zoom;
        if (ix !== 0 || iy !== 0) {
          vx += (tx - vx) * VEL_APPROACH;
          vy += (ty - vy) * VEL_APPROACH;
        } else {
          vx *= VEL_DECAY;
          vy *= VEL_DECAY;
          if (Math.abs(vx) * zoom < 0.05) vx = 0;
          if (Math.abs(vy) * zoom < 0.05) vy = 0;
        }
        cx += vx;
        cy += vy;

        // zoom: hold triggers; anchor = screen center
        if (buttons & BTN.RTRIGGER) zoom = Math.min(maxZoom, zoom * ZOOM_STEP);
        if (buttons & BTN.LTRIGGER) zoom = Math.max(minZoom, zoom / ZOOM_STEP);
      }
    }
    // CROSS: reset to fit even if a contact is currently held.
    if (bind && buttons & BTN.CROSS) {
      zoom = minZoom;
      cx = doc.w / 2;
      cy = doc.h / 2;
      vx = 0;
      vy = 0;
    }

    // clamp the center so content cannot be panned fully off screen; when a
    // whole axis fits on screen, lock it centered
    const halfW = vw / 2 / zoom;
    const halfH = vh / 2 / zoom;
    cx = halfW * 2 >= doc.w ? doc.w / 2 : Math.min(doc.w - halfW, Math.max(halfW, cx));
    cy = halfH * 2 >= doc.h ? doc.h / 2 : Math.min(doc.h - halfH, Math.max(halfH, cy));

    // debounced mip switch
    const ideal = idealLevel();
    idealRun = ideal === lastIdeal ? idealRun + 1 : 0;
    lastIdeal = ideal;
    if (level < 0 || (ideal !== level && idealRun >= LEVEL_DEBOUNCE)) {
      switchLevel(ideal);
    } else {
      syncWindow();
    }

    // stream queued tiles within this frame's budget
    let loads = budget;
    while (loads > 0 && queue.length > 0) {
      const k = queue.shift()!;
      const m = mounted.get(k);
      if (!m || !m.textured || m.handle >= 0) continue;
      const lv = doc.levels[level];
      m.handle = loadTileTexture(lv.key, k);
      if (m.handle >= 0) getOps().setImage(m.node.id, m.handle);
      loads--;
    }

    // motion: three paint-only native props per world, gated by hot.prop
    const tx0 = vw / 2 - cx * zoom;
    const ty0 = vh / 2 - cy * zoom;
    const ov = doc.levels[doc.levels.length - 1];
    hot.prop(overviewWorld, "translateX", tx0);
    hot.prop(overviewWorld, "translateY", ty0);
    hot.prop(overviewWorld, "scale", zoom / ov.scale);
    const lv = doc.levels[level];
    hot.prop(activeWorld, "translateX", tx0);
    hot.prop(activeWorld, "translateY", ty0);
    hot.prop(activeWorld, "scale", zoom / lv.scale);

    props.onView?.({ zoom, minZoom, maxZoom, level, centerX: cx, centerY: cy });
  });

  onCleanup(() => {
    clearActive();
    for (const m of overviewMounted.splice(0)) unmountTile(overviewWorld, m);
  });

  return container as unknown as SolidJSX.Element;
}
