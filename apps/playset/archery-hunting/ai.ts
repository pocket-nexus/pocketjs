// ported from GameBlocks' archery-hunting (https://gb-archery-hunting.vercel.app/src/player-ai.js, MIT, xt4d/GameBlocks)
//
// The demo's PlayerAI: pick the best target the eye can see, walk into range
// crouched, swing the bow onto where the target will be, hold the draw the
// distance asks for and loose. It is also the title screen's backdrop.
//
// Written for the 3DS interpreter: no allocation, the choice and the shot
// solution each every 6th step on alternate phases, the aim every step.
// Deviations: the ballistic solution is closed-form (the quartic in flight
// time under gravity and wind) instead of a 97-step search; the choice tests
// sight for the three best-scoring targets, not all of them; sight against
// the terrain steps every 4 m instead of every 2.3 m, and trees and rocks
// come from a 12 m grid; animals are predicted along their velocity.

import { EYE, T_ANIMAL, T_CREATURE, T_RING, TARGET_SHAPE, terrainHeight } from "./visuals.ts";
import type { ArcheryHunting } from "./game.ts";

const DT = 1 / 60;
/** aimAtPoint: 1 - 0.018^dt and 1 - 0.024^dt at 60 Hz */
const K_AIM = 1 - Math.pow(0.018, DT);
const K_TURN = 1 - Math.pow(0.024, DT);
const YAW_STEP = 2.75 * DT;
const PITCH_STEP = 2.1 * DT;
const PITCH_MAX = 1.1;
const GRAVITY = 9.8;

export class Autopilot {
  /** controls for the hunter: -1..1 walk, and three holds */
  forward = 0;
  crouch = false;
  sprint = false;
  drawing = false;

  private target = -1;
  private shooting = false;
  private aimReady = false;
  private aimHold = 0;
  private fireCooldown = 0.65;
  private canShoot = false;
  private shotDraw = 1;
  private distance = 0;
  private yawError = 0;
  private aligned = false;
  private tick = 0;
  // the smoothed aim point and the point it eases toward
  private ax = 0;
  private ay = 0;
  private az = 0;
  private wx = 0;
  private wy = 0;
  private wz = 0;
  // results of predict() and solve()
  private px = 0;
  private py = 0;
  private pz = 0;
  private dx = 0;
  private dy = 0;
  private dz = 0;
  private flight = 0;
  private readonly scores = new Float32Array(16);
  private readonly checked = new Uint8Array(16);
  private readonly f = new Float32Array(9);

  constructor(private readonly game: ArcheryHunting) {}

  reset(): void {
    this.target = -1;
    this.shooting = false;
    this.aimReady = false;
    this.aimHold = 0;
    this.fireCooldown = 0.65;
    this.drawing = false;
    this.forward = 0;
    this.crouch = false;
    this.sprint = false;
    this.tick = 0;
  }

  step(): void {
    const g = this.game;
    this.fireCooldown = Math.max(0, this.fireCooldown - DT);
    const phase = this.tick++ % 6;
    if (phase === 0) this.choose();
    else if (phase === 3 && this.target >= 0 && this.shooting) this.resolve();
    const t = this.target;
    if (t < 0 || !g.tAlive[t]) {
      this.target = -1;
      this.forward = 0;
      this.drawing = false;
      this.sprint = false;
      this.aimHold = 0;
      return;
    }
    this.aim();
    const hud = g.hud;
    const draw = hud.draw;
    if (!this.shooting) {
      // steerCloserToTarget
      const animal = g.tType[t] === T_ANIMAL;
      const facing = Math.abs(this.yawError) < 0.65;
      const want = animal ? 28 : 24;
      this.forward = facing ? (this.distance > want ? 1 : this.distance < 10 ? -1 : 0) : 0;
      this.sprint = this.distance > 44 && facing && !animal;
      this.crouch = this.distance < want + 8 || animal;
      this.drawing = false;
      this.aimHold = 0;
      return;
    }
    // steerTowardTarget
    const range = g.tType[t] === T_CREATURE ? 58 : g.tType[t] === T_ANIMAL ? 46 : 52;
    const facing = Math.abs(this.yawError) < 0.55;
    this.forward = facing && draw < 0.2 ? (this.distance > range ? 1 : this.distance < 14 ? -1 : 0) : 0;
    this.sprint = false;
    this.crouch = this.distance < range + 8 || draw > 0.2;
    this.canShoot = hud.ammo > 0 && this.fireCooldown <= 0 && (this.distance <= range || hud.timer < 24);
    this.drawing = this.canShoot;
    this.aimHold = this.canShoot && this.aligned ? this.aimHold + DT : 0;
    if (this.canShoot && this.aimHold > 0.12 && draw >= this.shotDraw) {
      this.drawing = false;
      const time = this.fire(t);
      this.aimHold = 0;
      this.aimReady = false;
      if (time >= 0) {
        this.fireCooldown = Math.max(0.75, time + 0.35);
        this.target = -1;
      } else {
        this.fireCooldown = 0.2;
      }
    }
  }

  /** chooseTarget, or chooseApproachTarget when none is in sight. */
  private choose(): void {
    const g = this.game;
    const ent = g.play.ent;
    const p = g.player * 16;
    const ex = ent[p], ey = ent[p + 1] + EYE, ez = ent[p + 2];
    const n = g.targetCount;
    const scores = this.scores;
    const checked = this.checked;
    let alive = 0;
    for (let t = 0; t < n; t++) {
      checked[t] = 0;
      if (!g.tAlive[t]) continue;
      alive++;
      this.predict(t, 0);
      const d = Math.hypot(this.px - ent[p], this.py - ent[p + 1], this.pz - ent[p + 2]);
      const type = g.tType[t];
      scores[t] = d + g.tAlert[t] * 5 + (type === T_CREATURE ? -8 : type === T_ANIMAL ? -4 : 0);
    }
    if (alive === 0) {
      this.target = -1;
      return;
    }
    // the best-scoring targets in order, until one is in sight
    let best = -1;
    let bestScore = 1e9;
    for (let k = 0; k < 3; k++) {
      let pick = -1;
      let low = 1e9;
      for (let t = 0; t < n; t++) {
        if (g.tAlive[t] && !checked[t] && scores[t] < low) {
          low = scores[t];
          pick = t;
        }
      }
      if (pick < 0) break;
      checked[pick] = 1;
      this.predict(pick, 0);
      if (this.sight(ex, ey, ez, this.px, this.py, this.pz)) {
        best = pick;
        bestScore = low;
        break;
      }
    }
    const current = this.target;
    if (best >= 0 && current >= 0 && current !== best && this.shooting && g.tAlive[current] && scores[current] <= bestScore + 9) {
      this.predict(current, 0);
      if (this.sight(ex, ey, ez, this.px, this.py, this.pz)) best = current;
    }
    if (best >= 0) {
      if (best !== this.target || !this.shooting) this.aimReady = false;
      this.target = best;
      this.shooting = true;
      this.predict(best, 0);
      this.distance = Math.hypot(this.px - ent[p], this.py - ent[p + 1], this.pz - ent[p + 2]);
      this.wx = this.px;
      this.wy = this.py;
      this.wz = this.pz;
      return;
    }
    // approach: the nearest by distance and kind, aiming a little low
    let approach = -1;
    let low = 1e9;
    for (let t = 0; t < n; t++) {
      if (!g.tAlive[t]) continue;
      const type = g.tType[t];
      const s = scores[t] - g.tAlert[t] * 5 + (type === T_CREATURE ? -2 : 0);
      if (s < low) {
        low = s;
        approach = t;
      }
    }
    if (approach !== this.target || this.shooting) this.aimReady = false;
    this.target = approach;
    this.shooting = false;
    this.predict(approach, 0);
    this.wx = this.px;
    this.wy = this.py - 0.65;
    this.wz = this.pz;
    this.distance = Math.hypot(this.wx - ent[p], this.wy - ent[p + 1], this.wz - ent[p + 2]);
  }

  /** resolveShot: the draw the distance asks for and where to look so the
   *  arrow meets the target; a target behind cover sends the hunter walking. */
  private resolve(): void {
    const g = this.game;
    const ent = g.play.ent;
    const p = g.player * 16;
    const t = this.target;
    this.predict(t, 0);
    const d = Math.hypot(this.px - ent[p], this.py - ent[p + 1], this.pz - ent[p + 2]);
    this.distance = d;
    const draw = Math.max(0.94, Math.min(1, 0.86 + d / 180));
    this.shotDraw = draw;
    const ex = ent[p], ey = ent[p + 1] + EYE, ez = ent[p + 2];
    if (!this.solve(t, ex, ey, ez, 24 + draw * 44)) return;
    if (!this.sight(ex, ey, ez, this.px, this.py, this.pz)) {
      this.shooting = false;
      return;
    }
    this.wx = this.px;
    this.wy = this.py;
    this.wz = this.pz;
  }

  /** fireArrow: solve from the muzzle at this draw's speed and loose; the
   *  flight time, or -1 when the shot is blocked. */
  private fire(t: number): number {
    const g = this.game;
    const hud = g.hud;
    if (!g.tAlive[t] || hud.ammo <= 0 || hud.draw < 0.12) return -1;
    const f = this.f;
    g.shotFrame(f);
    const speed = 24 + hud.draw * 44;
    if (!this.solve(t, f[6], f[7], f[8], speed)) return -1;
    if (!this.sight(f[6], f[7], f[8], this.px, this.py, this.pz)) return -1;
    return g.launch(this.dx, this.dy, this.dz, speed) ? this.flight : -1;
  }

  /** aimAtPoint: ease the aim point, then turn the hunter toward it at
   *  most 2.75 rad/s in yaw and 2.1 in pitch. */
  private aim(): void {
    const g = this.game;
    const ent = g.play.ent;
    const p = g.player * 16;
    if (!this.aimReady) {
      this.ax = this.wx;
      this.ay = this.wy;
      this.az = this.wz;
      this.aimReady = true;
    } else {
      this.ax += (this.wx - this.ax) * K_AIM;
      this.ay += (this.wy - this.ay) * K_AIM;
      this.az += (this.wz - this.az) * K_AIM;
    }
    const ox = this.ax - ent[p], oy = this.ay - ent[p + 1] - EYE, oz = this.az - ent[p + 2];
    const wantYaw = Math.atan2(-ox, -oz);
    const wantPitch = Math.atan2(oy, Math.max(0.001, Math.hypot(ox, oz)));
    const yaw = ent[p + 6];
    const pitch = ent[p + 7];
    const yawErr = wrap(wantYaw - yaw);
    const yawStep = clamp(yawErr * K_TURN, -YAW_STEP, YAW_STEP);
    const pitchStep = clamp((wantPitch - pitch) * K_TURN, -PITCH_STEP, PITCH_STEP);
    const nextYaw = wrap(yaw + yawStep);
    const nextPitch = clamp(pitch + pitchStep, -PITCH_MAX, PITCH_MAX);
    ent[p + 6] = nextYaw;
    ent[p + 7] = nextPitch;
    this.yawError = wrap(wantYaw - nextYaw);
    this.aligned = Math.abs(this.yawError) < 0.026 && Math.abs(wantPitch - nextPitch) < 0.026;
  }

  /** sampleWeakSpot `ahead` seconds from now into (px, py, pz): a ring on
   *  its figure-eight, an animal along its velocity. */
  private predict(t: number, ahead: number): void {
    const g = this.game;
    const type = g.tType[t];
    let x: number, z: number;
    if (type === T_RING) {
      const time = g.elapsed + ahead;
      x = g.ringX(t, time);
      z = g.ringZ(t, time);
    } else {
      const o = g.tSlot[t] * 16;
      const ent = g.play.ent;
      x = ent[o] + ent[o + 3] * ahead;
      z = ent[o + 2] + ent[o + 5] * ahead;
    }
    this.px = x;
    this.py = terrainHeight(x, z) + TARGET_SHAPE[type].weak;
    this.pz = z;
  }

  /** solveBallisticTarget: the low arc from (sx, sy, sz) at `speed` under
   *  gravity and wind onto the target where it will be, refined three
   *  times for its motion. Leaves the point in p*, the direction in d* and
   *  the flight time; false when out of reach. */
  private solve(t: number, sx: number, sy: number, sz: number, speed: number): boolean {
    const wind = this.game.currentWind() * 0.38;
    // acceleration (wind, -g, 0)
    const aa = wind * wind + GRAVITY * GRAVITY;
    const s2 = speed * speed;
    let time = 0;
    for (let i = 0; i < 4; i++) {
      this.predict(t, time);
      const rx = this.px - sx, ry = this.py - sy, rz = this.pz - sz;
      // |r - a u / 2|^2 = s^2 u, u = time^2:  aa/4 u^2 - (r.a + s^2) u + |r|^2 = 0
      const ra = rx * wind - ry * GRAVITY;
      const b = ra + s2;
      const rr = rx * rx + ry * ry + rz * rz;
      const disc = b * b - aa * rr;
      if (disc < 0) return false;
      const u = (b - Math.sqrt(disc)) / (aa * 0.5);
      time = Math.sqrt(Math.max(u, 1e-6));
    }
    const u = time * time;
    const vx = (this.px - sx - 0.5 * wind * u) / time;
    const vy = (this.py - sy + 0.5 * GRAVITY * u) / time;
    const vz = (this.pz - sz) / time;
    const l = Math.hypot(vx, vy, vz) || 1;
    this.dx = vx / l;
    this.dy = vy / l;
    this.dz = vz / l;
    this.flight = time;
    return true;
  }

  /** hasLineOfSight: the terrain under the segment and the trunks and rocks
   *  beside it. */
  private sight(sx: number, sy: number, sz: number, tx: number, ty: number, tz: number): boolean {
    const dx = tx - sx, dy = ty - sy, dz = tz - sz;
    const length = Math.hypot(dx, dy, dz);
    const steps = Math.max(4, Math.min(24, Math.ceil(length / 4)));
    for (let i = 1; i < steps; i++) {
      const k = i / steps;
      const x = sx + dx * k, z = sz + dz * k;
      if (sy + dy * k < terrainHeight(x, z) + 0.16) return false;
    }
    const g = this.game;
    const len2 = dx * dx + dz * dz;
    if (len2 < 1e-4) return true;
    const cells = g.blockCells, items = g.blockItems;
    const bx = g.blockX, bz = g.blockZ, br = g.blockR, bb = g.blockBase, bt = g.blockTop;
    const x0 = cell(Math.min(sx, tx)), x1 = cell(Math.max(sx, tx));
    const z0 = cell(Math.min(sz, tz)), z1 = cell(Math.max(sz, tz));
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const c = cz * 15 + cx;
        for (let k = cells[c], end = cells[c + 1]; k < end; k++) {
          const i = items[k];
          const ox = bx[i] - sx, oz = bz[i] - sz;
          const u = (ox * dx + oz * dz) / len2;
          if (u <= 0.04 || u >= 0.96) continue;
          const mx = ox - dx * u, mz = oz - dz * u;
          const r = br[i];
          if (mx * mx + mz * mz > r * r) continue;
          const y = sy + dy * u;
          if (y >= bb[i] && y <= bt[i]) return false;
        }
      }
    }
    return true;
  }
}

function cell(v: number): number {
  const c = Math.floor((v + 90) / 12);
  return c < 0 ? 0 : c > 14 ? 14 : c;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
