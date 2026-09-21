import { open } from "node:fs/promises";

/** Called inside the provider Worker; reserve source bytes before reading fonts. */
export async function readTextWorkerFonts(paths: readonly string[]): Promise<Uint8Array[]> {
  if (!Array.isArray(paths) || paths.length > 64 || paths.some(path => typeof path !== "string"))
    throw Error("Font source count exceeds worker budget");
  const fonts: Uint8Array[] = [];
  let remaining = 32 * 1024 * 1024;
  for (const path of [...new Set(paths)]) {
    const file = await open(path, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 12 || stat.size > remaining) throw Error("Font source bytes exceed worker budget");
      const bytes = new Uint8Array(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw Error("Font source was truncated during worker read");
        offset += bytesRead;
      }
      remaining -= bytes.length; fonts.push(bytes);
    } finally { await file.close(); }
  }
  return fonts;
}
