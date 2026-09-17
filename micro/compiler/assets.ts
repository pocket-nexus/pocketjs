// micro/compiler/assets.ts — the app pack for a Micro program: styles.bin
// from the class literals the frontend collected, font atlases covering the
// strings the app can display, and the images and sprite atlases it names.
// Same compiler modules as tools/build.ts, driven by the IR instead of a
// module-graph scan, so a Micro build and the Solid build of one app agree
// on every style record and glyph.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { IMG_FLAG_LINEAR, PSM } from "../../contracts/spec/spec.ts";
import { registerAnimationTheme, setAnimationTickRate } from "../../framework/compiler/animation.ts";
import { bakeAtlases, type BakedAtlas } from "../../framework/compiler/bake-font.ts";
import { bakeSvg } from "../../framework/compiler/bake-svg.ts";
import {
  decodePng,
  encodeImageEntry,
  encodeSpriteEntry,
  KEY_STYLES,
  keyFont,
  keyImage,
  keySprite,
  pack,
  PAK_DTYPE,
  placeholderImage,
  type PakBlob,
} from "../../framework/compiler/pak.ts";
import { compileClasses, type CompiledStyles } from "../../framework/compiler/tailwind.ts";
import type { PocketConfig } from "../../framework/src/config.ts";
import type { Program } from "./ir.ts";

export interface BuiltAssets {
  styles: CompiledStyles;
  atlases: BakedAtlas[];
  pak: Uint8Array;
  /** Pak entry keys in order. */
  entries: string[];
}

interface SpriteMeta {
  cols: number;
  rows: number;
  frames: number;
  step: number;
  psm?: number;
}

interface ImageMeta {
  linear?: boolean;
  psm?: number;
}

async function loadTheme(root: string, appDir: string): Promise<PocketConfig["theme"]> {
  for (const path of [join(appDir, "pocket.config.ts"), join(root, "pocket.config.ts")]) {
    if (!existsSync(path)) continue;
    const mod = (await import(pathToFileURL(path).href)) as { default?: PocketConfig; config?: PocketConfig };
    return (mod.default ?? mod.config)?.theme;
  }
  return undefined;
}

export async function buildAssets(
  program: Program,
  appDir: string,
  root: string,
  log: (line: string) => void = () => {},
): Promise<BuiltAssets> {
  registerAnimationTheme(await loadTheme(root, appDir));
  setAnimationTickRate(60);
  const styles = compileClasses(program.assets.classes);
  const missing = program.assets.classes.filter((c) => !(c in styles.ids));
  if (missing.length > 0) {
    throw new Error(`Micro TS: class literals did not compile as styles: ${missing.map((m) => JSON.stringify(m)).join(", ")}`);
  }
  log(`  tailwind: ${styles.records.length} style record(s) from ${program.assets.classes.length} literal(s)`);

  const codepoints = new Set<number>();
  for (const s of program.assets.strings) for (const ch of s) codepoints.add(ch.codePointAt(0)!);
  const atlases = await bakeAtlases({ codepoints, slots: styles.usedFontSlots, rasterDensity: 1 });
  for (const a of atlases) {
    log(`  font: slot ${a.slot} (${a.px}px${a.bold ? " bold" : ""}) ${a.glyphCount} glyphs, ${a.bytes.length} bytes`);
  }

  const blobs: PakBlob[] = [
    { key: KEY_STYLES, dtype: PAK_DTYPE.u8, data: styles.bin },
    ...atlases.map((a) => ({ key: keyFont(a.slot), dtype: PAK_DTYPE.u8, data: a.bytes })),
  ];

  const spriteManifest = join(appDir, "sprites.json");
  const spriteMeta: Record<string, SpriteMeta> = existsSync(spriteManifest)
    ? ((await Bun.file(spriteManifest).json()) as Record<string, SpriteMeta>)
    : {};
  const imageManifest = join(appDir, "images.json");
  const imageMeta: Record<string, ImageMeta> = existsSync(imageManifest)
    ? ((await Bun.file(imageManifest).json()) as Record<string, ImageMeta>)
    : {};

  const names = [...new Set([...program.assets.images, ...program.assets.sprites])];
  for (const name of names) {
    const candidates = [join(appDir, name), join(root, "assets/images", name), join(root, "assets", name)];
    const found = candidates.find((c) => existsSync(c));
    let img;
    if (found) {
      img = /\.svg$/i.test(found)
        ? bakeSvg(await Bun.file(found).text(), 1)
        : decodePng(new Uint8Array(await Bun.file(found).arrayBuffer()));
      log(`  image: ${name} <- ${found} (${img.width}x${img.height})`);
    } else {
      img = placeholderImage();
      log(`  image: ${name} not found (tried ${candidates.join(", ")}) — 32x32 placeholder`);
    }
    const sp = spriteMeta[name];
    if (program.assets.sprites.includes(name)) {
      if (!sp) throw new Error(`Micro TS: sprite "${name}" has no entry in ${spriteManifest}`);
      blobs.push({
        key: keySprite(name),
        dtype: PAK_DTYPE.u8,
        data: encodeSpriteEntry(
          { atlasW: img.width, atlasH: img.height, frameCount: sp.frames, cols: sp.cols, frameStep: sp.step, rgba: img.rgba },
          sp.psm ?? PSM.PSM_8888,
        ),
      });
      log(`  sprite: ${name} (${sp.frames} frames, ${sp.cols} cols, step ${sp.step})`);
    }
    if (program.assets.images.includes(name)) {
      const meta = imageMeta[name];
      blobs.push({
        key: keyImage(name),
        dtype: PAK_DTYPE.u8,
        data: encodeImageEntry(img, meta?.psm ?? PSM.PSM_8888, meta?.linear ? IMG_FLAG_LINEAR : 0),
      });
    }
  }
  const pak = pack(blobs);
  log(`  pak: ${blobs.length} entries, ${pak.length} bytes`);
  return { styles, atlases, pak, entries: blobs.map((b) => b.key) };
}

export function appDirOf(entry: string): string {
  return dirname(entry);
}
