import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { FONT_ARCHIVE as F, decodeArchiveFace, type ArchiveStrike } from "../contracts/spec/font-archive.ts";
import type { OffloadMethods } from "./offload-capabilities.ts";

/** Run inside a companion Worker. Only exact provider-granted paths can open. */
export function createFontArchiveProvider(paths: Readonly<Record<string, string>>) {
  type Strike = ArchiveStrike & { index: number; data: number; packed: number };
  let fd: number | undefined, length = 0, generation = 0, strikes: Strike[] = [], identity = "";
  let reads = 0, bytes = 0, glyphs = 0, missing = 0;
  function close() { if (fd !== undefined) closeSync(fd); fd = undefined; strikes = []; }
  function read(at: number, size: number) {
    if (fd === undefined || at < 0 || at + size > length) throw new Error("Font archive bounds invalid");
    const out = Buffer.alloc(size);
    let done = 0;
    while (done < size) {
      const n = readSync(fd, out, done, size - done, at + done);
      if (!n) throw new Error("Font archive read failed");
      done += n; reads++; bytes += n;
    }
    return out;
  }
  const methods: OffloadMethods = {
    "font.open": path => {
      close();
      if (!Object.prototype.hasOwnProperty.call(paths, path)) throw new Error("Font path not granted");
      try {
        fd = openSync(paths[path], "r"); length = fstatSync(fd).size;
        if (length < 64 || length > F.maxBytes) throw new Error("Font archive size invalid");
        const h = read(0, 64), count = h.readUInt32LE(12);
        if (h.readUInt32LE(0) !== F.magic || h.readUInt32LE(4) !== F.version || h.readUInt32LE(8) !== length ||
            count < 1 || count > F.maxStrikes || h.subarray(48).some(v => v !== 0)) throw new Error("Invalid font header");
        identity = h.subarray(16, 48).toString("hex");
        const rows: number[][] = [];
        let end = 64 + count * 32;
        for (let i = 0; i < count; i++) {
          const d = read(64 + i * 32, 32), packed = Math.ceil(d[1] * d[2] / 4), n = d.readUInt32LE(8);
          const index = d.readUInt32LE(12), data = d.readUInt32LE(16);
          if (index !== end || data !== index + n * 12 || d.readUInt32LE(20) !== n * packed ||
              data + n * packed > length || d.subarray(24).some(v => v !== 0)) throw new Error("Invalid font strike bounds");
          rows.push([...d.subarray(0, 7), n]);
          strikes.push({ slot: d[0], width: d[1], height: d[2], baseline: d[3], lineHeight: d[4],
            advance: d[5], density: d[6], count: n, index, data, packed });
          end = data + n * packed;
        }
        if (end !== length) throw new Error("Invalid font archive end");
        generation = (generation + 1) >>> 0 || 1;
        const result = JSON.stringify({ generation, identity, strikes: rows });
        decodeArchiveFace(result);
        return result;
      } catch (error) { close(); throw error; }
    },
    "font.close": () => { close(); return ""; },
    "font.stats": () => JSON.stringify({ reads, bytes, glyphs, missing }),
    "font.glyphs": payload => {
      const q = JSON.parse(payload), s = strikes.find(s => s.slot === q.slot);
      if (!s || fd === undefined || q.generation !== generation || !Array.isArray(q.scalars) ||
          q.scalars.length < 1 || q.scalars.length > F.maxBatch || q.scalars.some((cp: number) =>
            !Number.isInteger(cp) || cp < 32 || cp > 0x10ffff || cp >= 0xd800 && cp <= 0xdfff)) throw new Error("Invalid font glyph request");
      const stride = 8 + s.packed, size = 12 + q.scalars.length * stride;
      if (size > 1250) throw new Error("Font reply exceeds budget");
      const out = Buffer.alloc(size);
      out.writeUInt32LE(F.glyphMagic, 0); out.writeUInt32LE(generation, 4);
      out.set([s.slot, q.scalars.length, s.width, s.height], 8);
      q.scalars.forEach((cp: number, i: number) => {
        const at = 12 + i * stride;
        out.writeUInt32LE(cp, at);
        let lo = 0, hi = s.count;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (read(s.index + mid * 12, 12).readUInt32LE(0) < cp) lo = mid + 1; else hi = mid;
        }
        if (lo === s.count) { missing++; return; }
        const entry = read(s.index + lo * 12, 12);
        if (entry.readUInt32LE(0) !== cp) { missing++; return; }
        const gid = entry.readUInt16LE(4);
        if (gid >= s.count || entry[7] > s.width) throw new Error("Invalid font glyph index");
        const cell = read(s.data + gid * s.packed, s.packed);
        let hash = 2166136261;
        for (const b of cell) hash = Math.imul(hash ^ b, 16777619);
        if ((hash >>> 0) !== entry.readUInt32LE(8)) throw new Error("Font glyph checksum mismatch");
        out.set([entry[6], entry[7], 1, 0], at + 4); out.set(cell, at + 8); glyphs++;
      });
      return out.toString("hex");
    },
  };
  return { methods, close };
}
