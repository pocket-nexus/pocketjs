// PocketUI ui/raster.ts — marks and rings as textures, drawn here.
//
// A mark made of native rectangles is sharp only where its edges are level
// or plumb. A turned stroke, a disc, a triangle or a rounded ring comes out
// of the core in steps a logical pixel high (three device pixels on a dense
// panel), which reads as mosaic. So anything with a slope or a curve is
// rasterized here instead: its coverage sampled sixteen times a texel into a
// small RGBA picture, uploaded once (host op uploadImgEntry, sampled
// bilinearly) and shown by an image node. The picture has the panel's own
// grain (platform.pixelRatio texels to the point), so the smoothing is the
// picture's and the sampler has little to add.
//
// At one pixel to the point the core's steps are the panel's pixels, and
// nothing is drawn here: a PSP has no double-precision unit, and sampling a
// ring's coverage in JavaScript there costs seconds where the rectangles
// cost nothing.
//
// Textures are shared by what they draw and how (the art and its ink), and
// counted: one nobody shows is freed once there are more than a few.
import { getOps } from "../../host.ts";
import { platform } from "../../platform.ts";
import type { GlyphArt, GlyphShape } from "./theme.ts";

/** texels to the point: the panel's pixels to the point */
const GRAIN = platform.pixelRatio;
const SUB = 4;
const KEEP = 48;

interface Entry {
  handle: number;
  refs: number;
  used: number;
}
const cache = new Map<string, Entry>();
let clock = 0;

/** Whether this host can show a picture made at run time. */
export function canRaster(): boolean {
  return GRAIN >= 2 && typeof getOps().uploadImgEntry === "function";
}

function rgba(color: string): [number, number, number, number] {
  const hex = color.slice(1);
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1];
}

/** The side of the texture for a picture `points` across: a power of two at about GRAIN texels a point. */
function sideFor(points: number): number {
  const wanted = Math.max(8, Math.ceil(points * GRAIN));
  let side = 8;
  while (side < wanted && side < 256) side *= 2;
  return side;
}

/** A shape's turn, worked out once for every sample of it. */
interface Turn {
  cos: number;
  sin: number;
}
const turns = new WeakMap<GlyphShape, Turn>();
function turnOf(shape: GlyphShape): Turn {
  let turn = turns.get(shape);
  if (!turn) {
    const angle = (-(shape.rot ?? 0) * Math.PI) / 180;
    turn = { cos: Math.cos(angle), sin: Math.sin(angle) };
    turns.set(shape, turn);
  }
  return turn;
}

/** The box, in the art's points, outside which no sample can be inside `shape`. */
function boundsOf(shape: GlyphShape): [number, number, number, number] {
  if (shape.tri) {
    const [ax, ay, bx, by, cx, cy] = shape.tri;
    return [Math.min(ax, bx, cx), Math.min(ay, by, cy), Math.max(ax, bx, cx), Math.max(ay, by, cy)];
  }
  // a turned box stays inside the circle through its corners
  const reach = shape.rot ? Math.hypot(shape.w, shape.h) / 2 : 0;
  const cx = shape.x + shape.w / 2;
  const cy = shape.y + shape.h / 2;
  return shape.rot ? [cx - reach, cy - reach, cx + reach, cy + reach] : [shape.x, shape.y, shape.x + shape.w, shape.y + shape.h];
}

/** Whether (px, py), in the art's points, is inside `shape`. */
function inside(shape: GlyphShape, px: number, py: number): boolean {
  if (shape.tri) {
    const [ax, ay, bx, by, cx, cy] = shape.tri;
    const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
    const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
    const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  }
  // into the shape's own frame: its centre the origin, its turn undone
  let x = px - (shape.x + shape.w / 2);
  let y = py - (shape.y + shape.h / 2);
  if (shape.rot) {
    const { cos, sin } = turnOf(shape);
    [x, y] = [x * cos - y * sin, x * sin + y * cos];
  }
  const within = (halfW: number, halfH: number, radius: number): boolean => {
    const r = Math.max(0, Math.min(radius, halfW, halfH));
    const dx = Math.abs(x) - (halfW - r);
    const dy = Math.abs(y) - (halfH - r);
    if (dx <= 0 && dy <= 0) return true;
    if (dx > r || dy > r) return false;
    if (dx <= 0 || dy <= 0) return true;
    return dx * dx + dy * dy <= r * r;
  };
  const radius = shape.r ?? 0;
  if (!within(shape.w / 2, shape.h / 2, radius)) return false;
  if (shape.ring) return !within(shape.w / 2 - shape.ring, shape.h / 2 - shape.ring, Math.max(0, radius - shape.ring));
  return true;
}

/** An RGBA picture `side` texels square of `shapes`, whose box is `w` x `h` points, as a host image entry. */
function entryOf(shapes: readonly GlyphShape[], w: number, h: number, side: number, ink: string): Uint8Array {
  const out = new Uint8Array(8 + side * side * 4);
  out[0] = side & 0xff;
  out[1] = side >> 8;
  out[2] = side & 0xff;
  out[3] = side >> 8;
  out[4] = 3; // PSM_8888
  out[5] = 2; // IMG_FLAG_LINEAR
  const colours = shapes.map((shape) => rgba(shape.color ?? ink));
  // each shape's box in texels: a texel outside it takes no samples of it
  const boxes = shapes.map((shape) => {
    const [x0, y0, x1, y1] = boundsOf(shape);
    return [Math.floor((x0 / w) * side) - 1, Math.floor((y0 / h) * side) - 1, Math.ceil((x1 / w) * side) + 1, Math.ceil((y1 / h) * side) + 1];
  });
  const samples = SUB * SUB;
  for (let ty = 0; ty < side; ty++) {
    for (let tx = 0; tx < side; tx++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let i = 0; i < shapes.length; i++) {
        const shape = shapes[i]!;
        const box = boxes[i]!;
        if (tx < box[0]! || ty < box[1]! || tx > box[2]! || ty > box[3]!) continue;
        let hits = 0;
        for (let sy = 0; sy < SUB; sy++) {
          const py = ((ty + (sy + 0.5) / SUB) / side) * h;
          for (let sx = 0; sx < SUB; sx++) if (inside(shape, ((tx + (sx + 0.5) / SUB) / side) * w, py)) hits++;
        }
        if (hits === 0) continue;
        const colour = colours[i]!;
        const alpha = (hits / samples) * colour[3] * (shape.opacity ?? 1);
        // this shape over what is there
        const under = a * (1 - alpha);
        const total = alpha + under;
        r = (colour[0] * alpha + r * under) / total;
        g = (colour[1] * alpha + g * under) / total;
        b = (colour[2] * alpha + b * under) / total;
        a = total;
      }
      const at = 8 + (ty * side + tx) * 4;
      out[at] = Math.round(r);
      out[at + 1] = Math.round(g);
      out[at + 2] = Math.round(b);
      out[at + 3] = Math.round(a * 255);
    }
  }
  return out;
}

function acquire(key: string, make: () => Uint8Array): string | null {
  let entry = cache.get(key);
  if (!entry) {
    const handle = getOps().uploadImgEntry?.(make()) ?? -1;
    if (handle < 0) return null;
    entry = { handle, refs: 0, used: 0 };
    cache.set(key, entry);
    if (cache.size > KEEP) {
      // the ones nobody shows, least recently shown first
      const idle = [...cache].filter(([name, held]) => held.refs === 0 && name !== key).sort((x, y) => x[1].used - y[1].used);
      for (const [name, held] of idle.slice(0, cache.size - KEEP)) {
        getOps().freeTexture?.(held.handle);
        cache.delete(name);
      }
    }
  }
  entry.refs++;
  entry.used = ++clock;
  return key;
}

/** The texture a key stands for. */
export function textureOf(key: string): number {
  return cache.get(key)?.handle ?? -1;
}

export function release(key: string | null): void {
  const entry = key ? cache.get(key) : undefined;
  if (entry && entry.refs > 0) entry.refs--;
}

/** A mark's art in `ink`, as a texture: its key, or null where the host shows none. */
export function markTexture(art: GlyphArt, ink: string): string | null {
  if (!canRaster() || art.w <= 0 || art.h <= 0) return null;
  const key = `m|${ink}|${art.w}x${art.h}|${JSON.stringify(art.shapes)}`;
  return acquire(key, () => entryOf(art.shapes, art.w, art.h, sideFor(Math.max(art.w, art.h)), ink));
}

/** The top-left quarter of a ring `radius` points to its outer edge and `width` thick, as a texture. The other three corners are this one mirrored. */
export function cornerTexture(radius: number, width: number, color: string): string | null {
  if (!canRaster() || radius <= 0) return null;
  const key = `c|${color}|${radius}|${width}`;
  // the full ring is a box 2 x radius square; the picture is its top-left quarter
  return acquire(key, () => entryOf([{ x: 0, y: 0, w: radius * 2, h: radius * 2, r: radius, ring: width }], radius, radius, sideFor(radius), color));
}

/** Whether a mark needs a picture: it has a slope or a curve. Level rectangles are sharper as rectangles. */
export function wantsRaster(art: GlyphArt): boolean {
  return art.shapes.some((shape) => shape.tri !== undefined || (shape.rot ?? 0) % 90 !== 0 || (shape.r ?? 0) > 0);
}
