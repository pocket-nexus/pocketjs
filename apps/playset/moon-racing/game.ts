// Moon Racing's gameplay over the playset kernels, ported from GameBlocks'
// moon-racing demo (https://gb-moon-racing.vercel.app/, MIT, xt4d/GameBlocks).
//
// What runs where:
//   native, every step — the four rovers (car kernel on the moon's 3.2 m/s²
//     gravity, pitched and rolled to the heightfield), the heightfield they
//     drive on, rover-to-rover pushes, the barrier rails as box colliders, the
//     front-wheel steering joints, the chase camera, the engine hum;
//   here, every frame — RaceCheckpointLapPlay (the countdown, each racer's next
//     gate, laps, finish order), the player's pad, a barrier-impact check on
//     the player's speed;
//   here, on a budget — the race-car AI (race-car-ai.js: WaypointDriver aimed
//     at each racer's next gate) for the three bots and, in the demo, for the
//     player (player-ai.js), every 2nd frame; the stuck-respawn check, every
//     6th frame.
//
// Deviations: the demo's Rapier raycast vehicles are the car kernel with the
// steering limited by speed (a lateral-acceleration cap stands in for tyre
// slip); the AI's corner slowdown reads the corner at the racer's next gate
// (the demo reads its own tracker's index, which mostly lags behind); ties in
// the standings break on the distance to the next gate instead of the racer
// id; the minimap becomes a beacon over the player's next gate and the
// standings readout.

import {
  ENT,
  EVENT,
  createPlayset,
  joint,
  layers,
  motion,
  sfx,
  type Archetype,
  type Playset,
  type Sound,
} from "@pocketjs/framework/playset";
import { BTN } from "@pocketjs/framework/input";
import * as V from "./visuals.ts";
import type { GameStatus, Pad, PlaysetGame } from "../kit/game.ts";

const L = layers("car");

const MOON_GRAVITY = 3.2;
const LAPS = 3;
const START_DELAY = 1.8;
const START_SPAWN_DISTANCE = 11.5;
const START_GRID_SPACING = 8.6;
const START_GRID_LATERAL = 2.5;
const BOT_COUNT = 3;
const BOT_COLORS = [0xd8d9d1, 0xb6bcc2, 0xc3b180];
const STUCK_SPEED = 0.75;
const STUCK_SECONDS = 3;
const MAX_SPEED = 34;
const WHEELBASE = 2.36;
const MAX_STEER = 0.44;
/** lateral acceleration the steering may ask for, m/s² */
const LATERAL_GRIP = 26;

// PHYSICS_AI_DRIVER_CONFIG and the WaypointDriver defaults it leaves alone
const TARGET_SPEED = 32;
const MIN_SPEED = 5.5;
const CORNER_SLOWDOWN = 9;
const STEER_GAIN = 1.7;
const STEER_DEADZONE = 0.16;
const BRAKE_YAW = 0.64;
const ACCEL_ERROR = 0.45;
const BRAKE_ERROR = -0.9;
const DRIVER_STUCK_SPEED = 0.35;
const DRIVER_STUCK_YAW = 1.35;
const DRIVER_STUCK_MS = 900;
const DRIVER_REVERSE_MS = 420;
const AI_EVERY = 2;
const POST_SPACING = 6.75;

export type Status = "title" | "playing" | "gameover";
const STARTING = 0, STARTED = 1, FINISHED = 2;

interface Racer {
  name: string;
  arch: Archetype;
  slot: number;
  spawnX: number;
  spawnZ: number;
  spawnYaw: number;
  laps: number;
  next: number;
  finished: boolean;
  order: number;
  time: number;
  stuck: number;
  respawns: number;
  // WaypointDriver state
  stuckMs: number;
  reverseMs: number;
  // the intents the driver chose
  turn: number;
  fwd: number;
  boost: number;
}

export interface Hud {
  status: Status;
  demo: boolean;
  rank: number;
  lap: number;
  gate: number;
  speed: number;
  time: number;
  countdown: number;
}

const yawOf = (dx: number, dz: number) => Math.atan2(-dx, -dz);

/** WaypointDriver's steering, capped so the rover never asks for more than
 *  LATERAL_GRIP of sideways acceleration at its speed. */
function steerLimit(speed: number): number {
  const v2 = Math.max(speed * speed, 1);
  const angle = Math.atan((LATERAL_GRIP * WHEELBASE) / v2);
  return angle >= MAX_STEER ? 1 : angle / MAX_STEER;
}

export class MoonRacing {
  readonly play: Playset;
  readonly hud: Hud = { status: "title", demo: true, rank: 4, lap: 1, gate: 0, speed: 0, time: 0, countdown: START_DELAY };
  readonly racers: Racer[] = [];
  private readonly cpx: Float32Array;
  private readonly cpz: Float32Array;
  private readonly cpy: Float32Array;
  private readonly corner: Float32Array;
  private readonly heights: Float32Array;
  private raceState = STARTING;
  private countdown = START_DELAY;
  private elapsed = 0;
  private finishCounter = 0;
  private aiTick = 0;
  private lastSpeed = 0;
  private bumpCooldown = 0;
  private note = "";
  private noteTime = 0;
  private beacon = -1;
  private beaconGate = -1;
  private readonly dust: { id: number };
  private readonly sounds: Record<"ready" | "go" | "gate" | "lap" | "win" | "lose" | "thud" | "scrape" | "respawn", Sound>;

  constructor() {
    const play = createPlayset({ capacity: 64, particles: 256, seed: 2026, lod: [10, 6, 12] });
    this.play = play;
    play.sky(V.PALETTE.space, V.PALETTE.space, V.PALETTE.space);
    play.fog(V.PALETTE.space, 145, 395, 1);
    // HemisphereLight(0xe4eaff, 0x202126, 0.58) and the sun at (58, 70, 20)
    play.light({ sun: [58, 70, -20], sunColor: 0xffffff, sunIntensity: 1.68, sky: 0xe4eaff, ground: 0x202126, ambient: 0.58 });
    play.gravity(MOON_GRAVITY);
    play.bounds(-V.WORLD_DRIVE_BOUND, V.WORLD_DRIVE_BOUND, -V.WORLD_DRIVE_BOUND, V.WORLD_DRIVE_BOUND);

    this.heights = V.terrainHeights();
    play.terrain({ size: V.TERRAIN_SIZE, resolution: V.TERRAIN_SAMPLES, height: this.heights, bands: V.TERRAIN_BANDS });

    const n = V.CHECKPOINTS.length;
    this.cpx = new Float32Array(n);
    this.cpz = new Float32Array(n);
    this.cpy = new Float32Array(n);
    this.corner = new Float32Array(V.cornerMagnitudes());
    for (let i = 0; i < n; i++) {
      this.cpx[i] = V.CHECKPOINTS[i][0];
      this.cpz[i] = V.CHECKPOINTS[i][1];
      this.cpy[i] = V.sampleHeights(this.heights, this.cpx[i], this.cpz[i]);
    }
    this.buildTrack();

    this.dust = play.emitter({ count: 26, life: 0.9, speed: 3.5, spread: 1.2, dir: [0, 1, 0], gravity: 0.4, size: [0.5, 1.2], color: [0x9a968c, 0x5e5b55], alpha: [0.8, 0], blend: "alpha", drag: 1.6 });
    this.sounds = {
      ready: play.sound({ ...sfx.select(), freq: 660, sustain: 0.08, volume: 0.3 }),
      go: play.sound({ ...sfx.checkpoint(), freq: 1046, volume: 0.36 }),
      gate: play.sound(sfx.checkpoint()),
      lap: play.sound(sfx.wave()),
      win: play.sound(sfx.win()),
      lose: play.sound(sfx.lose()),
      thud: play.sound(sfx.thud()),
      scrape: play.sound({ ...sfx.hit(), freq: 220, to: 90, volume: 0.3 }),
      respawn: play.sound(sfx.whoosh()),
    };
    const hum = play.sound({ ...sfx.motor(), freq: 92, volume: 0.3 });

    const carMotion = motion.car({
      accel: 9, maxSpeed: MAX_SPEED, reverse: 8, brake: 24, steer: MAX_STEER, steerRate: 5.5,
      grip: 5.5, drag: 0.08, driftGrip: 1.3, wheelbase: WHEELBASE, gravity: 1, boost: 1.6,
    });
    const archFor = (paint: number, accent: number | null) =>
      play.archetype({
        model: play.model(V.rover({ paint, accent })),
        motion: carMotion,
        layer: L.car, hits: L.car, solid: true, mass: 1, radius: 1.45, height: 1.2,
        ground: "gravity", groundOffset: V.ROVER_RIDE_HEIGHT, alignGround: true, shadow: 1.7, bounds: "clamp",
        joints: [joint.steer("fl", 1), joint.steer("fr", 1)],
        hum: accent !== null ? { sound: hum, speed: MAX_SPEED, pitch: 2.6 } : undefined,
      });
    // the player starts at the back of the grid, the bots ahead of it
    const grid = (index: number): [number, number, number] => {
      const distance = START_SPAWN_DISTANCE + index * START_GRID_SPACING;
      const lateral = (index % 2 === 0 ? -1 : 1) * START_GRID_LATERAL;
      const [x0, z0] = V.CHECKPOINTS[0];
      const [xp, zp] = V.CHECKPOINTS[n - 1];
      const len = Math.hypot(x0 - xp, z0 - zp);
      const fx = (x0 - xp) / len, fz = (z0 - zp) / len;
      const yaw = yawOf(fx, fz);
      const rx = Math.cos(yaw), rz = -Math.sin(yaw);
      return [x0 - fx * distance + rx * lateral, z0 - fz * distance + rz * lateral, yaw];
    };
    const racer = (name: string, arch: Archetype, at: [number, number, number]): Racer => ({
      name, arch, slot: -1, spawnX: at[0], spawnZ: at[1], spawnYaw: at[2], laps: 0, next: 0, finished: false, order: 0, time: 0,
      stuck: 0, respawns: 0, stuckMs: 0, reverseMs: 0, turn: 0, fwd: 0, boost: 0,
    });
    this.racers.push(racer("You", archFor(0xf1f2e8, 0x94c8ff), grid(BOT_COUNT)));
    for (let i = 0; i < BOT_COUNT; i++) this.racers.push(racer(`Bot ${i + 1}`, archFor(BOT_COLORS[i], null), grid(i)));

    play.rule(L.car, L.car, { event: true });
    play.on(EVENT.HIT, (_a, _b, _rule, x, y, z) => {
      if (this.bumpCooldown > 0) return;
      this.bumpCooldown = 0.35;
      play.play(this.sounds.thud, 0.8, 1, [x, y, z]);
    });

    this.reset(true);
  }

  private buildTrack(): void {
    const play = this.play;
    const n = V.CHECKPOINTS.length;
    // the road strip, one model per segment so each culls on its own
    for (let i = 0; i < n; i++) {
      const [ax, az] = V.CHECKPOINTS[i];
      const [bx, bz] = V.CHECKPOINTS[(i + 1) % n];
      const mid: [number, number] = [(ax + bx) / 2, (az + bz) / 2];
      play.place(play.model(V.roadSegment(i, this.heights, mid)), [mid[0], 0, mid[1]]);
    }
    // checkpoint gates across the road, facing along the track
    for (let i = 0; i < n; i++) {
      const [px, pz] = V.CHECKPOINTS[(i - 1 + n) % n];
      const [nx, nz] = V.CHECKPOINTS[(i + 1) % n];
      play.place(play.model(V.checkpointGate(i)), [this.cpx[i], this.cpy[i] + 0.02, this.cpz[i]], { yaw: yawOf(nx - px, nz - pz) });
    }
    this.beaconModel = play.model(V.nextGateBeacon());
    // barriers: posts every 6.75 m and one rail per segment, both sides
    const post = play.model(V.barrierPost());
    for (const side of [1, -1]) {
      const path = V.offsetPath(V.BARRIER_OFFSET, side);
      for (let i = 0; i < n; i++) {
        const [ax, az] = path[i];
        const [bx, bz] = path[(i + 1) % n];
        const len = Math.hypot(bx - ax, bz - az);
        const yaw = yawOf(bx - ax, bz - az);
        const mx = (ax + bx) / 2, mz = (az + bz) / 2;
        const my = V.sampleHeights(this.heights, mx, mz);
        play.place(play.model(V.barrierRail(len)), [mx, my + 0.02, mz], { yaw });
        play.colliderBox([mx, my + V.BARRIER_HEIGHT * 0.5, mz], [0.2, V.BARRIER_HEIGHT * 0.5, len / 2], yaw);
        const posts = Math.max(1, Math.floor(len / POST_SPACING));
        for (let k = 0; k < posts; k++) {
          const t = (k * POST_SPACING) / len;
          const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
          play.place(post, [x, V.sampleHeights(this.heights, x, z) + 0.02, z]);
        }
      }
    }
    const rockModel = play.model(V.rock());
    for (const r of V.rockPlacements()) {
      // the demo scales the rock unevenly; the playset scales a node evenly,
      // so the rock takes the mean and keeps the demo's rotation
      const s = (r.sx + r.sy + r.sz) / 3;
      play.place(rockModel, [r.x, V.sampleHeights(this.heights, r.x, r.z) + 0.22 * r.sy, r.z], { yaw: r.ry, pitch: r.rx, roll: r.rz, scale: s });
    }
    for (const s of V.starSectors(8)) play.place(play.model(s.model), s.at);
  }
  private beaconModel!: ReturnType<Playset["model"]>;

  reset(demo: boolean): void {
    const play = this.play;
    play.clear();
    this.hud.status = demo ? "title" : "playing";
    this.hud.demo = demo;
    this.raceState = STARTING;
    this.countdown = START_DELAY;
    this.elapsed = 0;
    this.finishCounter = 0;
    this.aiTick = 0;
    this.note = "";
    this.noteTime = 0;
    for (const r of this.racers) {
      r.slot = play.spawn(r.arch, r.spawnX, V.sampleHeights(this.heights, r.spawnX, r.spawnZ) + V.ROVER_RIDE_HEIGHT + 0.1, r.spawnZ, r.spawnYaw);
      r.laps = 0;
      r.next = 0;
      r.finished = false;
      r.order = 0;
      r.time = 0;
      r.stuck = 0;
      r.respawns = 0;
      r.stuckMs = 0;
      r.reverseMs = 0;
      r.turn = 0;
      r.fwd = 0;
      r.boost = 0;
    }
    const player = this.racers[0].slot;
    if (this.beacon < 0) this.beacon = play.place(this.beaconModel, [0, -50, 0], { static: false });
    this.beaconGate = -1;
    this.moveBeacon();
    // PoseFollowCameraRig: 8.2 m behind, 3.1 m up, looking 1.2 m ahead
    play.followCamera(player, { offset: [0, 3.1, 8.2], lookAhead: 1.2, lookUp: 1.1, heading: true, fov: 66, near: 0.3, far: 400, smooth: 9, smoothLook: 12 });
    play.play(this.sounds.ready, 0.9);
    this.lastSpeed = 0;
  }

  private moveBeacon(): void {
    const r = this.racers[0];
    const gate = r.finished ? -1 : r.next;
    if (gate === this.beaconGate) return;
    this.beaconGate = gate;
    if (gate < 0) this.play.move(this.beacon, 0, -50, 0, 0, 0, 0, 1, true);
    else this.play.move(this.beacon, this.cpx[gate], this.cpy[gate] + 7.2, this.cpz[gate]);
  }

  private say(text: string, seconds = 2.2): void {
    this.note = text;
    this.noteTime = seconds;
  }

  /** One frame: the countdown, the drivers, the native step, the gates. */
  frame(pad: Pad): void {
    const play = this.play;
    const dt = 1 / 60;
    const live = this.hud.status === "playing" || (this.hud.status === "title" && this.hud.demo);
    const racers = this.racers;
    if (live) {
      if (this.raceState === STARTING) {
        this.countdown -= dt;
        if (this.countdown <= 0) {
          this.raceState = STARTED;
          this.elapsed = -this.countdown;
          play.play(this.sounds.go, 1);
          this.say("GO", 1.2);
        }
      } else if (this.raceState === STARTED) this.elapsed += dt;
      const started = this.raceState !== STARTING;
      // the drivers think every 2nd frame; their intents hold in the INTENT
      // view in between, so only the pad writes every frame
      const first = this.hud.demo ? 0 : 1;
      if (this.aiTick++ % AI_EVERY === 0) {
        for (let i = first; i < racers.length; i++) {
          const r = racers[i];
          this.drive(r, started);
          play.steer(r.slot, 0, r.fwd, r.turn);
          play.buttons(r.slot, 0, 0, 0, r.boost);
        }
      }
      if (!this.hud.demo) {
        const r = racers[0];
        this.manual(r, pad, started);
        play.steer(r.slot, 0, r.fwd, r.turn);
        play.buttons(r.slot, 0, 0, pad.held & (BTN.RTRIGGER | BTN.LTRIGGER) ? 1 : 0, 0);
      }
    } else {
      for (let i = 0; i < racers.length; i++) {
        play.steer(racers[i].slot, 0, 0, 0);
        play.buttons(racers[i].slot, 0);
      }
    }
    this.bumpCooldown -= dt;
    play.frame(dt);
    if (live && this.raceState === STARTED) this.gates();
    if (live && this.aiTick % 6 === 0) this.stuckCheck();
    // a sudden loss of speed is the player meeting a rail or a rover
    const ent = play.ent;
    const o = racers[0].slot * 16;
    const speed = Math.sqrt(ent[o + 3] * ent[o + 3] + ent[o + 5] * ent[o + 5]);
    if (this.lastSpeed - speed > 2.4 && this.bumpCooldown <= 0) {
      this.bumpCooldown = 0.3;
      play.play(this.sounds.scrape, Math.min(1, (this.lastSpeed - speed) / 8), 1, [ent[o], ent[o + 1], ent[o + 2]]);
    }
    this.lastSpeed = speed;
    if (this.noteTime > 0) this.noteTime -= dt;
    const hud = this.hud;
    hud.speed = speed;
    hud.time = this.elapsed;
    hud.countdown = this.countdown;
    hud.lap = Math.min(LAPS, racers[0].laps + 1);
    hud.gate = racers[0].next;
  }

  /** The pad as DynamicCarMotionController controls. */
  private manual(r: Racer, pad: Pad, started: boolean): void {
    if (!started) {
      r.turn = 0;
      r.fwd = 0;
      return;
    }
    const throttle = pad.held & BTN.CIRCLE || pad.y > 0.35 ? 1 : 0;
    const brake = pad.held & BTN.CROSS || pad.y < -0.35 ? 1 : 0;
    r.fwd = throttle - brake;
    r.turn = pad.x * steerLimit(this.lastSpeed);
    r.boost = 0;
  }

  /** race-car-ai.js: WaypointDriver.step toward the racer's next gate. */
  private drive(r: Racer, started: boolean): void {
    if (!started || r.finished) {
      // neutral controls brake; a rover at rest just holds still
      r.turn = 0;
      r.fwd = r.finished && this.lastSpeedOf(r) > 1 ? -1 : 0;
      r.boost = 0;
      return;
    }
    const ent = this.play.ent;
    const o = r.slot * 16;
    const x = ent[o], z = ent[o + 2], yaw = ent[o + 6];
    const vx = ent[o + 3], vz = ent[o + 5];
    const speed = Math.sqrt(vx * vx + vz * vz);
    const g = r.next;
    let dx = this.cpx[g] - x;
    let dz = this.cpz[g] - z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-6) {
      r.turn = 0;
      r.fwd = 0;
      r.boost = 0;
      return;
    }
    dx /= len;
    dz /= len;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    let dot = fx * dx + fz * dz;
    dot = dot < -1 ? -1 : dot > 1 ? 1 : dot;
    // the target is to the right when it lies on the right vector's side
    const side = Math.cos(yaw) * dx - Math.sin(yaw) * dz;
    const yawError = Math.acos(dot) * (side >= 0 ? 1 : -1);
    let steer = yawError * STEER_GAIN;
    steer = steer < -1 ? -1 : steer > 1 ? 1 : steer;
    let desired = TARGET_SPEED - this.corner[g] * CORNER_SLOWDOWN;
    desired = desired < MIN_SPEED ? MIN_SPEED : desired > TARGET_SPEED ? TARGET_SPEED : desired;
    const speedError = desired - speed;
    const dtMs = (1000 / 60) * AI_EVERY;
    const absYaw = yawError < 0 ? -yawError : yawError;
    if (speed <= DRIVER_STUCK_SPEED && absYaw >= DRIVER_STUCK_YAW) {
      r.stuckMs += dtMs;
      if (r.stuckMs >= DRIVER_STUCK_MS) {
        r.reverseMs = DRIVER_REVERSE_MS;
        r.stuckMs = 0;
      }
    } else r.stuckMs = Math.max(0, r.stuckMs - dtMs * 2);
    const limit = steerLimit(speed);
    if (r.reverseMs > 0) {
      r.reverseMs = Math.max(0, r.reverseMs - dtMs);
      // reversing: the wheel turns the other way
      r.turn = (steer < -STEER_DEADZONE ? 1 : 0) - (steer > STEER_DEADZONE ? 1 : 0);
      r.fwd = -1;
      r.boost = 0;
      return;
    }
    const brake = (absYaw >= BRAKE_YAW && speed > desired * 0.7) || speedError <= BRAKE_ERROR;
    const throttle = speedError >= ACCEL_ERROR && !brake;
    r.turn = ((steer > STEER_DEADZONE ? 1 : 0) - (steer < -STEER_DEADZONE ? 1 : 0)) * limit;
    r.fwd = throttle ? 1 : brake ? -1 : 0;
    r.boost = throttle && steer > -0.15 && steer < 0.15 ? 1 : 0;
  }

  private lastSpeedOf(r: Racer): number {
    const ent = this.play.ent;
    const o = r.slot * 16;
    return Math.sqrt(ent[o + 3] * ent[o + 3] + ent[o + 5] * ent[o + 5]);
  }

  /** RaceCheckpointLapPlay._stepPlayer for every racer. */
  private gates(): void {
    const ent = this.play.ent;
    const racers = this.racers;
    const r2 = V.CHECKPOINT_RADIUS * V.CHECKPOINT_RADIUS;
    const count = this.cpx.length;
    let all = true;
    for (let i = 0; i < racers.length; i++) {
      const r = racers[i];
      if (r.finished) continue;
      all = false;
      const o = r.slot * 16;
      const g = r.next;
      const dx = ent[o] - this.cpx[g], dy = ent[o + 1] - this.cpy[g], dz = ent[o + 2] - this.cpz[g];
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      r.next = g + 1;
      if (r.next < count) {
        if (i === 0) this.play.play(this.sounds.gate, 0.8);
        if (i === 0) this.moveBeacon();
        continue;
      }
      r.next = 0;
      r.laps += 1;
      if (r.laps < LAPS) {
        if (i === 0) {
          this.play.play(this.sounds.lap, 0.9);
          this.say(`LAP ${r.laps} COMPLETE`);
          this.moveBeacon();
        }
        continue;
      }
      this.finishCounter += 1;
      r.finished = true;
      r.order = this.finishCounter;
      r.time = this.elapsed;
      if (i === 0) {
        this.moveBeacon();
        this.play.play(r.order === 1 ? this.sounds.win : this.sounds.lose, 1);
        this.say(`FINISHED P${r.order}`, 4);
        if (!this.hud.demo) this.hud.status = "gameover";
        else this.demoOver = this.play.tick;
      }
    }
    if (all) this.raceState = FINISHED;
  }
  /** the tick the demo's race ended on, -1 while it runs */
  demoOver = -1;

  /** updateStuckRespawns: a racer slower than 0.75 m/s for 3 s goes back to
   *  the last gate it passed, facing the next. */
  private stuckCheck(): void {
    if (this.raceState !== STARTED) return;
    const ent = this.play.ent;
    const count = this.cpx.length;
    for (let i = 0; i < this.racers.length; i++) {
      const r = this.racers[i];
      if (r.finished || this.lastSpeedOf(r) > STUCK_SPEED) {
        r.stuck = 0;
        continue;
      }
      r.stuck += 0.1;
      if (r.stuck < STUCK_SECONDS) continue;
      r.stuck = 0;
      r.respawns += 1;
      const passed = r.laps > 0 || r.next > 0;
      const last = (r.next - 1 + count) % count;
      let x = r.spawnX, z = r.spawnZ, yaw = r.spawnYaw;
      if (passed) {
        x = this.cpx[last];
        z = this.cpz[last];
        yaw = yawOf(this.cpx[r.next] - x, this.cpz[r.next] - z);
      }
      const o = r.slot * 16;
      ent[o] = x;
      ent[o + 1] = V.sampleHeights(this.heights, x, z) + V.ROVER_RIDE_HEIGHT + 0.3;
      ent[o + 2] = z;
      ent[o + 3] = 0;
      ent[o + 4] = 0;
      ent[o + 5] = 0;
      ent[o + ENT.YAW] = yaw;
      r.stuckMs = 0;
      r.reverseMs = 0;
      this.play.burst(this.dust, x, ent[o + 1], z);
      if (i === 0) {
        this.play.play(this.sounds.respawn, 0.8);
        this.say("RESPAWNED");
      }
    }
  }

  /** 1-based place: finish order, then laps, then gates, then distance to the
   *  next gate. */
  rankOf(index: number): number {
    const racers = this.racers;
    const me = racers[index];
    let ahead = 0;
    for (let i = 0; i < racers.length; i++) {
      if (i === index) continue;
      const r = racers[i];
      if (me.finished || r.finished) {
        if (r.finished && (!me.finished || r.order < me.order)) ahead++;
        continue;
      }
      if (r.laps !== me.laps) {
        if (r.laps > me.laps) ahead++;
        continue;
      }
      if (r.next !== me.next) {
        if (r.next > me.next) ahead++;
        continue;
      }
      if (this.gateDistance(r) < this.gateDistance(me)) ahead++;
    }
    return ahead + 1;
  }

  private gateDistance(r: Racer): number {
    const ent = this.play.ent;
    const o = r.slot * 16;
    const dx = ent[o] - this.cpx[r.next], dz = ent[o + 2] - this.cpz[r.next];
    return dx * dx + dz * dz;
  }

  get raceStarted(): boolean {
    return this.raceState !== STARTING;
  }

  get noteText(): string {
    return this.noteTime > 0 ? this.note : "";
  }
}

const clock = (s: number) => {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? "0" : ""}${r.toFixed(1)}`;
};

/** The game as the playset shell and the headless runner drive it. */
export function createGame(): PlaysetGame {
  const game = new MoonRacing();
  (globalThis as { __playsetGame?: unknown }).__playsetGame = game;
  let paused = false;
  const gates = V.CHECKPOINTS.length;
  return {
    title: "Moon Racing",
    tagline: "Three laps over the lunar regolith.\nClear every gate and beat the rover field.",
    accent: "#8a9bb8",
    controls: [
      ["Circle Pad / D-Pad", "Steer, throttle, brake"],
      ["A / B", "Throttle / brake"],
      ["L / R", "Handbrake"],
      ["START", "Pause"],
      ["SELECT", "Home"],
    ],
    readouts: [
      { label: "Position", value: () => `P${game.rankOf(0)} / ${game.racers.length}` },
      { label: "Lap", value: () => `${game.hud.lap} / ${LAPS}`, bar: () => (game.racers[0].laps * gates + game.racers[0].next) / (LAPS * gates), color: "#d7c06f" },
      { label: "Gate", value: () => `${game.hud.gate + 1} / ${gates}`, bar: () => game.hud.gate / gates, color: "#94c8ff" },
      { label: "Speed", value: () => `${Math.round(game.hud.speed)} m/s`, bar: () => game.hud.speed / MAX_SPEED, color: "#8bff7a" },
      { label: "Time", value: () => (game.raceStarted ? clock(game.hud.time) : `start in ${Math.max(0, game.hud.countdown).toFixed(1)}`) },
    ],
    play: game.play,
    status(): GameStatus {
      if (game.hud.status === "title") return "title";
      if (game.hud.status === "gameover") return "gameover";
      return paused ? "paused" : "playing";
    },
    start(demo: boolean) {
      paused = false;
      game.demoOver = -1;
      game.reset(demo);
    },
    pause(p: boolean) {
      paused = p;
    },
    frame(pad: Pad) {
      // the attract loop starts a new race four seconds after the demo's ends
      if (game.hud.demo && game.demoOver >= 0 && game.play.tick - game.demoOver > 240) {
        game.demoOver = -1;
        game.reset(true);
      }
      if (paused) return;
      game.frame(pad);
    },
    topLine: () => {
      const note = game.noteText;
      if (!game.raceStarted) return `READY   ${Math.max(0, game.hud.countdown).toFixed(1)}`;
      const head = `P${game.rankOf(0)}/${game.racers.length}   LAP ${game.hud.lap}/${LAPS}   GATE ${game.hud.gate + 1}/${gates}`;
      return `${head}   ${note || `${Math.round(game.hud.speed)} m/s`}`;
    },
    result: () => {
      const r = game.racers[0];
      return `${r.order === 1 ? "Win" : "Loss"} · finished P${r.order} in ${clock(r.time)}`;
    },
  };
}
