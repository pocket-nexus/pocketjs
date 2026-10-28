// The demo autopilot, ported from GameBlocks' pirate-seas player-ai.js
// (https://gb-pirate-seas.vercel.app/src/player-ai.js, MIT, xt4d/GameBlocks).
//
// The same decisions in the same order: back off a rock it is stuck on,
// fetch a repair kit when the hull is low or powder when the shot runs out,
// otherwise fight the nearest raider (close in, circle at broadside range,
// back off when too close, fire the side that faces it), then treasure,
// then a patrol sweep; every heading is bent around islands, rocks and the
// reef ring. Deviations: it reads the world from the playset views instead
// of the demo's JSON state, in one pass with no allocation, and the game
// runs it every fourth frame (the controls hold between runs).
//
// Coordinates are the playset's: x is the demo's right, z its -forward, and
// yaw has the demo's sign (positive turns left).

export interface PirateWorld {
  /** player x, z, yaw, speed, hp, maxHp, ammo, port and starboard cooldowns */
  px: number;
  pz: number;
  yaw: number;
  speed: number;
  hp: number;
  maxHp: number;
  ammo: number;
  coolPort: number;
  coolStarboard: number;
  /** live raiders and pickups (kind 0 treasure, 1 repair, 2 ammo) */
  enemyX: Float32Array;
  enemyZ: Float32Array;
  enemySlot: Float32Array;
  enemies: number;
  pickX: Float32Array;
  pickZ: Float32Array;
  pickKind: Float32Array;
  pickups: number;
  /** islands and rocks: demo radius, 1 for a rock */
  obsX: Float32Array;
  obsZ: Float32Array;
  obsR: Float32Array;
  obsRock: Uint8Array;
  obstacles: number;
}

/** What the controls ask of the ship this frame. */
export interface PirateControls {
  forward: number;
  backward: number;
  /** + right, - left */
  steer: number;
  brake: boolean;
  firePort: boolean;
  fireStarboard: boolean;
}

const EPSILON = 1e-6;
const HALF_PI = Math.PI * 0.5;
const ROCK_STUCK_GAP = 3.2;
const ROCK_STUCK_SPEED = 4.2;
const ROCK_REVERSE_SECONDS = 0.9;
const PLAYER_RADIUS = 11.2;
const WORLD_LIMIT = 210;
const BROADSIDE_RANGE = 64;
const CHASE_RANGE = 86;
const RETREAT_RANGE = 28;
const LOW_HEALTH_RATIO = 0.48;
const AMMO_FLOOR = 5;

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

export class PirateAutopilot {
  private orbitSign = 1;
  private targetSlot = -1;
  private patrolAngle = 0;
  private reverseTimer = 0;
  private awayX = 0;
  private awayZ = 0;
  // the steered heading of the last decision (a unit vector)
  private dx = 0;
  private dz = 0;

  reset(): void {
    this.orbitSign = 1;
    this.targetSlot = -1;
    this.patrolAngle = 0;
    this.reverseTimer = 0;
  }

  /** One decision covering `dt` seconds, written into `out`. */
  decide(w: PirateWorld, dt: number, out: PirateControls): void {
    out.forward = 0;
    out.backward = 0;
    out.steer = 0;
    out.brake = false;
    out.firePort = false;
    out.fireStarboard = false;
    const px = w.px;
    const pz = w.pz;
    this.reverseTimer = Math.max(0, this.reverseTimer - dt);
    // findRockStuck
    let stuckGap = 1e9;
    let sax = 0;
    let saz = 0;
    if (w.speed <= ROCK_STUCK_SPEED) {
      for (let i = 0; i < w.obstacles; i++) {
        if (!w.obsRock[i]) continue;
        const ax = px - w.obsX[i];
        const az = pz - w.obsZ[i];
        const d = Math.max(Math.sqrt(ax * ax + az * az), EPSILON);
        const gap = d - (w.obsR[i] + PLAYER_RADIUS);
        if (gap <= ROCK_STUCK_GAP && gap < stuckGap) {
          stuckGap = gap;
          sax = ax / d;
          saz = az / d;
        }
      }
    }
    if (stuckGap < 1e8) {
      if (this.reverseTimer <= 0) this.reverseTimer = ROCK_REVERSE_SECONDS;
      this.awayX = sax;
      this.awayZ = saz;
    }
    if (this.reverseTimer > 0) {
      // controlsReverseAway: back up with the stern toward the open water
      const err = wrap(Math.atan2(this.awayX, this.awayZ) - w.yaw);
      const turn = Math.min(1, Math.abs(err) / 0.72);
      out.backward = 0.9;
      out.steer = err > 0.045 ? -turn : err < -0.045 ? turn : 0;
      return;
    }

    // nearest raider and pickups of each kind
    let enemyD = 1e9, ex = 0, ez = 0, eslot = -1;
    for (let i = 0; i < w.enemies; i++) {
      const dx = w.enemyX[i] - px, dz = w.enemyZ[i] - pz;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < enemyD) {
        enemyD = d;
        ex = w.enemyX[i];
        ez = w.enemyZ[i];
        eslot = w.enemySlot[i];
      }
    }
    let treasureD = 1e9, tx = 0, tz = 0;
    let repairD = 1e9, rx = 0, rz = 0;
    let ammoD = 1e9, ax = 0, az = 0;
    for (let i = 0; i < w.pickups; i++) {
      const dx = w.pickX[i] - px, dz = w.pickZ[i] - pz;
      const d = Math.sqrt(dx * dx + dz * dz);
      const k = w.pickKind[i];
      if (k === 0 && d < treasureD) {
        treasureD = d;
        tx = w.pickX[i];
        tz = w.pickZ[i];
      } else if (k === 1 && d < repairD) {
        repairD = d;
        rx = w.pickX[i];
        rz = w.pickZ[i];
      } else if (k === 2 && d < ammoD) {
        ammoD = d;
        ax = w.pickX[i];
        az = w.pickZ[i];
      }
    }
    const needsRepair = w.hp <= w.maxHp * LOW_HEALTH_RATIO;
    const needsAmmo = w.ammo <= AMMO_FLOOR;
    let speed = 0.85;
    let brake = false;
    if (needsRepair && repairD < 1e8) {
      this.toward(rx - px, rz - pz);
      speed = 0.95;
      brake = repairD < 11;
    } else if (needsAmmo && ammoD < 1e8) {
      this.toward(ax - px, az - pz);
      speed = 0.92;
      brake = ammoD < 10;
    } else if (eslot >= 0) {
      // fightEnemy
      if (this.targetSlot !== eslot) {
        this.targetSlot = eslot;
        this.orbitSign = ex >= px ? 1 : -1;
      }
      const inv = 1 / Math.max(enemyD, EPSILON);
      const dirX = (ex - px) * inv;
      const dirZ = (ez - pz) * inv;
      // the ship's right is (cos yaw, -sin yaw)
      const sideDot = Math.cos(w.yaw) * dirX - Math.sin(w.yaw) * dirZ;
      const canBroadside = enemyD <= CHASE_RANGE && Math.abs(sideDot) > 0.62;
      out.firePort = canBroadside && sideDot < -0.62 && w.coolPort <= 0.05 && w.ammo > 0;
      out.fireStarboard = canBroadside && sideDot > 0.62 && w.coolStarboard <= 0.05 && w.ammo > 0;
      if (enemyD > CHASE_RANGE || w.ammo <= 0) {
        this.toward(dirX, dirZ);
        speed = w.ammo <= 0 ? 0.68 : 0.96;
      } else if (enemyD < RETREAT_RANGE) {
        this.toward(-dirX, -dirZ);
        speed = 0.82;
        brake = enemyD < 18;
      } else {
        // circle: the heading a quarter turn from the raider's bearing
        const yaw = Math.atan2(-dirX, -dirZ) + this.orbitSign * HALF_PI;
        this.toward(-Math.sin(yaw), -Math.cos(yaw));
        speed = enemyD > BROADSIDE_RANGE ? 0.76 : 0.58;
        brake = enemyD < BROADSIDE_RANGE * 0.72 && canBroadside;
      }
    } else if (treasureD < 1e8) {
      this.toward(tx - px, tz - pz);
      speed = 0.88;
      brake = treasureD < 10;
    } else if (ammoD < 1e8) {
      this.toward(ax - px, az - pz);
      speed = 0.78;
      brake = ammoD < 10;
    } else {
      // patrol: a slow sweep pulled toward the middle
      this.patrolAngle += dt * 0.35;
      const c = Math.sqrt(px * px + pz * pz);
      const cx = c > EPSILON ? (-px / c) * 1.4 : 0;
      const cz = c > EPSILON ? (-pz / c) * 1.4 : 0;
      this.toward(-Math.sin(this.patrolAngle) + cx, -Math.cos(this.patrolAngle) + cz);
      speed = 0.58;
    }
    this.aroundHazards(w);
    // controlsToward
    const len = Math.sqrt(this.dx * this.dx + this.dz * this.dz);
    if (len <= EPSILON) {
      out.brake = true;
      return;
    }
    const err = wrap(Math.atan2(-this.dx, -this.dz) - w.yaw);
    const abs = Math.abs(err);
    const turn = Math.min(1, abs / 0.72);
    const scale = abs > 1.45 ? 0.42 : abs > 0.95 ? 0.68 : 1;
    out.forward = Math.min(1, Math.max(0, speed * scale));
    out.steer = err > 0.045 ? -turn : err < -0.045 ? turn : 0;
    out.brake = brake;
  }

  private toward(x: number, z: number): void {
    const l = Math.sqrt(x * x + z * z);
    if (l <= EPSILON) {
      this.dx = 0;
      this.dz = 0;
      return;
    }
    this.dx = x / l;
    this.dz = z / l;
  }

  /** steerAroundHazards: repulsion from obstacles and the reef ring. */
  private aroundHazards(w: PirateWorld): void {
    if (this.dx === 0 && this.dz === 0) return;
    const px = w.px;
    const pz = w.pz;
    let ax = 0;
    let az = 0;
    for (let i = 0; i < w.obstacles; i++) {
      const x = px - w.obsX[i];
      const z = pz - w.obsZ[i];
      const d = Math.max(Math.sqrt(x * x + z * z), EPSILON);
      const safe = w.obsR[i] + PLAYER_RADIUS + 18;
      if (d < safe) {
        const k = (safe - d) / safe;
        const weight = k * k * 3.8;
        ax += (x * weight) / d;
        az += (z * weight) / d;
      }
    }
    const c = Math.sqrt(px * px + pz * pz);
    const buffer = WORLD_LIMIT - PLAYER_RADIUS - 18;
    if (c > buffer) {
      const inward = (c - buffer) / Math.max(1, WORLD_LIMIT - buffer);
      ax -= (px * 2.6 * inward) / Math.max(c, EPSILON);
      az -= (pz * 2.6 * inward) / Math.max(c, EPSILON);
    }
    this.toward(this.dx + ax, this.dz + az);
  }
}
