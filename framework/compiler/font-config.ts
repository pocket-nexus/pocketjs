import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fontSlotFor } from "./tailwind.ts";

export interface SizedFallbackTtf {
  path: string;
  /** Logical font sizes whose used slots receive this fallback face. */
  sizes: number[];
}

export type FallbackTtf = string | SizedFallbackTtf;

export interface FontConfig {
  fallbackTtfs: FallbackTtf[];
  codepoints: number[];
}

/** Character coverage is independent of the JS source graph. Runtime file
 * names and metadata can use any scalar admitted by this build policy. */
export function readFontConfig(path: string, onRead: (path: string) => void = () => {}): FontConfig {
  if (!existsSync(path)) return { fallbackTtfs: [], codepoints: [] };
  onRead(path);
  const value = JSON.parse(readFileSync(path, "utf8"));
  const fail = (message: string): never => { throw new Error(`PocketJS fonts.json: ${message}`); };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("expected an object");
  for (const key of Object.keys(value)) if (!["fallback", "characters", "characterFiles", "ranges"].includes(key)) fail(`unknown field ${key}`);
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
  const fallback = (): FallbackTtf[] => {
    const list = value.fallback === undefined ? [] : value.fallback;
    if (!Array.isArray(list)) fail("fallback must be an array");
    return list.map((entry: unknown, index: number) => {
      if (typeof entry === "string" && entry) return file(entry);
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return fail(`fallback[${index}] must be a nonempty path string or an object`);
      }
      const record = entry as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (!["path", "sizes"].includes(key)) fail(`unknown field fallback[${index}].${key}`);
      }
      const fallbackPath = record.path;
      const fallbackSizes = record.sizes;
      if (typeof fallbackPath !== "string" || !fallbackPath) {
        return fail(`fallback[${index}].path must be a nonempty string`);
      }
      if (!Array.isArray(fallbackSizes) || !fallbackSizes.length) {
        return fail(`fallback[${index}].sizes must be a nonempty array`);
      }
      const sizes: number[] = [];
      const sizeValues = fallbackSizes as unknown[];
      for (const size of sizeValues) {
        if (typeof size !== "number" || !Number.isInteger(size)) {
          return fail(`fallback[${index}].sizes must contain integer font sizes`);
        }
        try {
          fontSlotFor(size, false);
        } catch {
          return fail(`fallback[${index}].sizes contains unsupported font size ${size}`);
        }
        sizes.push(size);
      }
      return { path: file(fallbackPath as string), sizes: [...new Set(sizes)].sort((a, b) => a - b) };
    });
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
  return { fallbackTtfs: fallback(), codepoints: [...points].sort((a, b) => a - b) };
}
