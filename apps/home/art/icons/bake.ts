// apps/home/art/icons/bake.ts — turn icons.py's 512 px Blender renders into
// the textures Home draws, and write a contact sheet.
//
//   bun apps/home/art/icons/bake.ts .pocket-build/home-icons/render
//
// Each icon is drawn at a few sizes (24 in table rows and the banner, 46 on
// the springboard and the dock, 64 for the store's detail icon) and
// each size has its own texture, so the springboard draws its icons texel
// for texel. A texture is the power of two above the icon with the icon
// centred and room for the drop shadow.
//
// Every icon gets the same finish here, so the set reads as one family:
// the rounded-square mask (corner radius ICON_RADIUS of the side, 4x4
// supersampled), the iOS 6 gloss (a white wash over the top half whose lower
// edge is a shallow arc), a rim lit along the top and shaded along the
// bottom, and, at the springboard's 46, a soft shadow below. `plain` is the
// same finish with no picture: Home lays it over the tint gradient of an app
// that ships no icon.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { decodePng } from "../../../../framework/compiler/pak.ts";
import { encodePNG } from "../../../../tools/png.ts";

/** Corner radius as a fraction of the side; ui/chrome.tsx draws plain tiles with it. */
export const ICON_RADIUS = 0.2;

interface Size {
  icon: number;
  tex: number;
  shadow: boolean;
}
const SIZES: Record<number, Size> = {
  24: { icon: 24, tex: 32, shadow: false },
  46: { icon: 46, tex: 64, shadow: true },
  64: { icon: 64, tex: 64, shadow: false },
};

/** Which sizes each icon ships in. */
const ICONS: Record<string, number[]> = {
  settings: [24, 46],
  mac: [24, 46],
  wifi: [24],
  apps: [24],
  hn: [24, 46, 64],
  nexus: [24, 46, 64],
  plain: [24, 46, 64],
};

const RENDERS = resolve(process.argv[2] ?? ".pocket-build/home-icons/render");
const OUT = import.meta.dir;

type Rgba = Float32Array; // straight alpha, 0..1

/** Area-average a square RGBA image down to n x n (exact box weights). */
function resample(src: Uint8Array, size: number, n: number): Rgba {
  const out = new Float32Array(n * n * 4);
  const step = size / n;
  for (let y = 0; y < n; y++) {
    const y0 = y * step, y1 = y0 + step;
    for (let x = 0; x < n; x++) {
      const x0 = x * step, x1 = x0 + step;
      let r = 0, g = 0, b = 0, w = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
          const k = wx * wy, i = (sy * size + sx) * 4;
          r += src[i]! * k; g += src[i + 1]! * k; b += src[i + 2]! * k; w += k;
        }
      }
      const o = (y * n + x) * 4;
      out[o] = r / w / 255; out[o + 1] = g / w / 255; out[o + 2] = b / w / 255; out[o + 3] = 1;
    }
  }
  return out;
}

/** Signed distance to the rounded square of side n (negative inside). */
function sdf(px: number, py: number, n: number): number {
  const r = n * ICON_RADIUS;
  const qx = Math.abs(px - n / 2) - (n / 2 - r);
  const qy = Math.abs(py - n / 2) - (n / 2 - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Fraction of pixel (x, y) that `inside(px, py)` covers, 4x4 samples. */
function coverage(x: number, y: number, inside: (px: number, py: number) => boolean): number {
  let hits = 0;
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) if (inside(x + (i + 0.5) / 4, y + (j + 0.5) / 4)) hits++;
  return hits / 16;
}

/** `src` over `dst` in place, straight alpha. */
function over(dst: Rgba, o: number, r: number, g: number, b: number, a: number): void {
  const da = dst[o + 3]!;
  const oa = a + da * (1 - a);
  if (oa <= 0) return;
  dst[o] = (r * a + dst[o]! * da * (1 - a)) / oa;
  dst[o + 1] = (g * a + dst[o + 1]! * da * (1 - a)) / oa;
  dst[o + 2] = (b * a + dst[o + 2]! * da * (1 - a)) / oa;
  dst[o + 3] = oa;
}

/** The finish on an n x n icon (picture may be null for `plain`). */
function finish(picture: Rgba | null, n: number): Rgba {
  const out = picture ? picture.slice() : new Float32Array(n * n * 4);
  // The gloss: inside a wide ellipse centred above the icon.
  const ex = n / 2, ey = -0.55 * n, er = 1.05 * n;
  const inGloss = (px: number, py: number) => (px - ex) ** 2 + (py - ey) ** 2 <= er * er;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const o = (y * n + x) * 4;
      const gloss = coverage(x, y, inGloss);
      if (gloss > 0) {
        const t = (y + 0.5) / (0.5 * n);
        over(out, o, 1, 1, 1, gloss * (0.38 - 0.24 * Math.min(1, t)));
      }
      // The rim: the band within ~1.2 px of the edge, lit where the edge
      // faces up, shaded where it faces down.
      const cx = x + 0.5, cy = y + 0.5;
      const d = sdf(cx, cy, n);
      if (d > -1.4 && d < 0.5) {
        const ny = (sdf(cx, cy + 0.5, n) - sdf(cx, cy - 0.5, n));
        const band = 1 - Math.min(1, Math.abs(d + 0.6) / 0.9);
        if (ny < 0) over(out, o, 1, 1, 1, band * 0.45 * -ny);
        else over(out, o, 0, 0, 0, band * 0.35 * ny);
      }
    }
  }
  // The mask.
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const o = (y * n + x) * 4;
      out[o + 3] = out[o + 3]! * coverage(x, y, (px, py) => sdf(px, py, n) <= 0);
    }
  }
  return out;
}

/** Place a finished icon in its texture, over a soft shadow when asked. */
function compose(icon: Rgba, size: Size): Uint8Array {
  const { icon: n, tex } = size;
  const pad = (tex - n) / 2;
  const out = new Float32Array(tex * tex * 4);
  if (size.shadow) {
    const sigma = 0.045 * n, dy = 0.04 * n, alpha = 0.55;
    const k = Math.ceil(sigma * 3);
    const mask = new Float32Array(tex * tex);
    for (let y = 0; y < tex; y++) for (let x = 0; x < tex; x++) mask[y * tex + x] = coverage(x, y, (px, py) => sdf(px - pad, py - pad - dy, n) <= 0);
    const weights = Array.from({ length: 2 * k + 1 }, (_, i) => Math.exp(-((i - k) ** 2) / (2 * sigma * sigma)));
    const total = weights.reduce((a, b) => a + b, 0);
    const blur = (src: Float32Array, horizontal: boolean) => {
      const dst = new Float32Array(tex * tex);
      for (let y = 0; y < tex; y++) for (let x = 0; x < tex; x++) {
        let s = 0;
        for (let i = -k; i <= k; i++) {
          const sx = horizontal ? x + i : x, sy = horizontal ? y : y + i;
          if (sx >= 0 && sy >= 0 && sx < tex && sy < tex) s += src[sy * tex + sx]! * weights[i + k]!;
        }
        dst[y * tex + x] = s / total;
      }
      return dst;
    };
    const soft = blur(blur(mask, true), false);
    // Only outside the tile: a plain finish is laid over a tint it must not darken.
    for (let y = 0; y < tex; y++) for (let x = 0; x < tex; x++) {
      const inside = coverage(x, y, (px, py) => sdf(px - pad, py - pad, n) <= 0);
      out[(y * tex + x) * 4 + 3] = soft[y * tex + x]! * alpha * (1 - inside);
    }
  }
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const s = (y * n + x) * 4, o = ((y + pad) * tex + x + pad) * 4;
    over(out, o, icon[s]!, icon[s + 1]!, icon[s + 2]!, icon[s + 3]!);
  }
  const bytes = new Uint8Array(tex * tex * 4);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(Math.min(1, Math.max(0, out[i]!)) * 255);
  return bytes;
}

// ---- bake --------------------------------------------------------------------------

const baked: { name: string; size: number; tex: number; rgba: Uint8Array }[] = [];
for (const [name, sizes] of Object.entries(ICONS)) {
  const render = name === "plain" ? null : decodePng(new Uint8Array(await Bun.file(join(RENDERS, `${name}.png`)).arrayBuffer()));
  if (render && (render.width !== 512 || render.height !== 512)) throw new Error(`${name}: expected a 512 px render`);
  for (const n of sizes) {
    const size = SIZES[n]!;
    const rgba = compose(finish(render ? resample(render.rgba, 512, n) : null, n), size);
    writeFileSync(join(OUT, `${name}-${n}.png`), encodePNG(rgba, size.tex, size.tex));
    baked.push({ name, size: n, tex: size.tex, rgba });
    console.log(`${name}-${n}.png  ${size.tex}x${size.tex}`);
  }
}

// ---- the dock: iOS 6's glass shelf, drawn texel for texel -------------------------
//
// The shelf is 320 x 40 on screen (springboard.tsx draws the 512 x 64 texture
// at 1:1 from y 200; the rest falls off the screen). Its top is a trapezoid
// seen from above, its front lip a frosted band, and below the lip a shadow.

const DOCK_W = 512, DOCK_H = 64;
const SHELF = { inset: 14, front: 24, lip: 34, shadow: 40, w: 320 };
const dock = new Float32Array(DOCK_W * DOCK_H * 4);
const onTop = (px: number, py: number) => {
  if (py < 0 || py > SHELF.front || px > SHELF.w) return false;
  const inset = SHELF.inset * (1 - py / SHELF.front);
  return px >= inset && px <= SHELF.w - inset;
};
for (let y = 0; y < SHELF.shadow; y++) {
  for (let x = 0; x < SHELF.w; x++) {
    const o = (y * DOCK_W + x) * 4;
    if (y < SHELF.front) {
      const top = coverage(x, y, onTop);
      if (top === 0) continue;
      const t = (y + 0.5) / SHELF.front;
      // Glass: brighter toward the viewer, a little blue.
      over(dock, o, 0.87, 0.91, 0.96, top * (0.16 + 0.2 * t));
      // The back edge catches a thin line of light.
      if (y === 0) over(dock, o, 1, 1, 1, top * 0.7);
      // A soft reflection band across the middle of the glass.
      over(dock, o, 1, 1, 1, top * 0.1 * Math.exp(-(((t - 0.55) / 0.18) ** 2)));
    } else if (y === SHELF.front) {
      over(dock, o, 1, 1, 1, 0.92);
    } else if (y < SHELF.lip) {
      const t = (y - SHELF.front) / (SHELF.lip - SHELF.front);
      over(dock, o, 0.79, 0.83, 0.88, 0.5 - 0.22 * t);
      if (y === SHELF.front + 1) over(dock, o, 1, 1, 1, 0.35);
      if (y === SHELF.lip - 1) over(dock, o, 0, 0, 0, 0.4);
    } else {
      const t = (y - SHELF.lip) / (SHELF.shadow - SHELF.lip);
      over(dock, o, 0, 0, 0, 0.3 * (1 - t) ** 2);
    }
  }
}
const dockBytes = new Uint8Array(dock.length);
for (let i = 0; i < dockBytes.length; i++) dockBytes[i] = Math.round(Math.min(1, Math.max(0, dock[i]!)) * 255);
writeFileSync(join(OUT, "dock.png"), encodePNG(dockBytes, DOCK_W, DOCK_H));
console.log(`dock.png  ${DOCK_W}x${DOCK_H}`);

// ---- contact sheet: every texture at 1x, then 4x, over the springboard blue ---------

const ROW = 140, W = 1000;
const sheetH = ROW * Object.keys(ICONS).length;
const sheet = new Uint8Array(W * sheetH * 4);
for (let y = 0; y < sheetH; y++) for (let x = 0; x < W; x++) {
  const t = (y % ROW) / ROW, o = (y * W + x) * 4;
  sheet[o] = 0x1f - 18 * t; sheet[o + 1] = 0x52 - 40 * t; sheet[o + 2] = 0x77 - 50 * t; sheet[o + 3] = 255;
}
const blit = (img: Uint8Array, tex: number, left: number, top: number, zoom: number) => {
  for (let y = 0; y < tex * zoom; y++) for (let x = 0; x < tex * zoom; x++) {
    const s = (Math.floor(y / zoom) * tex + Math.floor(x / zoom)) * 4, o = ((top + y) * W + left + x) * 4;
    const a = img[s + 3]! / 255;
    for (let c = 0; c < 3; c++) sheet[o + c] = Math.round(img[s + c]! * a + sheet[o + c]! * (1 - a));
  }
};
const rows = [...new Set(baked.map((b) => b.name))];
for (const entry of baked) {
  const row = rows.indexOf(entry.name), top = row * ROW + 6;
  const column = entry.size === 24 ? 0 : entry.size === 46 ? 1 : 2;
  blit(entry.rgba, entry.tex, 10 + column * 140, top, 1);
  if (entry.size !== 64) blit(entry.rgba, entry.tex, 450 + column * 270, top, entry.size === 24 ? 4 : 2);
}
const sheetDir = resolve(".pocket-build/validation/home-icons");
mkdirSync(sheetDir, { recursive: true });
writeFileSync(join(sheetDir, "contact-sheet.png"), encodePNG(sheet, W, sheetH));
console.log(`contact sheet -> ${join(sheetDir, "contact-sheet.png")}`);
