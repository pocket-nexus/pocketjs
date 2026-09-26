/** CBZ extraction without executing archive tools or trusting member paths. */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { crc32 } from "./pack-format.ts";

export function extractCbz(path: string, out: string): void {
  if (statSync(path).size > 512 * 1024 * 1024) throw Error("Archive exceeds 512 MiB");
  const zip = readFileSync(path);
  let end = zip.length - 22;
  while (end >= Math.max(0, zip.length - 65557) && (zip.readUInt32LE(end) !== 0x06054b50 || end + 22 + zip.readUInt16LE(end + 20) !== zip.length)) end--;
  if (end < 0 || end < zip.length - 65557) throw Error("Invalid ZIP directory");
  if (zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6)) throw Error("Multi-disk ZIP is unsupported");
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16), expanded = 0;
  const names = new Set<string>();
  if (count > 10000 || count !== zip.readUInt16LE(end + 8)) throw Error("Archive has too many members");
  for (let n = 0; n < count; n++) {
    if (at + 46 > end || zip.readUInt32LE(at) !== 0x02014b50) throw Error("Invalid ZIP member");
    const flags = zip.readUInt16LE(at + 8), method = zip.readUInt16LE(at + 10);
    const checksum = zip.readUInt32LE(at + 16), stored = zip.readUInt32LE(at + 20), raw = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28), extra = zip.readUInt16LE(at + 30), comment = zip.readUInt16LE(at + 32);
    const mode = zip.readUInt32LE(at + 38) >>> 16, local = zip.readUInt32LE(at + 42);
    if (at + 46 + nameLength + extra + comment > end) throw Error("Truncated ZIP directory");
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    at += 46 + nameLength + extra + comment;
    if (!name || name.includes("\\") || name.includes(":" ) || name.includes("\0") || name.startsWith("/") || name.split("/").includes(".."))
      throw Error("Unsafe archive path");
    if ((mode & 0xf000) === 0xa000) throw Error("Archive symlinks are unsupported");
    if (name.endsWith("/") || name.split("/").some(part => part.startsWith(".") || part === "__MACOSX")) continue;
    if (!/\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(name) && !/(^|\/)ComicInfo\.xml$/i.test(name)) continue;
    if (flags & 1 || (method !== 0 && method !== 8)) throw Error("Encrypted or unsupported ZIP member");
    expanded += raw;
    if (raw > 32 * 1024 * 1024 || expanded > 1024 * 1024 * 1024) throw Error("Archive expansion budget exceeded");
    if (names.has(name.toLowerCase())) throw Error("Duplicate archive path");
    names.add(name.toLowerCase());
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) throw Error("Invalid ZIP local header");
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    if (start + stored > zip.length) throw Error("Truncated ZIP data");
    const compressed = zip.subarray(start, start + stored);
    const bytes = method === 8 ? inflateRawSync(compressed, { maxOutputLength: Math.max(1, raw) }) : compressed;
    if (bytes.length !== raw || crc32(bytes) !== checksum) throw Error("ZIP checksum mismatch");
    const dest = join(out, name);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
  }
}
