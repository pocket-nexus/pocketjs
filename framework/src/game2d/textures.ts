// @pocketjs/framework/game2d — texture pool with a byte budget.
//
// A handheld dies silently when its arena runs out, so nothing here loads without
// accounting. Images live in packs (see packs.ts); `get` loads on first use, marks the
// frame it was used on and evicts least-recently-used images when over budget. An
// image drawn in the current frame is never evicted.

import { getOps } from "../index.ts";
import type { PackImage, PackStore } from "./packs.ts";

type FreeOps = { freeTexture?: (handle: number) => void };

export interface TexturePool {
  /** Texture handle for this image, loading it if needed; -1 if it cannot load. */
  get(img: PackImage): number;
  /** Load now, ahead of use (between scenes). Stops at the budget. */
  preload(imgs: Iterable<PackImage>): void;
  /** Mark a new frame for LRU. */
  beginFrame(): void;
  /** Drop everything from one pack, or everything. */
  release(pack?: string): void;
  stats(): TextureStats;
  budget: number;
}

export interface TextureStats { live: number; bytes: number; peakBytes: number; loads: number; evictions: number; failures: number; loadsThisFrame: number; maxLoadsPerFrame: number }

/** Arena cost of one CLUT8 texture: pixels + palette + header. */
export const textureBytes = (w: number, h: number) => w * h + 1024 + 32;

export function createTexturePool(store: PackStore, budgetBytes: number): TexturePool {
  const live = new Map<PackImage, { handle: number; used: number; bytes: number }>();
  const st: TextureStats = { live: 0, bytes: 0, peakBytes: 0, loads: 0, evictions: 0, failures: 0, loadsThisFrame: 0, maxLoadsPerFrame: 0 };
  let frame = 0;
  const free = (img: PackImage) => {
    const e = live.get(img); if (!e) return;
    (getOps() as unknown as FreeOps).freeTexture?.(e.handle);
    live.delete(img); st.bytes -= e.bytes; st.live--;
  };
  const evictFor = (need: number) => {
    if (st.bytes + need <= pool.budget) return;
    // Map iteration is insertion order and `get` re-inserts on use, so this walks LRU first.
    for (const [img, e] of live) {
      if (e.used >= frame) break;
      free(img); st.evictions++;
      if (st.bytes + need <= pool.budget) return;
    }
  };
  const pool: TexturePool = {
    budget: budgetBytes,
    get(img) {
      const e = live.get(img);
      if (e) {
        if (e.used !== frame) { e.used = frame; live.delete(img); live.set(img, e); }
        return e.handle;
      }
      const bytes = textureBytes(img.tw, img.th);
      evictFor(bytes);
      const handle = store.loadImage(img);
      if (handle < 0) { st.failures++; return -1; }
      live.set(img, { handle, used: frame, bytes });
      st.bytes += bytes; st.live++; st.loads++; st.loadsThisFrame++;
      if (st.bytes > st.peakBytes) st.peakBytes = st.bytes;
      if (st.loadsThisFrame > st.maxLoadsPerFrame) st.maxLoadsPerFrame = st.loadsThisFrame;
      return handle;
    },
    preload(imgs) {
      for (const img of imgs) {
        if (live.has(img)) continue;
        if (st.bytes + textureBytes(img.tw, img.th) > pool.budget) return;
        pool.get(img);
      }
    },
    beginFrame() { frame++; st.loadsThisFrame = 0; },
    release(pack) { for (const img of [...live.keys()]) if (!pack || img.pack === pack) free(img); },
    stats: () => st,
  };
  return pool;
}
