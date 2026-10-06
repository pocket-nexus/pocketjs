// Area-weighted RGBA resampling for launcher icons.
//
// Each destination pixel averages the source area it covers, each source
// pixel weighted by the part of it inside that area, in premultiplied alpha
// so transparent pixels lend no colour to their neighbours. Downscaling is a
// box filter over the exact footprint; upscaling repeats source pixels and
// blends only along their shared edges.

import type { RgbaImage } from "./png.ts";

interface Tap {
  readonly index: number;
  readonly weight: number;
}

function taps(source: number, target: number): Tap[][] {
  const scale = source / target;
  const out: Tap[][] = [];
  for (let i = 0; i < target; i++) {
    const start = i * scale, end = (i + 1) * scale;
    const row: Tap[] = [];
    for (let s = Math.floor(start); s < Math.min(source, Math.ceil(end)); s++) {
      const weight = (Math.min(end, s + 1) - Math.max(start, s)) / scale;
      if (weight > 0) row.push({ index: s, weight });
    }
    out.push(row);
  }
  return out;
}

export function scaleRgba(image: RgbaImage, width: number, height: number): RgbaImage {
  if (image.width === width && image.height === height) return image;
  const columns = taps(image.width, width);
  const rows = taps(image.height, height);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const row of rows[y]!) {
        for (const column of columns[x]!) {
          const at = (row.index * image.width + column.index) * 4;
          const weight = row.weight * column.weight;
          const alpha = image.rgba[at + 3]! * weight;
          r += image.rgba[at]! * alpha;
          g += image.rgba[at + 1]! * alpha;
          b += image.rgba[at + 2]! * alpha;
          a += alpha;
        }
      }
      const out = (y * width + x) * 4;
      if (a > 0) {
        rgba[out] = Math.min(255, Math.round(r / a));
        rgba[out + 1] = Math.min(255, Math.round(g / a));
        rgba[out + 2] = Math.min(255, Math.round(b / a));
        rgba[out + 3] = Math.min(255, Math.round(a));
      }
    }
  }
  return { width, height, rgba };
}

/** The image composited over an opaque background colour (alpha 255 everywhere). */
export function flattenRgba(image: RgbaImage, background: readonly [number, number, number]): RgbaImage {
  const rgba = new Uint8Array(image.rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const alpha = image.rgba[i + 3]! / 255;
    for (let c = 0; c < 3; c++) {
      rgba[i + c] = Math.round(image.rgba[i + c]! * alpha + background[c]! * (1 - alpha));
    }
    rgba[i + 3] = 255;
  }
  return { width: image.width, height: image.height, rgba };
}

/** A square icon: refuses a non-square source, then scales it to `size`. */
export function squareIcon(image: RgbaImage, size: number): RgbaImage {
  if (image.width !== image.height) {
    throw new Error(`icon: ${image.width}x${image.height} is not square`);
  }
  return scaleRgba(image, size, size);
}
