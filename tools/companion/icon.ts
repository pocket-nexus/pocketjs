// Pocket Companion's icon: a plum tile with two interlocked link rings, drawn
// from distances with no image assets. The Mac app's icns (tools/companion-app.ts)
// and the CardputerZero launcher's icon (tools/cardputer-zero.ts) use it.

import { encodePNG } from "../png.ts";

/** Signed distance to a rounded rectangle centred at the origin. */
function roundedRect(x: number, y: number, hw: number, hh: number, r: number): number {
  const qx = Math.abs(x) - hw + r;
  const qy = Math.abs(y) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Plum tile with two interlocked link rings, anti-aliased by distance.
 *  Without the tile the rings fill the square on transparency, as icons on a
 *  black launcher are drawn (the CardputerZero's). */
export function drawIcon(size: number, options: { tile?: boolean } = {}): Buffer {
  const tiled = options.tile ?? true;
  const rgba = new Uint8Array(size * size * 4);
  const s = (size / 1024) * (tiled ? 1 : 1.3);
  const plumTop = [0x2a, 0x1d, 0x3d];
  const plumBottom = [0x17, 0x12, 0x26];
  const ring = [0xf4, 0xee, 0xff];
  const accent = [0xff, 0x9f, 0x5a];
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = (px + 0.5 - size / 2) / s;
      const y = (py + 0.5 - size / 2) / s;
      const px1 = 1 / s; // one output pixel in icon units
      const aa = (d: number) => Math.min(1, Math.max(0, 0.5 - d / px1));
      const tile = tiled ? aa(roundedRect(x, y, 412, 412, 92)) : 1;
      if (tile <= 0) continue;
      // Rings: rotate 45°, two rounded-rect outlines offset along the axis.
      const rx = (x + y) / Math.SQRT2;
      const ry = (y - x) / Math.SQRT2;
      const ringA = Math.abs(roundedRect(rx + 110, ry, 190, 105, 105)) - 34;
      const ringB = Math.abs(roundedRect(rx - 110, ry, 190, 105, 105)) - 34;
      // Interlock: ring B under ring A on the upper half, over it on the lower half.
      const a = aa(ringA);
      const b = aa(ringB);
      const t = (y + 412) / 824;
      let c = tiled ? plumTop.map((v, i) => v + (plumBottom[i] - v) * t) : a >= b ? ring : accent;
      const mix = (from: number[], to: number[], k: number) => from.map((v, i) => v + (to[i] - v) * k);
      c = mix(c, accent, b);
      c = mix(c, ring, a);
      if (ry >= 0) c = mix(c, accent, b);
      const o = (py * size + px) * 4;
      rgba[o] = Math.round(c[0]);
      rgba[o + 1] = Math.round(c[1]);
      rgba[o + 2] = Math.round(c[2]);
      rgba[o + 3] = Math.round(255 * (tiled ? tile : Math.max(a, b)));
    }
  }
  return encodePNG(rgba, size, size);
}
