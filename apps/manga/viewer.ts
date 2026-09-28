// apps/manga/viewer.ts — the pack-backed, camera-driven page viewer.
//
// A page is a baked RGB565 tile pyramid in a PRP resource pack. The viewer
// streams tiles through the app's resource collection on demand and never
// through Solid's reconciler: one `image` node per visible tile is created,
// attached and detached imperatively, and each frame writes only the world's
// translateX/translateY/scale through hot.prop (paint-only, no relayout).
//
// Two worlds are stacked: the coarse fit level (level 0) covers the visible
// viewport as an overview, so a sharp tile still loading shows its low-res
// counterpart; the level matching the camera zoom is streamed above it.
// Tile demand order is overview first, then the visible sharp window.
// Motion runs through the shared
// createPageCamera so pan inertia and the zoom tween match the tile viewer.

import { onCleanup, type JSX as SolidJSX } from "solid-js";
import { BTN, ENUMS } from "../../contracts/spec/spec.ts";
import { createGesture } from "@pocketjs/framework/gesture";
import { getOps } from "@pocketjs/framework/host";
import { analogX, analogY, onFrame } from "@pocketjs/framework/lifecycle";
import { simulationHz } from "@pocketjs/framework/clock";
import * as hot from "@pocketjs/framework/hot";
import { createElement, detachNode, insertNode, setProp, type NodeMirror } from "@pocketjs/framework/renderer";
import { createPageCamera } from "./camera.ts";
import type { ResourceView } from "@pocketjs/framework/resource-view";
import type { TextureResource } from "@pocketjs/framework/resource";
import {
  TILE,
  pageStep,
  pageTile,
  pickLevel,
  windowTiles,
  type SeriesMeta,
  type TileAddress,
} from "./model.ts";

/** Screen-space pan speed at full stick tilt or a held d-pad (px/s). */
const PAN_SPEED = 900;
/** Log2 zoom per trigger press (~x1.41). */
const ZOOM_STEP = 0.5;
/** Frames the ideal level must hold before the active world is remounted. */
const LEVEL_DEBOUNCE = 4;
/** Whole tiles of prefetch beyond the visible window. */
const PREFETCH = 1;
/** Logical size of the auxiliary (lower) screen the touch gestures arrive on. */
const AUX_W = 320;
const AUX_H = 240;

export interface ViewerDemand {
  input: TileAddress;
  priority: number;
}
export interface ReaderTileStatus {
  previewReady: number; previewTotal: number; previewFailed: number;
  detailReady: number; detailTotal: number; detailFailed: number;
  failed: TileAddress[];
}

/** Initial framing: fit the page width (default), the whole page, or 1:1. */
export type ViewMode = "width" | "page" | "native";

export interface PageViewerProps {
  meta: SeriesMeta;
  page: number;
  /** The page collection view the app created; the viewer reads values only. */
  view: ResourceView<TileAddress, TextureResource>;
  width: number;
  height: number;
  /** Initial framing; changing it re-opens the page. Default "width". */
  mode?: ViewMode;
  /** Called each frame with the ordered tile demand (overview first). */
  onDemand: (list: ViewerDemand[]) => void;
  /** At fit zoom a LEFT/RIGHT press requests a page turn instead of a pan. */
  onPage: (delta: number) => void;
  onStatus?: (status: ReaderTileStatus) => void;
  onView?: (info: { zoom: number; level: number }) => void;
}

interface Mounted {
  node: NodeMirror;
  input: TileAddress;
  handle: number;
}

export function PageViewer(props: PageViewerProps): SolidJSX.Element {
  const container = createElement("view");
  setProp(container, "style", {
    width: props.width,
    height: props.height,
    overflow: ENUMS.Overflow.Hidden,
    bgColor: 0xff000000,
  });
  const makeWorld = (): NodeMirror => {
    const world = createElement("view");
    setProp(world, "style", {
      posType: ENUMS.PosType.Absolute,
      insetT: 0,
      insetL: 0,
      width: 1,
      height: 1,
      originX: -0.5, // transform about the top-left corner, not the center
      originY: -0.5,
    });
    insertNode(container, world);
    return world;
  };
  const overviewWorld = makeWorld();
  const activeWorld = makeWorld();

  // Stable TileAddress identity per pack entry: the resource snapshot compares
  // by object identity, so freshly built addresses each frame would rebuild
  // the demand union every frame.
  const addresses = new Map<string, TileAddress>();
  const address = (pack: string, entry: number): TileAddress => {
    const key = `${pack}/${entry}`;
    let hit = addresses.get(key);
    if (!hit) {
      hit = { pack, entry };
      addresses.set(key, hit);
    }
    return hit;
  };

  let cam = makeCamera(props.meta);
  let activeLevel = -1;
  let lastIdeal = -1;
  let idealRun = 0;
  let prevButtons = 0;
  let lastMeta: SeriesMeta | undefined;
  let lastPage = -1;
  let lastMode: ViewMode | undefined;

  const overview = new Map<number, Mounted>();
  const active = new Map<number, Mounted>();
  const demand: ViewerDemand[] = [];
  let nextPreview: TileAddress[] = [];
  let detailStarted = false;
  let settledFrames = 0;

  function modeZoom(meta: SeriesMeta): number {
    const max = Math.max(0, Math.log2(props.width / meta.pageW), Math.log2(meta.levels[meta.levels.length - 1]!.scale));
    if (props.mode === "native") return max;
    if (props.mode === "page") {
      return Math.min(0, Math.log2(props.width / meta.pageW), Math.log2(props.height / meta.pageH));
    }
    return Math.log2(props.width / meta.pageW);
  }

  function makeCamera(meta: SeriesMeta) {
    const max = Math.max(0, Math.log2(props.width / meta.pageW), Math.log2(meta.levels[meta.levels.length - 1]!.scale));
    const fitPage = Math.min(0, Math.log2(props.width / meta.pageW), Math.log2(props.height / meta.pageH));
    return createPageCamera({
      width: props.width,
      height: props.height,
      x: meta.pageW / 2,
      y: Math.min(meta.pageH / 2, props.height / (2 * 2 ** modeZoom(meta))),
      zoom: modeZoom(meta),
      minZoom: Math.min(0, fitPage),
      maxZoom: max,
      bounds: { width: meta.pageW, height: meta.pageH },
    });
  }

  const imageAt = (tx: number, ty: number): NodeMirror => {
    const node = createElement("image");
    setProp(node, "style", {
      posType: ENUMS.PosType.Absolute,
      insetL: tx * TILE,
      insetT: ty * TILE,
      width: TILE,
      height: TILE,
    });
    return node;
  };

  const mountOverview = (meta: SeriesMeta, _page: number) => {
    for (const m of overview.values()) detachNode(overviewWorld, m.node);
    overview.clear();
    const lv = meta.levels[0]!;
    setProp(overviewWorld, "style", { width: lv.cols * TILE, height: lv.rows * TILE });
  };
  function syncTiles(world: NodeMirror, mounted: Map<number, Mounted>, tiles: ReturnType<typeof windowTiles>) {
    // Each layer owns at most 12 textures; both layers fit the 28-entry budget,
    // including old, tall SD packs whose overview is not a thumbnail.
    const want = new Map(tiles.slice(0, 12).map(tile => [tile.entry, tile]));
    for (const [key, m] of mounted) if (!want.has(key)) { detachNode(world, m.node); mounted.delete(key); }
    for (const [key, tile] of want) if (!mounted.has(key)) {
      const node = imageAt(tile.tx, tile.ty); insertNode(world, node);
      mounted.set(key, { node, input: address(tile.pack, tile.entry), handle: -1 });
    }
  }

  const clearActive = () => {
    for (const m of active.values()) detachNode(activeWorld, m.node);
    active.clear();
    activeLevel = -1;
    detailStarted = false;
  };

  const switchLevel = (meta: SeriesMeta, next: number) => {
    for (const m of active.values()) detachNode(activeWorld, m.node);
    active.clear();
    activeLevel = next;
    detailStarted = false;
    if (next <= 0) return; // level 0 is the pinned overview
    const lv = meta.levels[next]!;
    setProp(activeWorld, "style", { width: lv.cols * TILE, height: lv.rows * TILE });
  };

  const initDoc = (meta: SeriesMeta, page: number) => {
    clearActive();
    addresses.clear();
    cam = makeCamera(meta);
    mountOverview(meta, page);
    nextPreview = [];
    settledFrames = 0;
    if (page + 1 < meta.pages) {
      const next = makeCamera(meta).view(), scale = 2 ** next.zoom;
      nextPreview = windowTiles(meta, page + 1, 0,
        next.x - props.width / 2 / scale, next.y - props.height / 2 / scale,
        props.width / scale, props.height / scale, 0).map(tile => address(tile.pack, tile.entry));
    }
    lastIdeal = -1;
    idealRun = 0;
  };
  initDoc(props.meta, props.page);

  onFrame((buttons) => {
    const meta = props.meta;
    if (meta !== lastMeta || props.page !== lastPage || props.mode !== lastMode) {
      lastMeta = meta;
      lastPage = props.page;
      lastMode = props.mode;
      initDoc(meta, props.page);
    }

    const view = cam.view();
    const scale = 2 ** view.zoom;
    const atFit = meta.pageW * scale <= props.width + 1e-6;

    // Pan: stick when tilted, otherwise the d-pad. At fit, the d-pad's left
    // and right turn pages instead.
    let dirX = analogX();
    let dirY = analogY();
    if (dirX === 0 && dirY === 0) {
      if (buttons & BTN.LEFT) dirX -= 1;
      if (buttons & BTN.RIGHT) dirX += 1;
      if (buttons & BTN.UP) dirY -= 1;
      if (buttons & BTN.DOWN) dirY += 1;
    }
    if (atFit) {
      if (buttons & BTN.LEFT && !(prevButtons & BTN.LEFT)) props.onPage(-pageStep(meta.direction));
      if (buttons & BTN.RIGHT && !(prevButtons & BTN.RIGHT)) props.onPage(pageStep(meta.direction));
      dirX = 0;
    }
    if (buttons & BTN.ZL && !(prevButtons & BTN.ZL)) cam.zoomBy(-ZOOM_STEP);
    if (buttons & BTN.ZR && !(prevButtons & BTN.ZR)) cam.zoomBy(ZOOM_STEP);
    if (buttons & BTN.TRIANGLE && !(prevButtons & BTN.TRIANGLE)) cam.jump(meta.pageW / 2, Math.min(meta.pageH / 2, props.height / (2 * 2 ** modeZoom(meta))), modeZoom(meta));
    prevButtons = buttons;
    cam.step(Math.min(1 / 15, 1 / simulationHz()), -dirX * PAN_SPEED, -dirY * PAN_SPEED);

    // Level choice, debounced so a zoom hovering at a boundary does not thrash.
    const ideal = pickLevel(meta, scale);
    idealRun = ideal === lastIdeal ? idealRun + 1 : 0;
    lastIdeal = ideal;
    if (activeLevel < 0 || (ideal !== activeLevel && idealRun >= LEVEL_DEBOUNCE)) {
      switchLevel(meta, ideal);
    }

    // The visible document rectangle drives the active level's tile window.
    // Keep the overview focused on the camera viewport.
    const halfW = props.width / 2 / scale;
    const halfH = props.height / 2 / scale;
    // A whole tall-page overview can cost over a MiB on the 3DS Relay link.
    // Read the visible part first; the camera requests more as the user pans.
    const overviewTiles = windowTiles(meta, props.page, 0, view.x - halfW, view.y - halfH, halfW * 2, halfH * 2, 0);
    syncTiles(overviewWorld, overview, overviewTiles);
    const previewStates = [...overview.values()].map(m => props.view.state(m.input));
    const previewSettled = previewStates.every(state => state.status === "ready" || state.status === "error");
    let visibleDetail: TileAddress[] = [];
    if (activeLevel > 0 && (previewSettled || detailStarted)) {
      detailStarted = true;
      const visible = windowTiles(meta, props.page, activeLevel, view.x - halfW, view.y - halfH, halfW * 2, halfH * 2, 0);
      visibleDetail = visible.map(tile => address(tile.pack, tile.entry));
      const ready = visible.every(tile => !!props.view.value(address(tile.pack, tile.entry)));
      syncTiles(activeWorld, active, ready
        ? windowTiles(meta, props.page, activeLevel, view.x - halfW, view.y - halfH, halfW * 2, halfH * 2, PREFETCH)
        : visible);
    } else if (active.size) syncTiles(activeWorld, active, []);

    // Demand: the pinned overview is admitted first, the sharp window next.
    demand.length = 0;
    for (const m of overview.values()) demand.push({ input: m.input, priority: 0 });
    const visibleKeys = new Set(visibleDetail.map(input => `${input.pack}/${input.entry}`));
    for (const m of active.values()) demand.push({ input: m.input,
      priority: visibleKeys.has(`${m.input.pack}/${m.input.entry}`) ? 1 : 3 });
    const detailStates = visibleDetail.map(input => props.view.state(input));
    // The companion prepares later pages in RAM. On the narrow device link,
    // wait for the foreground to settle before transferring the next preview.
    const foregroundReady = previewStates.length > 0 && previewStates.every(state => state.status === "ready") &&
      (activeLevel <= 0 || detailStates.length > 0 && detailStates.every(state => state.status === "ready"));
    settledFrames = foregroundReady ? Math.min(45, settledFrames + 1) : 0;
    if (settledFrames >= 45)
      for (const input of nextPreview) demand.push({ input, priority: 2 });
    props.onDemand(demand);
    if (addresses.size > 96) {
      const used = new Set(demand.map(d => `${d.input.pack}/${d.input.entry}`));
      for (const key of addresses.keys()) if (!used.has(key)) addresses.delete(key);
    }

    // Bind any tile whose texture has arrived, then place the worlds.
    for (const m of overview.values()) {
      const value = props.view.value(m.input);
      if (value && value.handle !== m.handle) {
        getOps().setImage(m.node.id, value.handle);
        m.handle = value.handle;
      }
    }
    for (const m of active.values()) {
      const value = props.view.value(m.input);
      if (value && value.handle !== m.handle) {
        getOps().setImage(m.node.id, value.handle);
        m.handle = value.handle;
      }
    }
    const failed = [
      ...[...overview.values()].filter((_, i) => previewStates[i]?.status === "error"),
    ].map(m => m.input).concat(visibleDetail.filter((_, i) => detailStates[i]?.status === "error"));
    props.onStatus?.({
      previewReady: previewStates.filter(state => state.status === "ready").length,
      previewTotal: previewStates.length,
      previewFailed: previewStates.filter(state => state.status === "error").length,
      detailReady: detailStates.filter(state => state.status === "ready").length,
      detailTotal: detailStates.length,
      detailFailed: detailStates.filter(state => state.status === "error").length,
      failed,
    });
    const tx = props.width / 2 - view.x * scale;
    const ty = props.height / 2 - view.y * scale;
    const ov = meta.levels[0]!;
    hot.prop(overviewWorld, "translateX", tx);
    hot.prop(overviewWorld, "translateY", ty);
    hot.prop(overviewWorld, "scale", scale / ov.scale);
    if (activeLevel > 0) {
      hot.prop(activeWorld, "translateX", tx);
      hot.prop(activeWorld, "translateY", ty);
      hot.prop(activeWorld, "scale", scale / meta.levels[activeLevel]!.scale);
    }
    props.onView?.({ zoom: view.zoom, level: activeLevel });
  });

  // Touch gestures arrive on the LOWER (auxiliary) screen; the picture stays
  // on the top screen, so the viewport anchor is always the top-screen center.
  // A left or right tap turns the page like the d-pad; a drag pans with the
  // same inertia; a two-finger spread zooms (single-touch panels just pan).
  const auxRegion = { rect: () => ({ x: 0, y: 0, w: AUX_W, h: AUX_H }) };
  const pageDelta = (sign: number) => props.onPage(sign * pageStep(props.meta.direction));
  createGesture({
    surface: "auxiliary",
    region: { rect: () => ({ x: 0, y: 0, w: (AUX_W * 3) / 10, h: AUX_H }) },
    onTap: () => pageDelta(-1),
  });
  createGesture({
    surface: "auxiliary",
    region: { rect: () => ({ x: (AUX_W * 7) / 10, y: 0, w: (AUX_W * 3) / 10, h: AUX_H }) },
    onTap: () => pageDelta(1),
  });
  createGesture({
    surface: "auxiliary",
    region: auxRegion,
    onPanStart: () => cam.beginDrag(),
    onPanMove: (c) => cam.drag(c.fdx, c.fdy),
    onPanEnd: (c) => cam.endDrag(c.vx, c.vy),
  });
  let pinchLastSpan = 0;
  createGesture({
    surface: "auxiliary",
    region: auxRegion,
    onPinchStart: (p) => {
      pinchLastSpan = p.span;
      cam.stop();
    },
    onPinchMove: (p) => {
      const previous = pinchLastSpan > 0 ? pinchLastSpan : p.startSpan;
      if (previous > 0 && p.span > 0) {
        const view = cam.view();
        cam.jump(view.x, view.y, view.zoom + Math.log2(p.span / previous));
      }
      pinchLastSpan = p.span;
    },
    onPinchEnd: () => (pinchLastSpan = 0),
  });

  onCleanup(() => {
    for (const m of overview.values()) detachNode(overviewWorld, m.node);
    overview.clear();
    clearActive();
    props.onDemand([]);
  });

  return container as unknown as SolidJSX.Element;
}
