/** Bilinear resampling shared by native program artwork builders. */
export function resizeBilinear(
  rgba: Uint8Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Uint8Array {
  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = ((y + 0.5) * sh) / dh - 0.5;
    const y0 = Math.min(sh - 1, Math.max(0, Math.floor(sy)));
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = Math.min(1, Math.max(0, sy - y0));
    for (let x = 0; x < dw; x++) {
      const sx = ((x + 0.5) * sw) / dw - 0.5;
      const x0 = Math.min(sw - 1, Math.max(0, Math.floor(sx)));
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = Math.min(1, Math.max(0, sx - x0));
      const o = (y * dw + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top =
          rgba[(y0 * sw + x0) * 4 + c] +
          (rgba[(y0 * sw + x1) * 4 + c] - rgba[(y0 * sw + x0) * 4 + c]) * fx;
        const bot =
          rgba[(y1 * sw + x0) * 4 + c] +
          (rgba[(y1 * sw + x1) * 4 + c] - rgba[(y1 * sw + x0) * 4 + c]) * fx;
        out[o + c] = Math.round(top + (bot - top) * fy);
      }
    }
  }
  return out;
}
