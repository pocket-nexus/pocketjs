/** Immutable indexed resources. Image decoding and PICA pixel preparation run
 * during the desktop bake; the console only inflates a bounded record. */
import {
  openSync,
  closeSync,
  writeSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { deflateSync } from "node:zlib";

export function crc32(bytes: Uint8Array) {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
/** Core RGB565 stores red in the low bits; PICA RGB565 stores it high.
 * PICA's 8x8 Morton blocks also reverse the vertical texture coordinate. */
export function prepareTiledRGB565(
  bytes: Uint8Array,
  width: number,
  height: number,
) {
  for (const n of [width, height])
    if (!Number.isInteger(n) || n < 16 || n > 256 || n & (n - 1))
      throw Error("Invalid texture size");
  if (bytes.length !== width * height * 2) throw Error("Invalid RGB565 pixels");
  const out = Buffer.alloc(bytes.length);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const sy = height - 1 - y,
        source = (sy * width + x) * 2,
        v = bytes[source]! | (bytes[source + 1]! << 8);
      const mx = x & 7,
        my = y & 7,
        morton =
          (mx & 1) |
          ((my & 1) << 1) |
          ((mx & 2) << 1) |
          ((my & 2) << 2) |
          ((mx & 4) << 2) |
          ((my & 4) << 3);
      const at = (((y >>> 3) * (width >>> 3) + (x >>> 3)) * 64 + morton) * 2;
      out.writeUInt16LE(((v & 31) << 11) | (v & 0x7e0) | ((v >>> 11) & 31), at);
    }
  return out;
}
export function createResourcePack(path: string, count: number) {
  if (!Number.isInteger(count) || count < 1 || count > 65536)
    throw Error("Invalid pack count");
  const pending = path + ".partial",
    fd = openSync(pending, "w"),
    header = Buffer.alloc(64 + count * 24);
  header.write("PRP1");
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(count, 8);
  let offset = header.length,
    next = 0,
    closed = false;
  const write = (b: Uint8Array, at: number) => {
    let n = 0;
    while (n < b.length) {
      const k = writeSync(fd, b, n, b.length - n, at + n);
      if (!k) throw Error("Short pack write");
      n += k;
    }
  };
  write(header, 0);
  return {
    add(bytes: Uint8Array, image?: { width: number; height: number }) {
      if (closed || next >= count || !bytes.length || bytes.length > 131072)
        throw Error("Pack entry budget exceeded");
      if (image) {
        for (const n of [image.width, image.height])
          if (!Number.isInteger(n) || n < 16 || n > 256 || n & (n - 1))
            throw Error("Invalid image");
        if (bytes.length !== image.width * image.height * 2)
          throw Error("Invalid pixels");
      } else if (bytes.length > 2500)
        throw Error("Data record exceeds 2500 bytes");
      const encoded = deflateSync(bytes, { level: 3 });
      if (encoded.length > 131200 || offset + encoded.length > 0x7fffffff)
        throw Error("Pack exceeds native bounds");
      const at = 64 + next * 24;
      for (const [p, v] of [
        [0, offset],
        [4, encoded.length],
        [8, bytes.length],
        [12, crc32(bytes)],
        [16, image ? 2 : 1],
      ])
        header.writeUInt32LE(v!, at + p!);
      header.writeUInt16LE(image?.width ?? 0, at + 20);
      header.writeUInt16LE(image?.height ?? 0, at + 22);
      write(encoded, offset);
      offset += encoded.length;
      return next++;
    },
    finish() {
      if (closed || next !== count) throw Error("Incomplete pack");
      header.writeUInt32LE(offset, 12);
      write(header, 0);
      closeSync(fd);
      closed = true;
      renameSync(pending, path);
      return { entries: count, bytes: offset };
    },
    abort() {
      if (!closed) {
        closeSync(fd);
        closed = true;
        unlinkSync(pending);
      }
    },
  };
}
