import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { extractCbz } from "../apps/manga/archive.ts";
import { crc32 } from "../apps/manga/pack-format.ts";

function zip(entries: { name: string; data?: string; mode?: number; compressed?: boolean; badCrc?: boolean; rawSize?: number }[], comment = Buffer.alloc(0)) {
  const local: Buffer[] = [], directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = Buffer.from(entry.data ?? "page");
    const stored = entry.compressed ? deflateRawSync(data) : data;
    const h = Buffer.alloc(30), c = Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt16LE(entry.compressed ? 8 : 0, 8);
    h.writeUInt32LE(entry.badCrc ? 0 : crc32(data), 14); h.writeUInt32LE(stored.length, 18); h.writeUInt32LE(entry.rawSize ?? data.length, 22); h.writeUInt16LE(name.length, 26);
    c.writeUInt32LE(0x02014b50); c.writeUInt16LE(0x314, 4); c.writeUInt16LE(20, 6);
    h.copy(c, 8, 6, 28); c.writeUInt32LE(((entry.mode ?? 0x81a4) * 65536) >>> 0, 38); c.writeUInt32LE(offset, 42);
    local.push(h, name, stored); directory.push(c, name); offset += h.length + name.length + stored.length;
  }
  const dir = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...local, dir, end, comment]);
}

test("CBZ reads stored/deflated pages and ignores an EOCD signature inside its comment", () => {
  const root = mkdtempSync(join(tmpdir(), "manga-cbz-"));
  try {
    const path = join(root, "book.cbz"), out = join(root, "out"), comment = Buffer.alloc(30);
    comment.writeUInt32LE(0x06054b50);
    writeFileSync(path, zip([{ name: "雪/01.png" }, { name: "雪/02.jpg", data: "second", compressed: true }, { name: "ComicInfo.xml", data: "<ComicInfo/>" }], comment));
    extractCbz(path, out);
    expect(readFileSync(join(out, "雪/01.png"), "utf8")).toBe("page");
    expect(readFileSync(join(out, "雪/02.jpg"), "utf8")).toBe("second");
    expect(readFileSync(join(out, "ComicInfo.xml"), "utf8")).toBe("<ComicInfo/>");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CBZ rejects traversal, symlinks, duplicate paths, expansion bombs and bad CRC", () => {
  const root = mkdtempSync(join(tmpdir(), "manga-cbz-"));
  try {
    for (const entries of [
      [{ name: "../outside.png" }], [{ name: "/absolute.png" }], [{ name: "dir\\escape.png" }],
      [{ name: "link.png", mode: 0xa1ff }], [{ name: "a.png" }, { name: "A.png" }],
      [{ name: "bad.png", badCrc: true }], [{ name: "huge.png", compressed: true, rawSize: 33 * 1024 * 1024 }],
    ]) {
      const path = join(root, "bad.cbz"), out = join(root, "out");
      writeFileSync(path, zip(entries));
      expect(() => extractCbz(path, out)).toThrow(); rmSync(out, { recursive: true, force: true });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
