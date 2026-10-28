// The desert: height field and the seeded props, ported from GameBlocks'
// desert-shooter (https://gb-desert-shooter.vercel.app/src/game.js, MIT,
// xt4d/GameBlocks), class DesertWorld.
//
// Coordinates: the demo's (right, up, forward) is playset (x, y, -z); its yaw
// and the playset's agree (0 faces forward, positive turns left).
//
// Deviations: the props sit in flat arrays with a coarse grid over them, so
// the autopilot asks for the props near a point instead of walking all of
// them; collision against them is the native static colliders.

import { mulberry } from "../kit/random.ts";

export const WORLD_BOUNDS = 220;
export type PropType = "mesa" | "cactus" | "rocks" | "cliff" | "scrub" | "bones";

export interface Prop {
  type: PropType;
  x: number;
  z: number;
  y: number;
  radius: number;
  scale: number;
  yaw: number;
}

/** Height of the dunes at demo coordinates (right, forward). */
export function duneHeight(right: number, forward: number): number {
  return Math.sin(right * 0.035) * 1.15 + Math.cos(forward * 0.026) * 0.9 + Math.sin((right + forward) * 0.015) * 0.8;
}

const GRID_CELL = 40;
const GRID_N = Math.ceil((WORLD_BOUNDS * 2) / GRID_CELL);

export class DesertWorld {
  readonly bounds = WORLD_BOUNDS;
  readonly props: Prop[] = [];
  /** collider centres and radii, one entry per prop */
  readonly cx: Float64Array;
  readonly cz: Float64Array;
  readonly cr: Float64Array;
  readonly count: number;
  /** prop indices per grid cell, and each cell's first index into `cells` */
  private readonly cellStart = new Int32Array(GRID_N * GRID_N + 1);
  private readonly cells: Int32Array;

  constructor(seed = 90616) {
    const prng = mulberry(seed);
    const add = (type: PropType, right: number, forward: number, radius: number, scale = 1) => {
      this.props.push({
        type,
        x: right,
        z: -forward,
        y: duneHeight(right, forward),
        radius: radius * scale,
        scale,
        yaw: prng.uniform(0, Math.PI * 2),
      });
    };
    for (let i = 0; i < 16; i += 1) {
      const angle = (i / 16) * Math.PI * 2 + prng.uniform(-0.1, 0.1);
      const dist = prng.uniform(this.bounds * 0.72, this.bounds * 0.98);
      const scale = prng.uniform(0.75, 1.35);
      add("mesa", Math.cos(angle) * dist, Math.sin(angle) * dist, 6.4, scale);
    }
    for (let i = 0; i < 118; i += 1) {
      const right = prng.uniform(-this.bounds * 0.9, this.bounds * 0.9);
      const forward = prng.uniform(-this.bounds * 0.9, this.bounds * 0.9);
      if (Math.hypot(right, forward) < 22) continue;
      const roll = prng();
      if (roll < 0.24) add("cactus", right, forward, 1.05);
      else if (roll < 0.5) add("rocks", right, forward, 2.25);
      else if (roll < 0.66) add("cliff", right, forward, prng.uniform(2.8, 7.8));
      else if (roll < 0.88) add("scrub", right, forward, 0.85);
      else add("bones", right, forward, 1.05);
    }
    const n = this.props.length;
    this.count = n;
    this.cx = new Float64Array(n);
    this.cz = new Float64Array(n);
    this.cr = new Float64Array(n);
    this.props.forEach((p, i) => {
      this.cx[i] = p.x;
      this.cz[i] = p.z;
      this.cr[i] = p.radius;
    });
    // bucket every prop into the cells its disc touches
    const lists: number[][] = Array.from({ length: GRID_N * GRID_N }, () => []);
    this.props.forEach((p, i) => {
      const [x0, x1] = this.cellRange(p.x, p.radius);
      const [z0, z1] = this.cellRange(p.z, p.radius);
      for (let gz = z0; gz <= z1; gz++) for (let gx = x0; gx <= x1; gx++) lists[gz * GRID_N + gx].push(i);
    });
    const flat: number[] = [];
    lists.forEach((l, c) => {
      this.cellStart[c] = flat.length;
      flat.push(...l);
    });
    this.cellStart[GRID_N * GRID_N] = flat.length;
    this.cells = Int32Array.from(flat);
  }

  /** Height at playset (x, z). */
  height(x: number, z: number): number {
    return duneHeight(x, -z);
  }

  private cellRange(c: number, r: number): [number, number] {
    const a = Math.floor((c - r + WORLD_BOUNDS) / GRID_CELL);
    const b = Math.floor((c + r + WORLD_BOUNDS) / GRID_CELL);
    return [Math.max(0, Math.min(GRID_N - 1, a)), Math.max(0, Math.min(GRID_N - 1, b))];
  }

  /** Prop indices whose cells meet the square of half size `r` around (x, z),
   *  into `out` (duplicates removed by `stamp`); the count. */
  near(x: number, z: number, r: number, out: Int32Array, stamp: Uint32Array, epoch: number): number {
    const x0 = Math.max(0, Math.floor((x - r + WORLD_BOUNDS) / GRID_CELL));
    const x1 = Math.min(GRID_N - 1, Math.floor((x + r + WORLD_BOUNDS) / GRID_CELL));
    const z0 = Math.max(0, Math.floor((z - r + WORLD_BOUNDS) / GRID_CELL));
    const z1 = Math.min(GRID_N - 1, Math.floor((z + r + WORLD_BOUNDS) / GRID_CELL));
    const start = this.cellStart;
    const cells = this.cells;
    let n = 0;
    for (let gz = z0; gz <= z1; gz++) {
      for (let gx = x0; gx <= x1; gx++) {
        const c = gz * GRID_N + gx;
        for (let k = start[c], e = start[c + 1]; k < e; k++) {
          const i = cells[k];
          if (stamp[i] === epoch) continue;
          stamp[i] = epoch;
          out[n++] = i;
        }
      }
    }
    return n;
  }

  /** The demo's firstStaticBlockerBetween on the ground plane: whether the
   *  segment from (ax, az) to (bx, bz) crosses a prop disc grown by `extra`
   *  for some t in [minT, maxT]. Only the props in the grid cells under the
   *  segment's box are tested. */
  blocked(ax: number, az: number, bx: number, bz: number, extra: number, minT: number, maxT: number, scratch: Int32Array, stamp: Uint32Array, epoch: number): boolean {
    const dx = bx - ax;
    const dz = bz - az;
    const lenSq = dx * dx + dz * dz;
    if (lenSq <= 1e-6) return false;
    const loX = Math.min(ax, bx), hiX = Math.max(ax, bx), loZ = Math.min(az, bz), hiZ = Math.max(az, bz);
    const half = Math.max(hiX - loX, hiZ - loZ) * 0.5 + extra;
    const n = this.near((loX + hiX) * 0.5, (loZ + hiZ) * 0.5, half, scratch, stamp, epoch);
    const cx = this.cx, cz = this.cz, cr = this.cr;
    for (let k = 0; k < n; k++) {
      const i = scratch[k];
      const r = cr[i] + extra;
      const px = cx[i], pz = cz[i];
      if (px + r < loX || px - r > hiX || pz + r < loZ || pz - r > hiZ) continue;
      const fx = ax - px;
      const fz = az - pz;
      const b = 2 * (fx * dx + fz * dz);
      const c = fx * fx + fz * fz - r * r;
      // the start inside the disc counts as a hit at minT
      if (c <= 0) return true;
      const disc = b * b - 4 * lenSq * c;
      if (disc < 0) continue;
      const root = Math.sqrt(disc);
      const t0 = (-b - root) / (2 * lenSq);
      const t1 = (-b + root) / (2 * lenSq);
      if ((t0 >= minT && t0 <= maxT) || (t1 >= minT && t1 <= maxT)) return true;
    }
    return false;
  }
}
