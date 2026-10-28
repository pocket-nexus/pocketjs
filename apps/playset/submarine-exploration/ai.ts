// The demo autopilot, ported from GameBlocks' submarine-exploration
// src/player-ai.js (https://gb-submarine-exploration.vercel.app/, MIT,
// xt4d/GameBlocks).
//
// Same target order (evade a predator, recover at the station when systems
// run low, a nearby crystal when the battery is under half, the nearest
// artifact, resources for the upgrade, the station) and the same control
// shaping, written for the 3DS interpreter: scalars instead of vectors,
// pickups found through the native `near` query instead of a scan of all
// 112, no allocation. Deviation: the demo's autopilot never scans; this one
// sends a pulse every ten seconds or so when no predator is near, so the
// title backdrop shows the sonar.

import type { SubmarineExploration } from "./game.ts";
import { L, SURFACE, WORLD_RADIUS, floorAt } from "./game.ts";

const EVADE = 0;
const ARTIFACT = 1;
const PICKUP = 2;
const STATION = 3;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export class SubAutopilot {
  fwd = 0;
  side = 0;
  rise = 0;
  turn = 0;
  brake = false;
  scan = false;
  private kind = STATION;
  private tx = 0;
  private ty = 0;
  private tz = 0;
  private stop = 8;
  private nearestThreat = 1e9;
  private scanTimer = 6;
  private scans = 0;

  reset(): void {
    this.fwd = this.side = this.rise = this.turn = 0;
    this.brake = false;
    this.scan = false;
    this.scanTimer = 6;
  }

  decide(g: SubmarineExploration): void {
    const play = g.play;
    const ent = play.ent;
    const p = g.player * 16;
    const px = ent[p], py = ent[p + 1], pz = ent[p + 2], yaw = ent[p + 6];
    const vx = ent[p + 3], vy = ent[p + 4], vz = ent[p + 5];
    const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
    this.choose(g, px, py, pz);
    let dx = this.tx - px, dy = this.ty - py, dz = this.tz - pz;
    const direct = Math.sqrt(dx * dx + dy * dy + dz * dz);
    // _applyAvoidance: predators push the course away on the ground plane
    let nearest = 1e9;
    const slots = g.creatureSlot;
    for (let i = 0; i < 4; i++) {
      const o = slots[i] * 16;
      const ax = px - ent[o], ay = py - ent[o + 1], az = pz - ent[o + 2];
      const d = Math.sqrt(ax * ax + ay * ay + az * az);
      if (d < nearest) nearest = d;
      const alert = g.creatureAlert[i] !== 0;
      const influence = alert ? 90 : 64;
      if (d > 0.001 && d < influence) {
        const al = Math.sqrt(ax * ax + az * az);
        const ux = al > 0.001 ? ax / al : Math.sin(yaw);
        const uz = al > 0.001 ? az / al : Math.cos(yaw);
        const w = (influence - d) * (alert ? 7.5 : 4.2);
        dx += ux * w;
        dz += uz * w;
      }
    }
    this.nearestThreat = nearest;
    if (py < floorAt(px, pz) + 7) dy += 24;
    if (py > SURFACE - 3) dy -= 18;
    const planar = Math.sqrt(px * px + pz * pz);
    if (planar > WORLD_RADIUS - 20) {
      const k = ((planar - (WORLD_RADIUS - 20)) * 2) / planar;
      dx -= px * k;
      dz -= pz * k;
    }
    // decide(): the control shaping
    const flat = Math.sqrt(dx * dx + dz * dz);
    const targetYaw = flat > 0.001 ? Math.atan2(-dx, -dz) : yaw;
    let yawError = targetYaw - yaw;
    yawError = Math.atan2(Math.sin(yawError), Math.cos(yawError));
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = -fz, rz = fx;
    const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const ux = dl > 0.0316 ? dx / dl : fx;
    const uz = dl > 0.0316 ? dz / dl : fz;
    const localRight = ux * rx + uz * rz;
    const localForward = ux * fx + uz * fz;
    const alignment = flat > 0.001 ? (fx * dx + fz * dz) / flat : 1;
    const evade = this.kind === EVADE;
    const stop = this.stop;
    const approach = evade ? 1 : direct > stop ? clamp((direct - stop) / stop, 0, 1) : 0;
    const sideLimit = evade ? 1 : 0.32;
    const reverseLimit = evade ? 0.9 : 0.14;
    let forward = approach * clamp((localForward + 0.22) / 1.22, evade ? 0 : 0.14, 1);
    let left = approach * clamp(-localRight, 0, sideLimit);
    let right = approach * clamp(localRight, 0, sideLimit);
    const backward = approach * clamp(-localForward, 0, reverseLimit);
    if (Math.abs(yawError) > 1.15) forward = Math.min(forward, 0.5);
    if (this.kind === ARTIFACT && direct < 34 && alignment > 0.3) {
      forward = Math.min(forward, 0.24);
      left = Math.min(left, 0.18);
      right = Math.min(right, 0.18);
    }
    const bs = g.hud.battery <= 0 ? 0.28 : 1;
    const back = Math.max(backward, direct < stop * 0.6 ? 0.18 : 0);
    this.fwd = (forward - back) * bs;
    this.side = (right - left) * bs;
    this.rise = (clamp(dy / 9, 0, 1) - clamp(-dy / 9, 0, 1)) * bs;
    // steerRight - steerLeft: TURN > 0 turns right
    this.turn = (clamp(-yawError / 0.65, 0, 1) - clamp(yawError / 0.65, 0, 1)) * bs;
    this.brake = !evade && (direct < stop * 1.45 || (direct < 22 && speed > 10));
    // the sonar, now and then, when nothing is hunting
    this.scanTimer -= 4 / 60;
    this.scan = false;
    if (this.scanTimer <= 0 && nearest > 95 && g.hud.battery > 30) {
      this.scan = true;
      this.scanTimer = 9 + (this.scans++ % 4);
    }
  }

  /** _chooseTarget */
  private choose(g: SubmarineExploration, px: number, py: number, pz: number): void {
    const hud = g.hud;
    const ent = g.play.ent;
    const low = hud.oxygen < 32 || hud.hull < 52 || hud.battery < 18;
    // _predatorEscapeTarget
    let threat = 1e9;
    let ex = 0, ez = 0;
    const slots = g.creatureSlot;
    for (let i = 0; i < 4; i++) {
      const o = slots[i] * 16;
      const ax = px - ent[o], ay = py - ent[o + 1], az = pz - ent[o + 2];
      const d = Math.sqrt(ax * ax + ay * ay + az * az);
      if (d < threat) threat = d;
      const influence = g.creatureAlert[i] ? 90 : 72;
      if (d >= influence) continue;
      const al = Math.sqrt(ax * ax + az * az) || 1;
      const w = (influence - d + 8) / influence;
      ex += (ax / al) * w;
      ez += (az / al) * w;
    }
    const el = Math.sqrt(ex * ex + ez * ez);
    if (el > 0.0316 && threat <= 72 && (!low || threat < 54)) {
      let x = px + (ex / el) * 112;
      let z = pz + (ez / el) * 112;
      const pd = Math.sqrt(x * x + z * z);
      if (pd > WORLD_RADIUS - 12) {
        const k = (WORLD_RADIUS - 12) / pd;
        x *= k;
        z *= k;
      }
      this.set(EVADE, x, clamp(py + 10, floorAt(x, z) + 9, SURFACE - 5), z, 5);
      return;
    }
    if (low) {
      this.set(STATION, g.stationX, g.stationY, g.stationZ, 9);
      return;
    }
    if (hud.battery < 48 && this.nearestPickup(g, px, py, pz, 72, true)) return;
    if (hud.artifactsFound < 4) {
      let best = -1;
      let bestD = 1e12;
      for (let i = 0; i < 4; i++) {
        if (g.artifactFound[i]) continue;
        const dx = g.artifactX[i] - px, dy = g.artifactY[i] - py, dz = g.artifactZ[i] - pz;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best >= 0) {
        this.set(ARTIFACT, g.artifactX[best], g.artifactY[best], g.artifactZ[best], 6);
        return;
      }
    }
    if (!hud.upgraded && hud.resources < 8) {
      if (this.nearestPickup(g, px, py, pz, 160, false) || this.nearestPickup(g, px, py, pz, 1400, false)) return;
    }
    this.set(STATION, g.stationX, g.stationY, g.stationZ, 9);
  }

  /** The nearest pickup inside `radius` (crystals only when asked). */
  private nearestPickup(g: SubmarineExploration, px: number, py: number, pz: number, radius: number, crystalsOnly: boolean): boolean {
    const play = g.play;
    const ent = play.ent;
    const list = play.list;
    const n = play.near(L.pickup, px, pz, radius);
    const crystal = g.crystalArch.id + 1;
    let best = -1;
    let bestD = radius * radius;
    for (let i = 0; i < n; i++) {
      const o = list[i] * 16;
      if (crystalsOnly && ent[o + 13] !== crystal) continue;
      const dx = ent[o] - px, dy = ent[o + 1] - py, dz = ent[o + 2] - pz;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    if (best < 0) return false;
    const r = ent[best + 13] === crystal ? 2.2 * 0.9 : 2.2;
    this.set(PICKUP, ent[best], ent[best + 1], ent[best + 2], r + 2.5);
    return true;
  }

  private set(kind: number, x: number, y: number, z: number, stop: number): void {
    this.kind = kind;
    this.tx = x;
    this.ty = y;
    this.tz = z;
    this.stop = stop;
  }
}
