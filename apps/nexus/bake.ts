// apps/nexus/bake.ts — texture staging shared by the Pocket Nexus art bakes
// (apps/nexus/gen-art.ts, apps/nexus-touch/gen-art.ts).
//
// Both bakes draw with DRAW_JS, the homepage's canvas art ported to
// size-parameterized functions, in headless Chrome. Every texture is checked
// to be a power of two of at most 512 px, gets the colour of its opaque edges
// bled into the transparent texels around them (the GPUs filter bilinearly
// with straight alpha, so bare transparent black would fringe), and is
// written only after the whole bake has passed its checks.

import { readdirSync, rmSync } from "node:fs";
import { decodePng } from "../../framework/compiler/pak.ts";
import { encodePNG } from "../../tools/png.ts";

/** The homepage's canvas art (window.NX), evaluated by every Nexus bake. */
export const DRAW_JS = new URL("./art/draw.js", import.meta.url).pathname;

export interface Rgba { rgba: Uint8Array; width: number; height: number }

export const isPow2 = (n: number) => n >= 8 && n <= 512 && (n & (n - 1)) === 0;

/** A canvas's PNG data URL, as bytes. */
export const dataUrlBytes = (url: string) => Uint8Array.from(atob(url.split(",")[1]), (c) => c.charCodeAt(0));

/** Decode PNG bytes into a mutable image. */
export function decode(bytes: Uint8Array): Rgba {
  const image = decodePng(bytes);
  return { rgba: new Uint8Array(image.rgba), width: image.width, height: image.height };
}

/** Copy the colour of opaque neighbours into fully transparent texels. */
export function bleed({ rgba, width: w, height: h }: Rgba): void {
  for (let pass = 0; pass < 6; pass++) {
    const src = rgba.slice();
    let changed = false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (src[i + 3] !== 0 || (src[i] | src[i + 1] | src[i + 2]) !== 0) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = (ny * w + nx) * 4;
          if (src[j + 3] === 0 && (src[j] | src[j + 1] | src[j + 2]) === 0) continue;
          r += src[j]; g += src[j + 1]; b += src[j + 2]; n++;
        }
        if (n > 0) {
          rgba[i] = Math.round(r / n); rgba[i + 1] = Math.round(g / n); rgba[i + 2] = Math.round(b / n);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
}

/** Encoded textures by file name, written together once the bake has passed. */
export class TextureStage {
  readonly files = new Map<string, Uint8Array>();

  /** Check, bleed and encode `image` as `name`; the image is bled in place. */
  put(name: string, image: Rgba): void {
    if (!isPow2(image.width) || !isPow2(image.height)) throw new Error(`${name}: ${image.width}x${image.height} is not a power-of-two texture`);
    if (this.files.has(name)) throw new Error(`${name}: baked twice`);
    bleed(image);
    this.files.set(name, encodePNG(image.rgba, image.width, image.height));
  }

  /** Replace every PNG in `dir` with the staged textures. */
  async write(dir: string): Promise<void> {
    for (const name of readdirSync(dir)) if (name.endsWith(".png") && !this.files.has(name)) rmSync(dir + name);
    for (const [name, png] of this.files) await Bun.write(dir + name, png);
  }
}
