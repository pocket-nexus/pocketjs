// Shared deterministic PNG encoder for developer captures and golden tests.
//
// Determinism: Bun.deflateSync is deterministic, chunks carry no time or
// text metadata — byte equality is meaningful across runs and machines.

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** adler32 (the zlib-stream trailer). */
function adler32(buf: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Bun.deflateSync emits a RAW deflate stream; PNG IDAT needs the zlib
 *  wrapper (2-byte header + adler32 trailer) — add it ourselves. */
function zlibWrap(raw: Uint8Array): Buffer {
  // (cast: Buffer is Uint8Array<ArrayBufferLike> but this one is always heap-backed)
  const body = Bun.deflateSync(raw as Uint8Array<ArrayBuffer>);
  const out = Buffer.alloc(body.length + 6);
  out[0] = 0x78; // CM=8, CINFO=7
  out[1] = 0x01; // FCHECK making (out[0]<<8|out[1]) % 31 == 0, FLEVEL 0
  Buffer.from(body).copy(out, 2);
  out.writeUInt32BE(adler32(raw), body.length + 2);
  return out;
}

export function encodePNG(rgba: Uint8Array, w: number, h: number): Buffer {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibWrap(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Encode an 8-bit indexed PNG: one palette index per pixel, `palette` as
 *  r, g, b triples (at most 256). The PS Vita reads its bubble icon in this form. */
export function encodeIndexedPNG(indices: Uint8Array, palette: Uint8Array, w: number, h: number): Buffer {
  if (palette.length === 0 || palette.length > 768 || palette.length % 3 !== 0) throw new Error("encodeIndexedPNG: palette holds 1 to 256 colours");
  if (indices.length !== w * h) throw new Error("encodeIndexedPNG: one index per pixel");
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0; // filter: none
    Buffer.from(indices.buffer, indices.byteOffset + y * w, w).copy(raw, y * (w + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // color type: palette
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("PLTE", palette),
    chunk("IDAT", zlibWrap(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Decode an 8-bit RGB, RGBA or indexed, non-interlaced PNG (what Chrome's
 *  screenshot and the encoders above write) to RGBA bytes. */
export function decodePNG(png: Uint8Array): { rgba: Uint8Array; w: number; h: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const w = view.getUint32(16), h = view.getUint32(20);
  const depth = png[24], type = png[25], interlace = png[28];
  if (depth !== 8 || (type !== 2 && type !== 3 && type !== 6) || interlace !== 0) {
    throw new Error(`decodePNG: unsupported PNG (depth ${depth}, colour type ${type}, interlace ${interlace})`);
  }
  const parts: Uint8Array[] = [];
  let palette: Uint8Array | undefined;
  for (let at = 8; at < png.length; ) {
    const length = view.getUint32(at);
    const name = String.fromCharCode(png[at + 4], png[at + 5], png[at + 6], png[at + 7]);
    if (name === "IDAT") parts.push(png.subarray(at + 8, at + 8 + length));
    if (name === "PLTE") palette = png.subarray(at + 8, at + 8 + length);
    at += 12 + length;
  }
  // skip the 2-byte zlib header; inflateSync stops at the end of the raw stream
  const raw = Bun.inflateSync(Buffer.concat(parts).subarray(2) as Uint8Array<ArrayBuffer>);
  if (type === 3 && !palette) throw new Error("decodePNG: indexed PNG without a palette");
  const channels = type === 6 ? 4 : type === 3 ? 1 : 3;
  const stride = w * channels;
  const rgba = new Uint8Array(w * h * 4);
  const line = new Uint8Array(stride), above = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? line[i - channels] : 0;
      const up = above[i];
      const corner = i >= channels ? above[i - channels] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - corner;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - corner);
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      }
      line[i] = (row[i] + predicted) & 255;
    }
    for (let x = 0; x < w; x++) {
      // an indexed pixel names a palette entry; the others carry their channels
      const from = palette ? palette : line, at = palette ? line[x] * 3 : x * channels;
      rgba[(y * w + x) * 4] = from[at];
      rgba[(y * w + x) * 4 + 1] = from[at + 1];
      rgba[(y * w + x) * 4 + 2] = from[at + 2];
      rgba[(y * w + x) * 4 + 3] = channels === 4 ? line[x * channels + 3] : 255;
    }
    above.set(line);
  }
  return { rgba, w, h };
}
