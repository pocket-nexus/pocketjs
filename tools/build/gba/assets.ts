/** Build-time palette reduction and sprite layer → GBA tile packing. */
import { readFileSync, writeFileSync } from "node:fs";
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
interface ManifestFrame { file: string; value?: number; color?: number; char?: string; advance?: number }
interface ManifestLayer {
  name: string; kind: "branches" | "opacity" | "size" | "color" | "text"; island: boolean; translate: boolean;
  node: number[]; crop: Crop; grid: "wide32x16" | "tall16x32"; base: string; frames: ManifestFrame[]; below: number[];
  signatures: { style: number; src: string | null; text: string | null }[];
  range?: [number, number]; prop?: "width" | "height"; samples?: number[]; prefix?: string; prefixAdvance?: number; maxLength?: number; glyphs?: { char: string; advance: number }[];
}
interface BakeManifest { width: number; height: number; format: string; background: string; layers: ManifestLayer[] }

export const OAM_SLOTS = 128;
export const OBJ_VRAM_BYTES = 0x8000;
const KIND: Record<ManifestLayer["kind"], number> = { branches: 0, opacity: 1, size: 2, color: 3, text: 4 };
const SHAPE: Record<ManifestLayer["grid"], { id: number; width: number; height: number }> = { wide32x16: { id: 0, width: 32, height: 16 }, tall16x32: { id: 1, width: 16, height: 32 } };

export interface PackedLayer { name: string; kind: string; frames: number; bytesPerFrame: number; crop: Crop; oam: number; vramBytes: number }
export interface PackSummary { backgroundTiles: number; backgroundBytes: number; palettes: { background: number; objects: number }; layers: PackedLayer[]; oamSlots: number; vramBytes: number; frameBytes: number }

/**
 * Pack the baker's manifest into `assets.rs`: palettes, background tiles and
 * one `Layer` table entry per sprite layer, with OAM slots and OBJ VRAM
 * allocated in layer order. Hardware limits are build errors here.
 */
export function packLayers(directory: string, generated: string): PackSummary {
  const manifest: BakeManifest = JSON.parse(readFileSync(resolve(directory, "manifest.json"), "utf8"));
  const { width, height } = manifest;
  if (manifest.format !== "rgb555le" || !Number.isInteger(width) || !Number.isInteger(height)) throw new Error("GBA assets require rgb555le native snapshots");
  const read = (file: string, length: number) => {
    const bytes = readFileSync(resolve(directory, file));
    if (bytes.length !== length * 2) throw new Error(`Invalid native snapshot: ${file}; expected ${length * 2} bytes`);
    return Uint16Array.from({ length }, (_, i) => bytes.readUInt16LE(i * 2));
  };
  const background = read(manifest.background, width * height);
  const bgHistogram = new Map<number, number>();
  for (const color of background) bgHistogram.set(color, (bgHistogram.get(color) ?? 0) + 1);
  const bgPalette = paletteFor(bgHistogram), bgIndex = indexer(bgPalette);
  const bgTiles: number[] = [], bgMap = Array(32 * 32).fill(0), dedup = new Map<string, number>();
  for (let y = 0; y < Math.ceil(height / 8); ++y) for (let x = 0; x < Math.ceil(width / 8); ++x) {
    const tile: number[] = [];
    for (let dy = 0; dy < 8; ++dy) for (let dx = 0; dx < 8; ++dx) {
      const px = x * 8 + dx, py = y * 8 + dy;
      tile.push(px < width && py < height ? bgIndex(background[py * width + px]!) : 0);
    }
    const key = tile.join(",");
    let id = dedup.get(key);
    if (id === undefined) { id = bgTiles.length / 64; dedup.set(key, id); bgTiles.push(...tile); }
    bgMap[y * 32 + x] = id;
  }
  if (bgTiles.length > 0xf800) throw new Error("Background exceeds GBA character memory");

  // Layers: transparent where a frame equals the layer's base capture.
  const histogram = new Map<number, number>();
  const layers = manifest.layers.map(layer => {
    const [, , w, h] = layer.crop;
    const base = read(layer.base, w * h);
    const frames = layer.frames.map(frame => {
      const native = read(frame.file, w * h), pixels = new Int32Array(w * h).fill(-1);
      for (let i = 0; i < w * h; ++i) {
        if (native[i] === base[i]) continue;
        pixels[i] = native[i]!;
        histogram.set(native[i]!, (histogram.get(native[i]!) ?? 0) + 1);
      }
      return { ...frame, pixels };
    });
    const shape = SHAPE[layer.grid];
    if (w % shape.width || h % shape.height) throw new Error(`${layer.name}: crop ${w}x${h} is not a ${layer.grid} grid`);
    const columns = w / shape.width, rows = h / shape.height;
    // Text layers keep every glyph resident and place one object per glyph;
    // the others hold one frame in VRAM and swap it on change.
    const objectsPerFrame = columns * rows;
    const oam = layer.kind === "text" ? (layer.maxLength ?? 0) * objectsPerFrame : objectsPerFrame;
    const vramBytes = (layer.kind === "text" ? frames.length : 1) * w * h;
    return { layer, frames, shape, columns, rows, oam, vramBytes };
  });
  // A layer was baked over the lower layers it paints across, so those
  // pixels of the lower layer must be the same in every one of its states;
  // otherwise one of them would show a stale blend.
  const screenIndex = (item: typeof layers[number], i: number) => (item.layer.crop[1] + Math.floor(i / item.layer.crop[2])) * width + item.layer.crop[0] + i % item.layer.crop[2];
  for (const [index, upper] of layers.entries()) {
    const paintedAbove = new Set<number>();
    for (const frame of upper.frames) for (let i = 0; i < frame.pixels.length; ++i) if (frame.pixels[i]! >= 0) paintedAbove.add(screenIndex(upper, i));
    for (const lowerIndex of upper.layer.below) {
      const lower = layers[lowerIndex]!;
      const [, , w, h] = lower.layer.crop;
      for (let i = 0; i < w * h; ++i) {
        if (!paintedAbove.has(screenIndex(lower, i))) continue;
        const values = new Set(lower.frames.map(frame => frame.pixels[i]!));
        if (values.size > 1) throw new Error(`layer ${upper.layer.name} paints over ${lower.layer.name} at (${lower.layer.crop[0] + i % w}, ${lower.layer.crop[1] + Math.floor(i / w)}) where ${lower.layer.name} differs between its states; move one of them`);
      }
    }
    void index;
  }
  const oamSlots = layers.reduce((sum, item) => sum + item.oam, 0);
  const vramBytes = layers.reduce((sum, item) => sum + item.vramBytes, 0);
  if (oamSlots > OAM_SLOTS) throw new Error(`sprite layers need ${oamSlots} OAM slots; the GBA has ${OAM_SLOTS}`);
  if (vramBytes > OBJ_VRAM_BYTES) throw new Error(`sprite layers need ${vramBytes} bytes of OBJ VRAM; the GBA has ${OBJ_VRAM_BYTES}`);
  const objPalette = paletteFor(histogram), objIndex = indexer(objPalette);

  const source: string[] = ["// Generated from the compiler's sprite layer plan and the native bake. Do not edit."];
  const array = (name: string, words: number[], type = "u16") => source.push(`pub static ${name}: [${type}; ${words.length}] = [${words.join(",")}];`);
  const halfwords = (bytes: ArrayLike<number>) => Array.from({ length: bytes.length / 2 }, (_, i) => bytes[i * 2]! | bytes[i * 2 + 1]! << 8);
  const str = (value: string | null | undefined) => JSON.stringify(value ?? "");
  array("BG_PALETTE", bgPalette); array("BG_TILES", halfwords(bgTiles)); array("BG_MAP", bgMap); array("OBJ_PALETTE", objPalette);
  const entries: string[] = [];
  const packed: PackedLayer[] = [];
  // Lower OAM indices draw on top: later layers (painted above) take the
  // first slots.
  const oamStart: number[] = [];
  let slot = 0;
  for (let i = layers.length - 1; i >= 0; --i) { oamStart[i] = slot; slot += layers[i]!.oam; }
  let vramWords = 0, frameBytes = 0;
  for (const [index, item] of layers.entries()) {
    const { layer, frames, shape, columns, rows } = item;
    const oamFirst = oamStart[index]!;
    const [x, y, w, h] = layer.crop;
    const names: string[] = [];
    for (const [i, frame] of frames.entries()) {
      const pixels = Uint8Array.from(frame.pixels, color => color < 0 ? 0 : objIndex(color));
      const tiles = objectTiles(pixels, w, h, shape.width, shape.height);
      array(`LAYER${index}_FRAME${i}`, halfwords(tiles)); names.push(`&LAYER${index}_FRAME${i}`);
      frameBytes += tiles.length;
    }
    source.push(`static LAYER${index}_FRAMES: [&[u16]; ${names.length}] = [${names.join(",")}];`);
    const keys = layer.kind === "size" ? frames.map(frame => frame.value!) : layer.kind === "color" ? frames.map(frame => frame.color! >>> 0)
      : layer.kind === "text" ? frames.map(frame => frame.char!.codePointAt(0)!) : [];
    array(`LAYER${index}_KEYS`, keys, "u32");
    array(`LAYER${index}_STYLES`, layer.signatures.map(signature => signature.style), "i32");
    source.push(`static LAYER${index}_ASSETS: [&str; ${layer.signatures.length}] = [${layer.signatures.map(signature => str(signature.src)).join(",")}];`);
    source.push(`static LAYER${index}_TEXTS: [&str; ${layer.signatures.length}] = [${layer.signatures.map(signature => str(signature.text)).join(",")}];`);
    // Quarter-pixel advances preserve the core's glyph spacing; OAM positions round at presentation.
    array(`LAYER${index}_ADVANCES`, (layer.glyphs ?? []).map(glyph => Math.round(glyph.advance * 4)), "i16");
    array(`LAYER${index}_NODE`, layer.node, "u8");
    entries.push(`Layer { name: ${str(layer.name)}, kind: ${KIND[layer.kind]}, crop: [${[x, y, w, h].join(",")}], shape: ${shape.id}, columns: ${columns}, rows: ${rows}, oam_first: ${oamFirst}, vram_words: ${vramWords}, translate: ${layer.translate}, node: &LAYER${index}_NODE, frames: &LAYER${index}_FRAMES, keys: &LAYER${index}_KEYS, styles: &LAYER${index}_STYLES, assets: &LAYER${index}_ASSETS, texts: &LAYER${index}_TEXTS, advances: &LAYER${index}_ADVANCES, prefix: ${str(layer.prefix)}, prefix_advance: ${Math.round((layer.prefixAdvance ?? 0) * 4)}, max_glyphs: ${layer.maxLength ?? 0}, axis: ${layer.prop === "height" ? 1 : 0}, range_low: ${layer.range?.[0] ?? 0} }`);
    packed.push({ name: layer.name, kind: layer.kind, frames: frames.length, bytesPerFrame: w * h, crop: layer.crop, oam: item.oam, vramBytes: item.vramBytes });
    vramWords += item.vramBytes / 2;
  }
  source.push(`pub static LAYERS: [Layer; ${entries.length}] = [${entries.join(",\n")}];`);
  source.push(`pub const OAM_SLOTS_USED: usize = ${oamSlots};`);
  source.push(`pub const OBJ_VRAM_WORDS: usize = ${vramWords};`);
  writeFileSync(resolve(generated, "assets.rs"), source.join("\n") + "\n");
  const summary: PackSummary = { backgroundTiles: bgTiles.length / 64, backgroundBytes: bgTiles.length, palettes: { background: new Set(bgPalette).size, objects: new Set(objPalette).size }, layers: packed, oamSlots, vramBytes, frameBytes };
  writeFileSync(resolve(generated, "assets.json"), JSON.stringify(summary, null, 2) + "\n");
  return summary;
}
