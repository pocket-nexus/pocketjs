import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { rasterizeIconSvg } from "./icon-raster.ts";

/**
 * The launcher icon of an Android package, one file a density.
 *
 * A launcher draws the file of its own density bucket; a single 64-pixel
 * bitmap in `res/drawable` (the mdpi bucket) is scaled up by 2 on an xhdpi
 * phone. Each file here is made from the source once, by averaging the
 * source pixels a destination pixel covers. A source is never scaled up.
 */
export const ANDROID_LAUNCHER_DENSITIES = [
  ["mdpi", 48],
  ["hdpi", 72],
  ["xhdpi", 96],
  ["xxhdpi", 144],
  ["xxxhdpi", 192],
] as const;

/** The largest file's side: a bitmap source has at least this many pixels a side. */
export const ANDROID_ICON_MIN_SOURCE = 192;

/** PocketJS's mark on its plum ground, a vector drawing (tools/generate-brand.ts). */
export const ANDROID_DEFAULT_ICON = "assets/brand/pocketjs-avatar-dark.svg";

export interface AndroidLauncherIcons {
  /** SHA-256 of the source file's bytes. */
  readonly sourceSha256: string;
  readonly files: ReadonlyArray<{ readonly density: string; readonly size: number; readonly path: string; readonly sha256: string }>;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * `side` by `side` straight RGBA from `source` by `source` straight RGBA: each
 * destination pixel is the mean of the source area it covers, with the
 * partly covered pixels at its edges weighted by the part covered. Colour is
 * averaged premultiplied, so a transparent pixel adds no colour to an edge.
 */
export function downsampleSquare(pixels: Uint8ClampedArray | Uint8Array, source: number, side: number): Uint8ClampedArray {
  if (side > source) throw new Error(`an icon is never scaled up: ${source} pixels to ${side}`);
  const out = new Uint8ClampedArray(side * side * 4);
  const step = source / side;
  for (let y = 0; y < side; y++) {
    const top = y * step, bottom = (y + 1) * step;
    for (let x = 0; x < side; x++) {
      const left = x * step, right = (x + 1) * step;
      let red = 0, green = 0, blue = 0, alpha = 0, area = 0;
      for (let sy = Math.floor(top); sy < Math.ceil(bottom); sy++) {
        const rows = Math.min(bottom, sy + 1) - Math.max(top, sy);
        for (let sx = Math.floor(left); sx < Math.ceil(right); sx++) {
          const weight = rows * (Math.min(right, sx + 1) - Math.max(left, sx));
          const i = (sy * source + sx) * 4;
          const a = pixels[i + 3] * weight;
          red += pixels[i] * a;
          green += pixels[i + 1] * a;
          blue += pixels[i + 2] * a;
          alpha += a;
          area += weight;
        }
      }
      const o = (y * side + x) * 4;
      out[o] = alpha ? Math.round(red / alpha) : 0;
      out[o + 1] = alpha ? Math.round(green / alpha) : 0;
      out[o + 2] = alpha ? Math.round(blue / alpha) : 0;
      out[o + 3] = Math.round(alpha / area);
    }
  }
  return out;
}

function encode(pixels: Uint8ClampedArray, side: number): Buffer {
  const canvas = createCanvas(side, side);
  const context = canvas.getContext("2d");
  const image = context.createImageData(side, side);
  image.data.set(pixels);
  context.putImageData(image, 0, 0);
  return canvas.toBuffer("image/png");
}

/**
 * Writes `mipmap-<density>/icon.png` for the five densities under
 * `resources`. `sourcePath` is a square PNG of at least 192 pixels a side, or
 * an SVG that declares its width and height; a vector is rastered for each
 * size on its own, at four samples a pixel in each direction.
 */
export async function bakeAndroidLauncherIcons(sourcePath: string, resources: string): Promise<AndroidLauncherIcons> {
  const bytes = readFileSync(sourcePath);
  const vector = sourcePath.toLowerCase().endsWith(".svg");
  let bitmap: { pixels: Uint8ClampedArray; side: number } | undefined;
  if (!vector) {
    const image = await loadImage(bytes);
    if (image.width !== image.height) {
      throw new Error(`an Android launcher icon is square: ${sourcePath} is ${image.width} by ${image.height}`);
    }
    if (image.width < ANDROID_ICON_MIN_SOURCE) {
      throw new Error(
        `an Android launcher icon is never scaled up: ${sourcePath} is ${image.width} pixels a side, ` +
          `and the largest file is ${ANDROID_ICON_MIN_SOURCE}`,
      );
    }
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    bitmap = { pixels: context.getImageData(0, 0, image.width, image.height).data, side: image.width };
  }
  const files: Array<AndroidLauncherIcons["files"][number]> = [];
  for (const [density, size] of ANDROID_LAUNCHER_DENSITIES) {
    const png = bitmap
      ? encode(downsampleSquare(bitmap.pixels, bitmap.side, size), size)
      : (await rasterizeIconSvg(bytes.toString("utf8"), size, size, false)).toBuffer("image/png");
    const directory = join(resources, `mipmap-${density}`);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "icon.png");
    writeFileSync(path, png);
    files.push({ density, size, path, sha256: sha256(png) });
  }
  return { sourceSha256: sha256(bytes), files };
}
