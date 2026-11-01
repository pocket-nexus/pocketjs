// @pocketjs/framework/game2d — darkness mask.
//
// A low-resolution CLUT8 texture whose palette is black at falling alpha, stretched over the
// screen with bilinear sampling. Lights are concentric ellipses; every band of every light is a
// run of TypedArray.fill per scanline, painted dark to bright so overlapping lights take the
// union. A few hundred native fills per update, not a per-pixel loop: this is what makes several
// moving lights affordable on a 333 MHz interpreter.

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

export function createLightMask(o: { screenW: number; screenH: number; texW?: number; texH?: number; levels?: number; every?: number; aspect?: number }): LightMask {
  const W = o.texW ?? 128, H = o.texH ?? 64, L = o.levels ?? 8, every = o.every ?? 2, aspect = o.aspect ?? 1.7;
  const blob = new Uint8Array(HEADER + PAL + W * H);
  const dv = new DataView(blob.buffer);
  dv.setUint16(0, W, true); dv.setUint16(2, H, true); blob[4] = PSM_T8; blob[5] = IMG_FLAG_LINEAR;
  // Palette: index i = light level i of L-1, alpha falls with light (ABGR, black).
  for (let i = 0; i < L; i++) {
    const k = i / (L - 1);
    dv.setUint32(HEADER + i * 4, (Math.round(0xf6 * (1 - k) * (1 - k * 0.15)) << 24) >>> 0, true);
  }
  const px = blob.subarray(HEADER + PAL);
  const kx = W / o.screenW, ky = H / o.screenH;
  let handle = -1, frame = 0;
  const ops = () => getOps() as unknown as Ops;
  const m: LightMask = {
    handle: () => handle,
    update(lights, ambient = 0) {
      if (handle >= 0 && frame++ % every !== 0) return handle;
      px.fill(ambient);
      for (let lv = Math.max(1, ambient + 1); lv < L; lv++) {
        for (let n = 0; n < lights.length; n++) {
          const l = lights[n], a = l.a ?? 1;
          // radius of this level: bright inner, dim outer
          const f = 1 - lv / (L - 1) / a;
          if (f <= 0) continue;
          const rx = l.r * f * kx, ry = (l.r * f * ky) / aspect;
          if (rx < 0.5) continue;
          const cx = l.x * kx, cy = l.y * ky;
          const y0 = Math.max(0, Math.ceil(cy - ry)), y1 = Math.min(H - 1, Math.floor(cy + ry));
          for (let y = y0; y <= y1; y++) {
            const t = (y - cy) / ry, half = rx * Math.sqrt(1 - t * t);
            let x0 = Math.ceil(cx - half), x1 = Math.floor(cx + half) + 1;
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
