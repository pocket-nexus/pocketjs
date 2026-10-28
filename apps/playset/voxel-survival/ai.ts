// The demo's autopilot, ported from GameBlocks' voxel-survival player-ai.js
// (https://gb-voxel-survival.vercel.app/src/player-ai.js, MIT, xt4d/GameBlocks).
//
// The same loop: aim at the nearest goal crystal, run and hop toward it,
// mine it from within reach, climb out of pits, wander when stuck. It runs
// every third frame with that frame span as its time step; the look change
// it decides is spread over the frames until the next decision, which is
// the per-frame smoothing of the original summed over three frames.
//
// Deviations: positions are world coordinates (x right, y up, the demo's
// forward z is -z here); the 34-block fallback scan for non-goal crystals is
// dropped (the demo's targets are only its ten goal sites, kept as flags by
// the game); the pit-escape search is cached for a quarter second. Nothing
// here allocates per call.

import type { Random } from "../kit/random.ts";

/** What the autopilot reads from the game. */
export interface VoxelAiHost {
  readonly px: number;
  readonly py: number;
  readonly pz: number;
  readonly yaw: number;
  readonly pitch: number;
  readonly grounded: boolean;
  readonly finished: boolean;
  /** the generated surface height at a world position (terrainHeight + 1) */
  surfaceAt(x: number, z: number): number;
  /** goal sites as world blocks, three ints each, and which still hold a crystal */
  readonly sites: Int32Array;
  readonly siteAlive: Uint8Array;
}

export const EYE = 1.58;

const angleDelta = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export const AI_MODE = { idle: 0, landing: 1, done: 2, collecting: 3, escaping: 4, exploring: 5 } as const;

export class VoxelAi {
  mode: number = AI_MODE.idle;
  // decision outputs, read by the game every frame until the next decision
  forward = 0;
  right = 0;
  sprint = false;
  /** one-shot: the game clears them when it acts */
  jump = false;
  primary = false;
  yawStep = 0;
  pitchStep = 0;

  private target = -1;
  private actionCooldown = 0;
  private scanCooldown = 0;
  private jumpCooldown = 0;
  private wanderTimer = 0;
  private wanderYaw = 0;
  private stuckTimer = 0;
  private stuckCheckTimer = 0;
  private intentTimer = 8;
  private lastX = 0;
  private lastZ = 0;
  private escapeTimer = 0;
  private escapeX = 0;
  private escapeY = 0;
  private escapeZ = 0;
  private aimYawDelta = 0;
  private aimPitchDelta = 0;
  private aimError = 0;
  private frames = 3;

  constructor(private readonly random: Random) {}

  reset(px: number, pz: number): void {
    this.mode = AI_MODE.idle;
    this.intentTimer = this.random.uniform(6, 10);
    this.target = -1;
    this.actionCooldown = 0;
    this.scanCooldown = 0;
    this.jumpCooldown = 0;
    this.stuckTimer = 0;
    this.stuckCheckTimer = 0;
    this.escapeTimer = 0;
    this.lastX = px;
    this.lastZ = pz;
    this.neutral();
  }

  private neutral(): void {
    this.forward = 0;
    this.right = 0;
    this.sprint = false;
    this.jump = false;
    this.primary = false;
    this.yawStep = 0;
    this.pitchStep = 0;
  }

  /** One decision covering `frames` frames of 1/60 s. */
  think(g: VoxelAiHost, frames: number): void {
    const dt = frames / 60;
    this.frames = frames;
    this.actionCooldown = Math.max(0, this.actionCooldown - dt);
    this.jumpCooldown = Math.max(0, this.jumpCooldown - dt);
    this.escapeTimer -= dt;
    this.updateStuck(g, dt);
    this.neutral();
    const groundY = g.surfaceAt(g.px, g.pz);
    if (!g.grounded && g.py > groundY + 2.5) {
      this.mode = AI_MODE.landing;
      return;
    }
    if (g.finished) {
      this.mode = AI_MODE.done;
      return;
    }
    this.resourceLoop(g, dt);
  }

  private aimAt(g: VoxelAiHost, x: number, y: number, z: number, dt: number, responsiveness: number, maxTurnRate: number): void {
    const dx = x - g.px;
    const dy = y - (g.py + EYE);
    const dz = z - g.pz;
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (length <= 0.0001) {
      this.aimYawDelta = 0;
      this.aimPitchDelta = 0;
      this.aimError = 0;
      return;
    }
    const yaw = Math.atan2(-dx, -dz);
    const pitch = clamp(Math.asin(clamp(dy / length, -1, 1)), -1.36, 1.36);
    const alpha = 1 - Math.exp(-dt * responsiveness);
    const yd = clamp(angleDelta(g.yaw, yaw) * alpha, -maxTurnRate * dt, maxTurnRate * dt);
    const pd = clamp((pitch - g.pitch) * alpha, -maxTurnRate * 0.75 * dt, maxTurnRate * 0.75 * dt);
    this.aimYawDelta = yd;
    this.aimPitchDelta = pd;
    this.aimError = Math.hypot(angleDelta(g.yaw + yd, yaw), pitch - (g.pitch + pd));
  }

  private look(): void {
    this.yawStep = this.aimYawDelta / this.frames;
    this.pitchStep = this.aimPitchDelta / this.frames;
  }

  private pitDepth(g: VoxelAiHost): number {
    return Math.max(0, g.surfaceAt(g.px, g.pz) - g.py);
  }

  private targetValid(g: VoxelAiHost): boolean {
    const t = this.target;
    if (t < 0 || !g.siteAlive[t]) return false;
    const s = g.sites;
    const cx = s[t * 3] + 0.5, cy = s[t * 3 + 1] + 0.5, cz = s[t * 3 + 2] + 0.5;
    const planar = Math.hypot(cx - g.px, cz - g.pz);
    if (planar < 1.3 && cy < g.py - 0.15) return false;
    const ey = g.py + EYE;
    return Math.sqrt(planar * planar + (cy - ey) * (cy - ey)) < 96;
  }

  /** The nearest goal crystal still standing, by eye distance. */
  private findTarget(g: VoxelAiHost): number {
    const s = g.sites;
    const ex = g.px, ey = g.py + EYE, ez = g.pz;
    let best = -1;
    let bestD = 1e9;
    for (let i = 0; i < g.siteAlive.length; i++) {
      if (!g.siteAlive[i]) continue;
      const dx = s[i * 3] + 0.5 - ex, dy = s[i * 3 + 1] + 0.5 - ey, dz = s[i * 3 + 2] + 0.5 - ez;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  private updateStuck(g: VoxelAiHost, dt: number): void {
    this.stuckCheckTimer += dt;
    if (this.stuckCheckTimer < 0.45) return;
    const moved = Math.hypot(g.px - this.lastX, g.pz - this.lastZ);
    if (moved < 0.12) this.stuckTimer += this.stuckCheckTimer;
    else this.stuckTimer = Math.max(0, this.stuckTimer - this.stuckCheckTimer * 1.8);
    this.lastX = g.px;
    this.lastZ = g.pz;
    this.stuckCheckTimer = 0;
  }

  private shouldJump(g: VoxelAiHost, planar: number, targetY: number): boolean {
    if (!g.grounded || this.jumpCooldown > 0) return false;
    const above = targetY === targetY && targetY > g.py + 0.75 && planar < 4.5;
    if (this.stuckTimer > 0.35 || above || planar > 7) {
      this.jumpCooldown = 0.85;
      return true;
    }
    return false;
  }

  private resourceLoop(g: VoxelAiHost, dt: number): void {
    this.scanCooldown -= dt;
    if (!this.targetValid(g) || this.scanCooldown <= 0) {
      this.target = this.findTarget(g);
      this.scanCooldown = 0.35;
    }
    if (this.target < 0) {
      this.explore(g, dt);
      return;
    }
    const s = g.sites;
    const t = this.target;
    const cx = s[t * 3] + 0.5, cy = s[t * 3 + 1] + 0.5, cz = s[t * 3 + 2] + 0.5;
    const ey = g.py + EYE;
    const planar = Math.hypot(cx - g.px, cz - g.pz);
    const eyeDistance = Math.sqrt(planar * planar + (cy - ey) * (cy - ey));
    if (this.shouldEscapePit(g, cy, planar)) {
      this.pitEscape(g, dt);
      return;
    }
    this.mode = AI_MODE.collecting;
    this.aimAt(g, cx, cy, cz, dt, 6.5, 1.85);
    this.look();
    if (eyeDistance > 5.85 || planar > 5.25) {
      this.forward = 1;
      this.sprint = true;
      this.jump = this.shouldJump(g, planar, cy);
      return;
    }
    if (this.aimError < 0.11 && this.actionCooldown <= 0) {
      this.primary = true;
      this.actionCooldown = 0.34;
    }
    this.jump = this.shouldJump(g, planar, cy);
  }

  private shouldEscapePit(g: VoxelAiHost, targetY: number, planar: number): boolean {
    const depth = this.pitDepth(g);
    if (depth < 1.05) return false;
    // a target close by and below eye level is dug for, not escaped from
    if (planar < 5.2 && targetY < g.py + 0.6) return false;
    return g.grounded || this.stuckTimer > 0.25 || depth > 1.45;
  }

  /** The nearest rim around a pit, on the generated surface (the demo's
   *  ring search, in its own forward axis so ties break the same way). */
  private findPitEscape(g: VoxelAiHost): void {
    const ox = g.px;
    const oy = g.py;
    const ozl = -g.pz;
    const current = g.surfaceAt(ox, g.pz);
    let found = false;
    let bestScore = 1e9;
    for (let radius = 2; radius <= 7 && !found; radius++) {
      const samples = Math.max(12, radius * 8);
      for (let index = 0; index < samples; index++) {
        const angle = (index / samples) * Math.PI * 2;
        const x = Math.floor(ox + Math.cos(angle) * radius);
        const zl = Math.floor(ozl + Math.sin(angle) * radius);
        // the column at logical z zl is world block z -zl - 1
        const surfaceY = g.surfaceAt(x + 0.5, -zl - 0.5);
        if (surfaceY < oy + 0.4) continue;
        const planar = Math.hypot(x + 0.5 - ox, zl + 0.5 - ozl);
        const score = planar + Math.abs(surfaceY - current) * 0.35 + Math.max(0, surfaceY - current) * 2;
        if (score < bestScore) {
          bestScore = score;
          this.escapeX = x + 0.5;
          this.escapeY = surfaceY + 0.35;
          this.escapeZ = -(zl + 0.5);
          found = true;
        }
      }
    }
    if (!found) {
      this.escapeX = ox;
      this.escapeY = current + 0.35;
      this.escapeZ = g.pz - 4;
    }
  }

  private pitEscape(g: VoxelAiHost, dt: number): void {
    if (this.escapeTimer <= 0) {
      this.findPitEscape(g);
      this.escapeTimer = 0.25;
    }
    this.aimAt(g, this.escapeX, this.escapeY, this.escapeZ, dt, 8.5, 2.8);
    this.look();
    if (g.grounded && this.jumpCooldown <= 0) {
      this.jumpCooldown = 0.46;
      this.jump = true;
    }
    this.mode = AI_MODE.escaping;
    this.forward = 1;
    this.sprint = true;
  }

  private explore(g: VoxelAiHost, dt: number): void {
    this.mode = AI_MODE.exploring;
    this.target = -1;
    this.wanderTimer -= dt;
    if (this.wanderTimer <= 0 || this.stuckTimer > 0.8) {
      this.wanderYaw += this.random.uniform(-1.35, 1.35) + (this.stuckTimer > 0.8 ? Math.PI * 0.5 : 0);
      this.wanderTimer = this.random.uniform(1.8, 3.4);
      this.stuckTimer = Math.max(0, this.stuckTimer - 0.4);
    }
    const alpha = 1 - Math.exp(-dt * 2.4);
    const yd = clamp(angleDelta(g.yaw, this.wanderYaw) * alpha, -1.8 * dt, 1.8 * dt);
    const targetPitch = -0.08 + Math.sin(this.intentTimer * 2.2) * 0.04;
    const span = 0.04 * this.frames;
    const pd = clamp(g.pitch + (targetPitch - g.pitch) * alpha - g.pitch, -span, span);
    this.yawStep = yd / this.frames;
    this.pitchStep = pd / this.frames;
    this.forward = 1;
    this.right = Math.sin(this.wanderTimer * 3.7) * 0.35;
    this.sprint = this.stuckTimer > 0.3;
    this.jump = this.shouldJump(g, 0, NaN);
  }
}
