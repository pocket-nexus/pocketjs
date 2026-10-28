// The demo autopilot, ported from GameBlocks' mech-arena
// (https://gb-mech-arena.vercel.app/src/player-ai.js, MIT, xt4d/GameBlocks),
// class PlayerAI. It decides every 1/3 s, as in the demo, and the game
// follows its move target, faces its target drone and holds its fire and
// jump until the next decision.
//
// Written for the 3DS interpreter: the drones and the shots come from two
// native queries into locals, the pillars from flat arrays.
//
// Deviation: the clear-shot test intersects the segment with each pillar's
// circle analytically where the demo sampled points every 0.29 m; both
// ignore height (the shot runs below the pillar tops).

import { ENT } from "@pocketjs/framework/playset";
import { mulberry } from "../kit/random.ts";
import { HALF_WORLD, L, PILLARS, PLAYER_RADIUS, type MechArena } from "./game.ts";

const FIRE_RANGE = 18;
const FIRE_YAW_TOLERANCE = 0.32;
const FIRE_BLOCKER_RADIUS = 0.45;
/** DRONES radii and max hp, in DRONE_TYPES order (game.ts imports this module) */
const RADIUS = [1.3, 1.65, 1.95];

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

export class Autopilot {
  private strafeSign = 1;
  private strafeTimer = 0;
  private stuckTimer = 0;
  private prevX = 0;
  private prevY = 0;
  private prevZ = 0;
  private random = mulberry(0x2f6e2b1);
  private readonly px = new Float64Array(PILLARS.length);
  private readonly pz = new Float64Array(PILLARS.length);
  private readonly pr = new Float64Array(PILLARS.length);
  private readonly pb = new Float64Array(PILLARS.length);

  constructor() {
    PILLARS.forEach((p, i) => {
      this.px[i] = p.x;
      this.pz[i] = p.z;
      this.pr[i] = p.radius;
      this.pb[i] = p.bodyRadius;
    });
  }

  reset(): void {
    this.strafeSign = 1;
    this.strafeTimer = 0;
    this.stuckTimer = 0;
    this.prevX = this.prevY = this.prevZ = 0;
    this.random = mulberry(0x2f6e2b1);
  }

  /** computeAction: into game.moveTo*, moving, target, firing, jumping. */
  decide(g: MechArena, dt: number): void {
    const play = g.play;
    const ent = play.ent;
    const list = play.list;
    const o = g.player * 16;
    const x = ent[o], y = ent[o + 1], z = ent[o + 2];
    const yaw = ent[o + ENT.YAW];

    // chooseTarget: nearest by planar distance, weighted toward the hurt
    let target = -1;
    let best = Infinity;
    const index = g.droneIndex;
    const n = play.near(L.drone, x, z, 1000);
    for (let i = 0; i < n; i++) {
      const s = list[i];
      const e = s * 16;
      if (index[ent[e + ENT.ARCH] - 1] < 0) continue;
      const dx = ent[e] - x, dz = ent[e + 2] - z;
      const health = ent[e + ENT.HP] / Math.max(1, ent[e + ENT.HP_MAX]);
      const score = (dx * dx + dz * dz) * (0.65 + health * 0.35);
      if (score < best) {
        best = score;
        target = s;
      }
    }
    // updateStrafe
    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0) {
      this.strafeTimer = 1.4 + this.random() * 1.1;
      this.strafeSign *= -1;
    }

    let mx = 0, mz = 0;
    let tx = 0, ty = 0, tz = 0, tr = 0;
    if (target >= 0) {
      const e = target * 16;
      tx = ent[e];
      ty = ent[e + 1];
      tz = ent[e + 2];
      tr = RADIUS[index[ent[e + ENT.ARCH] - 1]];
      // steerAroundTarget
      const dx = tx - x, dz = tz - z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > 0.001) {
        const ux = dx / d, uz = dz / d;
        if (d > 23) {
          mx += ux;
          mz += uz;
        } else if (d < 12) {
          mx -= ux;
          mz -= uz;
        }
        // BASIS.sideVector in playset axes
        const k = d < 28 ? 0.95 : 0.45;
        mx += -uz * this.strafeSign * k;
        mz += ux * this.strafeSign * k;
      }
    } else {
      // steerToCenter
      const l = Math.sqrt(x * x + z * z);
      if (l * l > 36) {
        mx -= x / l;
        mz -= z / l;
      }
    }

    // addShotAvoidance (and the nearest shot, for shouldJump)
    let nearestShot = Infinity;
    const ns = play.near(L.shot, x, z, 30);
    for (let i = 0; i < ns; i++) {
      const e = list[i] * 16;
      const ax = x - ent[e], az = z - ent[e + 2];
      const ay = y - ent[e + 1];
      const d3 = Math.sqrt(ax * ax + ay * ay + az * az);
      if (d3 < nearestShot) nearestShot = d3;
      const d = Math.sqrt(ax * ax + az * az);
      if (d > 8 || d <= 0.001) continue;
      if (ent[e + ENT.VX] * ax + ent[e + ENT.VZ] * az <= 0) continue;
      const k = 1.25 * (1 - d / 8);
      mx += (ax / d) * k;
      mz += (az / d) * k;
    }

    // addPillarAvoidance
    {
      const l = Math.sqrt(mx * mx + mz * mz);
      const has = l > 0.01;
      const vx = has ? mx / l : 0, vz = has ? mz / l : 0;
      const lookahead = 10;
      const buffer = PLAYER_RADIUS + 0.65;
      const ppx = this.px, ppz = this.pz, ppr = this.pr;
      let ax = 0, az = 0;
      for (let i = 0; i < ppx.length; i++) {
        let awayX = x - ppx[i];
        let awayZ = z - ppz[i];
        const d2 = awayX * awayX + awayZ * awayZ;
        const d = Math.sqrt(Math.max(d2, 0.0001));
        const hard = ppr[i] + buffer;
        const avoid = hard + 5.2;
        if (!has && d > avoid) continue;
        const pathR = hard + 2.8;
        let pathStrength = 0;
        let blocking = false;
        if (has) {
          const proj = -awayX * vx - awayZ * vz;
          if (proj > 0 && proj < lookahead) {
            const cx = x + vx * proj - ppx[i];
            const cz = z + vz * proj - ppz[i];
            const pd = Math.sqrt(cx * cx + cz * cz);
            if (pd < pathR) {
              blocking = true;
              const s = Math.max(0, Math.min(1, (pathR - pd) / pathR));
              pathStrength = s * (1 - (proj / lookahead) * 0.35);
            }
          }
        }
        const near = Math.max(0, Math.min(1, (avoid - d) / Math.max(0.001, avoid - hard)));
        if (!blocking && near <= 0) continue;
        if (d2 <= 0.0001) {
          awayX = has ? -vx : this.strafeSign;
          awayZ = has ? -vz : 0;
        } else {
          awayX /= d;
          awayZ /= d;
        }
        const strength = Math.max(near, pathStrength);
        ax += awayX * (1.1 + strength * 2.6);
        az += awayZ * (1.1 + strength * 2.6);
        // the tangent (in demo axes: right' = -away.forward, forward' = away.right)
        const tanX = awayZ, tanZ = -awayX;
        const dot = has ? tanX * vx + tanZ * vz : this.strafeSign;
        const sign = dot >= 0 ? 1 : -1;
        const k = 0.45 + pathStrength * 1.5 + near * 0.6;
        ax += tanX * sign * k;
        az += tanZ * sign * k;
      }
      mx += ax;
      mz += az;
    }

    // addBoundaryAvoidance
    const limit = HALF_WORLD - 7;
    if (x > limit) mx -= 1;
    if (x < -limit) mx += 1;
    if (-z > limit) mz += 1;
    if (-z < -limit) mz -= 1;

    // resolveAim and hasClearShot
    let fire = false;
    let clear = false;
    let distance = Infinity;
    if (target >= 0) {
      const ex = x, ey = y + 1.55, ez = z;
      const ay = ty + tr * 0.25;
      const dx = tx - ex, dy = ay - ey, dz = tz - ez;
      distance = Math.max(0.001, Math.sqrt(dx * dx + dy * dy + dz * dz));
      const yawError = wrap(Math.atan2(-dx, -dz) - yaw);
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      clear = this.clearShot(ex + fx * 1.55, ez + fz * 1.55, tx, tz);
      if (distance <= FIRE_RANGE && clear) mx = mz = 0;
      fire = distance <= FIRE_RANGE && Math.abs(yawError) <= FIRE_YAW_TOLERANCE && clear;
    }

    // resolveMoveTarget: 8 m along the wish, confined like the mech
    const wish = Math.sqrt(mx * mx + mz * mz);
    if (wish > 0.01) {
      let gx = x + (mx / wish) * 8;
      let gz = z + (mz / wish) * 8;
      const r = PLAYER_RADIUS + 0.35;
      gx = Math.max(-HALF_WORLD + r, Math.min(HALF_WORLD - r, gx));
      gz = Math.max(-HALF_WORLD + r, Math.min(HALF_WORLD - r, gz));
      const ppx = this.px, ppz = this.pz, ppr = this.pr;
      for (let i = 0; i < ppx.length; i++) {
        const dx = gx - ppx[i], dz = gz - ppz[i];
        const min = ppr[i] + r;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min) continue;
        const d = Math.sqrt(Math.max(d2, 0.0001));
        gx = ppx[i] + (dx / d) * min;
        gz = ppz[i] + (dz / d) * min;
      }
      g.moveToX = gx;
      g.moveToZ = gz;
      g.moving = true;
    } else g.moving = false;

    // shouldJump
    const mdx = x - this.prevX, mdy = y - this.prevY, mdz = z - this.prevZ;
    const moved = Math.sqrt(mdx * mdx + mdy * mdy + mdz * mdz);
    this.stuckTimer = g.moving && moved < 0.02 ? this.stuckTimer + dt : 0;
    this.prevX = x;
    this.prevY = y;
    this.prevZ = z;
    const grounded = (ent[o + ENT.STATE] & 1) !== 0;
    const jump = grounded && (this.stuckTimer > 0.45 || nearestShot < 4.5);
    if (jump) this.stuckTimer = 0;

    g.target = target;
    g.firing = fire;
    g.jumping = jump;
  }

  /** segmentHitsArena on the ground plane: the pillar bodies grown by 0.45 m. */
  private clearShot(ax: number, az: number, bx: number, bz: number): boolean {
    const lim = HALF_WORLD - FIRE_BLOCKER_RADIUS;
    if (Math.abs(bx) >= lim || Math.abs(bz) >= lim) return false;
    const dx = bx - ax, dz = bz - az;
    const lenSq = dx * dx + dz * dz;
    if (lenSq < 1e-6) return true;
    const ppx = this.px, ppz = this.pz, ppb = this.pb;
    for (let i = 0; i < ppx.length; i++) {
      const r = ppb[i] + FIRE_BLOCKER_RADIUS;
      const fx = ppx[i] - ax, fz = ppz[i] - az;
      let t = (fx * dx + fz * dz) / lenSq;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = ax + dx * t - ppx[i], cz = az + dz * t - ppz[i];
      if (cx * cx + cz * cz <= r * r) return false;
    }
    return true;
  }
}
