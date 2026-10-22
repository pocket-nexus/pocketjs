// Round pictures for a console's lists (an X avatar, a Discord avatar or
// server icon): a decoded image box-filtered to a disc and encoded as an IMG
// entry (framework/compiler/pak.ts).

import { encodeImageEntry, type DecodedImage } from "../../framework/compiler/pak.ts";

export interface DiscOptions {
  /** The texture's side in pixels. */
  size: number;
  /** The disc's diameter, centred in the texture; default `size`. */
  circle?: number;
  /** The RGB the disc is drawn over (the texture is opaque), or null for a
   *  transparent surround. */
  background: readonly [number, number, number] | null;
  /** The texture's PSM. */
  psm: number;
}

/** `image` box-filtered to the disc's diameter and cut to the disc, its
 *  edge antialiased from 4x4 samples a pixel, as an IMG entry. */
export function discImage(image: DecodedImage, options: DiscOptions): Uint8Array {
  const { size, background } = options;
  const circle = options.circle ?? size;
  const out = new Uint8Array(size * size * 4);
  const scaleX = image.width / circle;
  const scaleY = image.height / circle;
  const margin = (size - circle) / 2;
  const radius = circle / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const cx = x - margin;
      const cy = y - margin;
      // Coverage of the circle over this pixel, 4x4 samples.
      let inside = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const dx = cx + (sx + 0.5) / 4 - radius;
          const dy = cy + (sy + 0.5) / 4 - radius;
          if (dx * dx + dy * dy <= radius * radius) inside++;
        }
      }
      if (inside === 0) {
        if (background) out.set([...background, 255], o);
        continue;
      }
      // The source box under this pixel, clamped into the image.
      const x0 = Math.max(0, Math.min(image.width - 1, Math.floor(cx * scaleX)));
      const y0 = Math.max(0, Math.min(image.height - 1, Math.floor(cy * scaleY)));
      const x1 = Math.max(x0 + 1, Math.min(image.width, Math.floor((cx + 1) * scaleX)));
      const y1 = Math.max(y0 + 1, Math.min(image.height, Math.floor((cy + 1) * scaleY)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * image.width + sx) * 4;
          r += image.rgba[i]!;
          g += image.rgba[i + 1]!;
          b += image.rgba[i + 2]!;
          a += image.rgba[i + 3]!;
        }
      }
      const n = (x1 - x0) * (y1 - y0);
      const rgb = [r / n, g / n, b / n];
      const alpha = ((a / n) * inside) / 16;
      if (!background) {
        out.set([...rgb.map(Math.round), Math.round(alpha)], o);
        continue;
      }
      const cover = alpha / 255;
      for (let c = 0; c < 3; c++) out[o + c] = Math.round(rgb[c]! * cover + background[c]! * (1 - cover));
      out[o + 3] = 255;
    }
  }
  return encodeImageEntry({ width: size, height: size, rgba: out }, options.psm);
}
