// @pocketjs/framework/game2d — the stage: an immediate-mode drawing API on a retained node pool.
//
// Game code is written the way 2D games are: every frame, `begin()`, draw back to front, `end()`.
// The i-th draw call of a kind reuses the i-th pooled node, so a scene that does not change its
// draw order costs one comparison per property and no native call at all.
//
// Nodes are laid out at a fixed 1×1 box and sized with scaleX/scaleY. Transforms are paint-only:
// drawing never relayouts, whatever sizes the images are, and a negative scale mirrors.
//
// Measured on a real PSP at 333 MHz: raw ops.setProp 35 µs, hot.prop on a changed value 139 µs (WeakMap
// gate plus encoding), Math.round 6 µs, Math.sin 34 µs (doubles are soft-float). So this file compares
// against its own shadow and calls setProp directly, and rounds with `| 0`.

import { Index, type JSX } from "solid-js";
import { Image, Text, View } from "../components.ts";
import * as hot from "../hot.ts";
import { getOps } from "../index.ts";
import { PROP } from "../../../contracts/spec/spec.ts";
import type { NodeMirror } from "../index.ts";
import type { PackImage } from "./packs.ts";
import type { TexturePool } from "./textures.ts";

export interface DrawOpts { flip?: boolean; alpha?: number; sx?: number; sy?: number }
export interface TextOpts { color?: number; size?: 12 | 16; align?: "left" | "center" | "right"; outline?: boolean; alpha?: number }

export interface Gfx {
  begin(): void;
  end(): void;
  /** World-to-screen offset applied to everything until changed. */
  origin(x: number, y: number): void;
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

export interface StageConfig { width: number; height: number; images?: number; rects?: number; texts?: number; tex: TexturePool }

interface Shadow { handle: number; x: number; y: number; sx: number; sy: number; alpha: number; z: number; color: number; text: string; shown: boolean }
const shadow = (): Shadow => ({ handle: -2, x: NaN, y: NaN, sx: NaN, sy: NaN, alpha: NaN, z: -1, color: -1, text: "", shown: false });

const P_TX = PROP.translateX, P_TY = PROP.translateY, P_SX = PROP.scaleX, P_SY = PROP.scaleY, P_OP = PROP.opacity, P_Z = PROP.zIndex, P_BG = PROP.bgColor, P_FG = PROP.textColor, P_ALIGN = PROP.textAlign;
const round = (v: number) => (v < 0 ? (v - 0.5) | 0 : (v + 0.5) | 0);

/** Colors are ABGR u32 throughout, matching the native spec. */
export const rgb = (hex: number, a = 255) => (((a << 24) | ((hex & 0xff) << 16) | (hex & 0xff00) | ((hex >> 16) & 0xff)) >>> 0);

export function createStage(cfg: StageConfig): { gfx: Gfx; View: () => JSX.Element } {
  const NI = cfg.images ?? 160, NR = cfg.rects ?? 48, NT = cfg.texts ?? 24;
  const imgNodes: (NodeMirror | undefined)[] = new Array(NI), imgSh = Array.from({ length: NI }, shadow);
  const rectNodes: (NodeMirror | undefined)[] = new Array(NR), rectSh = Array.from({ length: NR }, shadow);
  // Baked glyphs exist at fixed sizes, so each size has its own pool of fixed cells.
  const TW = 240;
  const textNodes: (NodeMirror | undefined)[] = new Array(NT), textSh = Array.from({ length: NT }, shadow);
  const bigNodes: (NodeMirror | undefined)[] = new Array(NT), bigSh = Array.from({ length: NT }, shadow);
  let ni = 0, nr = 0, nt = 0, nb = 0, z = 1, ox = 0, oy = 0, dropped = 0;
  let prevI = 0, prevR = 0, prevT = 0, prevB = 0;

  const ops = () => getOps() as unknown as { setProp(id: number, prop: number, value: number): void; setImage(id: number, h: number): void };
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
    const i = ni++, node = imgNodes[i], s = imgSh[i];
    if (s.handle !== handle && node) { s.handle = handle; ops().setImage(node.id, handle); }
    place(node, s, x, y, w, h, flip, alpha);
  };

  const gfx: Gfx = {
    begin() { ni = 0; nr = 0; nt = 0; nb = 0; z = 1; ox = 0; oy = 0; dropped = 0; cfg.tex.beginFrame(); },
    end() {
      const hide = (nodes: (NodeMirror | undefined)[], sh: Shadow[], from: number, to: number) => {
        for (let i = from; i < to; i++) if (sh[i].alpha !== 0 && nodes[i]) { sh[i].alpha = 0; ops().setProp(nodes[i]!.id, P_OP, 0); }
      };
      hide(imgNodes, imgSh, ni, prevI); hide(rectNodes, rectSh, nr, prevR); hide(textNodes, textSh, nt, prevT); hide(bigNodes, bigSh, nb, prevB);
      prevI = ni; prevR = nr; prevT = nt; prevB = nb;
    },
    origin(x, y) { ox = x; oy = y; },
    cell(img, x, y, o) {
      if (!img) return;
      const h = cfg.tex.get(img);
      const a = o?.alpha ?? 1, flip = !!o?.flip;
      const X = round(x + ox), Y = round(y + oy);
      const left = flip ? X + img.fw - img.ox - img.tw : X + img.ox;
      pushImage(h, left, Y + img.oy, img.tw * (o?.sx ?? 1), img.th * (o?.sy ?? 1), flip, a);
    },
    sprite(img, x, y, o) {
      if (!img) return;
      gfx.cell(img, x - (o?.flip ? img.fw - img.ax : img.ax), y - img.ay, o);
    },
    texture(handle, x, y, w, h, alpha = 1) { pushImage(handle, round(x + ox), round(y + oy), w, h, false, alpha); },
    rect(x, y, w, h, abgr, alpha = 1) {
      if (nr >= NR) { dropped++; return; }
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
  function StageView() {
    return (
      <View class="absolute left-0 top-0 overflow-hidden" style={{ width: cfg.width, height: cfg.height }}>
        <Index each={iList}>{(_, i) => <Image class="absolute left-0 top-0 opacity-0" style={unit} ref={(n: NodeMirror) => { imgNodes[i] = n; }} />}</Index>
        <Index each={rList}>{(_, i) => <View class="absolute left-0 top-0 opacity-0" style={unit} ref={(n: NodeMirror) => { rectNodes[i] = n; }} />}</Index>
        <Index each={tList}>{(_, i) => <Text class="absolute left-0 top-0 opacity-0 text-xs" style={{ width: TW, height: 16 }} ref={(n: NodeMirror) => { textNodes[i] = n; }}>{" "}</Text>}</Index>
        <Index each={tList}>{(_, i) => <Text class="absolute left-0 top-0 opacity-0 text-base" style={{ width: TW, height: 20 }} ref={(n: NodeMirror) => { bigNodes[i] = n; }}>{" "}</Text>}</Index>
      </View>
    );
  }
  return { gfx, View: StageView };
}
