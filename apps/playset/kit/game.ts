// What a playset game gives the shared shell (shell.tsx) and the headless
// runner (tools/playset-sim.ts): no UI, only state, readouts and a frame.

import type { Playset } from "@pocketjs/framework/playset";

export type GameStatus = "title" | "playing" | "paused" | "gameover";

/** The pad as a game reads it: sticks in -1..1 with up positive, buttons
 *  held and newly pressed (contracts/spec/spec.ts BTN; on the 3DS A is
 *  CIRCLE, B CROSS, X TRIANGLE, Y SQUARE). */
export interface Pad {
  x: number;
  y: number;
  rx: number;
  ry: number;
  held: number;
  pressed: number;
}

export interface Readout {
  readonly label: string;
  /** a number or short text, sampled six times a second */
  value(): string | number;
  /** 0..1 draws a bar under the value */
  bar?(): number;
  readonly color?: string;
}

export interface PlaysetGame {
  readonly title: string;
  /** two short lines, "\n" between them */
  readonly tagline: string;
  /** accent for buttons and bars, "#rrggbb" */
  readonly accent: string;
  readonly controls: readonly (readonly [string, string])[];
  readonly readouts: readonly Readout[];
  readonly play: Playset;
  status(): GameStatus;
  /** start a run; demo = the game plays itself (also the title's backdrop) */
  start(demo: boolean): void;
  frame(pad: Pad): void;
  /** the top-screen corner line while playing */
  topLine(): string;
  /** the game-over card's second line */
  result(): string;
  pause?(paused: boolean): void;
}
