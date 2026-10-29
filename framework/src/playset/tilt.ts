// @pocketjs/framework/playset/tilt — a tilting plate and a ball rolling on
// it, over the native tilt module (engine/crates/pocket-playset/src/modules/
// tilt.rs).
//
// The module owns one plate at a time: its size, walls and moving blocks as
// boxes, holes, pickups and the goal zone, the tilt controller, the ball's
// physics, and the matrices of the plate node and the block nodes, so the
// plate and everything on it tilt together. The ball slot's intents steer it
// (Playset.steer(ball, right, forward), each -1..1).
//
// It reports TILT_EVENT.END (a = ball, DATA = hole index when it fell
// through one, -1 when it reached the goal; VALUE = seconds on the plate),
// EVENT.PICKUP for a pickup (a = ball, b = pickup slot, DATA = pickup index,
// VALUE = pickups collected) and EVENT.HIT for a bump (a = ball, DATA = wall
// index, walls then blocks, -1 for the plate edge; VALUE = impact speed).
//
// Coordinates are plate-local (right, forward), the plate centred on its
// origin, as GameBlocks' marble-puzzle levels are written.

import { playsetModuleEvent } from "../../../contracts/spec/playset.ts";
import { MODULE, type Archetype, type Playset } from "./index.ts";

/** The module's events, for Playset.on(). */
export const TILT_EVENT = { END: playsetModuleEvent(MODULE.TILT, 0) } as const;

export const TILT_OP = { PLATE: 1, WALL: 2, BLOCK: 3, HOLE: 4, PICKUP: 5, PHASE: 6, TUNE: 7, STATE: 8, ROUTE: 9 } as const;

/** FROZEN holds everything still; FELL sinks through a hole and ARRIVED
 *  settles at the goal, the plate tilting in both. */
export const TILT_PHASE = { FROZEN: 0, ROLLING: 1, FELL: 2, ARRIVED: 3 } as const;

/** `TiltTable.state()` fields; moving blocks follow from BLOCKS as (right, forward). */
export const TILT_STATE = {
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

export interface TiltRect {
  right: number;
  forward: number;
  width: number;
  depth: number;
}

export interface TiltPlate {
  name?: string;
  size: { right: number; forward: number };
  start: { right: number; forward: number };
  goal: { right: number; forward: number; radius: number };
  walls: readonly TiltRect[];
  holes: readonly { right: number; forward: number; radius: number }[];
  movingBlocks: readonly (TiltRect & { axis: "right" | "forward"; distance: number; speed: number })[];
  pickups: readonly { right: number; forward: number }[];
}

export interface TiltLoad {
  /** a dynamic scene node (place(..., { static: false })) of the plate */
  node: number;
  /** one dynamic node per moving block, in order */
  blockNodes: readonly number[];
  ball: Archetype;
  pickup: Archetype;
  radius?: number;
  pickupUp?: number;
  /** the height of a block node's origin above the plate */
  blockUp?: number;
  /** the plate centre in the world */
  center?: readonly [number, number, number];
}

export class TiltTable {
  private readonly args = new Float32Array(16);
  /** the last `state()` result */
  readonly out = new Float32Array(32);
  /** the last `route()` waypoints as (right, forward) pairs */
  readonly path = new Float32Array(128);
  /** the ball slot of the loaded plate */
  ball = -1;
  readonly pickups: number[] = [];

  constructor(readonly play: Playset) {}

  private call(op: number, out: Float32Array = this.out): number {
    return this.play.call(MODULE.TILT, op, this.args, out);
  }

  /** Load a plate, frozen until `phase(ROLLING)`; returns the ball slot.
   *  Call it again after `Playset.clear()`. */
  load(plate: TiltPlate, o: TiltLoad): number {
    const a = this.args;
    const c = o.center ?? [0, 0, 0];
    a.set([
      plate.size.right, plate.size.forward, plate.start.right, plate.start.forward,
      plate.goal.right, plate.goal.forward, plate.goal.radius, o.radius ?? 0.42,
      c[0], c[1], c[2], o.node, o.ball.id, o.pickup.id, o.pickupUp ?? 0.72,
    ]);
    this.ball = this.call(TILT_OP.PLATE);
    for (const w of plate.walls) {
      a.set([w.right, w.forward, w.width, w.depth]);
      this.call(TILT_OP.WALL);
    }
    plate.movingBlocks.forEach((b, i) => {
      a.set([b.right, b.forward, b.width, b.depth, b.axis === "forward" ? 1 : 0, b.distance, b.speed, o.blockNodes[i] ?? -1, o.blockUp ?? 0]);
      this.call(TILT_OP.BLOCK);
    });
    for (const h of plate.holes) {
      a.set([h.right, h.forward, h.radius]);
      this.call(TILT_OP.HOLE);
    }
    this.pickups.length = 0;
    for (const s of plate.pickups) {
      a[0] = s.right;
      a[1] = s.forward;
      this.pickups.push(this.call(TILT_OP.PICKUP));
    }
    return this.ball;
  }

  phase(p: number): void {
    this.args[0] = p;
    this.call(TILT_OP.PHASE);
  }

  /** PlateTiltController and Game.updatePhysics constants. */
  tune(o: { maxTilt?: number; tiltLag?: number; gravity?: number; friction?: number; maxSpeed?: number }): void {
    const a = this.args;
    a[0] = o.maxTilt ?? 0.22;
    a[1] = o.tiltLag ?? 0.09;
    a[2] = o.gravity ?? 15.5;
    a[3] = o.friction ?? 0.72;
    a[4] = o.maxSpeed ?? 12;
    this.call(TILT_OP.TUNE);
  }

  /** The ball, the tilt and the moving blocks into `out` (TILT_STATE). */
  state(): Float32Array {
    this.call(TILT_OP.STATE);
    return this.out;
  }

  /** PlayerAi.planRoute from the ball to (right, forward): waypoints into
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
    return this.call(TILT_OP.ROUTE, this.path);
  }
}
