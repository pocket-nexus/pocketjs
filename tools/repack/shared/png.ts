// PNG in TypeScript, for the repack steps (no canvas, no native module):
// decode any PNG to straight RGBA8, scale a square picture, encode RGBA8.
//
// Decoding reads every colour type (grey, RGB, palette, grey + alpha, RGBA),
// bit depths 1 to 16, tRNS transparency and Adam7 interlacing; 16-bit
// samples keep their high byte. Encoding writes 8-bit RGBA with one filter
// chosen per row (the least sum of absolute differences, as libpng does)
// and no metadata chunks, so the same pixels give the same bytes.

import { crc32 } from "./crc32.ts";

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** Straight (not premultiplied) RGBA, 4 bytes a pixel, rows top to bottom. */
  readonly rgba: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const output = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(output).arrayBuffer());
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Reverses the row filters of one (sub)image in place; returns the raw rows. */
function unfilter(data: Uint8Array, offset: number, width: number, height: number, bitsPerPixel: number): { rows: Uint8Array; next: number } {
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const rows = new Uint8Array(stride * height);
  let cursor = offset;
  for (let y = 0; y < height; y++) {
    if (cursor + 1 + stride > data.length) throw new Error("png: image data is truncated");
    const filter = data[cursor++];
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const raw = data[cursor + x];
      const left = x >= bpp ? rows[row + x - bpp] : 0;
      const up = y > 0 ? rows[row - stride + x] : 0;
      const upLeft = y > 0 && x >= bpp ? rows[row - stride + x - bpp] : 0;
      let value: number;
      switch (filter) {
        case 0: value = raw; break;
        case 1: value = raw + left; break;
        case 2: value = raw + up; break;
        case 3: value = raw + ((left + up) >> 1); break;
        case 4: value = raw + paeth(left, up, upLeft); break;
        default: throw new Error(`png: unknown row filter ${filter}`);
      }
      rows[row + x] = value & 0xff;
    }
    cursor += stride;
  }
  return { rows, next: cursor };
}

/** Decodes a PNG file to straight RGBA8. */
export async function decodePng(bytes: Uint8Array): Promise<RgbaImage> {
  if (bytes.length < 8 || SIGNATURE.some((value, i) => bytes[i] !== value)) throw new Error("png: not a PNG file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0, height = 0, depth = 0, colour = 0, interlace = 0;
  let palette: Uint8Array | undefined;
  let transparency: Uint8Array | undefined;
  const compressed: Uint8Array[] = [];
  let cursor = 8;
  for (;;) {
    if (cursor + 12 > bytes.length) throw new Error("png: file ends before IEND");
    const length = view.getUint32(cursor);
    const type = String.fromCharCode(...bytes.subarray(cursor + 4, cursor + 8));
    const body = bytes.subarray(cursor + 8, cursor + 8 + length);
    if (body.length !== length) throw new Error(`png: ${type} chunk is truncated`);
    if (crc32(bytes.subarray(cursor + 4, cursor + 8 + length)) !== view.getUint32(cursor + 8 + length)) {
      throw new Error(`png: ${type} chunk fails its CRC`);
    }
    cursor += 12 + length;
    if (type === "IHDR") {
      const header = new DataView(body.buffer, body.byteOffset, body.byteLength);
      width = header.getUint32(0);
      height = header.getUint32(4);
      depth = body[8];
      colour = body[9];
      interlace = body[12];
      if (!(colour in CHANNELS)) throw new Error(`png: unknown colour type ${colour}`);
      if (![1, 2, 4, 8, 16].includes(depth)) throw new Error(`png: unknown bit depth ${depth}`);
      if (body[10] !== 0 || body[11] !== 0 || interlace > 1) throw new Error("png: unknown compression, filter or interlace method");
      if (!width || !height) throw new Error("png: empty image");
    } else if (type === "PLTE") palette = body;
    else if (type === "tRNS") transparency = body;
    else if (type === "IDAT") compressed.push(body);
    else if (type === "IEND") break;
  }
  if (!width) throw new Error("png: no IHDR chunk");
  if (colour === 3 && !palette) throw new Error("png: palette image without PLTE");
  const total = compressed.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of compressed) {
    joined.set(part, at);
    at += part.length;
  }
  const data = await pipe(joined, new DecompressionStream("deflate"));
  const channels = CHANNELS[colour];
  const bitsPerPixel = channels * depth;
  const rgba = new Uint8Array(width * height * 4);
  const tv = transparency ? new DataView(transparency.buffer, transparency.byteOffset, transparency.byteLength) : undefined;

  const sample = (rows: Uint8Array, stride: number, x: number, y: number, channel: number): number => {
    if (depth === 8) return rows[y * stride + x * channels + channel];
    if (depth === 16) return (rows[y * stride + (x * channels + channel) * 2] << 8) | rows[y * stride + (x * channels + channel) * 2 + 1];
    const bit = (x * channels + channel) * depth;
    return (rows[y * stride + (bit >> 3)] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
  };
  const to8 = (value: number): number => depth === 16 ? value >> 8 : depth === 8 ? value : Math.round((value * 255) / ((1 << depth) - 1));

  const place = (rows: Uint8Array, subWidth: number, subHeight: number, x0: number, y0: number, dx: number, dy: number) => {
    const stride = Math.ceil((subWidth * bitsPerPixel) / 8);
    for (let y = 0; y < subHeight; y++) {
      for (let x = 0; x < subWidth; x++) {
        const o = ((y0 + y * dy) * width + x0 + x * dx) * 4;
        if (colour === 3) {
          const index = sample(rows, stride, x, y, 0);
          if (index * 3 + 2 >= palette!.length) throw new Error("png: palette index out of range");
          rgba[o] = palette![index * 3];
          rgba[o + 1] = palette![index * 3 + 1];
          rgba[o + 2] = palette![index * 3 + 2];
          rgba[o + 3] = transparency && index < transparency.length ? transparency[index] : 255;
        } else if (colour === 0 || colour === 4) {
          const grey = sample(rows, stride, x, y, 0);
          const value = to8(grey);
          rgba[o] = rgba[o + 1] = rgba[o + 2] = value;
          rgba[o + 3] = colour === 4 ? to8(sample(rows, stride, x, y, 1)) : tv && tv.byteLength >= 2 && tv.getUint16(0) === grey ? 0 : 255;
        } else {
          const r = sample(rows, stride, x, y, 0), g = sample(rows, stride, x, y, 1), b = sample(rows, stride, x, y, 2);
          rgba[o] = to8(r);
          rgba[o + 1] = to8(g);
          rgba[o + 2] = to8(b);
          rgba[o + 3] = colour === 6
            ? to8(sample(rows, stride, x, y, 3))
            : tv && tv.byteLength >= 6 && tv.getUint16(0) === r && tv.getUint16(2) === g && tv.getUint16(4) === b ? 0 : 255;
        }
      }
    }
  };

  if (interlace === 0) {
    place(unfilter(data, 0, width, height, bitsPerPixel).rows, width, height, 0, 0, 1, 1);
  } else {
    // Adam7: seven passes, each a sub-image on its own grid.
    const passes = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
    let offset = 0;
    for (const [x0, y0, dx, dy] of passes) {
      const subWidth = Math.ceil((width - x0) / dx), subHeight = Math.ceil((height - y0) / dy);
      if (subWidth <= 0 || subHeight <= 0) continue;
      const { rows, next } = unfilter(data, offset, subWidth, subHeight, bitsPerPixel);
      place(rows, subWidth, subHeight, x0, y0, dx, dy);
      offset = next;
    }
  }
  return { width, height, rgba };
}

/**
 * `side` by `side` straight RGBA from a `source` by `source` picture. Each
 * destination pixel is the mean of the source area it covers, with partly
 * covered source pixels weighted by the part covered, colour averaged
 * premultiplied so a transparent pixel adds no colour to an edge. Going
 * down this is a box filter; going up, each destination pixel covers part of
 * one or two source pixels, so edges stay sharp.
 */
export function scaleSquare(pixels: Uint8Array | Uint8ClampedArray, source: number, side: number): Uint8Array {
  const out = new Uint8Array(side * side * 4);
  const step = source / side;
  for (let y = 0; y < side; y++) {
    const top = y * step, bottom = (y + 1) * step;
    for (let x = 0; x < side; x++) {
      const left = x * step, right = (x + 1) * step;
      let red = 0, green = 0, blue = 0, alpha = 0, area = 0;
      for (let sy = Math.floor(top); sy < Math.min(source, Math.ceil(bottom)); sy++) {
        const rows = Math.min(bottom, sy + 1) - Math.max(top, sy);
        for (let sx = Math.floor(left); sx < Math.min(source, Math.ceil(right)); sx++) {
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

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** An 8-bit RGBA PNG of `image`: one filter a row, no metadata chunks. */
export async function encodePng(image: RgbaImage): Promise<Uint8Array> {
  const { width, height, rgba } = image;
  if (rgba.length !== width * height * 4) throw new Error("png: pixel buffer does not match the size");
  const stride = width * 4;
  const filtered = new Uint8Array((stride + 1) * height);
  const candidate = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    let best = Infinity;
    for (let filter = 0; filter <= 4; filter++) {
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const raw = rgba[row + x];
        const left = x >= 4 ? rgba[row + x - 4] : 0;
        const up = y > 0 ? rgba[row - stride + x] : 0;
        const upLeft = y > 0 && x >= 4 ? rgba[row - stride + x - 4] : 0;
        const predicted = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth(left, up, upLeft);
        const value = (raw - predicted) & 0xff;
        candidate[x] = value;
        sum += value < 128 ? value : 256 - value;
      }
      if (sum < best) {
        best = sum;
        const at = y * (stride + 1);
        filtered[at] = filter;
        filtered.set(candidate, at + 1);
      }
    }
  }
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header[8] = 8;
  header[9] = 6;
  const parts = [
    Uint8Array.from(SIGNATURE),
    chunk("IHDR", header),
    chunk("IDAT", await pipe(filtered, new CompressionStream("deflate"))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
