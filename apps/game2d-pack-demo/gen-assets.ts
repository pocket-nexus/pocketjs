// Deterministically synthesize the demo's data, all of it original:
//
//   gen/data/demo/tiles.pack   six IMG entries behind a small index
//   gen/data/demo/scale.pcm    60 s, one note per second, climbing
//   gen/data/demo/tone.pcm     10 s of phase-continuous sine, loop point at 2 s
//   media/blip.wav, chime.wav  the sound effects pak.json splices (committed)
//
//   bun apps/game2d-pack-demo/gen-assets.ts
//
// gen/data/ is the game data root: verify/ copies or serves it. It is not
// committed (/apps/*/gen/ is ignored) and the app's pak does not include it.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeImageEntry } from "../../framework/compiler/pak.ts";
import { IMG_FLAG_RLE, PSM, packbitsEncode } from "../../contracts/spec/spec.ts";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = join(ROOT, "gen/data/demo");
const MEDIA = join(ROOT, "media");
mkdirSync(DATA, { recursive: true });
mkdirSync(MEDIA, { recursive: true });

// ---- images ---------------------------------------------------------------

type Rgba = [number, number, number, number];

/** T8 IMG entry: header, 1024-byte palette, index stream (PackBits when asked). */
function t8Entry(w: number, h: number, palette: Rgba[], index: (x: number, y: number) => number, rle: boolean): Uint8Array {
  const pixels = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pixels[y * w + x] = index(x, y);
  const stream = rle ? packbitsEncode(pixels) : pixels;
  const out = new Uint8Array(8 + 1024 + stream.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, w, true);
  view.setUint16(2, h, true);
  out[4] = PSM.PSM_T8;
  out[5] = rle ? IMG_FLAG_RLE : 0;
  palette.forEach((c, i) => out.set(c, 8 + i * 4));
  out.set(stream, 8 + 1024);
  return out;
}

function rgbaEntry(w: number, h: number, psm: number, pixel: (x: number, y: number) => Rgba): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set(pixel(x, y), (y * w + x) * 4);
  return encodeImageEntry({ width: w, height: h, rgba }, psm);
}

const QUADRANTS: Rgba[] = [
  [230, 60, 50, 255],
  [60, 190, 80, 255],
  [60, 110, 230, 255],
  [240, 200, 50, 255],
  [20, 20, 30, 255],
  [245, 245, 245, 255],
];
/** Four coloured quadrants, with a ring around the centre and a dark border. */
function quadrantIndex(x: number, y: number, size: number): number {
  const edge = Math.max(2, size >> 6);
  if (x < edge || y < edge || x >= size - edge || y >= size - edge) return 4;
  const d = Math.hypot(x - size / 2, y - size / 2) / size;
  if (d > 0.2 && d < 0.26) return 5;
  return (y < size / 2 ? 0 : 2) + (x < size / 2 ? 0 : 1);
}

const ramp256: Rgba[] = Array.from({ length: 256 }, (_, i) => [i, 255 - i, (i * 3) & 255, 255]);
const hash = (x: number, y: number) => {
  let v = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  v = Math.imul(v ^ (v >>> 13), 1274126177);
  return (v ^ (v >>> 16)) & 255;
};

const entries: { name: string; bytes: Uint8Array }[] = [
  // T8 + RLE, the shape a game's tiles take.
  { name: "256 T8 RLE", bytes: t8Entry(256, 256, QUADRANTS, (x, y) => quadrantIndex(x, y, 256), true) },
  // T8 without RLE: pixel stream passed through.
  { name: "128 T8 raw", bytes: t8Entry(128, 128, QUADRANTS, (x, y) => quadrantIndex(128 - 1 - x, y, 128), false) },
  // A palette gradient in vertical bands.
  { name: "64 T8 ramp", bytes: t8Entry(64, 64, ramp256, (x) => (x * 4) & 255, true) },
  // 262 KB, over the 128 KB the svc mailbox path refuses.
  {
    name: "256 8888",
    bytes: rgbaEntry(256, 256, PSM.PSM_8888, (x, y) => [x, y, 255 - x, 255]),
  },
  // 16-bit.
  {
    name: "128 5650",
    bytes: rgbaEntry(128, 128, PSM.PSM_5650, (x, y) => (((x >> 4) + (y >> 4)) & 1 ? [250, 130, 30, 255] : [30, 40, 90, 255])),
  },
  // 263 KB of noise: incompressible, the slowest decode a T8 entry can ask for.
  { name: "512 T8 noise", bytes: t8Entry(512, 512, ramp256, (x, y) => hash(x, y), true) },
];

// Index: u32 magic "PTIL", u32 count, then (u32 offset, u32 length) per entry. Entries 64-aligned.
const headerBytes = 8 + entries.length * 8;
let cursor = (headerBytes + 63) & ~63;
const offsets = entries.map((entry) => {
  const at = cursor;
  cursor = (cursor + entry.bytes.length + 63) & ~63;
  return at;
});
const tiles = new Uint8Array(cursor);
const header = new DataView(tiles.buffer);
header.setUint32(0, 0x4c495450, true);
header.setUint32(4, entries.length, true);
entries.forEach((entry, i) => {
  header.setUint32(8 + i * 8, offsets[i]!, true);
  header.setUint32(12 + i * 8, entry.bytes.length, true);
  tiles.set(entry.bytes, offsets[i]!);
});
writeFileSync(join(DATA, "tiles.pack"), tiles);

// ---- music ----------------------------------------------------------------

const RATE = 22050;

function bytesOf(samples: Int16Array): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

/** One second per note, 60 notes climbing 15 equal steps per octave from 220 Hz
 *  to 3350 Hz: every second has its own pitch (verify/audio-check.ts reads it
 *  back). The envelope closes each note at silence, so the dips mark exact
 *  one-second spacing and an edge in a recording is a bug. */
function scaleTrack(): Int16Array {
  const out = new Int16Array(RATE * 60);
  for (let note = 0; note < 60; note++) {
    const frequency = 220 * 2 ** (note / 15);
    const start = note * RATE;
    for (let i = 0; i < RATE; i++) {
      const t = i / RATE;
      const envelope = Math.min(1, t / 0.02) * Math.min(1, (1 - t) / 0.02);
      out[start + i] = Math.round(12000 * envelope * Math.sin(2 * Math.PI * frequency * t));
    }
  }
  return out;
}

/** A 441 Hz sine (exactly 50 frames per period at 22 050 Hz) with no envelope:
 *  the 8 s loop from 2 s to 10 s closes in phase, so the seam is continuous in
 *  the file and any discontinuity in a recording came from the player. */
function toneTrack(): Int16Array {
  const out = new Int16Array(RATE * 10);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(10000 * Math.sin((2 * Math.PI * i) / 50));
  return out;
}

writeFileSync(join(DATA, "scale.pcm"), bytesOf(scaleTrack()));
writeFileSync(join(DATA, "tone.pcm"), bytesOf(toneTrack()));

// ---- sound effects --------------------------------------------------------

function wav(samples: Int16Array, rate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.byteLength);
  const view = new DataView(out.buffer);
  const tag = (offset: number, text: string) => {
    for (let i = 0; i < 4; i++) out[offset + i] = text.charCodeAt(i);
  };
  tag(0, "RIFF");
  view.setUint32(4, 36 + samples.byteLength, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, samples.byteLength, true);
  out.set(bytesOf(samples), 44);
  return out;
}

function pluck(seconds: number, frequency: number, rate: number): Int16Array {
  const out = new Int16Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const envelope = Math.min(1, t / 0.005) * Math.exp((-6 * t) / seconds);
    out[i] = Math.round(9000 * envelope * Math.sin(2 * Math.PI * frequency * t));
  }
  return out;
}

writeFileSync(join(MEDIA, "blip.wav"), wav(pluck(0.15, 1760, 22050), 22050));
writeFileSync(join(MEDIA, "chime.wav"), wav(pluck(0.6, 880, 11025), 11025));

console.log(`tiles.pack ${tiles.length} bytes, ${entries.length} entries: ${entries.map((e) => `${e.name}=${e.bytes.length}`).join(", ")}`);
