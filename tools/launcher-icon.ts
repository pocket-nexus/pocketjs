// tools/launcher-icon.ts — bake a manifest's `icon` into the launcher icon set
// a `.pocket` variant carries (contracts/spec/pocket-package.ts section 9).
//
//   bun tools/launcher-icon.ts <pocket.json>... [--density <n>] [--sheet <file.png>]
//   bun tools/launcher-icon.ts <pocket.json> --density <n> --out <file>
//
// The manifest's `icon` names a square SVG (with width and height) or PNG,
// relative to the manifest file, full-bleed and opaque: the launcher's mask
// cuts its corners. Each POCKET_ICON_SIZES row is rasterized at its side x
// the variant's raster density (the SVG 4x4 supersampled, a PNG area-averaged),
// cut to the rounded square of POCKET_ICON_RADIUS with 4x4 coverage, and
// centred in its power-of-two texture as a PSM_8888 IMG entry. The command
// form bakes the named manifests and, with --sheet, writes every entry at 1x
// and 4x on one sheet for review; with --out it writes one manifest's section
// (or removes the file when the manifest names no icon). The packers run that
// form as a subprocess (tools/pocket-pack.ts bakeIconSection), so a runtime
// configuration that imports them never loads the rasterizer.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { PSM } from "../contracts/spec/spec.ts";
import {
  POCKET_ICON_RADIUS,
  POCKET_ICON_SIZES,
  decodeIconSet,
  encodeIconSet,
  type PocketIconEntry,
} from "../contracts/spec/pocket-package.ts";
import { encodeImageEntry } from "../framework/compiler/pak.ts";

/** The drawing a manifest names, or null when it names none. */
export function manifestIconPath(manifestPath: string, manifest: unknown): string | null {
  const icon = (manifest as { icon?: unknown }).icon;
  if (icon === undefined) return null;
  if (typeof icon !== "string" || icon.length === 0) throw new Error(`${manifestPath}: icon must be a path`);
  return resolve(dirname(manifestPath), icon);
}

/** The drawing as n x n straight RGBA. */
async function picture(path: string, n: number): Promise<Uint8Array> {
  const kind = extname(path).toLowerCase();
  if (kind === ".svg") {
    const { rasterizeIconSvg } = await import("./icon-raster.ts");
    const canvas = await rasterizeIconSvg(readFileSync(path, "utf8"), n, n, true);
    return new Uint8Array(canvas.getContext("2d").getImageData(0, 0, n, n).data);
  }
  if (kind !== ".png") throw new Error(`${path}: an icon is an .svg or a .png`);
  const { decodePNG } = await import("./png.ts");
  const source = decodePNG(new Uint8Array(readFileSync(path)));
  if (source.w !== source.h) throw new Error(`${path}: an icon is square`);
  const out = new Uint8Array(n * n * 4);
  const step = source.w / n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let r = 0, g = 0, b = 0, a = 0, w = 0;
      for (let sy = Math.floor(y * step); sy < Math.ceil((y + 1) * step); sy++) {
        const wy = Math.min((y + 1) * step, sy + 1) - Math.max(y * step, sy);
        for (let sx = Math.floor(x * step); sx < Math.ceil((x + 1) * step); sx++) {
          const k = wy * (Math.min((x + 1) * step, sx + 1) - Math.max(x * step, sx));
          const i = (sy * source.w + sx) * 4;
          r += source.rgba[i]! * k; g += source.rgba[i + 1]! * k; b += source.rgba[i + 2]! * k; a += source.rgba[i + 3]! * k; w += k;
        }
      }
      const o = (y * n + x) * 4;
      out[o] = Math.round(r / w); out[o + 1] = Math.round(g / w); out[o + 2] = Math.round(b / w); out[o + 3] = Math.round(a / w);
      if (out[o + 3] !== 255) throw new Error(`${path}: icon artwork must be opaque`);
    }
  }
  return out;
}

/** Fraction of pixel (x, y) inside the rounded square of side n, 4x4 samples. */
function covered(x: number, y: number, n: number): number {
  const r = n * POCKET_ICON_RADIUS;
  let hits = 0;
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) {
      const qx = Math.abs(x + (i + 0.5) / 4 - n / 2) - (n / 2 - r);
      const qy = Math.abs(y + (j + 0.5) / 4 - n / 2) - (n / 2 - r);
      if (Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r <= 0) hits++;
    }
  }
  return hits / 16;
}

/** The icon set for one variant, or undefined when the manifest names no icon. */
export async function bakeIconSet(manifestPath: string, manifest: unknown, density: number): Promise<Uint8Array | undefined> {
  const path = manifestIconPath(manifestPath, manifest);
  if (!path) return undefined;
  if (!Number.isInteger(density) || density < 1) throw new Error(`launcher icon: invalid raster density ${density}`);
  const entries: PocketIconEntry[] = [];
  for (const size of POCKET_ICON_SIZES) {
    const n = size.icon * density, tex = size.texture * density, pad = (tex - n) / 2;
    const rgba = await picture(path, n);
    const out = new Uint8Array(tex * tex * 4);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const s = (y * n + x) * 4, o = ((y + pad) * tex + x + pad) * 4;
        out.set(rgba.subarray(s, s + 3), o);
        out[o + 3] = Math.round(rgba[s + 3]! * covered(x, y, n));
      }
    }
    entries.push({ icon: size.icon, texture: size.texture, image: encodeImageEntry({ width: tex, height: tex, rgba: out }, PSM.PSM_8888) });
  }
  return encodeIconSet(entries);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let density = 1;
  let sheet = "";
  let out = "";
  const manifests: string[] = [];
  while (args.length) {
    const a = args.shift()!;
    if (a === "--density") density = Number(args.shift());
    else if (a === "--sheet") sheet = resolve(args.shift() ?? "");
    else if (a === "--out") out = resolve(args.shift() ?? "");
    else manifests.push(resolve(a));
  }
  if (manifests.length === 0) {
    console.error("usage: bun tools/launcher-icon.ts <pocket.json>... [--density <n>] [--sheet <file.png>]");
    process.exit(1);
  }
  if (out) {
    if (manifests.length !== 1) throw new Error("launcher icon: --out takes one manifest");
    const set = await bakeIconSet(manifests[0]!, JSON.parse(readFileSync(manifests[0]!, "utf8")), density);
    if (set) writeFileSync(out, set);
    else rmSync(out, { force: true });
    process.exit(0);
  }
  const sets: { name: string; entries: PocketIconEntry[] }[] = [];
  for (const manifestPath of manifests) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: string };
    const set = await bakeIconSet(manifestPath, manifest, density);
    if (!set) throw new Error(`${manifestPath}: no icon`);
    sets.push({ name: manifest.name ?? manifestPath, entries: decodeIconSet(set) });
    console.log(`${manifest.name}: ${set.length} B`);
  }
  if (sheet) {
    // Each set on one row over Pocket Shell's springboard blue: 24, 46 and
    // 64 at 1x, then the 64 entry at 4x.
    const row = 64 * density * 5 + 16, width = (32 + 64 + 64) * density + 32 + 256 * density + 16;
    const rgba = new Uint8Array(width * row * sets.length * 4);
    for (let i = 0; i < rgba.length; i += 4) {
      const t = (Math.floor(i / 4 / width) % row) / row;
      rgba[i] = 0x1f - 18 * t; rgba[i + 1] = 0x52 - 40 * t; rgba[i + 2] = 0x77 - 50 * t; rgba[i + 3] = 255;
    }
    const blit = (image: Uint8Array, left: number, top: number, zoom: number) => {
      const tex = new DataView(image.buffer, image.byteOffset).getUint16(0, true);
      for (let y = 0; y < tex * zoom; y++) {
        for (let x = 0; x < tex * zoom; x++) {
          const s = 8 + (Math.floor(y / zoom) * tex + Math.floor(x / zoom)) * 4, o = ((top + y) * width + left + x) * 4;
          const a = image[s + 3]! / 255;
          for (let c = 0; c < 3; c++) rgba[o + c] = Math.round(image[s + c]! * a + rgba[o + c]! * (1 - a));
        }
      }
    };
    sets.forEach((set, index) => {
      let left = 8;
      for (const entry of set.entries) {
        blit(entry.image, left, index * row + 8, 1);
        left += entry.texture * density + 8;
      }
      blit(set.entries[set.entries.length - 1]!.image, left + 8, index * row + 8, 4);
    });
    const { encodePNG } = await import("./png.ts");
    writeFileSync(sheet, encodePNG(rgba, width, row * sets.length));
    console.log(`sheet: ${sheet}`);
  }
}
