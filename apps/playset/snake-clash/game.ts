// Snake Clash's gameplay over the playset grid module, ported from
// GameBlocks' snake-clash demo (https://gb-snake-clash.vercel.app/, MIT,
// xt4d/GameBlocks).
//
// What runs where:
//   native, every step — the board (modules/grid.rs): both snakes' cells
//     and segment slots, the tick, collisions, the apple, the flood-fill +
//     BFS planner (GameBlocks' PlayerAi) that steers the rival and, in the
//     demo, the player; the camera focus between the head and the centre;
//     the follow camera; the bite and the bursts (death emitters, sounds);
//   here, at event rate — scores, the step interval that shortens with the
//     player's score, the rival's respawn, game over, the cues;
//   here, per frame — the stick or d-pad turned into a direction when it
//     changes (one native call on a change). As in the demo's idle state, a
//     manual run holds still until the first direction.
//
// Deviations: a crash plays a burst and a sound (the demo has neither);
// every fifth apple plays a cue as the snakes speed up; the rival bursts
// into particles before it respawns.

import { createPlayset, motion, sfx, type Archetype, type Playset, type Sound } from "@pocketjs/framework/playset";
import { GRID_DIR, GRID_EVENT, GridBoard } from "@pocketjs/framework/playset/grid";
import * as V from "./visuals.ts";
import type { GameStatus, Pad, PlaysetGame } from "../kit/game.ts";

export type Status = "title" | "playing" | "gameover";

const PLAYER = 0;
const RIVAL = 1;
/** game.js DEFAULT_CONFIG */
const BASE_STEP = 0.15;
const MIN_STEP = 0.07;
const SPEEDUP = 0.004;
const INITIAL_LENGTH = 4;
const SEGMENT_UP = 0.12;
const APPLE_UP = 0.25;

export class SnakeClash {
  readonly play: Playset;
  readonly board: GridBoard;
  readonly hud = { status: "title" as Status, demo: true, score: 0, rival: 0, best: 0, length: INITIAL_LENGTH };
  private readonly playerHead: Archetype;
  private readonly playerBody: Archetype;
  private readonly rivalHead: Archetype;
  private readonly rivalBody: Archetype;
  private readonly apple: Archetype;
  private readonly focusArch: Archetype;
  private readonly crashSound: Sound;
  private readonly bigCrash: Sound;
  private readonly lose: Sound;
  private readonly turnSound: Sound;
  private readonly speedCue: Sound;
  private readonly respawnSound: Sound;
  private readonly flash: { id: number };
  private stickDir = -1;
  private focus = -1;
  /** game.js idle: a manual run holds still until the first direction */
  waiting = false;

  constructor() {
    const play = createPlayset({ capacity: 320, particles: 600, seed: 20260521 });
    this.play = play;
    this.board = new GridBoard(play);
    const P = V.PALETTE;
    play.sky(P.background, P.background, P.background);
    play.fog(P.background, 14, 34, 1);
    play.light({ sun: [0.5, 18, -2.5], sunColor: 0xfff2db, sunIntensity: 1.25, sky: 0xe6f2ff, ground: 0x2a3a48, ambient: 0.95 });
    play.gravity(18);
    play.ground({ y: V.GROUND.y, size: V.GROUND.size, color: P.ground, cell: V.GROUND.size });
    play.place(play.model(V.board()), [0, 0, 0], { static: true });

    const burst = (color: number, count: number, speed: number) =>
      play.emitter({ count, life: 0.55, speed, spread: Math.PI, dir: [0, 1, 0], gravity: 0.6, size: [0.22, 0.04], color: [color, color], alpha: [1, 0], blend: "add", drag: 1.2 });
    this.flash = burst(0xfff2db, 40, 7);
    const bite = play.sound(sfx.bite());
    this.crashSound = play.sound(sfx.crumble());
    this.bigCrash = play.sound(sfx.explosion());
    this.lose = play.sound(sfx.lose());
    this.turnSound = play.sound({ ...sfx.select(), volume: 0.12 });
    this.speedCue = play.sound(sfx.checkpoint());
    this.respawnSound = play.sound({ ...sfx.whoosh(), volume: 0.22 });

    const still = motion.none();
    const shadow = 0.85;
    this.playerHead = play.archetype({ model: play.model(V.head(P.playerHead)), motion: still, shadow, death: burst(P.playerHead, 14, 4) });
    this.playerBody = play.archetype({ model: play.model(V.segment(P.playerBody)), motion: still, shadow, death: burst(P.playerBody, 8, 3) });
    this.rivalHead = play.archetype({ model: play.model(V.head(P.rivalHead)), motion: still, shadow, death: burst(P.rivalHead, 14, 4) });
    this.rivalBody = play.archetype({ model: play.model(V.segment(P.rivalBody)), motion: still, shadow, death: burst(P.rivalBody, 8, 3) });
    this.apple = play.archetype({ model: play.model(V.apple()), motion: still, shadow: 0.45, death: burst(P.leaf, 16, 3.5), sounds: { death: bite } });
    this.focusArch = play.archetype({ motion: still, hidden: true });

    play.on(GRID_EVENT.PICKUP, (_head, _apple, snake) => this.onEat(snake));
    play.on(GRID_EVENT.CRASH, (_head, _hit, snake, x, y, z) => this.onCrash(snake, x, y, z));
    this.reset(true);
  }

  reset(demo: boolean): void {
    const play = this.play;
    play.clear();
    const hud = this.hud;
    hud.status = demo ? "title" : "playing";
    hud.demo = demo;
    hud.score = 0;
    hud.rival = 0;
    hud.length = INITIAL_LENGTH;
    this.stickDir = -1;
    const b = this.board;
    b.board({ cols: V.COLS, rows: V.ROWS, cell: V.CELL, origin: V.ORIGIN, tick: BASE_STEP, seed: 1337 });
    // game.js: the player at (3, rows / 2) heading right, the rival at
    // (columns - 4, 3) heading left; PlayerAi's weights for each
    b.add({
      start: [3, Math.floor(V.ROWS * 0.5)], dir: GRID_DIR.RIGHT, length: INITIAL_LENGTH, head: this.playerHead, body: this.playerBody,
      planner: demo, space: 2.4, pickup: 3.2, tail: 3.5, straight: 0.35, up: SEGMENT_UP,
    });
    b.add({
      start: [V.COLS - 4, 3], dir: GRID_DIR.LEFT, length: INITIAL_LENGTH, head: this.rivalHead, body: this.rivalBody,
      planner: true, space: 2, pickup: 3, tail: 3.5, straight: 0.5, up: SEGMENT_UP,
    });
    b.pickups(this.apple, { count: 1, growth: 1, up: APPLE_UP });
    this.focus = play.spawn(this.focusArch, 0, 0, 0);
    b.focus(this.focus, PLAYER, 0.16);
    // PositionFollowCameraRig: distance 12.4, height 15.5, lags 0.17 / 0.10 s
    play.followCamera(this.focus, { offset: [0, 15.5, 12.4], lookAhead: 0, lookUp: 0, heading: false, fov: 42, near: 4, far: 100, smooth: 1 / 0.17, smoothLook: 1 / 0.1 });
    this.waiting = !demo;
    b.run(demo);
  }

  private onEat(snake: number): void {
    const hud = this.hud;
    if (snake === PLAYER) {
      hud.score += 1;
      hud.best = Math.max(hud.best, hud.score);
      hud.length += 1;
      this.board.tick(Math.max(MIN_STEP, BASE_STEP - hud.score * SPEEDUP));
      if (hud.score % 5 === 0) this.play.play(this.speedCue, 0.7);
    } else if (snake === RIVAL) {
      hud.rival += 1;
    }
  }

  private onCrash(snake: number, x: number, y: number, z: number): void {
    const play = this.play;
    const at: [number, number, number] = [x, y, z];
    if (snake === PLAYER) {
      // game.js: the run ends and the board holds still
      this.hud.status = "gameover";
      this.hud.best = Math.max(this.hud.best, this.hud.score);
      this.board.run(false);
      play.burst(this.flash, x, y, z);
      play.play(this.bigCrash, 0.9, 1, at);
      play.play(this.lose, 0.8);
      play.shake(0.8);
      return;
    }
    // the rival starts again at its corner
    play.play(this.crashSound, 0.8, 1, at);
    play.play(this.respawnSound, 0.6);
    this.board.respawn(RIVAL, true);
  }

  frame(pad: Pad): void {
    const live = this.hud.status === "playing" || (this.hud.status === "title" && this.hud.demo);
    if (live && !this.hud.demo) {
      // the stick or d-pad as a direction, sent when it changes
      const x = pad.x;
      const y = pad.y;
      const ax = x < 0 ? -x : x;
      const ay = y < 0 ? -y : y;
      let dir = -1;
      if (ax > 0.5 || ay > 0.5) dir = ax >= ay ? (x > 0 ? GRID_DIR.RIGHT : GRID_DIR.LEFT) : y > 0 ? GRID_DIR.UP : GRID_DIR.DOWN;
      if (dir !== this.stickDir) {
        this.stickDir = dir;
        if (dir >= 0) {
          this.board.turn(PLAYER, dir);
          this.play.play(this.turnSound);
          if (this.waiting) {
            this.waiting = false;
            this.board.run(true);
          }
        }
      }
    }
    this.play.frame(1 / 60);
  }
}

/** The game as the playset shell and the headless runner drive it. */
export function createGame(): PlaysetGame {
  const game = new SnakeClash();
  (globalThis as { __playsetGame?: unknown }).__playsetGame = game;
  let paused = false;
  let overAt = -1;
  return {
    title: "Snake Clash",
    tagline: "Clash with the blue snake for the high score.\nEat apples; avoid walls, yourself and your rival.",
    accent: "#d72638",
    controls: [
      ["Circle Pad / D-Pad", "Turn"],
      ["Apples", "Grow and speed up"],
      ["START", "Pause"],
      ["Y", "Developer stats"],
      ["SELECT", "Home"],
    ],
    readouts: [
      { label: "Score", value: () => game.hud.score },
      { label: "Rival", value: () => game.hud.rival },
      { label: "Best", value: () => game.hud.best },
      { label: "Length", value: () => game.hud.length, bar: () => Math.min(1, game.hud.length / 40), color: "#f04f5d" },
      { label: "Step", value: () => `${Math.round(Math.max(MIN_STEP, BASE_STEP - game.hud.score * SPEEDUP) * 1000)} ms` },
    ],
    play: game.play,
    status(): GameStatus {
      if (game.hud.status === "title") return "title";
      if (game.hud.status === "gameover") return game.hud.demo ? "title" : "gameover";
      return paused ? "paused" : "playing";
    },
    start(demo: boolean) {
      paused = false;
      overAt = -1;
      game.reset(demo);
    },
    pause(p: boolean) {
      paused = p;
    },
    frame(pad: Pad) {
      // the attract loop restarts itself two seconds after a demo ends
      if (game.hud.demo && game.hud.status === "gameover") {
        if (overAt < 0) overAt = game.play.tick;
        else if (game.play.tick - overAt > 120) {
          overAt = -1;
          game.reset(true);
        }
      }
      if (paused) return;
      game.frame(pad);
    },
    topLine: () => (game.waiting ? "PRESS A DIRECTION TO START" : `SCORE ${game.hud.score}    RIVAL ${game.hud.rival}    BEST ${game.hud.best}`),
    result: () => `Score ${game.hud.score} · rival ${game.hud.rival} · best ${game.hud.best}`,
  };
}
