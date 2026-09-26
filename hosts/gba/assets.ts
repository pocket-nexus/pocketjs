/** Build-time palette reduction and native Hero → GBA tile packing. */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const channels = (color: number) => [color & 31, color >> 5 & 31, color >> 10 & 31];

/** Weighted median cut in the GBA's actual five-bit color space. Index 0 is reserved. */
export function paletteFor(histogram: Map<number, number>): number[] {
  type Color = { color: number; weight: number; rgb: number[] };
  const initial = [...histogram].map(([color, weight]) => ({ color, weight, rgb: channels(color) }));
  if (!initial.length) return Array(256).fill(0);
  const boxes: Color[][] = [initial];
  const range = (box: Color[]) => [0, 1, 2].map(channel => {
    let min = 31, max = 0;
    for (const color of box) { min = Math.min(min, color.rgb[channel]!); max = Math.max(max, color.rgb[channel]!); }
    return max - min;
  });
  while (boxes.length < 255) {
    let selected = -1, score = -1;
    for (let i = 0; i < boxes.length; ++i) {
      if (boxes[i]!.length < 2) continue;
      const candidate = Math.max(...range(boxes[i]!)) ** 2 * Math.sqrt(boxes[i]!.reduce((sum, color) => sum + color.weight, 0));
      if (candidate > score) { selected = i; score = candidate; }
    }
    if (selected < 0) break;
    const box = boxes[selected]!, spans = range(box), axis = spans.indexOf(Math.max(...spans));
    box.sort((a, b) => a.rgb[axis]! - b.rgb[axis]! || a.color - b.color);
    const half = box.reduce((sum, color) => sum + color.weight, 0) / 2;
    let sum = 0, split = 0;
    do { sum += box[split++]!.weight; } while (sum < half && split < box.length - 1);
    boxes.splice(selected, 1, box.slice(0, split), box.slice(split));
  }
  const palette = [0, ...boxes.map(box => {
    const weight = box.reduce((sum, color) => sum + color.weight, 0);
    const rgb = [0, 1, 2].map(axis => Math.round(box.reduce((sum, color) => sum + color.rgb[axis]! * color.weight, 0) / weight));
    return rgb[0]! | rgb[1]! << 5 | rgb[2]! << 10;
  })];
  while (palette.length < 256) palette.push(palette[1]!);
  return palette;
}

function indexer(palette: number[]) {
  const cache = new Map<number, number>();
  return (color: number) => {
    const known = cache.get(color);
    if (known !== undefined) return known;
    const rgb = channels(color);
    let best = 1, distance = Infinity;
    for (let i = 1; i < palette.length; ++i) {
      const sample = channels(palette[i]!);
      const delta = rgb.reduce((sum, channel, c) => sum + (channel - sample[c]!) ** 2, 0);
      if (delta < distance) { best = i; distance = delta; }
    }
    cache.set(color, best);
    return best;
  };
}

/** OBJ data: object rows, then 8×8 tile rows within each object. */
export function objectTiles(pixels: Uint8Array, width: number, height: number, objectWidth: number, objectHeight: number): Uint8Array {
  if (![width, height, objectWidth, objectHeight].every(value => Number.isSafeInteger(value) && value > 0)
      || pixels.length !== width * height || width % objectWidth || height % objectHeight || objectWidth % 8 || objectHeight % 8) throw new Error("Invalid OBJ patch dimensions");
  const tiles = new Uint8Array(pixels.length);
  let output = 0;
  for (let oy = 0; oy < height; oy += objectHeight) for (let ox = 0; ox < width; ox += objectWidth)
    for (let ty = 0; ty < objectHeight; ty += 8) for (let tx = 0; tx < objectWidth; tx += 8)
      for (let y = 0; y < 8; ++y) for (let x = 0; x < 8; ++x)
        tiles[output++] = pixels[(oy + ty + y) * width + ox + tx + x]!;
  return tiles;
}

type Crop = [number, number, number, number];
interface Frame { file: string; width?: number; color?: number; advance?: number; char?: string }
interface BakeManifest {
  width: number; height: number; format: string;
  background: string; digitsBackground: string; prefixAdvance: number;
  spinner: Frame[]; underline: Frame[]; button: Frame[]; digits: Frame[]; message: string;
  crops: Record<"spinner" | "underline" | "button" | "digits" | "message", Crop>;
}

export function packHeroAssets(directory: string, generated: string) {
  const manifest: BakeManifest = JSON.parse(readFileSync(resolve(directory, "manifest.json"), "utf8"));
  // This is the Hero cartridge's fixed OBJ allocation, shared with scene.rs.
  // Changing a crop or frame count requires changing that allocation too;
  // accepting arbitrary dimensions here could overwrite a neighboring layer.
  if (manifest.width !== 240 || manifest.height !== 160 || manifest.format !== "rgb555le") {
    throw new Error("Hero assets require 240x160 rgb555le native snapshots");
  }
  const crops: BakeManifest["crops"] = {
    spinner: [200, 56, 32, 48], underline: [0, 80, 160, 16],
    button: [0, 112, 96, 48], digits: [100, 120, 16, 32], message: [8, 144, 224, 16],
  };
  for (const name of Object.keys(crops) as (keyof typeof crops)[]) {
    const actual = manifest.crops?.[name], expected = crops[name];
    if (!Array.isArray(actual) || actual.length !== 4 || expected.some((value, index) => actual[index] !== value)) {
      throw new Error(`Hero OBJ allocation requires ${name} crop [${expected.join(", ")}]`);
    }
  }
  const counts = { spinner: 8, underline: 145, button: 21, digits: 11 } as const;
  const files = new Set<string>();
  const requireFile = (file: string) => {
    if (typeof file !== "string" || !file.length) throw new Error("Hero snapshot file is missing");
    files.add(file);
  };
  requireFile(manifest.background); requireFile(manifest.digitsBackground); requireFile(manifest.message);
  for (const name of Object.keys(counts) as (keyof typeof counts)[]) {
    const frames = manifest[name];
    if (!Array.isArray(frames) || frames.length !== counts[name]) {
      throw new Error(`Hero OBJ allocation requires ${counts[name]} ${name} frames`);
    }
    for (const frame of frames) requireFile(frame?.file);
  }
  if (manifest.underline.some((frame, index) => frame.width !== index)) {
    throw new Error("Hero underline frames must be ordered by width 0 through 144");
  }
  if (manifest.button.some(frame => !Number.isInteger(frame.color) || frame.color! < 0 || frame.color! > 0xffffffff)) {
    throw new Error("Hero button frames require unsigned 32-bit colors");
  }
  if (manifest.digits.some((frame, index) => frame.char !== "0123456789-"[index]
    || !Number.isFinite(frame.advance) || frame.advance! <= 0 || frame.advance! > 16)) {
    throw new Error("Hero digit frames must be 0 through 9 then minus, with advances in (0, 16]");
  }
  if (!Number.isFinite(manifest.prefixAdvance) || manifest.prefixAdvance < 0 || manifest.prefixAdvance > 240) {
    throw new Error("Hero counter prefix advance must be between 0 and 240 pixels");
  }
  for (const file of files) {
    if (statSync(resolve(directory, file)).size !== 240 * 160 * 2) {
      throw new Error(`Invalid native snapshot: ${file}; expected 76800 bytes`);
    }
  }
  const read = (file: string) => {
    const bytes = readFileSync(resolve(directory, file));
    if (bytes.length !== 240 * 160 * 2) throw new Error(`Invalid native snapshot: ${file}`);
    return Uint16Array.from({ length: 240 * 160 }, (_, i) => bytes.readUInt16LE(i * 2));
  };
  const background = read(manifest.background), digitsBackground = read(manifest.digitsBackground);
  const bgHistogram = new Map<number, number>();
  for (const color of background) bgHistogram.set(color, (bgHistogram.get(color) ?? 0) + 1);
  const bgPalette = paletteFor(bgHistogram), bgIndex = indexer(bgPalette);
  const bgTiles: number[] = [], bgMap = Array(32 * 32).fill(0), dedup = new Map<string, number>();
  for (let y = 0; y < 20; ++y) for (let x = 0; x < 30; ++x) {
    const tile: number[] = [];
    for (let dy = 0; dy < 8; ++dy) for (let dx = 0; dx < 8; ++dx) tile.push(bgIndex(background[(y * 8 + dy) * 240 + x * 8 + dx]!));
    const key = tile.join(",");
    let id = dedup.get(key);
    if (id === undefined) { id = bgTiles.length / 64; dedup.set(key, id); bgTiles.push(...tile); }
    bgMap[y * 32 + x] = id;
  }
  if (bgTiles.length > 0xf800) throw new Error("Hero background exceeds GBA character memory");
  const histogram = new Map<number, number>();
  const groups = (["spinner", "underline", "button", "digits", "message"] as const).map(name => {
    const crop = manifest.crops[name];
    const [x, y, width, height] = crop;
    const base = name === "digits" ? digitsBackground : background;
    const frames = (name === "message" ? [{ file: manifest.message }] : manifest[name]).map(frame => {
      const native = read(frame.file), pixels = new Int32Array(width * height).fill(-1);
      for (let py = 0; py < height; ++py) for (let px = 0; px < width; ++px) {
        if (x + px < 0 || x + px >= 240 || y + py < 0 || y + py >= 160) continue;
        const offset = (y + py) * 240 + x + px, color = native[offset]!;
        if (color === base[offset]) continue;
        pixels[py * width + px] = color;
        histogram.set(color, (histogram.get(color) ?? 0) + 1);
      }
      return { ...frame, pixels };
    });
    return { name, crop, frames, objectWidth: name === "digits" ? 16 : 32, objectHeight: name === "digits" ? 32 : 16 };
  });
  const objPalette = paletteFor(histogram), objIndex = indexer(objPalette);
  const source: string[] = ["// Generated from the native TSX scene. Do not edit."];
  const array = (name: string, words: number[]) => source.push(`pub static ${name}: [u16; ${words.length}] = [${words.join(",")}];`);
  const halfwords = (bytes: ArrayLike<number>) => Array.from({ length: bytes.length / 2 }, (_, i) => bytes[i * 2]! | bytes[i * 2 + 1]! << 8);
  array("BG_PALETTE", bgPalette); array("BG_TILES", halfwords(bgTiles)); array("BG_MAP", bgMap); array("OBJ_PALETTE", objPalette);
  const summary: Record<string, unknown> = { backgroundTiles: bgTiles.length / 64, backgroundBytes: bgTiles.length, palettes: { background: new Set(bgPalette).size, objects: new Set(objPalette).size } };
  for (const group of groups) {
    const name = group.name.toUpperCase(), frames: string[] = [];
    for (const [i, frame] of group.frames.entries()) {
      const pixels = Uint8Array.from(frame.pixels, color => color < 0 ? 0 : objIndex(color));
      const tiles = objectTiles(pixels, group.crop[2], group.crop[3], group.objectWidth, group.objectHeight);
      array(`${name}_${i}`, halfwords(tiles)); frames.push(`&${name}_${i}`);
    }
    source.push(`pub static ${name}: [&[u16]; ${frames.length}] = [${frames.join(",")}];`);
    source.push(`pub const ${name}_CROP: [i16; 4] = [${group.crop.join(",")}];`);
    summary[group.name] = { frames: frames.length, bytesPerFrame: group.crop[2] * group.crop[3], crop: group.crop };
  }
  source.push(`pub static BUTTON_COLORS: [u32; ${manifest.button.length}] = [${manifest.button.map(frame => frame.color).join(",")}];`);
  // Quarter-pixel advances preserve the core's variable glyph spacing. OAM positions round at presentation.
  source.push(`pub static DIGIT_ADVANCES: [i16; ${manifest.digits.length}] = [${manifest.digits.map(frame => Math.round(frame.advance! * 4)).join(",")}];`);
  source.push(`pub const PREFIX_ADVANCE: i16 = ${Math.round(manifest.prefixAdvance * 4)};`);
  writeFileSync(resolve(generated, "assets.rs"), source.join("\n") + "\n");
  writeFileSync(resolve(generated, "assets.json"), JSON.stringify(summary, null, 2) + "\n");
  return summary;
}
