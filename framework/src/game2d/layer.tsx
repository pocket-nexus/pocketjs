// @pocketjs/framework/game2d — layers: the immediate-mode drawing vocabulary, and when it runs.
//
// A layer is one `Gfx`: `begin()`, draw back to front, `end()`. A dynamic layer runs that every
// frame. A static layer runs it only after `invalidate()` and otherwise costs no script work: its
// content stays on screen, and the images it shows are pinned in the texture pool. A layer inside
// a camera draws in world space and does not clip; the camera does.
//
// On a host with `setDrawItems`, images and rects are records in one Int32Array: a draw call
// writes 4 integers (sizes in 1/16 px, so a scaled image keeps its size), and `end()` hands each run of records between two texts to a view in one
// native call, which the core paints as it would equivalent image and box nodes. Text stays on
// pooled text nodes, and a text drawn between images starts a new run, so draw order holds.
//
// Elsewhere the i-th draw call of a kind reuses the i-th pooled node, so a scene that does not
// change its draw order costs one comparison per property and no native call at all. Nodes are
// laid out at a fixed 1×1 box and sized with scaleX/scaleY: drawing never relayouts, and a
// negative scale mirrors.
//
// Measured on a real PSP at 333 MHz: raw ops.setProp 35 µs, hot.prop on a changed value 139 µs (WeakMap
// gate plus encoding), Math.round 6 µs, Math.sin 34 µs (doubles are soft-float). So this file compares
// against its own shadow and calls setProp directly, and rounds with `| 0`.

import { Index, type JSX } from "solid-js";
import { Image, Text, View } from "../components.ts";
import * as hot from "../hot.ts";
import { getOps } from "../index.ts";
import { virtualFrame } from "../clock.ts";
import { DRAW_ITEM_FLAG, DRAW_ITEM_KIND, DRAW_ITEM_WORDS, PROP } from "../../../contracts/spec/spec.ts";
import type { NodeMirror } from "../index.ts";
import type { PackImage } from "./packs.ts";
import type { TexturePool } from "./textures.ts";

export interface DrawOpts { flip?: boolean; alpha?: number; sx?: number; sy?: number }
export interface TextOpts { color?: number; size?: 12 | 16; align?: "left" | "center" | "right"; outline?: boolean; alpha?: number }

export interface Gfx {
  begin(): void;
  end(): void;
  /** Offset added to every following draw call until changed. */
  origin(x: number, y: number): void;
  /** The current offset. */
  readonly ox: number;
  readonly oy: number;
  /** Draw an image with its original cell's top-left at (x, y). */
  cell(img: PackImage | undefined, x: number, y: number, o?: DrawOpts): void;
  /** Draw an image with its anchor at (x, y). */
  sprite(img: PackImage | undefined, x: number, y: number, o?: DrawOpts): void;
  /** Draw a raw texture handle covering (x, y, w, h). */
  texture(handle: number, x: number, y: number, w: number, h: number, alpha?: number): void;
  rect(x: number, y: number, w: number, h: number, abgr: number, alpha?: number): void;
  text(s: string, x: number, y: number, o?: TextOpts): void;
  size(): { width: number; height: number };
  stats(): { images: number; rects: number; texts: number; dropped: number };
}

export interface LayerConfig {
  width: number; height: number; images?: number; rects?: number; texts?: number; tex: TexturePool;
  /** Clip to the layer's box (default). A layer inside a camera draws in world space: false. */
  clip?: boolean;
  /** false keeps one node per image and rect even where the host has `setDrawItems`. */
  drawItems?: boolean;
}
export interface LayerStats { images: number; rects: number; texts: number; dropped: number; draws: number }
export interface Layer { gfx: Gfx; View: () => JSX.Element; stats(): LayerStats }

export interface StaticLayerConfig extends LayerConfig {
  /** Draws the layer's whole content. Runs on the first frame and after `invalidate()`. */
  draw(gfx: Gfx): void;
}
export interface StaticLayer {
  View: () => JSX.Element;
  /** Draw again on the next `frame()`. */
  invalidate(): void;
  /** Call once per frame. Draws when invalidated, when the texture pool dropped its textures, or
   *  while an image it wanted is still loading. Returns true when it drew. */
  frame(): boolean;
  stats(): LayerStats;
}

interface Shadow { handle: number; x: number; y: number; sx: number; sy: number; alpha: number; z: number; color: number; text: string; shown: boolean }
const shadow = (): Shadow => ({ handle: -2, x: NaN, y: NaN, sx: NaN, sy: NaN, alpha: NaN, z: -1, color: -1, text: "", shown: false });

const P_TX = PROP.translateX, P_TY = PROP.translateY, P_SX = PROP.scaleX, P_SY = PROP.scaleY, P_OP = PROP.opacity, P_Z = PROP.zIndex, P_BG = PROP.bgColor, P_FG = PROP.textColor, P_ALIGN = PROP.textAlign;
// Half up, and the same for every integer shift: round(v + k) === round(v) + k. Rounding in world
// space and in screen space then agree, so a sprite does not move a pixel as it crosses an edge.
// A whole number passes through: on a PSP adding 0.5 makes it a soft-float double.
const round = (v: number) => ((v | 0) === v ? v : ((v + 32768.5) | 0) - 32768);
const alphaByte = (a: number) => (a <= 0 ? 0 : a >= 1 ? 255 : (a * 255 + 0.5) | 0);

/** Colors are ABGR u32 throughout, matching the native spec. */
export const rgb = (hex: number, a = 255) => (((a << 24) | ((hex & 0xff) << 16) | (hex & 0xff00) | ((hex >> 16) & 0xff)) >>> 0);

export function createLayer(cfg: LayerConfig): Layer {
  return layer(cfg, false);
}

export function createStaticLayer(cfg: StaticLayerConfig): StaticLayer {
  const inner = layer(cfg, true);
  let dirty = true, epoch = -1, waitFrames = 0;
  return {
    View: inner.View,
    invalidate() { dirty = true; },
    frame() {
      const missing = inner.missed() > 0;
      if (missing) waitFrames++;
      if (!dirty && epoch === cfg.tex.epoch() && !(missing && (waitFrames & 7) === 0)) return false;
      dirty = false; epoch = cfg.tex.epoch(); waitFrames = 0;
      inner.gfx.begin(); cfg.draw(inner.gfx); inner.gfx.end();
      return true;
    },
    stats: inner.stats,
  };
}

function layer(cfg: LayerConfig, pinning: boolean): Layer & { missed(): number } {
  const NI = cfg.images ?? 160, NR = cfg.rects ?? 48, NT = cfg.texts ?? 24;
  const imgNodes: (NodeMirror | undefined)[] = new Array(NI), imgSh = Array.from({ length: NI }, shadow);
  const rectNodes: (NodeMirror | undefined)[] = new Array(NR), rectSh = Array.from({ length: NR }, shadow);
  // Baked glyphs exist at fixed sizes, so each size has its own pool of fixed cells.
  const TW = 240;
  const textNodes: (NodeMirror | undefined)[] = new Array(NT), textSh = Array.from({ length: NT }, shadow);
  const bigNodes: (NodeMirror | undefined)[] = new Array(NT), bigSh = Array.from({ length: NT }, shadow);
  let ni = 0, nr = 0, nt = 0, nb = 0, z = 1, ox = 0, oy = 0, dropped = 0, draws = 0, missed = 0;
  // A static layer pins what it shows until it draws again.
  const held: PackImage[] = [];
  let prevI = 0, prevR = 0, prevT = 0, prevB = 0;

  type StageOps = { setProp(id: number, prop: number, value: number): void; setImage(id: number, h: number): void; setDrawItems?(id: number, items: ArrayBufferView): void };
  const ops = () => getOps() as unknown as StageOps;

  // Draw-item mode, chosen when the view mounts. Every text can split the image run, so there is
  // one run view more than text nodes. A run past the last view joins the last one.
  let list = false;
  const NS = 2 * NT + 1, W = DRAW_ITEM_WORDS;
  // All integers: on a PSP a Float32Array write converts a double in software.
  const items = new ArrayBuffer((NI + NR) * W * 4), i32 = new Int32Array(items);
  const runNodes: (NodeMirror | undefined)[] = new Array(NS), runFrom = new Int32Array(NS + 1), runZ = new Int32Array(NS), runZSent = new Int32Array(NS).fill(-1), runSent = new Int32Array(NS);
  let n = 0, runs = 0, runOpen = false;
  const IMAGE = DRAW_ITEM_KIND.image, RECT = DRAW_ITEM_KIND.rect, FLIP = DRAW_ITEM_FLAG.flipX;
  function openRun() {
    runOpen = true;
    if (runs < NS) { runFrom[runs] = n; runZ[runs] = z++; runs++; }
  }
  /** One record; x and y are whole pixels, w and h go in 1/16 px. Positions outside the i16 range
   *  and sizes from 4096 px are skipped. */
  function record(word0: number, ref: number, x: number, y: number, w: number, h: number, alpha: number) {
    // A whole size shifts; only a scaled one multiplies.
    const w16 = (w | 0) === w ? w << 4 : (w * 16 + 0.5) | 0, h16 = (h | 0) === h ? h << 4 : (h * 16 + 0.5) | 0;
    if (x < -32768 || x > 32767 || y < -32768 || y > 32767 || w16 <= 0 || h16 <= 0 || w16 > 65535 || h16 > 65535) return;
    if (!runOpen) openRun();
    const o = n++ * W;
    i32[o] = word0 | (alpha === 1 ? 0xff00 : alphaByte(alpha) << 8); i32[o + 1] = ref;
    i32[o + 2] = (x & 0xffff) | (y << 16); i32[o + 3] = w16 | (h16 << 16);
  }
  // A run that starts and ends where it did last frame reuses its view: no allocation per frame.
  const runViews: (Uint8Array | undefined)[] = new Array(NS);
  const runViewFrom = new Int32Array(NS).fill(-1), runViewCount = new Int32Array(NS).fill(-1);
  let prevRuns = 0;
  function submitRuns() {
    const op = ops();
    runFrom[runs] = n;
    const last = runs > prevRuns ? runs : prevRuns;
    for (let k = 0; k < last; k++) {
      const node = runNodes[k];
      if (!node) continue;
      const from = runFrom[k], count = k < runs ? runFrom[k + 1] - from : 0;
      if (count === 0 && runSent[k] === 0) continue;
      runSent[k] = count;
      let view = runViews[k];
      if (view === undefined || runViewFrom[k] !== from || runViewCount[k] !== count) {
        view = runViews[k] = new Uint8Array(items, from * W * 4, count * W * 4);
        runViewFrom[k] = from; runViewCount[k] = count;
      }
      op.setDrawItems!(node.id, view);
      if (count > 0 && runZSent[k] !== runZ[k]) { runZSent[k] = runZ[k]; op.setProp(node.id, P_Z, runZ[k]); }
    }
    prevRuns = runs;
  }
  function hide(nodes: (NodeMirror | undefined)[], sh: Shadow[], from: number, to: number) {
    for (let i = from; i < to; i++) if (sh[i].alpha !== 0 && nodes[i]) { sh[i].alpha = 0; ops().setProp(nodes[i]!.id, P_OP, 0); }
  }
  function place(node: NodeMirror | undefined, s: Shadow, x: number, y: number, w: number, h: number, flip: boolean, alpha: number) {
    if (!node) return;
    const op = ops(), id = node.id;
    // A 1×1 box scaled about its centre: its centre must land on the rect's centre.
    const sx = flip ? -w : w, sy = h, tx = x + w / 2 - 0.5, ty = y + h / 2 - 0.5;
    if (s.x !== tx) { s.x = tx; op.setProp(id, P_TX, tx); }
    if (s.y !== ty) { s.y = ty; op.setProp(id, P_TY, ty); }
    if (s.sx !== sx) { s.sx = sx; op.setProp(id, P_SX, sx); }
    if (s.sy !== sy) { s.sy = sy; op.setProp(id, P_SY, sy); }
    if (s.alpha !== alpha) { s.alpha = alpha; op.setProp(id, P_OP, alpha); }
    if (s.z !== z) { s.z = z; op.setProp(id, P_Z, z); }
    z++;
  }
  const pushImage = (handle: number, x: number, y: number, w: number, h: number, flip: boolean, alpha: number) => {
    if (handle < 0) return;
    if (ni >= NI) { dropped++; return; }
    if (list) { ni++; record(flip ? IMAGE | FLIP : IMAGE, handle, x, y, w, h, alpha); return; }
    const i = ni++, node = imgNodes[i], s = imgSh[i];
    if (s.handle !== handle && node) { s.handle = handle; ops().setImage(node.id, handle); }
    place(node, s, x, y, w, h, flip, alpha);
  };

  const pool = cfg.tex;
  let useFrame = 0;
  function cell(img: PackImage | undefined, x: number, y: number, o?: DrawOpts) {
    if (img === undefined) return;
    // A loaded image marks its own LRU frame: no call into the pool.
    let h = img.handle;
    if (h >= 0) img.used = useFrame;
    else if ((h = pool.get(img)) < 0) { missed++; return; }
    if (pinning) { pool.pin(img); held.push(img); }
    let X = x + ox, Y = y + oy;
    if ((X | 0) !== X) X = ((X + 32768.5) | 0) - 32768;
    if ((Y | 0) !== Y) Y = ((Y + 32768.5) | 0) - 32768;
    // The common draw: unscaled, opaque, unmirrored, in a list. Four integer writes; the size
    // word was computed when the pack mounted.
    if (o === undefined && list) {
      const px = X + img.ox, py = Y + img.oy, wh = img.wh16;
      if (ni >= NI) { dropped++; return; }
      ni++;
      if ((px + 32768) >>> 0 > 65535 || (py + 32768) >>> 0 > 65535 || wh === 0) return;
      if (!runOpen) openRun();
      const r = n++ << 2;
      i32[r] = IMAGE | 0xff00; i32[r + 1] = h; i32[r + 2] = (px & 0xffff) | (py << 16); i32[r + 3] = wh;
      return;
    }
    if (o === undefined) { pushImage(h, X + img.ox, Y + img.oy, img.tw, img.th, false, 1); return; }
    const flip = !!o.flip;
    pushImage(h, flip ? X + img.fw - img.ox - img.tw : X + img.ox, Y + img.oy, o.sx === undefined ? img.tw : img.tw * o.sx, o.sy === undefined ? img.th : img.th * o.sy, flip, o.alpha === undefined ? 1 : o.alpha);
  }

  const gfx: Gfx = {
    begin() {
      ni = 0; nr = 0; nt = 0; nb = 0; z = 1; ox = 0; oy = 0; dropped = 0; missed = 0; n = 0; runs = 0; runOpen = false; draws++;
      if (pinning) { for (let i = 0; i < held.length; i++) pool.unpin(held[i]); held.length = 0; }
      else cfg.tex.beginFrame(virtualFrame());
      useFrame = pool.frame();
    },
    end() {
      if (list) submitRuns();
      else { hide(imgNodes, imgSh, ni, prevI); hide(rectNodes, rectSh, nr, prevR); }
      hide(textNodes, textSh, nt, prevT); hide(bigNodes, bigSh, nb, prevB);
      prevI = ni; prevR = nr; prevT = nt; prevB = nb;
    },
    origin(x, y) { ox = x; oy = y; },
    get ox() { return ox; },
    get oy() { return oy; },
    cell,
    sprite(img, x, y, o) {
      if (!img) return;
      cell(img, x - (o !== undefined && o.flip ? img.fw - img.ax : img.ax), y - img.ay, o);
    },
    texture(handle, x, y, w, h, alpha = 1) { pushImage(handle, round(x + ox), round(y + oy), w, h, false, alpha); },
    rect(x, y, w, h, abgr, alpha = 1) {
      if (nr >= NR) { dropped++; return; }
      if (list) { nr++; record(RECT, abgr, round(x + ox), round(y + oy), w, h, alpha); return; }
      const i = nr++, node = rectNodes[i], s = rectSh[i];
      if (s.color !== abgr && node) { s.color = abgr; ops().setProp(node.id, P_BG, abgr); }
      place(node, s, round(x + ox), round(y + oy), w, h, false, alpha);
    },
    text(str, x, y, o) {
      const size = o?.size ?? 12, color = o?.color ?? 0xfff4efdc, align = o?.align ?? "left", a = o?.alpha ?? 1;
      const X = round(x + ox), Y = round(y + oy);
      const left = align === "left" ? X : align === "center" ? X - TW / 2 : X - TW;
      const big = size === 16;
      const alignId = align === "left" ? 0 : align === "center" ? 1 : 2;
      runOpen = false;
      const put = (dx: number, dy: number, col: number) => {
        const pool = big ? bigNodes : textNodes, sh = big ? bigSh : textSh;
        if ((big ? nb : nt) >= NT) { dropped++; return; }
        const i = big ? nb++ : nt++, node = pool[i], s = sh[i];
        if (s.text !== str) { s.text = str; hot.text(node, str); }
        if (!node) return;
        const op = ops(), id = node.id;
        if (s.color !== col) { s.color = col; op.setProp(id, P_FG, col); }
        if (s.sx !== alignId) { s.sx = alignId; op.setProp(id, P_ALIGN, alignId); }
        if (s.x !== left + dx) { s.x = left + dx; op.setProp(id, P_TX, s.x); }
        if (s.y !== Y + dy) { s.y = Y + dy; op.setProp(id, P_TY, s.y); }
        if (s.alpha !== a) { s.alpha = a; op.setProp(id, P_OP, a); }
        if (s.z !== z) { s.z = z; op.setProp(id, P_Z, z); }
        z++;
      };
      if (o?.outline !== false) put(1, 1, 0xff0c0e12);
      put(0, 0, color);
    },
    size: () => ({ width: cfg.width, height: cfg.height }),
    stats: () => ({ images: ni, rects: nr, texts: nt + nb, dropped }),
  };

  const unit = { width: 1, height: 1 };
  const iList = new Array(NI).fill(0), rList = new Array(NR).fill(0), tList = new Array(NT).fill(0);
  const sList = new Array(NS).fill(0), box = { width: cfg.width, height: cfg.height };
  const frameClass = cfg.clip === false ? "absolute left-0 top-0" : "absolute left-0 top-0 overflow-hidden";
  function LayerView() {
    list = cfg.drawItems !== false && typeof ops()?.setDrawItems === "function";
    if (list) {
      return (
        <View class={frameClass} style={box}>
          <Index each={sList}>{(_, i) => <View class="absolute left-0 top-0" style={box} ref={(n: NodeMirror) => { runNodes[i] = n; }} />}</Index>
          <Index each={tList}>{(_, i) => <Text class="absolute left-0 top-0 opacity-0 text-xs" style={{ width: TW, height: 16 }} ref={(n: NodeMirror) => { textNodes[i] = n; }}>{" "}</Text>}</Index>
          <Index each={tList}>{(_, i) => <Text class="absolute left-0 top-0 opacity-0 text-base" style={{ width: TW, height: 20 }} ref={(n: NodeMirror) => { bigNodes[i] = n; }}>{" "}</Text>}</Index>
        </View>
      );
    }
    return (
      <View class={frameClass} style={box}>
        <Index each={iList}>{(_, i) => <Image class="absolute left-0 top-0 opacity-0" style={unit} ref={(n: NodeMirror) => { imgNodes[i] = n; }} />}</Index>
        <Index each={rList}>{(_, i) => <View class="absolute left-0 top-0 opacity-0" style={unit} ref={(n: NodeMirror) => { rectNodes[i] = n; }} />}</Index>
        <Index each={tList}>{(_, i) => <Text class="absolute left-0 top-0 opacity-0 text-xs" style={{ width: TW, height: 16 }} ref={(n: NodeMirror) => { textNodes[i] = n; }}>{" "}</Text>}</Index>
        <Index each={tList}>{(_, i) => <Text class="absolute left-0 top-0 opacity-0 text-base" style={{ width: TW, height: 20 }} ref={(n: NodeMirror) => { bigNodes[i] = n; }}>{" "}</Text>}</Index>
      </View>
    );
  }
  return { gfx, View: LayerView, stats: () => ({ images: ni, rects: nr, texts: nt + nb, dropped, draws }), missed: () => missed };
}
