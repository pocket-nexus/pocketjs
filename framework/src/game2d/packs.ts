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
}

/** One image in a pack. tw/th: the power-of-two texture. w/h: used pixels. ox/oy: trim offset
 *  inside the original cell of fw×fh. ax/ay: anchor inside that cell. */
export interface PackImage {
  pack: string; name: string; off: number; len: number;
  tw: number; th: number; w: number; h: number; ox: number; oy: number; fw: number; fh: number; ax: number; ay: number;
}

export interface PackManifest {
  /** name -> [off, len, tw, th, w, h, ox, oy, fw, fh, ax, ay] */
  images: Record<string, number[]>;
  /** Anything else the game wants to keep with the content. */
  data?: Record<string, unknown>;
}

export interface MountedPack { name: string; fh: number; images: Map<string, PackImage>; data: Record<string, unknown> }

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
      const images = new Map<string, PackImage>();
      for (const key in man.images) {
        const v = man.images[key];
        images.set(key, { pack: name, name: key, off: v[0] + 8 + n, len: v[1], tw: v[2], th: v[3], w: v[4], h: v[5], ox: v[6], oy: v[7], fw: v[8], fh: v[9], ax: v[10], ay: v[11] });
      }
      const m: MountedPack = { name, fh, images, data: man.data ?? {} };
      packs.set(name, m);
      return m;
    },
    unmount(name) { const m = packs.get(name); if (m) { host?.close(m.fh); packs.delete(name); } },
    mounted: (name) => packs.get(name),
    image(name) {
      for (const m of packs.values()) { const i = m.images.get(name); if (i) return i; }
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
