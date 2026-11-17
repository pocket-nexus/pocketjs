// @pocketjs/framework/game2d — texture pool with a byte budget.
//
// A handheld dies with no message when its arena runs out, so nothing here loads without
// accounting. Images live in packs (see packs.ts); `get` loads on first use, marks the
// frame it was used on and evicts least-recently-used images when over budget. An
// image drawn in the current frame is never evicted, and neither is one a static layer
// pins: a static layer draws once and stays on screen without drawing again.

import { getOps } from "../index.ts";
import type { PackImage, PackStore } from "./packs.ts";

type FreeOps = { freeTexture?: (handle: number) => void };

export interface TexturePool {
  /** Texture handle for this image, loading it if needed; -1 if it cannot load. */
  get(img: PackImage): number;
  /** Load now, ahead of use (between scenes). Stops at the budget. */
  preload(imgs: Iterable<PackImage>): void;
  /** Mark a new frame for LRU. With `key`, a second call with the same key is no frame: every
   *  layer begins its frame with the host frame's number, and draws earlier in that frame stay
   *  this frame's. */
  beginFrame(key?: number): void;
  /** The current LRU frame. A layer that finds an image loaded marks `img.used` with it itself. */
  frame(): number;
  /** Drop everything from one pack, or everything, pinned or not. Bumps `epoch`. */
  release(pack?: string): void;
  /** Keep an image's texture while a static layer shows it. Counted: each pin needs an unpin. */
  pin(img: PackImage): void;
  unpin(img: PackImage): void;
  /** Changes when `release` drops textures, so a static layer knows to draw again. */
  epoch(): number;
  stats(): TextureStats;
  budget: number;
}

export interface TextureStats { live: number; bytes: number; peakBytes: number; loads: number; evictions: number; failures: number; loadsThisFrame: number; maxLoadsPerFrame: number }

/** Longest wait between tries at an image that keeps failing to load (frames). */
const RETRY_MAX_FRAMES = 240;

/** Arena cost of one CLUT8 texture: pixels + palette + header. */
export const textureBytes = (w: number, h: number) => w * h + 1024 + 32;

export function createTexturePool(store: PackStore, budgetBytes: number, freeTexture: (handle: number) => void = (h) => (getOps() as unknown as FreeOps).freeTexture?.(h)): TexturePool {
  // State lives on the image itself: `get` runs for every sprite every frame, and on a PSP a Map
  // lookup costs 8 µs while a property read costs 2. Eviction, which is rare, pays for a sort instead.
  let live: PackImage[] = [];
  const st: TextureStats = { live: 0, bytes: 0, peakBytes: 0, loads: 0, evictions: 0, failures: 0, loadsThisFrame: 0, maxLoadsPerFrame: 0 };
  let frame = 1, lastPurge = -1000, epoch = 0, lastKey = NaN;
  const free = (img: PackImage) => {
    if (img.handle < 0) return;
    freeTexture(img.handle);
    img.handle = -1; st.bytes -= textureBytes(img.tw, img.th); st.live--;
  };
  const evictFor = (need: number) => {
    if (st.bytes + need <= pool.budget) return;
    // Free a little extra so a scene change does not sort once per image.
    const target = pool.budget - need - (pool.budget >> 4);
    live.sort((a, b) => a.used - b.used);
    const keep: PackImage[] = [];
    for (let i = 0; i < live.length; i++) {
      const img = live[i];
      if (st.bytes > target && img.used < frame && img.pins === 0) { free(img); st.evictions++; }
      else keep.push(img);
    }
    live = keep;
  };
  const pool: TexturePool = {
    budget: budgetBytes,
    get(img) {
      if (img.handle >= 0) { img.used = frame; return img.handle; }
      if (frame < img.retryAt) return -1;
      const bytes = textureBytes(img.tw, img.th);
      evictFor(bytes);
      const handle = store.loadImage(img);
      if (handle < 0) {
        // Usually the arena: full, or free only in pieces. Freed storage drains after the GPU is done with
        // it, so make room now and retry soon. A corrupt image also lands here, and each try reads the whole
        // entry from storage, so the wait doubles. The purge has its own cooldown: one bad image must not
        // throw away everything, every frame.
        st.failures++;
        img.retryAt = frame + Math.min(RETRY_MAX_FRAMES, 1 << img.fails);
        if (img.fails < 16) img.fails++;
        if (frame - lastPurge > 60) { lastPurge = frame; evictFor(pool.budget * 2); }
        return -1;
      }
      img.fails = 0; img.retryAt = 0;
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
    beginFrame(key) {
      if (key !== undefined) { if (key === lastKey) return; lastKey = key; }
      frame++; st.loadsThisFrame = 0;
    },
    frame: () => frame,
    release(pack) {
      const keep: PackImage[] = [];
      for (const img of live) { if (!pack || img.pack === pack) free(img); else keep.push(img); }
      live = keep;
      epoch++;
    },
    pin(img) { img.pins++; },
    unpin(img) { if (img.pins > 0) img.pins--; },
    epoch: () => epoch,
    stats: () => st,
  };
  return pool;
}
