// The demo's autopilot, ported from GameBlocks' endless-runner player-ai.js
// (https://gb-endless-runner.vercel.app/src/player-ai.js, MIT, xt4d/GameBlocks).
//
// The same rules in the same order: slide under a close low beam, jump a
// close block or barrier, change to the safest lane before a ground
// obstacle, then (outside the one-second freeze after a lane change) steer
// toward a reachable coin or boost. Written for the 3DS interpreter: the
// nearest obstacle of each lane is found once per decision into flat
// fields, so every rule is a few comparisons; the game calls it every third
// frame with that span as its time step.

export const COMMAND = { none: 0, left: 1, right: 2, jump: 3, slide: 4 } as const;

const LOW_BEAM = 2;

/** What the autopilot reads: the course near the runner in flat arrays. */
export interface RunnerView {
  readonly targetLane: number;
  readonly grounded: boolean;
  readonly forward: number;
  readonly effectiveSpeed: number;
  readonly obstacleCount: number;
  readonly obstacleLane: Int8Array;
  readonly obstacleType: Int8Array;
  readonly obstacleForward: Float32Array;
  readonly obstacleAlive: Uint8Array;
  readonly itemCount: number;
  readonly itemLane: Int8Array;
  readonly itemType: Int8Array;
  readonly itemForward: Float32Array;
  readonly itemActive: Uint8Array;
}

export class RunnerAi {
  private freeze = 0;
  // the nearest obstacle ahead (distance > -1) per lane
  private readonly nearDist = new Float32Array(3);
  private readonly nearType = new Int8Array(3);

  reset(): void {
    this.freeze = 0;
  }

  decide(v: RunnerView, dt: number): number {
    this.freeze = Math.max(0, this.freeze - dt);
    const command = this.choose(v);
    if (command === COMMAND.left || command === COMMAND.right) this.freeze = 1;
    return command;
  }

  private scan(v: RunnerView): void {
    const nd = this.nearDist, nt = this.nearType;
    nd[0] = nd[1] = nd[2] = 1e9;
    nt[0] = nt[1] = nt[2] = -1;
    const pf = v.forward;
    const lane = v.obstacleLane, type = v.obstacleType, fwd = v.obstacleForward, alive = v.obstacleAlive;
    for (let i = 0; i < v.obstacleCount; i++) {
      if (!alive[i]) continue;
      const d = fwd[i] - pf;
      if (d <= -1) continue;
      const l = lane[i];
      if (d < nd[l]) {
        nd[l] = d;
        nt[l] = type[i];
      }
    }
  }

  private slideDistance(v: RunnerView): number {
    return Math.max(10, v.effectiveSpeed * 0.85);
  }

  private urgentLowBeam(v: RunnerView, lane: number): boolean {
    return this.nearType[lane] === LOW_BEAM && this.nearDist[lane] < this.slideDistance(v) * 1.35;
  }

  private choose(v: RunnerView): number {
    this.scan(v);
    const lane = v.targetLane;
    const dType = this.nearType[lane];
    const dDist = this.nearDist[lane];
    const ground = dType === 0 || dType === 1;
    if (dType === LOW_BEAM && dDist < this.slideDistance(v) && v.grounded) return COMMAND.slide;
    if (ground && dDist < Math.max(6, v.effectiveSpeed * 0.45) && v.grounded) return COMMAND.jump;
    if (ground && dDist < Math.max(18, v.effectiveSpeed * 1.55)) {
      const safest = this.safestLane(v);
      if (safest !== lane) return safest < lane ? COMMAND.left : COMMAND.right;
    }
    if (this.freeze > 0) return COMMAND.none;
    const pickup = this.collectibleLane(v);
    if (pickup >= 0 && pickup !== lane) return pickup < lane ? COMMAND.left : COMMAND.right;
    return COMMAND.none;
  }

  private safestLane(v: RunnerView): number {
    let best = v.targetLane;
    let bestScore = -1e9;
    for (let l = 0; l < 3; l++) {
      const clear = this.nearType[l] >= 0 ? this.nearDist[l] : 999;
      const cost = Math.abs(l - v.targetLane) * 2.5;
      const centred = l === 1 ? 1.5 : 0;
      const beam = this.urgentLowBeam(v, l) && l !== v.targetLane ? 40 : 0;
      const score = clear - cost + centred - beam;
      if (score > bestScore) {
        bestScore = score;
        best = l;
      }
    }
    return best;
  }

  private laneSafe(v: RunnerView, lane: number, lookAhead: number): boolean {
    const t = this.nearType[lane];
    if (t < 0) return true;
    if (t === LOW_BEAM) return !this.urgentLowBeam(v, lane);
    return this.nearDist[lane] > lookAhead;
  }

  /** The demo's sort (boosts first, then the nearest) as one pass. */
  private collectibleLane(v: RunnerView): number {
    const pf = v.forward;
    let pick = -1;
    let pickBoost = false;
    let pickDist = 1e9;
    for (let i = 0; i < v.itemCount; i++) {
      if (!v.itemActive[i]) continue;
      const d = v.itemForward[i] - pf;
      if (d <= 4 || d >= 34) continue;
      if (!this.laneSafe(v, v.itemLane[i], d + 8)) continue;
      const boost = v.itemType[i] === 1;
      if (pick < 0 || (boost && !pickBoost) || (boost === pickBoost && d < pickDist)) {
        pick = i;
        pickBoost = boost;
        pickDist = d;
      }
    }
    if (pick < 0) return -1;
    const steps = Math.abs(v.itemLane[pick] - v.targetLane);
    return pickDist > 7 + steps * 4 ? v.itemLane[pick] : -1;
  }
}
