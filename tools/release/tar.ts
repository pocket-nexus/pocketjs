import { gzipSync } from "node:zlib";
import { readFileSync, statSync } from "node:fs";
import { relative, sep } from "node:path";
import { filesUnder } from "./receipt.ts";

/** Portable ustar: sorted regular files, fixed ownership and timestamps. */
export function archiveDirectory(directory: string): Uint8Array {
  const blocks: Buffer[] = [];
  for (const file of filesUnder(directory)) {
    const path = relative(directory, file).split(sep).join("/");
    let name = path, prefix = "";
    if (Buffer.byteLength(name) > 100) {
      const split = path.lastIndexOf("/");
      prefix = path.slice(0, split); name = path.slice(split + 1);
    }
    if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155)
      throw new Error("release archive path exceeds ustar limits: " + path);
    const body = readFileSync(file), header = Buffer.alloc(512);
    const field = (offset: number, value: string) => header.write(value, offset, "utf8");
    const octal = (offset: number, length: number, value: number) => {
      const encoded = value.toString(8);
      if (encoded.length >= length) throw new Error("release archive field exceeds ustar limits");
      field(offset, encoded.padStart(length - 1, "0") + "\0");
    };
    field(0, name); octal(100, 8, statSync(file).mode & 0o111 ? 0o755 : 0o644);
    octal(108, 8, 0); octal(116, 8, 0); octal(124, 12, body.length); octal(136, 12, 0);
    field(148, "        "); field(156, "0"); field(257, "ustar\0"); field(263, "00"); field(345, prefix);
    field(148, header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ");
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}
