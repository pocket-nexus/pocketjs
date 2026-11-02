// @pocketjs/framework/game2d — content packs.
//
// A pack is one file: an image table, game data as JSON, then self-contained IMG entries. The
// file stays on storage (memory stick, or an ArrayBuffer on the web); only the table, the data
// and the textures currently in use occupy memory. That is what lets a long game ship more
// content than a handheld's RAM. The image table is read straight into typed arrays: a game with
// thousands of images pays 52 bytes for each, with no JSON parse and no string per name.
//
//   bytes 0..4   "GPK2"
//   bytes 4..8   u32 LE image count n
//   bytes 8..12  u32 LE data length d
//   bytes 12..   n * 12 i32 LE rows [off, len, tw, th, w, h, ox, oy, fw, fh, ax, ay], sorted by name hash
//   then         n u32 LE name hashes (packNameHash), ascending and unique
//   then         d bytes of data JSON, ASCII only (non-ASCII escaped)
//   then         IMG entries; row offsets count from the end of the data JSON
//
// Hosts provide `globalThis.pack` (capability data.pack, docs/PACKS.md). `pack-writer.ts` writes this format.

import { PACK_OPEN_PENDING, type PackOps } from "../../../contracts/spec/pack.ts";

export type PackHost = PackOps;

/** One image in a pack. tw/th: the power-of-two texture. w/h: used pixels. ox/oy: trim offset
 *  inside the original cell of fw×fh. ax/ay: anchor inside that cell. */
export interface PackImage {
  pack: string; name: string; off: number; len: number;
  tw: number; th: number; w: number; h: number; ox: number; oy: number; fw: number; fh: number; ax: number; ay: number;
  /** Owned by the texture pool: live handle (-1 when not loaded), the frame it was last drawn on, and
   *  the retry state after a failed load (failures in a row, first frame allowed to try again). */
  handle: number; used: number; fails: number; retryAt: number;
}

export interface MountedPack { name: string; fh: number; rows: Int32Array; hashes: Uint32Array; base: number; data: Record<string, unknown> }

export interface PackStore {
  /** Open and parse a pack. Resolves once ready (on the web that may take several frames). */
  mount(name: string, path: string, waitFrame: () => Promise<void>): Promise<MountedPack | null>;
  unmount(name: string): void;
  mounted(name: string): MountedPack | undefined;
  /** Find an image across every mounted pack, oldest first. The object is cached until `trim`. */
  image(name: string): PackImage | undefined;
  /** Forget cached image objects with no live texture. Call between chapters: a long game draws thousands. */
  trim(): void;
  data(key: string): unknown;
  loadImage(img: PackImage): number;
  /** A whole JSON file under the data root, or null when it is missing or not JSON. Not a pack: a game
   *  keeps per-chapter data here so only the current chapter occupies the heap. */
  readJson<T = unknown>(path: string, waitFrame: () => Promise<void>): Promise<T | null>;
  /** Whether this host has the pack module at all. */
  available(): boolean;
}

/** The pack module, or null where the host doesn't mount one. A live lookup, like `audioHost`. */
export function packHost(): PackHost | null {
  const ns = (globalThis as { pack?: unknown }).pack;
  if (!ns || typeof ns !== "object") return null;
  return typeof (ns as PackOps).open === "function" ? (ns as PackOps) : null;
}

function ascii(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 4096;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  return s;
}

/** FNV-1a over UTF-16 code units. A pack writer must reject names that collide inside one pack. */
export function packNameHash(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Open a file, waiting out a host that fetches it first (about a minute at 60 Hz). */
async function openWaiting(host: PackHost, path: string, waitFrame: () => Promise<void>): Promise<number> {
  let fh = host.open(path);
  for (let tries = 0; fh === PACK_OPEN_PENDING && tries < 3600; tries++) { await waitFrame(); fh = host.open(path); }
  return fh;
}

/** Parse one open pack, or null if the file is not a whole, valid pack. */
function readPack(host: PackHost, fh: number, name: string): MountedPack | null {
  const head = new Uint8Array(12);
  if (host.read(fh, 0, head) !== 12 || ascii(head.subarray(0, 4)) !== "GPK2") return null;
  const u32 = (at: number) => (head[at] | (head[at + 1] << 8) | (head[at + 2] << 16) | (head[at + 3] << 24)) >>> 0;
  const n = u32(4), d = u32(8), base = 12 + n * 52 + d;
  // The sizes come from the file: check them before allocating for them.
  if (base > host.size(fh)) return null;
  const rows = new Int32Array(n * 12), hashes = new Uint32Array(n), json = new Uint8Array(d);
  const rowBytes = new Uint8Array(rows.buffer), hashBytes = new Uint8Array(hashes.buffer);
  if (host.read(fh, 12, rowBytes) !== rowBytes.length || host.read(fh, 12 + rowBytes.length, hashBytes) !== hashBytes.length
    || host.read(fh, 12 + rowBytes.length + hashBytes.length, json) !== d) return null;
  let data: unknown = {};
  if (d > 0) { try { data = JSON.parse(ascii(json)); } catch { return null; } }
  if (data === null || typeof data !== "object") return null;
  return { name, fh, rows, hashes, base, data: data as Record<string, unknown> };
}

export function createPackStore(host: PackHost | null = packHost()): PackStore {
  const packs = new Map<string, MountedPack>();
  const cache = new Map<string, PackImage | null>();
  const store: PackStore = {
    available: () => !!host,
    async readJson<T>(path: string, waitFrame: () => Promise<void>) {
      if (!host) return null;
      const fh = await openWaiting(host, path, waitFrame);
      if (fh < 0) return null;
      const bytes = new Uint8Array(Math.max(0, host.size(fh)));
      const whole = host.read(fh, 0, bytes) === bytes.length;
      host.close(fh);
      if (!whole) return null;
      try { return JSON.parse(ascii(bytes)) as T; } catch { return null; }
    },
    async mount(name, path, waitFrame) {
      const had = packs.get(name); if (had) return had;
      if (!host) return null;
      const fh = await openWaiting(host, path, waitFrame);
      if (fh < 0) return null;
      const m = readPack(host, fh, name);
      if (!m) { host.close(fh); return null; } // handles are few: a bad file must not keep one
      packs.set(name, m);
      for (const [k, img] of cache) if (!img) cache.delete(k); // a name that was missing may live in this pack
      return m;
    },
    unmount(name) {
      const m = packs.get(name); if (!m) return;
      host?.close(m.fh); packs.delete(name);
      for (const [k, img] of cache) if (!img || img.pack === name) cache.delete(k);
    },
    mounted: (name) => packs.get(name),
    image(name) {
      const had = cache.get(name);
      if (had !== undefined) return had ?? undefined;
      const h = packNameHash(name);
      for (const m of packs.values()) {
        let lo = 0, hi = m.hashes.length - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >>> 1, v = m.hashes[mid];
          if (v === h) {
            const r = m.rows, o = mid * 12;
            const img: PackImage = { pack: m.name, name, off: r[o] + m.base, len: r[o + 1], tw: r[o + 2], th: r[o + 3], w: r[o + 4], h: r[o + 5], ox: r[o + 6], oy: r[o + 7], fw: r[o + 8], fh: r[o + 9], ax: r[o + 10], ay: r[o + 11], handle: -1, used: 0, fails: 0, retryAt: 0 };
            cache.set(name, img);
            return img;
          }
          if (v < h) lo = mid + 1; else hi = mid - 1;
        }
      }
      cache.set(name, null); // a missing name is asked for every frame: remember it, the hash is not free
      return undefined;
    },
    trim() { for (const [k, img] of cache) if (!img || img.handle < 0) cache.delete(k); },
    data(key) {
      for (const m of packs.values()) if (key in m.data) return m.data[key];
      return undefined;
    },
    loadImage(img) {
      const m = packs.get(img.pack);
      if (!m || !host) return -1;
      return host.loadImg(m.fh, img.off, img.len);
    },
  };
  return store;
}
