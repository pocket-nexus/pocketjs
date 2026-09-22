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
