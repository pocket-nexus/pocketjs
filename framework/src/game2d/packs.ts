// @pocketjs/framework/game2d — content packs.
//
// A pack is one file: a JSON manifest followed by self-contained IMG entries. The file
// stays on storage (memory stick, or an ArrayBuffer on the web); only the manifest and
// the textures currently in use occupy memory. That is what lets a long game ship more
// content than a handheld's RAM: mount the arc you are in, unmount the one you left.
//
//   bytes 0..4   "GPK1"
//   bytes 4..8   u32 LE manifest length
//   bytes 8..    manifest JSON, ASCII only (non-ASCII escaped)
//   then         IMG entries; manifest offsets count from the end of the manifest
//
// Hosts provide `globalThis.pack` (capability data.pack, docs/PACKS.md).

export interface PackHost {
  open(path: string): number;
  size(fh: number): number;
  read(fh: number, offset: number, dst: Uint8Array): number;
  loadImg(fh: number, offset: number, length: number): number;
  close(fh: number): void;
  /** Optional: JSON memory readings (see contracts/spec/pack.ts). */
  mem?(): string;
  /** Optional: collect JS cycles now, returns microseconds. */
  gc?(): number;
}

/** One image in a pack. tw/th: the power-of-two texture. w/h: used pixels. ox/oy: trim offset
 *  inside the original cell of fw×fh. ax/ay: anchor inside that cell. */
export interface PackImage {
  pack: string; name: string; off: number; len: number;
  tw: number; th: number; w: number; h: number; ox: number; oy: number; fw: number; fh: number; ax: number; ay: number;
  /** Owned by the texture pool: live handle (-1 when not loaded) and the frame it was last drawn on. */
  handle: number; used: number;
}

export interface PackManifest {
  /** name -> [off, len, tw, th, w, h, ox, oy, fw, fh, ax, ay] */
  images: Record<string, number[]>;
  /** Anything else the game wants to keep with the content. */
  data?: Record<string, unknown>;
}

export interface MountedPack { name: string; fh: number; images: Map<string, PackImage>; rows: Int32Array; index: Map<string, number>; data: Record<string, unknown> }

export interface PackStore {
  /** Open and parse a pack. Resolves once ready (on the web that may take several frames). */
  mount(name: string, path: string, waitFrame: () => Promise<void>): Promise<MountedPack | null>;
  unmount(name: string): void;
  mounted(name: string): MountedPack | undefined;
  /** Find an image across every mounted pack, newest first. */
  image(name: string): PackImage | undefined;
  data(key: string): unknown;
  loadImage(img: PackImage): number;
  /** Read raw bytes (a data file inside the game's data root). */
  available(): boolean;
}

export function packHost(): PackHost | null {
  return (globalThis as unknown as { pack?: PackHost }).pack ?? null;
}

function ascii(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 4096;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  return s;
}

export function createPackStore(host: PackHost | null = packHost()): PackStore {
  const packs = new Map<string, MountedPack>();
  const store: PackStore = {
    available: () => !!host,
    async mount(name, path, waitFrame) {
      const had = packs.get(name); if (had) return had;
      if (!host) return null;
      let fh = host.open(path);
      for (let tries = 0; fh === -2 && tries < 3600; tries++) { await waitFrame(); fh = host.open(path); }
      if (fh < 0) return null;
      const head = new Uint8Array(8);
      if (host.read(fh, 0, head) !== 8 || ascii(head.subarray(0, 4)) !== "GPK1") { host.close(fh); return null; }
      const n = head[4] | (head[5] << 8) | (head[6] << 16) | (head[7] * 16777216);
      const buf = new Uint8Array(n);
      if (host.read(fh, 8, buf) !== n) { host.close(fh); return null; }
      const man = JSON.parse(ascii(buf)) as PackManifest;
      // A long game has thousands of images and most are never drawn in a session: keep one Int32Array
      // row per image and build the object on first use.
      const names = Object.keys(man.images), rows = new Int32Array(names.length * 12), index = new Map<string, number>();
      for (let i = 0; i < names.length; i++) {
        const v = man.images[names[i]];
        for (let k = 0; k < 12; k++) rows[i * 12 + k] = v[k];
        rows[i * 12] += 8 + n;
        index.set(names[i], i);
      }
      man.images = {};
      const images = new Map<string, PackImage>();
      const m: MountedPack = { name, fh, images, rows, index, data: man.data ?? {} };
      packs.set(name, m);
      return m;
    },
    unmount(name) { const m = packs.get(name); if (m) { host?.close(m.fh); packs.delete(name); } },
    mounted: (name) => packs.get(name),
    image(name) {
      for (const m of packs.values()) {
        const had = m.images.get(name); if (had) return had;
        const i = m.index.get(name); if (i === undefined) continue;
        const r = m.rows, o = i * 12;
        const img: PackImage = { pack: m.name, name, off: r[o], len: r[o + 1], tw: r[o + 2], th: r[o + 3], w: r[o + 4], h: r[o + 5], ox: r[o + 6], oy: r[o + 7], fw: r[o + 8], fh: r[o + 9], ax: r[o + 10], ay: r[o + 11], handle: -1, used: 0 };
        m.images.set(name, img);
        return img;
      }
      return undefined;
    },
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
