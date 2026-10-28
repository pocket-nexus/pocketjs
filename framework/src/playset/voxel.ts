// @pocketjs/framework/playset/voxel — a chunked block world over the voxel
// module (engine/crates/pocket-playset/src/modules/voxel.rs).
//
// The world is a fixed box of blocks, one byte each (0 = air, 1..15 = types
// with a palette colour). Block (x, y, z) fills [x, x+1] x [y, y+1] x
// [z, z+1] in world metres, y up. The module meshes 16x16x16 chunks into
// ground tiles natively (hidden faces culled, corner occlusion baked into
// the colours, even faces merged) and rebuilds only the chunks an edit
// touches, a couple per step. Bodies are slots it collides with the blocks
// after each step; a game moves them by writing velocity (the `none` kernel
// integrates it) and reads GROUNDED back.
//
// Every method is one native call over preallocated arguments: nothing here
// allocates after the constructor, so the queries are safe in a frame.

import { PLAYSET_MODULE } from "../../../contracts/spec/playset.ts";
import { Color } from "./three.ts";
import type { Playset } from "./index.ts";

/** Op ids of the voxel module (modules/voxel.rs `op`). */
export const VOXEL_OP = {
  INIT: 1,
  PALETTE: 2,
  SHADE: 3,
  GET: 4,
  SET: 5,
  SET_LIST: 6,
  FILL: 7,
  COLUMNS: 8,
  HEIGHT: 9,
  RAYCAST: 10,
  BODY: 11,
  BUILD: 12,
  BUDGET: 13,
  SNAPSHOT: 14,
  RESTORE: 15,
  STATS: 16,
  COUNT: 17,
} as const;

/** `VoxelWorld.hit` after a raycast: the block, the normal of the face the
 *  ray entered, and the distance. */
export const VOXEL_HIT = { X: 0, Y: 1, Z: 2, NX: 3, NY: 4, NZ: 5, DISTANCE: 6 } as const;

export interface VoxelWorldOptions {
  /** blocks along x, y, z */
  size: readonly [number, number, number];
  /** the world block coordinate of the box's first block */
  origin?: readonly [number, number, number];
}

export class VoxelWorld {
  readonly play: Playset;
  readonly size: readonly [number, number, number];
  readonly origin: readonly [number, number, number];
  /** ground tiles the module owns */
  readonly tiles: number;
  /** filled by `raycast` (VOXEL_HIT) */
  readonly hit = new Float32Array(8);
  /** filled by `stats`: faces, vertices, dirty chunks, chunks rebuilt last step */
  readonly counters = new Float32Array(4);
  private readonly a = new Float32Array(8);

  constructor(play: Playset, o: VoxelWorldOptions) {
    this.play = play;
    this.size = o.size;
    this.origin = o.origin ?? [0, 0, 0];
    const a = this.a;
    a[0] = o.size[0];
    a[1] = o.size[1];
    a[2] = o.size[2];
    a[3] = this.origin[0];
    a[4] = this.origin[1];
    a[5] = this.origin[2];
    this.tiles = play.call(PLAYSET_MODULE.VOXEL, VOXEL_OP.INIT, a);
    if (this.tiles <= 0) throw new Error("playset: this host's playset has no voxel module");
  }

  /** A block type's colour (hex sRGB) and emissive amount 0..1; `flat`
   *  faces skip corner occlusion, so they merge into fewer quads (foliage). */
  palette(type: number, hex: number, o: { glow?: number; flat?: boolean } = {}): void {
    const c = new Color(hex);
    const a = this.a;
    a[0] = type;
    a[1] = c.r;
    a[2] = c.g;
    a[3] = c.b;
    a[4] = o.glow ?? 0;
    a[5] = o.flat ? 1 : 0;
    this.play.call(PLAYSET_MODULE.VOXEL, VOXEL_OP.PALETTE, a);
  }

  /** Linear light per face direction, and the corner occlusion strength. */
  shade(o: { px?: number; nx?: number; py?: number; ny?: number; pz?: number; nz?: number; ao?: number }): void {
    const a = this.a;
    a[0] = o.px ?? 0.9;
    a[1] = o.nx ?? 0.9;
    a[2] = o.py ?? 1.16;
    a[3] = o.ny ?? 0.62;
    a[4] = o.pz ?? 0.78;
    a[5] = o.nz ?? 0.78;
    a[6] = o.ao ?? 1;
    this.play.call(PLAYSET_MODULE.VOXEL, VOXEL_OP.SHADE, a);
  }

  private op3(op: number, x: number, y: number, z: number, w = 0): number {
    const a = this.a;
    a[0] = x;
    a[1] = y;
    a[2] = z;
    a[3] = w;
    return this.play.call(PLAYSET_MODULE.VOXEL, op, a);
  }

  /** The block type at a block coordinate; -1 outside the box. */
  get(x: number, y: number, z: number): number {
    return this.op3(VOXEL_OP.GET, x, y, z);
  }

  /** Set a block; returns the previous type (-1 outside). */
  set(x: number, y: number, z: number, type: number): number {
    return this.op3(VOXEL_OP.SET, x, y, z, type);
  }

  /** Many blocks at once: (x, y, z, type) quadruples. */
  setMany(list: Float32Array): number {
    return this.play.call(PLAYSET_MODULE.VOXEL, VOXEL_OP.SET_LIST, list);
  }

  /** A box of one type, corners inclusive. */
  fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, type: number): number {
    const a = this.a;
    a[0] = x0;
    a[1] = y0;
    a[2] = z0;
    a[3] = x1;
    a[4] = y1;
    a[5] = z1;
    a[6] = type;
    return this.play.call(PLAYSET_MODULE.VOXEL, VOXEL_OP.FILL, a);
  }

  /** Terrain from heights: the `w` x `d` columns from (x0, z0), row-major
   *  along x, each filled from the floor up to its height (inclusive) with
   *  `top` for the upper `depth` blocks and `base` below. */
  columns(x0: number, z0: number, w: number, d: number, heights: Float32Array, o: { base: number; top: number; depth: number }): number {
    const args = new Float32Array(7 + w * d);
    args[0] = x0;
    args[1] = z0;
    args[2] = w;
    args[3] = d;
    args[4] = o.base;
    args[5] = o.top;
    args[6] = o.depth;
    args.set(heights.subarray(0, w * d), 7);
    return this.play.call(PLAYSET_MODULE.VOXEL, VOXEL_OP.COLUMNS, args);
  }

  /** y of the first air above the column's highest block. */
  height(x: number, z: number): number {
    return this.op3(VOXEL_OP.HEIGHT, x, z, 0);
  }

  /** The first block along a ray within `max`: its type (0 = none), with
   *  the block, the face normal and the distance in `hit`. */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number): number {
    const a = this.a;
    a[0] = ox;
    a[1] = oy;
    a[2] = oz;
    a[3] = dx;
    a[4] = dy;
    a[5] = dz;
    a[6] = max;
    return this.play.call(PLAYSET_MODULE.VOXEL, VOXEL_OP.RAYCAST, a, this.hit);
  }

  /** Collide a slot with the blocks every step: a box `radius` wide each
   *  way and `height` tall standing on the slot's position; falls are
   *  capped at `maxFall` m/s (0 = no cap). */
  body(slot: number, radius: number, height: number, maxFall = 0): void {
    this.op3(VOXEL_OP.BODY, slot, radius, height, maxFall);
  }

  removeBody(slot: number): void {
    this.op3(VOXEL_OP.BODY, slot, 0, 0, 0);
  }

  /** Mesh every dirty chunk now (after generating); the count. */
  build(): number {
    return this.play.call(PLAYSET_MODULE.VOXEL, VOXEL_OP.BUILD);
  }

  /** Chunks rebuilt per step at most (2 by default). */
  budget(chunks: number): void {
    this.op3(VOXEL_OP.BUDGET, chunks, 0, 0);
  }

  /** Keep a copy of the blocks, for `restore`. */
  snapshot(): void {
    this.play.call(PLAYSET_MODULE.VOXEL, VOXEL_OP.SNAPSHOT);
  }

  /** The blocks of the last snapshot; chunks that differ rebuild. */
  restore(): number {
    return this.play.call(PLAYSET_MODULE.VOXEL, VOXEL_OP.RESTORE);
  }

  /** Blocks of one type in the box. */
  count(type: number): number {
    return this.op3(VOXEL_OP.COUNT, type, 0, 0);
  }

  /** faces, vertices, dirty chunks, chunks rebuilt by the last step */
  stats(): Float32Array {
    this.play.call(PLAYSET_MODULE.VOXEL, VOXEL_OP.STATS, undefined, this.counters);
    return this.counters;
  }
}
