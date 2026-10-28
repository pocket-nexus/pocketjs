// Marble Puzzle's gameplay over the playset marble module, ported from
// GameBlocks' marble-puzzle demo (https://gb-marble-puzzle.vercel.app/,
// MIT, xt4d/GameBlocks).
//
// What runs where:
//   native, every step — the plate's tilt toward the stick, the ball's
//     rolling physics, walls, moving blocks, holes, stars and the goal, and
//     the matrices that tilt the level node, the block nodes, the marble and
//     the stars together (modules/marble.rs); the follow camera; the star
//     bursts and chimes (the star archetype's death emitter and sound);
//   here, at event rate — the level sequence, scoring, failing, the cues,
//     the route the autopilot asks for every 1.2 s (planned natively, from
//     a cost-to-goal field kept per level);
//   here, on a budget — the autopilot's steering (GameBlocks' PlayerAi,
//     every 2nd frame) and the rolling sound's volume and pitch (every 4th).
//
// Deviations: the demo's ramps and traps are empty in all three levels and
// are not ported; falling into a hole ends the run as the demo's "Failed"
// panel does, with a sound; bumps, rolling, stars and the goal have sounds
// (the demo has none); the moving blocks' clock starts with each level.

import { EVENT, ENT, createPlayset, joint, motion, sfx, type Archetype, type Playset, type Sound } from "@pocketjs/framework/playset";
import { MARBLE_PHASE, MARBLE_STATE, MarbleBoard, type MarbleLevel } from "@pocketjs/framework/playset/marble";
import * as V from "./visuals.ts";
import type { GameStatus, Pad, PlaysetGame } from "../kit/game.ts";

/** game.js LEVELS (ramps and traps are empty in every level). */
export const LEVELS: readonly MarbleLevel[] = [
  {
    name: "Sky Table",
    size: { right: 18, forward: 14 },
    start: { right: -7.2, forward: -4.8 },
    goal: { right: 7.1, forward: 4.6, radius: 1.0 },
    walls: [
      { right: 0, forward: -6.95, width: 18, depth: 0.45 },
      { right: 0, forward: 6.95, width: 18, depth: 0.45 },
      { right: -8.95, forward: 0, width: 0.45, depth: 14 },
      { right: 8.95, forward: 0, width: 0.45, depth: 14 },
      { right: -1.2, forward: -1.1, width: 0.55, depth: 5.8 },
      { right: 3.6, forward: 2.3, width: 5.2, depth: 0.5 },
    ],
    holes: [
      { right: -3.8, forward: 1.3, radius: 0.85 },
      { right: 2.1, forward: -2.7, radius: 0.95 },
    ],
    movingBlocks: [{ right: 1.5, forward: 0.1, width: 1.25, depth: 1.25, axis: "forward", distance: 2.9, speed: 1.2 }],
    stars: [
      { right: -5.7, forward: 4.7 },
      { right: 0.8, forward: -4.7 },
      { right: 6.6, forward: 0.9 },
    ],
  },
  {
    name: "Ramp Run",
    size: { right: 20, forward: 16 },
    start: { right: -8, forward: 5.5 },
    goal: { right: 8.1, forward: -5.7, radius: 1.0 },
    walls: [
      { right: 0, forward: -7.95, width: 20, depth: 0.45 },
      { right: 0, forward: 7.95, width: 20, depth: 0.45 },
      { right: -9.95, forward: 0, width: 0.45, depth: 16 },
      { right: 9.95, forward: 0, width: 0.45, depth: 16 },
      { right: -4.2, forward: 1.2, width: 6.4, depth: 0.45 },
      { right: 3.2, forward: -2.3, width: 0.5, depth: 6.2 },
      { right: 6.5, forward: 2.6, width: 4.1, depth: 0.5 },
    ],
    holes: [
      { right: -6.1, forward: -1.7, radius: 0.95 },
      { right: 0.3, forward: 0.4, radius: 0.8 },
      { right: 5.8, forward: 5.2, radius: 1.05 },
    ],
    movingBlocks: [
      { right: -2.5, forward: -3.1, width: 1.35, depth: 1.35, axis: "right", distance: 3.3, speed: 1.05 },
      { right: 5.7, forward: 0.3, width: 1.2, depth: 2.0, axis: "forward", distance: 2.8, speed: 1.35 },
    ],
    stars: [
      { right: -7.9, forward: -5.6 },
      { right: -1.1, forward: 6.2 },
      { right: 4.4, forward: 3.8 },
      { right: 8.2, forward: -2.8 },
    ],
  },
  {
    name: "Trap Gallery",
    size: { right: 22, forward: 18 },
    start: { right: -9, forward: -6.6 },
    goal: { right: 9.1, forward: 6.9, radius: 1.0 },
    walls: [
      { right: 0, forward: -8.95, width: 22, depth: 0.45 },
      { right: 0, forward: 8.95, width: 22, depth: 0.45 },
      { right: -10.95, forward: 0, width: 0.45, depth: 18 },
      { right: 10.95, forward: 0, width: 0.45, depth: 18 },
      { right: -5.9, forward: -2.1, width: 0.5, depth: 6.4 },
      { right: -0.8, forward: 2.4, width: 6.8, depth: 0.5 },
      { right: 4.7, forward: -3.4, width: 0.5, depth: 6.6 },
      { right: 6.8, forward: 3.8, width: 5.6, depth: 0.5 },
    ],
    holes: [
      { right: -8.1, forward: 0.9, radius: 0.9 },
      { right: -2.6, forward: -5.8, radius: 0.85 },
      { right: 2.7, forward: 0.1, radius: 0.95 },
      { right: 8.1, forward: -1.6, radius: 0.88 },
    ],
    movingBlocks: [
      { right: -2.3, forward: -0.8, width: 1.2, depth: 2.6, axis: "right", distance: 3.7, speed: 1.0 },
      { right: 2.2, forward: 5.3, width: 1.5, depth: 1.5, axis: "forward", distance: 3.1, speed: 1.45 },
      { right: 7.3, forward: -5.1, width: 2.4, depth: 1.1, axis: "right", distance: 2.5, speed: 1.7 },
    ],
    stars: [
      { right: -8.4, forward: 6.6 },
      { right: -4.1, forward: -6.8 },
      { right: 1.1, forward: 3.9 },
      { right: 5.6, forward: -6.7 },
      { right: 9.2, forward: 4.2 },
    ],
  },
];

export type Phase = "playing" | "failed" | "advancing" | "complete";

const AUTO_ADVANCE = 0.9;
const FAIL_HOLD = 1.6;
/** PositionFollowCameraRig: azimuth 0.22 pi, lags 0.18 / 0.12 s */
const AZIMUTH = Math.PI * 0.22;

interface LevelView {
  node: number;
  blocks: number[];
  /** holes as (right, forward, radius) and block sizes as (width, depth), for the autopilot */
  holes: Float32Array;
  blockSize: Float32Array;
}

export class MarblePuzzle {
  readonly play: Playset;
  readonly board: MarbleBoard;
  readonly hud = { status: "title" as "title" | "playing" | "gameover", demo: true, phase: "playing" as Phase, level: 0, score: 0, collected: 0, elapsed: 0, complete: false };
  private readonly views: LevelView[] = [];
  private readonly marbleArch: Archetype;
  private readonly starArch: Archetype;
  private readonly bump: Sound;
  private readonly fall: Sound;
  private readonly goal: Sound;
  private readonly win: Sound;
  private readonly lose: Sound;
  private readonly roll: Sound;
  private readonly levelCue: Sound;
  private rollVoice = 0;
  private wait = 0;
  private tick = 0;
  // the autopilot (PlayerAi) between frames
  private waypoint = 0;
  private routeCount = 0;
  private planCooldown = 0;
  private aiX = 0;
  private aiF = 0;

  constructor() {
    const play = createPlayset({ capacity: 64, particles: 300, seed: 20260702 });
    this.play = play;
    this.board = new MarbleBoard(play);
    play.sky(0x000000, 0x000000, 0x000000);
    play.fog(0x000000, 60, 140, 0);
    // HemisphereLight 0xf4fbff / 0x28343b 1.4, the sun 0xfff3d4 2.55 from
    // (-8, 18, -10) in the demo's basis; the fill and rim lights fold into
    // the hemisphere
    play.light({ sun: [-8, 18, 10], sunColor: 0xfff3d4, sunIntensity: 0.8, sky: 0xe8f6ff, ground: 0x3a4a52, ambient: 0.5 });
    play.gravity(0);
    for (const lv of LEVELS) {
      const node = play.place(play.model(V.level(lv)), [0, 0, 0], { static: false, hidden: true });
      const blocks = lv.movingBlocks.map((b) => play.place(play.model(V.movingBlock(b.width, b.depth)), [0, 0, 0], { static: false, hidden: true }));
      this.views.push({
        node,
        blocks,
        holes: new Float32Array(lv.holes.flatMap((h) => [h.right, h.forward, h.radius])),
        blockSize: new Float32Array(lv.movingBlocks.flatMap((b) => [b.width, b.depth])),
      });
    }
    const sparkle = play.emitter({ count: 22, life: 0.6, speed: 3.2, spread: Math.PI, dir: [0, 1, 0], gravity: 0.3, size: [0.2, 0.03], color: [0xffe9a0, 0xffb040], alpha: [1, 0], blend: "add", drag: 1.4 });
    const chime = play.sound(sfx.coin());
    this.marbleArch = play.archetype({ model: play.model(V.marble()), motion: motion.none() });
    this.starArch = play.archetype({
      model: play.model(V.star()), motion: motion.none(), death: sparkle, sounds: { death: chime },
      joints: [joint.spin("spin", "y", 2.3), joint.spin("tumble", "x", 1.1)],
    });
    this.bump = play.sound(sfx.thud());
    this.fall = play.sound({ ...sfx.lose(), freq: 520, to: 90, sustain: 0.3, decay: 0.5 });
    this.goal = play.sound(sfx.checkpoint());
    this.win = play.sound(sfx.win());
    this.lose = play.sound(sfx.hurt());
    this.levelCue = play.sound(sfx.wave());
    this.roll = play.sound({ ...sfx.roll(), volume: 0.5 });

    play.on(EVENT.MARBLE, (_m, _b, data, _x, _y, _z, elapsed) => this.onMarble(data, elapsed));
    play.on(EVENT.PICKUP, (_m, _s, _i, _x, _y, _z, collected) => {
      this.hud.collected = collected;
    });
    play.on(EVENT.HIT, (_m, _b, _w, _x, _y, _z, speed) => this.play.play(this.bump, Math.min(1, speed / 7), 0.9 + Math.min(0.4, speed * 0.03)));
    this.reset(true);
  }

  reset(demo: boolean): void {
    const play = this.play;
    play.clear();
    const hud = this.hud;
    hud.status = demo ? "title" : "playing";
    hud.demo = demo;
    hud.score = 0;
    hud.complete = false;
    if (this.rollVoice <= 0) this.rollVoice = play.loop(this.roll, 0);
    this.loadLevel(0);
  }

  private loadLevel(index: number): void {
    const play = this.play;
    const hud = this.hud;
    hud.level = index;
    hud.phase = "playing";
    hud.collected = 0;
    hud.elapsed = 0;
    this.wait = 0;
    for (let i = 0; i < this.views.length; i++) {
      if (i === index) continue;
      const v = this.views[i];
      play.move(v.node, 0, 0, 0, 0, 0, 0, 1, true);
      for (const b of v.blocks) play.move(b, 0, 0, 0, 0, 0, 0, 1, true);
    }
    const lv = LEVELS[index];
    const view = this.views[index];
    const marble = this.board.load(lv, {
      node: view.node, blockNodes: view.blocks, marble: this.marbleArch, star: this.starArch,
      radius: V.MARBLE_RADIUS, starUp: V.STAR_UP, blockUp: V.BLOCK_UP,
    });
    this.board.phase(MARBLE_PHASE.PLAYING);
    // configureCameraForLevel: distance 0.5 and height 0.58 of the extent
    const extent = Math.max(lv.size.right, lv.size.forward);
    const d = extent * 0.5;
    play.followCamera(marble, {
      offset: [-Math.sin(AZIMUTH) * d, extent * 0.58, Math.cos(AZIMUTH) * d], lookAhead: 0, lookUp: 0.5, heading: false,
      fov: 60, near: 1.5, far: 140, smooth: 1 / 0.18, smoothLook: 1 / 0.12,
    });
    this.waypoint = 0;
    this.routeCount = 0;
    this.planCooldown = 0;
    this.aiX = 0;
    this.aiF = 0;
  }

  private onMarble(data: number, elapsed: number): void {
    const play = this.play;
    const hud = this.hud;
    hud.elapsed = elapsed;
    if (data >= 0) {
      // failLevel: through a hole
      hud.phase = "failed";
      play.play(this.fall, 0.9);
      play.play(this.lose, 0.5);
      return;
    }
    // completeLevel
    const level = 500 + hud.collected * 100 + Math.max(0, Math.round(90 - elapsed) * 5);
    hud.score += level;
    if (hud.level >= LEVELS.length - 1) {
      hud.phase = "complete";
      hud.complete = true;
      play.play(this.win, 0.9);
    } else {
      hud.phase = "advancing";
      play.play(this.goal, 0.9);
    }
    this.wait = 0;
  }

  frame(pad: Pad): void {
    const play = this.play;
    const hud = this.hud;
    const dt = 1 / 60;
    const marble = this.board.marble;
    if (hud.phase === "playing") {
      if (hud.demo) {
        if ((this.tick & 1) === 0) this.autopilot(2 * dt);
        play.steer(marble, this.aiX, this.aiF);
      } else {
        play.steer(marble, pad.x, pad.y);
      }
    } else {
      play.steer(marble, 0, 0);
      this.wait += dt;
      if (hud.phase === "advancing" && this.wait >= AUTO_ADVANCE) {
        play.play(this.levelCue, 0.7);
        this.loadLevel(hud.level + 1);
      } else if ((hud.phase === "failed" && this.wait >= FAIL_HOLD) || (hud.phase === "complete" && this.wait >= FAIL_HOLD)) {
        if (hud.status !== "gameover") hud.status = "gameover";
      }
    }
    play.frame(dt);
    this.tick++;
    if ((this.tick & 3) === 0) {
      // the rolling sound follows the marble's speed on the plate
      const speed = hud.phase === "playing" ? play.ent[marble * 16 + ENT.SPEED] : 0;
      const k = speed > 6 ? 1 : speed / 6;
      play.setLoop(this.rollVoice, k * 0.9, 0.75 + k * 0.6);
      if (hud.phase === "playing") hud.elapsed += 4 * dt;
    }
  }

  /** Silence the roll while the shell pauses or leaves the run. */
  quiet(): void {
    this.play.setLoop(this.rollVoice, 0, 1);
  }

  /** GameBlocks' PlayerAi.steerToward: follow the planned route to the
   *  goal at a speed that falls off near it, pushed away from holes and
   *  moving blocks, as tilt signals. Written for the 3DS interpreter: one
   *  native state read, locals, no allocation. */
  private autopilot(dt: number): void {
    const board = this.board;
    const lv = LEVELS[this.hud.level];
    const st = board.state();
    const mr = st[MARBLE_STATE.RIGHT];
    const mf = st[MARBLE_STATE.FORWARD];
    const vr = st[MARBLE_STATE.VR];
    const vf = st[MARBLE_STATE.VF];
    const gr = lv.goal.right;
    const gf = lv.goal.forward;
    this.planCooldown -= dt;
    if (this.routeCount === 0 || this.planCooldown <= 0) {
      this.routeCount = board.route(gr, gf);
      this.waypoint = 0;
      this.planCooldown = 1.2;
    }
    const path = board.path;
    const n = this.routeCount;
    while (this.waypoint < n - 1) {
      const dr = path[this.waypoint * 2] - mr;
      const df = path[this.waypoint * 2 + 1] - mf;
      if (dr * dr + df * df > 0.58 * 0.58) break;
      this.waypoint++;
    }
    const wr = n > 0 ? path[this.waypoint * 2] : gr;
    const wf = n > 0 ? path[this.waypoint * 2 + 1] : gf;
    const tr = wr - mr;
    const tf = wf - mf;
    const wd = Math.max(0.001, Math.sqrt(tr * tr + tf * tf));
    const goalDistance = Math.sqrt((gr - mr) * (gr - mr) + (gf - mf) * (gf - mf));
    const final = this.waypoint >= n - 1;
    const desired = Math.min(final ? 3.2 : 4.4, Math.max(0.45, (final ? goalDistance : wd) * 1.65));
    const dvr = (tr / wd) * desired;
    const dvf = (tf / wd) * desired;
    // avoidanceVector: holes and the moving blocks' current rectangles
    let ar = 0;
    let af = 0;
    const radius = V.MARBLE_RADIUS;
    const holes = this.views[this.hud.level].holes;
    for (let i = 0; i < holes.length; i += 3) {
      const reach = holes[i + 2] + radius + 1.15;
      const dr = mr - holes[i];
      const df = mf - holes[i + 1];
      const d = Math.sqrt(dr * dr + df * df);
      if (d > 1e-5 && d < reach) {
        const force = ((reach - d) / reach) * 5.4;
        ar += (dr / d) * force;
        af += (df / d) * force;
      }
    }
    const sizes = this.views[this.hud.level].blockSize;
    const blocks = st[MARBLE_STATE.BLOCK_COUNT];
    for (let i = 0; i < blocks; i++) {
      const cr = st[MARBLE_STATE.BLOCKS + i * 2];
      const cf = st[MARBLE_STATE.BLOCKS + i * 2 + 1];
      const hw = sizes[i * 2] * 0.5;
      const hd = sizes[i * 2 + 1] * 0.5;
      const reach = Math.max(hw, hd) + radius + 0.95;
      const qr = mr < cr - hw ? cr - hw : mr > cr + hw ? cr + hw : mr;
      const qf = mf < cf - hd ? cf - hd : mf > cf + hd ? cf + hd : mf;
      let dr = mr - qr;
      let df = mf - qf;
      let d = Math.sqrt(dr * dr + df * df);
      if (d <= 1e-5) {
        // inside: leave by the nearer face
        if (hw - Math.abs(mr - cr) < hd - Math.abs(mf - cf)) {
          dr = mr >= cr ? 1 : -1;
          df = 0;
        } else {
          dr = 0;
          df = mf >= cf ? 1 : -1;
        }
        d = 1;
      }
      if (d < reach) {
        const force = ((reach - d) / reach) * 3.4;
        ar += (dr / d) * force;
        af += (df / d) * force;
      }
    }
    const gain = goalDistance < 1.7 ? 3.3 : 2.2;
    const accelR = (dvr - vr) * gain + ar;
    const accelF = (dvf - vf) * gain + af;
    const sr = accelR / 15.5;
    const sf = accelF / 15.5;
    this.aiX = sr > 1 ? 1 : sr < -1 ? -1 : sr;
    this.aiF = sf > 1 ? 1 : sf < -1 ? -1 : sf;
  }
}

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m < 10 ? "0" : ""}${m}:${s < 10 ? "0" : ""}${s}`;
}

/** The game as the playset shell and the headless runner drive it. */
export function createGame(): PlaysetGame {
  const game = new MarblePuzzle();
  (globalThis as { __playsetGame?: unknown }).__playsetGame = game;
  let paused = false;
  let overAt = -1;
  const hud = game.hud;
  return {
    title: "Marble Puzzle",
    tagline: "Tilt the table to roll the marble to the glowing goal.\nCollect stars; mind the holes and the moving blocks.",
    accent: "#39b27a",
    controls: [
      ["Circle Pad / D-Pad", "Tilt the table"],
      ["Stars", "+100 each"],
      ["START", "Pause"],
      ["Y", "Developer stats"],
      ["SELECT", "Home"],
    ],
    readouts: [
      { label: "Level", value: () => `${hud.level + 1}/${LEVELS.length} ${LEVELS[hud.level].name}` },
      { label: "Time", value: () => clock(hud.elapsed) },
      { label: "Score", value: () => hud.score },
      { label: "Stars", value: () => `${hud.collected}/${LEVELS[hud.level].stars.length}`, bar: () => hud.collected / LEVELS[hud.level].stars.length, color: "#ffd56a" },
      { label: "Time bonus", value: () => Math.max(0, Math.round(90 - hud.elapsed) * 5), bar: () => Math.max(0, 90 - hud.elapsed) / 90, color: "#39e79b" },
    ],
    play: game.play,
    status(): GameStatus {
      if (hud.status === "title") return "title";
      if (hud.status === "gameover") return hud.demo ? "title" : "gameover";
      return paused ? "paused" : "playing";
    },
    start(demo: boolean) {
      paused = false;
      overAt = -1;
      game.reset(demo);
    },
    pause(p: boolean) {
      paused = p;
      if (p) game.quiet();
    },
    frame(pad: Pad) {
      // the attract loop starts over two seconds after a demo run ends
      if (hud.demo && hud.status === "gameover") {
        if (overAt < 0) {
          overAt = game.play.tick;
          game.quiet();
        } else if (game.play.tick - overAt > 120) {
          overAt = -1;
          game.reset(true);
        }
      }
      if (paused) return;
      game.frame(pad);
    },
    topLine: () => `LEVEL ${hud.level + 1}/${LEVELS.length}    STARS ${hud.collected}/${LEVELS[hud.level].stars.length}    ${clock(hud.elapsed)}    SCORE ${hud.score}`,
    result: () => (hud.complete ? `All levels cleared · score ${hud.score}` : `Into a hole on level ${hud.level + 1} · score ${hud.score}`),
  };
}
