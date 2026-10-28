// @pocketjs/framework/playset/marble — a tilting plate and a rolling ball
// over the native marble module (engine/crates/pocket-playset/src/modules/
// marble.rs).
//
// The module owns one level at a time: the plate size, walls and moving
// blocks as boxes, holes, stars and the goal, the tilt controller, the
// ball's physics, and the matrices of the level node and the block nodes,
// so the plate and everything on it tilt together. The marble slot's
// intents steer it (Playset.steer(marble, right, forward), each -1..1).
//
// It reports EVENT.MARBLE (a = marble, DATA = hole index when it fell
// through one, -1 when it reached the goal; VALUE = seconds on the level),
// EVENT.PICKUP for a star (a = marble, b = star slot, DATA = star index,
// VALUE = stars collected) and EVENT.HIT for a bump (a = marble, DATA = wall
// index, walls then blocks, -1 for the plate edge; VALUE = impact speed).
//
// Coordinates are plate-local (right, forward), the plate centred on its
// origin, as GameBlocks' marble-puzzle levels are written.

import { MODULE, type Archetype, type Playset } from "./index.ts";

export const MARBLE_OP = { LEVEL: 1, WALL: 2, BLOCK: 3, HOLE: 4, STAR: 5, PHASE: 6, TUNE: 7, STATE: 8, ROUTE: 9 } as const;

export const MARBLE_PHASE = { FROZEN: 0, PLAYING: 1, FAILED: 2, DONE: 3 } as const;

/** `MarbleBoard.state()` fields; moving blocks follow from BLOCKS as (right, forward). */
export const MARBLE_STATE = {
  PHASE: 0,
  RIGHT: 1,
  FORWARD: 2,
  UP: 3,
  VR: 4,
  VF: 5,
  TILT_RIGHT: 6,
  TILT_FORWARD: 7,
  COLLECTED: 8,
  ELAPSED: 9,
  SPEED: 10,
  BLOCK_COUNT: 11,
  BLOCKS: 12,
} as const;

export interface MarbleRect {
  right: number;
  forward: number;
  width: number;
  depth: number;
}

export interface MarbleLevel {
  name?: string;
  size: { right: number; forward: number };
  start: { right: number; forward: number };
  goal: { right: number; forward: number; radius: number };
  walls: readonly MarbleRect[];
  holes: readonly { right: number; forward: number; radius: number }[];
  movingBlocks: readonly (MarbleRect & { axis: "right" | "forward"; distance: number; speed: number })[];
  stars: readonly { right: number; forward: number }[];
}

export interface MarbleLoad {
  /** a dynamic scene node (place(..., { static: false })) of the level's plate */
  node: number;
  /** one dynamic node per moving block, in order */
  blockNodes: readonly number[];
  marble: Archetype;
  star: Archetype;
  radius?: number;
  starUp?: number;
  /** the height of a block node's origin above the plate */
  blockUp?: number;
  /** the plate centre in the world */
  center?: readonly [number, number, number];
}

export class MarbleBoard {
  private readonly args = new Float32Array(16);
  /** the last `state()` result */
  readonly out = new Float32Array(32);
  /** the last `route()` waypoints as (right, forward) pairs */
  readonly path = new Float32Array(128);
  /** the marble slot of the loaded level */
  marble = -1;
  readonly stars: number[] = [];

  constructor(readonly play: Playset) {}

  private call(op: number, out: Float32Array = this.out): number {
    return this.play.call(MODULE.MARBLE, op, this.args, out);
  }

  /** Load a level, frozen until `phase(PLAYING)`; returns the marble slot.
   *  Call it again after `Playset.clear()`. */
  load(level: MarbleLevel, o: MarbleLoad): number {
    const a = this.args;
    const c = o.center ?? [0, 0, 0];
    a.set([
      level.size.right, level.size.forward, level.start.right, level.start.forward,
      level.goal.right, level.goal.forward, level.goal.radius, o.radius ?? 0.42,
      c[0], c[1], c[2], o.node, o.marble.id, o.star.id, o.starUp ?? 0.72,
    ]);
    this.marble = this.call(MARBLE_OP.LEVEL);
    for (const w of level.walls) {
      a.set([w.right, w.forward, w.width, w.depth]);
      this.call(MARBLE_OP.WALL);
    }
    level.movingBlocks.forEach((b, i) => {
      a.set([b.right, b.forward, b.width, b.depth, b.axis === "forward" ? 1 : 0, b.distance, b.speed, o.blockNodes[i] ?? -1, o.blockUp ?? 0]);
      this.call(MARBLE_OP.BLOCK);
    });
    for (const h of level.holes) {
      a.set([h.right, h.forward, h.radius]);
      this.call(MARBLE_OP.HOLE);
    }
    this.stars.length = 0;
    for (const s of level.stars) {
      a[0] = s.right;
      a[1] = s.forward;
      this.stars.push(this.call(MARBLE_OP.STAR));
    }
    return this.marble;
  }

  phase(p: number): void {
    this.args[0] = p;
    this.call(MARBLE_OP.PHASE);
  }

  /** PlateTiltController and Game.updatePhysics constants. */
  tune(o: { maxTilt?: number; tiltLag?: number; gravity?: number; friction?: number; maxSpeed?: number }): void {
    const a = this.args;
    a[0] = o.maxTilt ?? 0.22;
    a[1] = o.tiltLag ?? 0.09;
    a[2] = o.gravity ?? 15.5;
    a[3] = o.friction ?? 0.72;
    a[4] = o.maxSpeed ?? 12;
    this.call(MARBLE_OP.TUNE);
  }

  /** The marble, the tilt and the moving blocks into `out` (MARBLE_STATE). */
  state(): Float32Array {
    this.call(MARBLE_OP.STATE);
    return this.out;
  }

  /** PlayerAi.planRoute from the marble to (right, forward): waypoints into
   *  `path`; their count. */
  route(right: number, forward: number, o: { cell?: number; margin?: number; wallPad?: number; holePad?: number; blockPad?: number } = {}): number {
    const a = this.args;
    a[0] = right;
    a[1] = forward;
    a[2] = o.cell ?? 0.55;
    a[3] = o.margin ?? 0.54;
    a[4] = o.wallPad ?? 0.58;
    a[5] = o.holePad ?? 0.78;
    a[6] = o.blockPad ?? 0.64;
    return this.call(MARBLE_OP.ROUTE, this.path);
  }
}
