// @pocketjs/framework/playset/grid — chains that step cell by cell on a
// board, over the native grid module (engine/crates/pocket-playset/src/
// modules/grid.rs).
//
// The module owns the board: every chain's cells, a slot per segment (a head
// archetype and a body archetype), pickup slots, the tick, collisions and the
// flood-fill + BFS planner that steers planner chains. It runs after the
// world's step and reports GRID_EVENT.PICKUP (a = head slot, b = pickup slot,
// DATA = chain, VALUE = length with the growth still to come) and
// GRID_EVENT.CRASH (a = head slot, b = the slot it ran into or -1, DATA =
// chain, VALUE = GRID_CRASH).
//
// Cell (right, forward) sits at origin + (right * cell, up, -forward * cell).
// Every call below writes a preallocated argument array: none allocates.

import { playsetModuleEvent } from "../../../contracts/spec/playset.ts";
import { MODULE, type Archetype, type Playset } from "./index.ts";

/** The module's events, for Playset.on(). */
export const GRID_EVENT = { PICKUP: playsetModuleEvent(MODULE.GRID, 0), CRASH: playsetModuleEvent(MODULE.GRID, 1) } as const;

export const GRID_OP = {
  BOARD: 1,
  ADD: 2,
  TURN: 3,
  CONTROL: 4,
  PICKUPS: 5,
  RESPAWN: 6,
  RUN: 7,
  TICK: 8,
  STATE: 9,
  WEIGHTS: 10,
  FOCUS: 11,
  REMOVE: 12,
} as const;

/** 0 up (+forward), 1 right, 2 down, 3 left. */
export const GRID_DIR = { UP: 0, RIGHT: 1, DOWN: 2, LEFT: 3 } as const;

/** GRID_EVENT.CRASH VALUE. */
export const GRID_CRASH = { WALL: 0, SELF: 1, CHAIN: 2 } as const;

/** `GridBoard.state()` fields. */
export const GRID_STATE = {
  ALIVE: 0,
  LENGTH: 1,
  DIR: 2,
  HEAD_RIGHT: 3,
  HEAD_FORWARD: 4,
  HEAD_SLOT: 5,
  PENDING: 6,
  PLANNER: 7,
  TICKS: 8,
} as const;

/** The planner's weights (from GameBlocks' snake-clash PlayerAi). */
export interface GridWeights {
  /** per reachable cell after the move */
  space?: number;
  /** per step to the nearest pickup */
  pickup?: number;
  /** when the tail stays reachable */
  tail?: number;
  /** for keeping the heading */
  straight?: number;
}

export interface ChainSpec extends GridWeights {
  start: readonly [number, number];
  dir: number;
  length?: number;
  head: Archetype;
  body: Archetype;
  /** the planner steers it; otherwise `turn()` does */
  planner?: boolean;
  /** segment height above the board */
  up?: number;
}

export class GridBoard {
  private readonly args = new Float32Array(16);
  /** the last `state()` result */
  readonly out = new Float32Array(16);

  constructor(readonly play: Playset) {}

  /** The module reads the first `n` floats; the rest of `args` is ignored. */
  private call(op: number, _n: number): number {
    return this.play.call(MODULE.GRID, op, this.args, this.out);
  }

  /** A new board; removes every chain and pickup slot the module placed.
   *  Call it again after `Playset.clear()`. `glide` 0 snaps segments to
   *  their cells at each tick (the demo); up to 1 carries them from the
   *  previous cell over that fraction of a tick, one tick behind. */
  board(o: { cols: number; rows: number; cell?: number; origin?: readonly [number, number, number]; tick: number; seed?: number; glide?: number }): void {
    const a = this.args;
    const origin = o.origin ?? [0, 0, 0];
    a[0] = o.cols;
    a[1] = o.rows;
    a[2] = o.cell ?? 1;
    a[3] = origin[0];
    a[4] = origin[1];
    a[5] = origin[2];
    a[6] = o.tick;
    a[7] = o.seed ?? 1;
    a[8] = o.glide ?? 0;
    this.call(GRID_OP.BOARD, 9);
  }

  /** A chain at its start cell; its index, -1 when the board is full. */
  add(s: ChainSpec): number {
    const a = this.args;
    a[0] = s.start[0];
    a[1] = s.start[1];
    a[2] = s.dir;
    a[3] = s.length ?? 4;
    a[4] = s.head.id;
    a[5] = s.body.id;
    a[6] = s.planner ? 1 : 0;
    a[7] = s.space ?? 2.4;
    a[8] = s.pickup ?? 1;
    a[9] = s.tail ?? 3.5;
    a[10] = s.straight ?? 0.15;
    a[11] = s.up ?? 0;
    return this.call(GRID_OP.ADD, 12);
  }

  /** The guest's next direction for a chain (taken at the next tick; a
   *  reversal keeps the heading). */
  turn(chain: number, dir: number): void {
    this.args[0] = chain;
    this.args[1] = dir;
    this.call(GRID_OP.TURN, 2);
  }

  /** Hand a chain to the planner or back to `turn()`. */
  control(chain: number, planner: boolean): void {
    this.args[0] = chain;
    this.args[1] = planner ? 1 : 0;
    this.call(GRID_OP.CONTROL, 2);
  }

  weights(chain: number, w: GridWeights): void {
    const a = this.args;
    a[0] = chain;
    a[1] = w.space ?? 2.4;
    a[2] = w.pickup ?? 1;
    a[3] = w.tail ?? 3.5;
    a[4] = w.straight ?? 0.15;
    this.call(GRID_OP.WEIGHTS, 5);
  }

  /** Keep `count` pickups of `arch` on free cells; the chain that takes one
   *  grows by `growth`. */
  pickups(arch: Archetype, o: { count?: number; growth?: number; up?: number } = {}): void {
    const a = this.args;
    a[0] = arch.id;
    a[1] = o.count ?? 1;
    a[2] = o.growth ?? 1;
    a[3] = o.up ?? 0;
    this.call(GRID_OP.PICKUPS, 4);
  }

  /** Back to its start; with `effects` the old segments die with their emitters. */
  respawn(chain: number, effects = false): void {
    this.args[0] = chain;
    this.args[1] = effects ? 1 : 0;
    this.call(GRID_OP.RESPAWN, 2);
  }

  /** Remove a chain's segments and leave it dead. */
  remove(chain: number, effects = false): void {
    this.args[0] = chain;
    this.args[1] = effects ? 1 : 0;
    this.call(GRID_OP.REMOVE, 2);
  }

  /** Ticks run (true) or the board holds still (the idle bob still plays). */
  run(on: boolean): void {
    this.args[0] = on ? 1 : 0;
    this.call(GRID_OP.RUN, 1);
  }

  /** Seconds per tick. */
  tick(seconds: number): void {
    this.args[0] = seconds;
    this.call(GRID_OP.TICK, 1);
  }

  /** A chain's state into `out` (GRID_STATE); returns `out`. */
  state(chain: number): Float32Array {
    this.args[0] = chain;
    this.call(GRID_OP.STATE, 1);
    return this.out;
  }

  /** Keep `slot` (a camera target) between a chain's head and the board
   *  centre: 0 on the head, 1 on the centre. */
  focus(slot: number, chain: number, lerp: number): void {
    this.args[0] = slot;
    this.args[1] = chain;
    this.args[2] = lerp;
    this.call(GRID_OP.FOCUS, 3);
  }
}
