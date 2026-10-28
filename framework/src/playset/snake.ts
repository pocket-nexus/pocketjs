// @pocketjs/framework/playset/snake — grid snakes over the native snake
// module (engine/crates/pocket-playset/src/modules/snake.rs).
//
// The module owns the board: every snake's cells, a slot per segment (a head
// archetype and a body archetype), food slots, the tick, collisions and the
// flood-fill + BFS planner that steers AI snakes. It runs after the world's
// step and reports SNAKE_EVENT.EAT (a = head slot, b = food slot, DATA =
// snake, VALUE = length with the growth still to come) and SNAKE_EVENT.CRASH
// (a = head slot, b = the slot it ran into or -1, DATA = snake, VALUE =
// SNAKE_CRASH).
//
// Cell (right, forward) sits at origin + (right * cell, up, -forward * cell).
// Every call below writes a preallocated argument array: none allocates.

import { playsetModuleEvent } from "../../../contracts/spec/playset.ts";
import { MODULE, type Archetype, type Playset } from "./index.ts";

/** The module's events, for Playset.on(). */
export const SNAKE_EVENT = { EAT: playsetModuleEvent(MODULE.SNAKE, 0), CRASH: playsetModuleEvent(MODULE.SNAKE, 1) } as const;

export const SNAKE_OP = {
  BOARD: 1,
  ADD: 2,
  TURN: 3,
  CONTROL: 4,
  FOOD: 5,
  RESPAWN: 6,
  RUN: 7,
  TICK: 8,
  STATE: 9,
  WEIGHTS: 10,
  FOCUS: 11,
  REMOVE: 12,
} as const;

/** 0 up (+forward), 1 right, 2 down, 3 left. */
export const SNAKE_DIR = { UP: 0, RIGHT: 1, DOWN: 2, LEFT: 3 } as const;

/** SNAKE_EVENT.CRASH VALUE. */
export const SNAKE_CRASH = { WALL: 0, SELF: 1, SNAKE: 2 } as const;

/** `SnakeBoard.state()` fields. */
export const SNAKE_STATE = {
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

/** The planner's weights (GameBlocks' PlayerAi). */
export interface SnakeWeights {
  /** per reachable cell after the move */
  space?: number;
  /** per step to the nearest food */
  food?: number;
  /** when the tail stays reachable */
  tail?: number;
  /** for keeping the heading */
  straight?: number;
}

export interface SnakeSpec extends SnakeWeights {
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

export class SnakeBoard {
  private readonly args = new Float32Array(16);
  /** the last `state()` result */
  readonly out = new Float32Array(16);

  constructor(readonly play: Playset) {}

  /** The module reads the first `n` floats; the rest of `args` is ignored. */
  private call(op: number, _n: number): number {
    return this.play.call(MODULE.SNAKE, op, this.args, this.out);
  }

  /** A new board; removes every snake and food slot the module placed.
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
    this.call(SNAKE_OP.BOARD, 9);
  }

  /** A snake at its start cell; its index, -1 when the board is full. */
  add(s: SnakeSpec): number {
    const a = this.args;
    a[0] = s.start[0];
    a[1] = s.start[1];
    a[2] = s.dir;
    a[3] = s.length ?? 4;
    a[4] = s.head.id;
    a[5] = s.body.id;
    a[6] = s.planner ? 1 : 0;
    a[7] = s.space ?? 2.4;
    a[8] = s.food ?? 1;
    a[9] = s.tail ?? 3.5;
    a[10] = s.straight ?? 0.15;
    a[11] = s.up ?? 0;
    return this.call(SNAKE_OP.ADD, 12);
  }

  /** The guest's next direction for a snake (taken at the next tick; a
   *  reversal keeps the heading). */
  turn(snake: number, dir: number): void {
    this.args[0] = snake;
    this.args[1] = dir;
    this.call(SNAKE_OP.TURN, 2);
  }

  /** Hand a snake to the planner (the demo autopilot) or back to `turn()`. */
  control(snake: number, planner: boolean): void {
    this.args[0] = snake;
    this.args[1] = planner ? 1 : 0;
    this.call(SNAKE_OP.CONTROL, 2);
  }

  weights(snake: number, w: SnakeWeights): void {
    const a = this.args;
    a[0] = snake;
    a[1] = w.space ?? 2.4;
    a[2] = w.food ?? 1;
    a[3] = w.tail ?? 3.5;
    a[4] = w.straight ?? 0.15;
    this.call(SNAKE_OP.WEIGHTS, 5);
  }

  /** Keep `count` food items of `arch` on free cells; eating one adds `growth`. */
  food(arch: Archetype, o: { count?: number; growth?: number; up?: number } = {}): void {
    const a = this.args;
    a[0] = arch.id;
    a[1] = o.count ?? 1;
    a[2] = o.growth ?? 1;
    a[3] = o.up ?? 0;
    this.call(SNAKE_OP.FOOD, 4);
  }

  /** Back to its start; with `effects` the old segments die with their emitters. */
  respawn(snake: number, effects = false): void {
    this.args[0] = snake;
    this.args[1] = effects ? 1 : 0;
    this.call(SNAKE_OP.RESPAWN, 2);
  }

  /** Remove a snake's segments and leave it dead. */
  remove(snake: number, effects = false): void {
    this.args[0] = snake;
    this.args[1] = effects ? 1 : 0;
    this.call(SNAKE_OP.REMOVE, 2);
  }

  /** Ticks run (true) or the board holds still (the idle bob still plays). */
  run(on: boolean): void {
    this.args[0] = on ? 1 : 0;
    this.call(SNAKE_OP.RUN, 1);
  }

  /** Seconds per tick. */
  tick(seconds: number): void {
    this.args[0] = seconds;
    this.call(SNAKE_OP.TICK, 1);
  }

  /** A snake's state into `out` (SNAKE_STATE); returns `out`. */
  state(snake: number): Float32Array {
    this.args[0] = snake;
    this.call(SNAKE_OP.STATE, 1);
    return this.out;
  }

  /** Keep `slot` (a camera target) between a snake's head and the board
   *  centre: 0 on the head, 1 on the centre. */
  focus(slot: number, snake: number, lerp: number): void {
    this.args[0] = slot;
    this.args[1] = snake;
    this.args[2] = lerp;
    this.call(SNAKE_OP.FOCUS, 3);
  }
}
