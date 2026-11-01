// @pocketjs/framework/game2d — darkness mask.
//
// A low-resolution CLUT8 texture whose palette is black at falling alpha, stretched over the
// screen with bilinear sampling. Lights are concentric ellipses; every band of every light is a
// run of TypedArray.fill per scanline, painted dark to bright so overlapping lights take the
// union. All integer: on a real PSP JS doubles are soft-float (Math.sqrt on the order of 20 µs),
// so a scanline uses a lookup table and fixed point, and an unchanged light set skips the work.

import { getOps } from "../index.ts";

export interface Light { x: number; y: number; r: number; a?: number }
export interface LightMask {
  /** Rebuild from lights in screen pixels, at most every `every` frames. Returns the texture handle. */
  update(lights: Light[], ambient?: number): number;
  handle(): number;
  dispose(): void;
}
type Ops = { uploadImgEntry?: (b: Uint8Array) => number; freeTexture?: (h: number) => void; uploadTexture: (b: Uint8Array, w: number, h: number, p: number) => number };

const HEADER = 8, PAL = 1024;
const IMG_FLAG_LINEAR = 2, PSM_T8 = 5;

// Half-widths of the unit circle in 1/256ths, so a scanline never touches a soft-float sqrt.
const CIRCLE = new Int16Array(257);
for (let i = 0; i <= 256; i++) { const t = i / 256; CIRCLE[i] = (Math.sqrt(1 - t * t) * 256) | 0; }

export function createLightMask(o: { screenW: number; screenH: number; texW?: number; texH?: number; levels?: number; every?: number; aspect?: number }): LightMask {
  const W = o.texW ?? 64, H = o.texH ?? 32, L = o.levels ?? 5, every = o.every ?? 4, aspect = o.aspect ?? 1.7;
  const blob = new Uint8Array(HEADER + PAL + W * H);
  const dv = new DataView(blob.buffer);
  dv.setUint16(0, W, true); dv.setUint16(2, H, true); blob[4] = PSM_T8; blob[5] = IMG_FLAG_LINEAR;
  // Palette: index i = light level i of L-1, alpha falls with light (ABGR, black).
  for (let i = 0; i < L; i++) {
    const k = i / (L - 1);
    dv.setUint32(HEADER + i * 4, (Math.round(0xf6 * (1 - k) * (1 - k * 0.15)) << 24) >>> 0, true);
  }
  // Radius of each level as a fraction of the light's radius, in 1/256ths: bright inner, dim outer.
  const RADIUS = new Int32Array(L);
  for (let lv = 1; lv < L; lv++) RADIUS[lv] = (((L - 1 - lv) / (L - 1)) * 256 + 40) | 0;
  const px = blob.subarray(HEADER + PAL);
  // Screen pixels to texels, as 16.16 fixed point.
  const kx = ((W * 65536) / o.screenW) | 0, ky = ((H * 65536) / o.screenH) | 0, kyA = (ky * 10 / ((aspect * 10) | 0)) | 0;
  let handle = -1, frame = 0, lastSig = -1;
  const ops = () => getOps() as unknown as Ops;
  const m: LightMask = {
    handle: () => handle,
    update(lights, ambient = 0) {
      if (handle >= 0 && frame++ % every !== 0) return handle;
      // Nothing moved by a whole texel: keep the texture (standing still costs nothing).
      let sig = lights.length | 0;
      for (let n = 0; n < lights.length; n++) { const l = lights[n]; sig = (Math.imul(sig, 31) + (((l.x * kx) >> 16) | 0) * 1024 + (((l.y * ky) >> 16) | 0) + ((l.r | 0) << 20)) | 0; }
      if (handle >= 0 && sig === lastSig) return handle;
      lastSig = sig;
      px.fill(ambient);
      for (let lv = Math.max(1, ambient + 1); lv < L; lv++) {
        for (let n = 0; n < lights.length; n++) {
          const l = lights[n], a = l.a === undefined || l.a >= 1 ? 256 : (l.a * 256) | 0;
          const frac = (RADIUS[lv] * a) >> 8, rr = l.r | 0;
          const rx = (rr * frac * (kx >> 8)) >> 16, ry = (rr * frac * (kyA >> 8)) >> 16;
          if (rx < 1 || ry < 1) continue;
          const cx = ((l.x | 0) * (kx >> 8)) >> 8, cy = ((l.y | 0) * (ky >> 8)) >> 8;
          const step = ((256 << 8) / ry) | 0;
          const y0 = cy - ry < 0 ? 0 : cy - ry, y1 = cy + ry >= H ? H - 1 : cy + ry;
          for (let y = y0; y <= y1; y++) {
            const dy = y < cy ? cy - y : y - cy, half = (rx * CIRCLE[(dy * step) >> 8]) >> 8;
            let x0 = cx - half, x1 = cx + half + 1;
            if (x0 < 0) x0 = 0; if (x1 > W) x1 = W;
            if (x0 < x1) px.fill(lv, y * W + x0, y * W + x1);
          }
        }
      }
      const op = ops(), old = handle;
      handle = op.uploadImgEntry ? op.uploadImgEntry(blob) : op.uploadTexture(blob.subarray(HEADER), W, H, PSM_T8);
      if (old >= 0) op.freeTexture?.(old);
      return handle;
    },
    dispose() { if (handle >= 0) ops().freeTexture?.(handle); handle = -1; },
  };
  return m;
}
