// The demo autopilot, ported from GameBlocks' desert-shooter
// (https://gb-desert-shooter.vercel.app/src/player-ai.js, MIT, xt4d/GameBlocks),
// class PlayerAI.
//
// Written for the 3DS interpreter: one pass over the dinosaurs and the
// pickups into flat arrays, the props asked from the world's grid around the
// rover instead of walked in full, and every view and constant in a local.
// It runs every 3rd frame with dt = 3/60, so the target smoothing uses the
// demo's blend compounded over three frames.
//
// Deviations: the escape score adds 3.6 for every prop the grid does not
// return (the demo's saturated clearance term, so the choice is unchanged);
// the rover's frame is its heading on the ground plane; it backs away only
// from a prop in its path, not one beside it; backing away from a prop
// counter-steers (the demo kept the steer, and forward and back turns
// cancelled each other in front of a bush); an unstick is followed by a 3 s
// detour to one side, so the rover stops retrying a gap it cannot pass, and
// a rover that wanted to travel but in 2 s neither made 5 m nor turned
// 0.5 rad unsticks as well.

import { ENT } from "@pocketjs/framework/playset";
import { L, PLAYER_RADIUS, type DesertShooter } from "./game.ts";

export interface Controls {
  forward: number;
  reverse: number;
  left: number;
  right: number;
  turretLeft: number;
  turretRight: number;
  drift: boolean;
  fire: boolean;
}

const FRONT_HALF_ANGLE = Math.PI / 3;
const STANDOFF = [10, 12, 16, 24]; // chase, charge, spit, boss
/** ENEMY_STATS radii, in ENEMY_TYPES order (game.ts imports this module) */
const RADIUS = [3.0, 3.8, 3.2, 7.2];
const MAX = 64;

const enum Kind {
  Idle,
  Patrol,
  Standoff,
  Center,
  Pickup,
  AttackRun,
  HoldRange,
  Enemy,
}

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** yaw toward (dx, dz): the playset's yaw_of, the demo's forwardToYaw */
function yawTo(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

export class Autopilot {
  private patrolAngle = 0;
  private steerDirection = 0;
  private lowSpeedTimer = 0;
  private unstickTimer = 0;
  private unstickSide = 1;
  private detour = 0;
  private detourSide = 1;
  private detourX = 0;
  private detourZ = 0;
  /** where the rover was one and two seconds ago, for the progress probe */
  private probe = 0;
  private probeX1 = 0;
  private probeZ1 = 0;
  private probeX2 = 1e9;
  private probeZ2 = 1e9;
  private probeYaw1 = 0;
  private probeYaw2 = 0;
  private smoothed = false;
  private smoothX = 0;
  private smoothZ = 0;
  private lastKind = Kind.Idle;
  // the dinosaurs: position, type, planar distance, in front
  private readonly ex = new Float64Array(MAX);
  private readonly ez = new Float64Array(MAX);
  private readonly ey = new Float64Array(MAX);
  private readonly et = new Int8Array(MAX);
  private readonly ed = new Float64Array(MAX);
  private readonly ef = new Uint8Array(MAX);
  private readonly close = new Int32Array(MAX);
  private props = new Int32Array(256);
  private stamp = new Uint32Array(0);
  private epoch = 1;

  reset(): void {
    this.patrolAngle = 0;
    this.steerDirection = 0;
    this.lowSpeedTimer = 0;
    this.unstickTimer = 0;
    this.unstickSide = 1;
    this.detour = 0;
    this.probe = 0;
    this.probeX2 = this.probeZ2 = 1e9;
    this.smoothed = false;
    this.lastKind = Kind.Idle;
  }

  plan(g: DesertShooter, dt: number, c: Controls): void {
    const play = g.play;
    const ent = play.ent;
    const list = play.list;
    const world = g.world;
    if (this.stamp.length < world.count) this.stamp = new Uint32Array(world.count);
    const o = g.player * 16;
    const px = ent[o];
    const pz = ent[o + 2];
    const yaw = ent[o + ENT.YAW];
    const speed = Math.abs(ent[o + ENT.SPEED]);
    const health = ent[o + ENT.HP];
    const ammo = g.hud.ammo;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const gunYaw = yaw + g.gunRelative;
    c.forward = c.reverse = c.left = c.right = c.turretLeft = c.turretRight = 0;
    c.drift = false;
    c.fire = false;

    // one pass over the dinosaurs
    const index = g.enemyIndex;
    const ex = this.ex, ez = this.ez, et = this.et, ed = this.ed, ef = this.ef;
    let count = 0;
    let nearest = -1;
    let closeCount = 0;
    const nEnemies = play.near(L.enemy, px, pz, 1000);
    for (let i = 0; i < nEnemies && count < MAX; i++) {
      const e = list[i] * 16;
      const t = index[ent[e + ENT.ARCH] - 1];
      if (t < 0) continue;
      const x = ent[e], z = ent[e + 2];
      const dx = x - px, dz = z - pz;
      const d = Math.sqrt(dx * dx + dz * dz);
      ex[count] = x;
      ez[count] = z;
      this.ey[count] = ent[e + 1];
      et[count] = t;
      ed[count] = d;
      const front = Math.abs(wrap(yawTo(dx, dz) - yaw)) <= FRONT_HALF_ANGLE;
      ef[count] = front ? 1 : 0;
      if (front && (nearest < 0 || d < ed[nearest])) nearest = count;
      if (d < STANDOFF[t] * 0.45) this.close[closeCount++] = count;
      count++;
    }
    // the pickups: nearest of any kind, of repairs, of ammo
    let pickX = 0, pickZ = 0, pickD = 1e9;
    let repX = 0, repZ = 0, repD = 1e9;
    let ammoX = 0, ammoZ = 0, ammoD = 1e9;
    const pIndex = g.pickupIndex;
    const nPickups = play.near(L.pickup, px, pz, 1000);
    for (let i = 0; i < nPickups; i++) {
      const e = list[i] * 16;
      const t = pIndex[ent[e + ENT.ARCH] - 1];
      const x = ent[e], z = ent[e + 2];
      const dx = x - px, dz = z - pz;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < pickD) {
        pickD = d;
        pickX = x;
        pickZ = z;
      }
      if (t === 0 && d < repD) {
        repD = d;
        repX = x;
        repZ = z;
      } else if (t === 1 && d < ammoD) {
        ammoD = d;
        ammoX = x;
        ammoZ = z;
      }
    }

    const edge = world.bounds - 34;
    let kind = Kind.Patrol;
    let tx = 0, tz = 0;
    const nd = nearest >= 0 ? ed[nearest] : 1e9;
    // hasGunShot on the nearest target in front, once for the plan
    const shot = nearest >= 0 && this.gunShot(g, px, pz, ent[o + 1], gunYaw, nearest);
    if (closeCount > 0) {
      this.escape(g, px, pz, fx, fz, rx, rz, this.close, closeCount, 34);
      tx = this.outX;
      tz = this.outZ;
      kind = Kind.Standoff;
    } else if (Math.abs(px) > edge || Math.abs(pz) > edge) {
      kind = Kind.Center;
    } else if (repD < 1e9 && health < 65 && nd > 22) {
      tx = repX;
      tz = repZ;
      kind = Kind.Pickup;
    } else if (ammoD < 1e9 && ammo < 18 && nd > 28) {
      tx = ammoX;
      tz = ammoZ;
      kind = Kind.Pickup;
    } else if (nearest >= 0) {
      const standoff = STANDOFF[et[nearest]];
      if (nd < standoff + 12 && !shot) {
        tx = ex[nearest];
        tz = ez[nearest];
        kind = Kind.AttackRun;
      } else if (nd < standoff) {
        let n = 0;
        for (let i = 0; i < count; i++) if (ed[i] < standoff + 12) this.close[n++] = i;
        this.escape(g, px, pz, fx, fz, rx, rz, this.close, n, standoff + 18);
        tx = this.outX;
        tz = this.outZ;
        kind = Kind.Standoff;
      } else {
        tx = ex[nearest];
        tz = ez[nearest];
        kind = nd < standoff + 9 ? Kind.HoldRange : Kind.Enemy;
      }
    } else if (pickD < 1e9) {
      tx = pickX;
      tz = pickZ;
      kind = Kind.Pickup;
    } else {
      this.patrolAngle += dt * 0.28;
      tx = Math.cos(this.patrolAngle) * 58;
      tz = -Math.sin(this.patrolAngle) * 58;
    }
    // after an unstick, a short detour off to one side (not in the demo)
    if (this.detour > 0 && kind !== Kind.Standoff) {
      this.detour -= dt;
      tx = this.detourX;
      tz = this.detourZ;
      kind = Kind.Patrol;
    }

    if (this.unstickTimer > 0) {
      this.unstickTimer -= dt;
      c.reverse = 1;
      if (this.unstickSide > 0) c.left = 1;
      else c.right = 1;
      return;
    }

    let obstacle = false;
    if (kind !== Kind.Standoff) obstacle = this.obstacleAhead(g, px, pz, fx, fz, rx, rz);
    if (obstacle) {
      c.forward = this.obstacleClose ? 0 : 1;
      c.reverse = this.obstacleClose ? 1 : 0;
      // backing away counter-steers, so the nose keeps swinging the same way
      const steer = this.obstacleClose ? -this.obstacleSteer : this.obstacleSteer;
      if (steer > 0) c.left = 1;
      else c.right = 1;
    } else {
      // the demo's smoothTarget, its blend compounded over the three frames
      if (!this.smoothed || this.lastKind !== kind) {
        this.smoothX = tx;
        this.smoothZ = tz;
        this.smoothed = true;
        this.lastKind = kind;
      } else {
        const blend = kind === Kind.Standoff ? 0.989 : 0.525;
        this.smoothX += (tx - this.smoothX) * blend;
        this.smoothZ += (tz - this.smoothZ) * blend;
      }
      const error = wrap(yawTo(this.smoothX - px, this.smoothZ - pz) - yaw);
      const absError = Math.abs(error);
      const urgent = kind === Kind.Standoff;
      if (kind === Kind.AttackRun) {
        if (nd < 9) c.reverse = speed < 9 ? 1 : 0;
        else c.forward = speed < 12 || absError < 0.9 ? 1 : 0;
      } else if (kind === Kind.HoldRange) {
        c.forward = speed < 7 && absError < 0.45 ? 1 : 0;
      } else if (urgent) {
        c.forward = speed < 25 ? 1 : 0;
        c.drift = true;
      } else {
        const cruise = kind === Kind.Pickup ? 22 : 20;
        c.forward = speed < cruise && (absError < 1.15 || speed < 4) ? 1 : 0;
      }
      const steer = kind === Kind.AttackRun ? (absError > 0.08 ? (error > 0 ? 1 : -1) : 0) : this.chooseSteer(error, speed, urgent);
      if (steer > 0) c.left = 1;
      else if (steer < 0) c.right = 1;
    }

    if (speed < 1.25 && c.forward) this.lowSpeedTimer += dt;
    else this.lowSpeedTimer = 0;
    // the progress probe (not in the demo): a rover that wants to travel but
    // in two seconds neither made 5 m nor turned 0.5 rad is rocking in place
    this.probe += dt;
    let stuck = false;
    if (this.probe >= 1) {
      this.probe -= 1;
      const travelling = kind === Kind.Patrol || kind === Kind.Enemy || kind === Kind.Pickup || kind === Kind.Center;
      const dx = px - this.probeX2, dz = pz - this.probeZ2;
      stuck = travelling && dx * dx + dz * dz < 25 && Math.abs(wrap(yaw - this.probeYaw2)) < 0.5;
      this.probeX2 = this.probeX1;
      this.probeZ2 = this.probeZ1;
      this.probeYaw2 = this.probeYaw1;
      this.probeX1 = px;
      this.probeZ1 = pz;
      this.probeYaw1 = yaw;
    }
    if (this.lowSpeedTimer > 0.85 || stuck) {
      this.unstickTimer = 0.75;
      this.unstickSide = px >= 0 ? -1 : 1;
      this.lowSpeedTimer = 0;
      // the detour: 35 m out at 110 degrees from the heading, sides alternating
      this.detourSide = -this.detourSide;
      const a = yaw + this.detourSide * 1.9;
      const lim = world.bounds - 30;
      this.detourX = Math.max(-lim, Math.min(lim, px - Math.sin(a) * 35));
      this.detourZ = Math.max(-lim, Math.min(lim, pz - Math.cos(a) * 35));
      this.detour = 3;
    }

    if (nearest >= 0) {
      // rotateTurretToward
      const err = wrap(yawTo(ex[nearest] - px, ez[nearest] - pz) - gunYaw);
      if (Math.abs(err) >= 0.08) {
        if (err > 0) c.turretLeft = 1;
        else c.turretRight = 1;
      }
      c.fire = ammo > 0 && shot;
    }
  }

  private chooseSteer(error: number, speed: number, urgent: boolean): number {
    const absError = Math.abs(error);
    const sign = error > 0 ? 1 : -1;
    const engage = urgent ? 0.16 : speed > 20 ? 0.24 : 0.18;
    const release = urgent ? 0.08 : 0.1;
    if (this.steerDirection === 0) {
      if (absError > engage) this.steerDirection = sign;
    } else if (absError < release) {
      this.steerDirection = 0;
    } else if (sign !== this.steerDirection && absError > engage * 1.35) {
      this.steerDirection = sign;
    }
    return this.steerDirection;
  }

  /** hasGunShot: in front, the gun line passes within 0.85 r of the body,
   *  under 150 m, and no prop stands between. */
  private gunShot(g: DesertShooter, px: number, pz: number, py: number, gunYaw: number, i: number): boolean {
    if (!this.ef[i]) return false;
    const ex = this.ex[i], ez = this.ez[i];
    const r = RADIUS[this.et[i]];
    const gfx = -Math.sin(gunYaw), gfz = -Math.cos(gunYaw);
    const mx = px + gfx * 2.75, my = py + 1.55, mz = pz + gfz * 2.75;
    const ty = this.ey[i] + r * 0.85;
    const dx = ex - mx, dy = ty - my, dz = ez - mz;
    const along = dx * gfx + dz * gfz;
    if (along <= 0 || along > 150) return false;
    const cx = mx + gfx * along - ex, cz = mz + gfz * along - ez;
    if (cx * cx + dy * dy + cz * cz > r * 0.85 * (r * 0.85)) return false;
    return !g.world.blocked(mx, mz, ex, ez, 0.35, 0.04, 0.96, this.props, this.stamp, ++this.epoch);
  }

  private obstacleClose = false;
  private obstacleSteer = 0;

  /** findObstacleAhead over the props near the rover. */
  private obstacleAhead(g: DesertShooter, px: number, pz: number, fx: number, fz: number, rx: number, rz: number): boolean {
    const world = g.world;
    const n = world.near(px, pz, 32, this.props, this.stamp, ++this.epoch);
    const cx = world.cx, cz = world.cz, cr = world.cr, props = this.props;
    let best = -1e9;
    let found = false;
    for (let k = 0; k < n; k++) {
      const i = props[k];
      const dx = cx[i] - px, dz = cz[i] - pz;
      const ahead = dx * fx + dz * fz;
      if (ahead < 1.5 || ahead > 18) continue;
      const lateral = dx * rx + dz * rz;
      const clearance = cr[i] + PLAYER_RADIUS + 1.8;
      if (Math.abs(lateral) > clearance) continue;
      const score = 18 - ahead + (clearance - Math.abs(lateral)) * 2;
      if (score > best) {
        best = score;
        found = true;
        // reverse only for a prop in the rover's path (the demo also backed
        // away from one beside it, inside the avoidance width)
        this.obstacleClose = ahead < 7 && Math.abs(lateral) < cr[i] + PLAYER_RADIUS + 0.6;
        this.obstacleSteer = lateral === 0 ? (px >= 0 ? -1 : 1) : lateral > 0 ? 1 : -1;
      }
    }
    return found;
  }

  private outX = 0;
  private outZ = 0;
  private readonly candX = new Float64Array(5);
  private readonly candZ = new Float64Array(5);

  /** escapePosition: away from `who`, the best of five headings; into outX/outZ. */
  private escape(g: DesertShooter, px: number, pz: number, fx: number, fz: number, rx: number, rz: number, who: Int32Array, n: number, distance: number): void {
    const bounds = g.world.bounds;
    let ax = 0, az = 0;
    for (let k = 0; k < n; k++) {
      const i = who[k];
      const dx = px - this.ex[i], dz = pz - this.ez[i];
      const d = Math.max(0.001, Math.sqrt(dx * dx + dz * dz));
      const w = Math.min(6, Math.max(0.35, 44 / d));
      ax += (dx / d) * w;
      az += (dz / d) * w;
    }
    if (Math.abs(px) > bounds - 48 || Math.abs(pz) > bounds - 48) {
      const l = Math.hypot(px, pz);
      if (l > 1e-3) {
        ax -= (px / l) * 1.8;
        az -= (pz / l) * 1.8;
      }
    }
    if (ax * ax + az * az < 1e-6) {
      ax = fx;
      az = fz;
    }
    const al = Math.hypot(ax, az);
    ax /= al;
    az /= al;
    const sideSign = this.steerDirection || (px >= 0 ? -1 : 1);
    // BASIS.sideVector in playset axes
    const sx = -az * sideSign, sz = ax * sideSign;
    const cand = this.candX, candZ = this.candZ;
    cand[0] = ax; candZ[0] = az;
    cand[1] = ax + sx * 0.72; candZ[1] = az + sz * 0.72;
    cand[2] = ax - sx * 0.72; candZ[2] = az - sz * 0.72;
    cand[3] = fx; candZ[3] = fz;
    cand[4] = rx * sideSign; candZ[4] = rz * sideSign;
    let best = -1e18;
    const lim = bounds - 24;
    for (let c = 0; c < 5; c++) {
      let dx = cand[c], dz = candZ[c];
      const l = Math.hypot(dx, dz);
      if (l < 1e-6) continue;
      dx /= l;
      dz /= l;
      const tx = Math.max(-lim, Math.min(lim, px + dx * distance));
      const tz = Math.max(-lim, Math.min(lim, pz + dz * distance));
      const score = this.escapeScore(g, tx, tz, who, n, dx * fx + dz * fz);
      if (score > best) {
        best = score;
        this.outX = tx;
        this.outZ = tz;
      }
    }
  }

  private escapeScore(g: DesertShooter, tx: number, tz: number, who: Int32Array, n: number, along: number): number {
    const world = g.world;
    let nearest = 1e9;
    for (let k = 0; k < n; k++) {
      const i = who[k];
      const dx = tx - this.ex[i], dz = tz - this.ez[i];
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < nearest) nearest = d;
    }
    const room = world.bounds - Math.max(Math.abs(tx), Math.abs(tz));
    let score = Math.min(nearest, 140) * 3.6 + Math.min(48, Math.max(0, room)) * 0.55 + along * 8;
    const m = world.near(tx, tz, 34, this.props, this.stamp, ++this.epoch);
    const cx = world.cx, cz = world.cz, cr = world.cr, props = this.props;
    for (let k = 0; k < m; k++) {
      const i = props[k];
      const clearance = Math.hypot(tx - cx[i], tz - cz[i]) - cr[i] - PLAYER_RADIUS - 4;
      score += clearance < 0 ? clearance * 90 : Math.min(clearance, 18) * 0.2;
    }
    // the props further away all score the saturated 18 * 0.2
    return score + (world.count - m) * 3.6;
  }
}
