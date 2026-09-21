import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface FontConfig {
  fallbackTtfs: string[];
  /** Immutable static TTF bytes supplied to the text worker through the PAK. */
  runtimeTtfs: string[];
  codepoints: number[];
}

/** Character coverage is independent of the JS source graph. Runtime file
 * names and metadata can use any scalar admitted by this build policy. */
export function readFontConfig(path: string, onRead: (path: string) => void = () => {}): FontConfig {
  if (!existsSync(path)) return { fallbackTtfs: [], runtimeTtfs: [], codepoints: [] };
  onRead(path);
  const value = JSON.parse(readFileSync(path, "utf8"));
  const fail = (message: string): never => { throw new Error(`PocketJS fonts.json: ${message}`); };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("expected an object");
  for (const key of Object.keys(value)) if (!["fallback", "runtime", "characters", "characterFiles", "ranges"].includes(key)) fail(`unknown field ${key}`);
  const strings = (key: string): string[] => {
    const list = value[key] ?? [];
    if (!Array.isArray(list) || list.some(x => typeof x !== "string" || !x)) fail(`${key} must be an array of nonempty strings`);
    return list;
  };
  const file = (name: string): string => {
    const absolute = resolve(dirname(path), name);
    if (!existsSync(absolute)) fail(`file not found: ${absolute}`);
    onRead(absolute);
    return absolute;
  };
  const points = new Set<number>();
  const add = (cp: number) => {
    if (cp >= 32 && cp !== 127 && !(cp >= 0xd800 && cp <= 0xdfff)) points.add(cp);
    if (points.size > 65534) fail("character coverage exceeds the 65534-glyph atlas budget");
  };
  const text = (s: string) => { for (const scalar of s) add(scalar.codePointAt(0)!); };
  if (value.characters !== undefined && typeof value.characters !== "string") fail("characters must be a string");
  text(value.characters ?? "");
  for (const name of strings("characterFiles")) {
    const bytes = readFileSync(file(name));
    if (bytes.length > 4 * 1024 * 1024) fail(`character file exceeds 4 MiB: ${name}`);
    text(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }
  for (const range of strings("ranges")) {
    const match = /^U\+([0-9A-Fa-f]{4,6})(?:-([0-9A-Fa-f]{4,6}))?$/.exec(range);
    if (!match) fail(`invalid Unicode range: ${range}`);
    const from = parseInt(match![1], 16), to = parseInt(match![2] ?? match![1], 16);
    if (from > to || to > 0x10ffff || to - from >= 65534) fail(`invalid or oversized Unicode range: ${range}`);
    for (let cp = from; cp <= to; cp++) add(cp);
  }
  const runtimeTtfs = [...new Set(strings("runtime").map(file))];
  if (runtimeTtfs.length > 8) fail("runtime font count exceeds 8");
  let runtimeBytes = 0;
  for (const path of runtimeTtfs) {
    const bytes = readFileSync(path);
    runtimeBytes += bytes.length;
    if (runtimeBytes > 32 * 1024 * 1024) fail("runtime fonts exceed the 32 MiB source budget");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 12 || view.getUint32(0) !== 0x00010000) fail("runtime fonts must be static TrueType faces");
    const count = view.getUint16(4);
    if (bytes.length < 12 + count * 16) fail("truncated runtime font directory");
    const tags = new Set<string>();
    for (let i = 0; i < count; i++) {
      const offset = 12 + i * 16;
      tags.add(bytes.toString("ascii", offset, offset + 4));
      if (view.getUint32(offset + 8) + view.getUint32(offset + 12) > bytes.length) fail("truncated runtime font table");
    }
    if (!tags.has("glyf") || !tags.has("loca") || tags.has("fvar")) fail("runtime fonts require static TrueType outlines");
  }
  return { fallbackTtfs: strings("fallback").map(file), runtimeTtfs, codepoints: [...points].sort((a, b) => a - b) };
}
