// PNG decode and encode for the repack step: Web-platform APIs only
// (DecompressionStream / CompressionStream), so the same code runs in Bun and
// in a Cloudflare Worker.
//
// decodePng reads every PNG a person can hand in as an icon: colour types 0,
// 2, 3, 4 and 6, bit depths 1 to 16, Adam7 interlacing and tRNS
// transparency, into 8-bit RGBA. encodePng writes 8-bit RGBA with filter 0 on
// every row and no metadata chunks.

import { crc32 } from "./crc32.ts";

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** width * height * 4 bytes, rows top to bottom, straight (not premultiplied) alpha. */
  readonly rgba: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Larger icons are refused before their pixels are allocated. */
const MAX_PIXELS = 4096 * 4096;

async function pipe(bytes: Uint8Array, transform: TransformStream<Uint8Array, Uint8Array>): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** zlib-wrapped inflate (RFC 1950). */
export function inflateZlib(bytes: Uint8Array): Promise<Uint8Array> {
  return pipe(bytes, new DecompressionStream("deflate") as unknown as TransformStream<Uint8Array, Uint8Array>);
}

/** zlib-wrapped deflate (RFC 1950). */
export function deflateZlib(bytes: Uint8Array): Promise<Uint8Array> {
  return pipe(bytes, new CompressionStream("deflate") as unknown as TransformStream<Uint8Array, Uint8Array>);
}

/** Raw deflate (RFC 1951), the zip method 8 payload. */
export function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  return pipe(bytes, new CompressionStream("deflate-raw") as unknown as TransformStream<Uint8Array, Uint8Array>);
}

const ADAM7: ReadonlyArray<readonly [number, number, number, number]> = [
  // x0, y0, dx, dy
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export async function decodePng(png: Uint8Array): Promise<RgbaImage> {
  if (png.length < 8 || SIGNATURE.some((byte, index) => png[index] !== byte)) {
    throw new Error("png: not a PNG file (bad signature)");
  }
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0, height = 0, depth = 0, type = -1, interlace = 0;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const data: Uint8Array[] = [];
  let ended = false;
  for (let at = 8; at + 12 <= png.length; ) {
    const length = view.getUint32(at);
    const name = String.fromCharCode(png[at + 4]!, png[at + 5]!, png[at + 6]!, png[at + 7]!);
    if (at + 12 + length > png.length) throw new Error(`png: truncated ${name} chunk`);
    const body = png.subarray(at + 8, at + 8 + length);
    if (crc32(png.subarray(at + 4, at + 8 + length)) !== view.getUint32(at + 8 + length)) {
      throw new Error(`png: ${name} chunk CRC mismatch`);
    }
    if (name === "IHDR") {
      const header = new DataView(body.buffer, body.byteOffset, body.byteLength);
      width = header.getUint32(0);
      height = header.getUint32(4);
      depth = body[8]!;
      type = body[9]!;
      interlace = body[12]!;
      if (body[10] !== 0 || body[11] !== 0 || interlace > 1) throw new Error("png: unknown compression, filter or interlace method");
    } else if (name === "PLTE") palette = body;
    else if (name === "tRNS") transparency = body;
    else if (name === "IDAT") data.push(body);
    else if (name === "IEND") {
      ended = true;
      break;
    }
    at += 12 + length;
  }
  if (!ended) throw new Error("png: no IEND chunk");
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type];
  const depths = ({ 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] } as Record<number, number[]>)[type];
  if (!channels || !depths?.includes(depth)) throw new Error(`png: colour type ${type} at bit depth ${depth} is not a PNG format`);
  if (width < 1 || height < 1 || width * height > MAX_PIXELS) throw new Error(`png: ${width}x${height} is outside 1..${MAX_PIXELS} pixels`);
  if (type === 3 && !palette) throw new Error("png: indexed image without a palette");
  if (data.length === 0) throw new Error("png: no image data");

  const joined = new Uint8Array(data.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of data) {
    joined.set(part, offset);
    offset += part.length;
  }
  const raw = await inflateZlib(joined);

  const bitsPerPixel = channels * depth;
  const filterStride = Math.max(1, bitsPerPixel >> 3);
  const rgba = new Uint8Array(width * height * 4);
  const maxSample = (1 << Math.min(depth, 8)) - 1;
  const passes = interlace ? ADAM7 : [[0, 0, 1, 1] as const];
  let cursor = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const passWidth = Math.ceil((width - x0) / dx);
    const passHeight = Math.ceil((height - y0) / dy);
    if (passWidth <= 0 || passHeight <= 0) continue;
    const rowBytes = Math.ceil((passWidth * bitsPerPixel) / 8);
    let above = new Uint8Array(rowBytes);
    let line = new Uint8Array(rowBytes);
    for (let py = 0; py < passHeight; py++) {
      if (cursor + 1 + rowBytes > raw.length) throw new Error("png: image data is shorter than the image");
      const filter = raw[cursor]!;
      const row = raw.subarray(cursor + 1, cursor + 1 + rowBytes);
      cursor += 1 + rowBytes;
      for (let i = 0; i < rowBytes; i++) {
        const left = i >= filterStride ? line[i - filterStride]! : 0;
        const up = above[i]!;
        const corner = i >= filterStride ? above[i - filterStride]! : 0;
        let predicted: number;
        switch (filter) {
          case 0: predicted = 0; break;
          case 1: predicted = left; break;
          case 2: predicted = up; break;
          case 3: predicted = (left + up) >> 1; break;
          case 4: predicted = paeth(left, up, corner); break;
          default: throw new Error(`png: unknown row filter ${filter}`);
        }
        line[i] = (row[i]! + predicted) & 255;
      }
      const y = y0 + py * dy;
      for (let px = 0; px < passWidth; px++) {
        const x = x0 + px * dx;
        const sample = (channel: number): number => {
          const index = px * channels + channel;
          if (depth === 8) return line[index]!;
          if (depth === 16) return (line[index * 2]! << 8) | line[index * 2 + 1]!;
          const bit = index * depth;
          return (line[bit >> 3]! >> (8 - depth - (bit & 7))) & maxSample;
        };
        const to8 = (value: number): number =>
          depth === 16 ? value >> 8 : depth === 8 ? value : Math.round((value * 255) / maxSample);
        let r: number, g: number, b: number, a = 255;
        if (type === 3) {
          const entry = sample(0);
          if (entry * 3 + 2 >= palette!.length) throw new Error(`png: palette index ${entry} is out of range`);
          r = palette![entry * 3]!;
          g = palette![entry * 3 + 1]!;
          b = palette![entry * 3 + 2]!;
          if (transparency && entry < transparency.length) a = transparency[entry]!;
        } else if (type === 0 || type === 4) {
          const gray = sample(0);
          r = g = b = to8(gray);
          if (type === 4) a = to8(sample(1));
          else if (transparency && transparency.length >= 2 && gray === ((transparency[0]! << 8) | transparency[1]!)) a = 0;
        } else {
          const red = sample(0), green = sample(1), blue = sample(2);
          r = to8(red);
          g = to8(green);
          b = to8(blue);
          if (type === 6) a = to8(sample(3));
          else if (
            transparency && transparency.length >= 6 &&
            red === ((transparency[0]! << 8) | transparency[1]!) &&
            green === ((transparency[2]! << 8) | transparency[3]!) &&
            blue === ((transparency[4]! << 8) | transparency[5]!)
          ) a = 0;
        }
        const out = (y * width + x) * 4;
        rgba[out] = r;
        rgba[out + 1] = g;
        rgba[out + 2] = b;
        rgba[out + 3] = a;
      }
      [above, line] = [line, above];
    }
  }
  return { width, height, rgba };
}

function chunk(name: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = name.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** 8-bit RGBA PNG; `opaque` drops the alpha channel (colour type 2). */
export async function encodePng(image: RgbaImage, options: { opaque?: boolean } = {}): Promise<Uint8Array> {
  const { width, height, rgba } = image;
  const channels = options.opaque ? 3 : 4;
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header[8] = 8;
  header[9] = options.opaque ? 2 : 6;
  const stride = width * channels + 1;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4, to = y * stride + 1 + x * channels;
      raw[to] = rgba[from]!;
      raw[to + 1] = rgba[from + 1]!;
      raw[to + 2] = rgba[from + 2]!;
      if (channels === 4) raw[to + 3] = rgba[from + 3]!;
    }
  }
  const parts = [
    new Uint8Array(SIGNATURE),
    chunk("IHDR", header),
    chunk("IDAT", await deflateZlib(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
