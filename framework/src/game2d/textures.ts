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
  // State lives on the image itself: `get` runs for every sprite every frame, and on a PSP a Map
  // lookup costs 8 µs while a property read costs 2. Eviction, which is rare, pays for a sort instead.
  let live: PackImage[] = [];
  const st: TextureStats = { live: 0, bytes: 0, peakBytes: 0, loads: 0, evictions: 0, failures: 0, loadsThisFrame: 0, maxLoadsPerFrame: 0 };
  let frame = 1;
  const free = (img: PackImage) => {
    if (img.handle < 0) return;
    (getOps() as unknown as FreeOps).freeTexture?.(img.handle);
    img.handle = -1; st.bytes -= textureBytes(img.tw, img.th); st.live--;
  };
  const evictFor = (need: number) => {
    if (st.bytes + need <= pool.budget) return;
    // Free a little extra so a scene change does not sort once per image.
    const target = pool.budget - need - (pool.budget >> 4);
    live.sort((a, b) => a.used - b.used);
    let i = 0;
    for (; i < live.length && st.bytes > target; i++) {
      if (live[i].used >= frame) break;
      free(live[i]); st.evictions++;
    }
    live = live.slice(i);
  };
  const pool: TexturePool = {
    budget: budgetBytes,
    get(img) {
      if (img.handle >= 0) { img.used = frame; return img.handle; }
      const bytes = textureBytes(img.tw, img.th);
      evictFor(bytes);
      const handle = store.loadImage(img);
      if (handle < 0) { st.failures++; return -1; }
      img.handle = handle; img.used = frame; live.push(img);
      st.bytes += bytes; st.live++; st.loads++; st.loadsThisFrame++;
      if (st.bytes > st.peakBytes) st.peakBytes = st.bytes;
      if (st.loadsThisFrame > st.maxLoadsPerFrame) st.maxLoadsPerFrame = st.loadsThisFrame;
      return handle;
    },
    preload(imgs) {
      for (const img of imgs) {
        if (img.handle >= 0) continue;
        if (st.bytes + textureBytes(img.tw, img.th) > pool.budget) return;
        pool.get(img);
      }
    },
    beginFrame() { frame++; st.loadsThisFrame = 0; },
    release(pack) {
      const keep: PackImage[] = [];
      for (const img of live) { if (!pack || img.pack === pack) free(img); else keep.push(img); }
      live = keep;
    },
    stats: () => st,
  };
  return pool;
}
