// Robotic Arm's demo autopilot, ported from GameBlocks' robotic-arm
// player-ai.js (https://gb-robotic-arm.vercel.app/src/player-ai.js, MIT,
// xt4d/GameBlocks).
//
// The same operator as the demo's: it presses the demo's keys (W/S walk,
// I/J/K/L look, Q/E reach, Space grip) through the same phases (move to the
// pickup, hover, lower, grip; lift, carry, hover, lower, settle, release),
// reading the game's state directly instead of its JSON text. Written for
// the 3DS interpreter: it runs every 3rd frame, keys are a bit mask, points
// live in fields, and nothing allocates.
//
// Deviations: shouldDriveAxis returns the pulse duty instead of testing the
// frame counter; the game applies the duty at the frame rate, so the demo's
// 6-frame pulse survives the slower decision rate. The grip check runs every
// frame (react). ARM_PATH_STEP scales by the decision interval. A phase that
// stalls for 9 s starts over (the attract loop must not hang). The status
// line is a code plus a can.

import type { RoboticArm } from "./game.ts";
import { TABLES } from "./visuals.ts";

export const CAN = { LOOSE: 0, HELD: 1, SETTLING: 2, DELIVERED: 3 } as const;
export const STATUS = { READY: 0, RELEASE: 1, CARRY: 2, GRIP: 3, BEYOND: 4, ALIGN: 5, COMPLETE: 6 } as const;
/** the demo's control keys as bits */
export const KEY = { W: 1, S: 2, I: 4, K: 8, J: 16, L: 32, Q: 64, E: 128 } as const;

/** A point's place in the camera frame (the demo's cameraFrustumPayload). */
export class View {
  centerIn = false;
  fullyIn = false;
  x = 0;
  y = 0;
  depth = 0;
}

const OPERATOR_RIGHT = 0;
const OPERATOR_FORWARD = -0.62;
const PLAYER_PICKUP_BACKOFF = 1.05;
const PLAYER_PICKUP_MAX_FORWARD = 1.55;
const PLAYER_DROP_BACKOFF = 1.35;
const PLAYER_DROP_MAX_FORWARD = 1.55;
const PLAYER_TOLERANCE = 0.08;
const DROP_TOLERANCE = 0.26;
const PICKUP_GRIP_TOLERANCE = 0.1;
const AI_GRIP_LOCAL_LATERAL_TOLERANCE = 0.13;
const AI_GRIP_LOCAL_DEPTH_TOLERANCE = 0.16;
const AI_GRIP_LOCAL_VERTICAL_TOLERANCE = 0.12;
const AI_GRIP_CENTERING_VERTICAL_WINDOW = 0.46;
const DROP_RELEASE_HEIGHT = 1.02;
const DROP_RELEASE_VERTICAL_MARGIN = 0.42;
const DROP_SAFE_LOWER_TOLERANCE = 0.05;
const RECEIVE_SAFE_DROP_MARGIN = 0.18;
const PICKUP_TRAVEL_CLEARANCE_HEIGHT = 1.56;
const PICKUP_TRAVEL_MAX_HEIGHT = 1.66;
const PICKUP_HORIZONTAL_TOLERANCE = 0.14;
const PICKUP_REAIM_TOLERANCE = 0.18;
const PICKUP_LOCAL_REAIM_TOLERANCE = 0.28;
const PICKUP_LOWER_HEIGHT_MARGIN = 0.1;
const PICKUP_CENTERING_HEIGHT_MARGIN = 0.18;
const PICKUP_SWING_REACH = 1.04;
const CARRY_HORIZONTAL_CLEARANCE_DISTANCE = 0.34;
const CARRY_TRAVEL_CLEARANCE_HEIGHT = 1.56;
const CARRY_HEIGHT = 1.6;
const CARRY_LIFT_READY_HEIGHT = 1.54;
const ARM_YAW_TOLERANCE = 0.045;
const ARM_UP_TOLERANCE = 0.06;
const ARM_REACH_TOLERANCE = 0.07;
const ARM_PATH_STEP = 0.06;
const ARM_GOAL_LEAD_LIMIT = 0.18;
const ARM_GOAL_RESET_DISTANCE = 0.9;
const ARM_GOAL_TARGET_RESET_DISTANCE = 0.32;
const ARM_GOAL_TOLERANCE = 0.03;
const ARM_MIN_REACH_LIMIT = 0.88;
const PLAYER_FINE_CONTROL_DISTANCE = 0.34;
const ARM_FINE_CONTROL_DISTANCE = 0.28;
const ARM_YAW_FINE_CONTROL_DISTANCE = 0.32;
const CONTROL_KEY_HOLD_SECONDS = 0.14;
const GRIP_COOLDOWN_SECONDS = 0.32;
const DROP_SETTLE_SECONDS = 0.45;
const VIEW_CENTER_TOLERANCE = 0.12;
const VIEW_DROP_NDC_LIMIT = 0.72;
const VIEW_DROP_RADIUS = 0.18;
const CARRY_MIN_VIEW_PITCH = 0.02;
const CARRY_DROP_LOOK_UP = 1.56;
const CAN_VIEW_RADIUS = Math.hypot(0.16, 0.29);
/** not in the demo: the attract loop's watchdog */
const STALL_SECONDS = 9;
/** red, green, blue: where each can goes on the receiving table */
const DROP_RIGHT = 1.9;
const DROP_FORWARD = [1.15, 2.0, 2.85];

const YAW_KEYS = KEY.J | KEY.L;

const PHASE = {
  IDLE: 0,
  MOVE_TO_PICKUP: 1,
  PICKUP_HOVER: 2,
  PICKUP_LOWER: 3,
  LIFT_CARGO: 4,
  MOVE_TO_DROP: 5,
  DROP_HOVER: 6,
  DROP_LOWER: 7,
  DROP_SETTLE: 8,
} as const;

/** Status lines; "$" is the can's name. */
export const AI_STATUS_TEXT = [
  "Auto waiting",
  "Auto gripping $",
  "Auto moving to $",
  "Auto lifting for $",
  "Auto raising claw for $",
  "Auto leveling claw for $",
  "Auto retracting for $",
  "Auto rotating to $",
  "Auto aiming $ horizontally",
  "Auto centering $",
  "Auto re-raising $",
  "Auto lowering $",
  "Auto lifting $",
  "Auto settling $",
  "Auto releasing $",
  "Auto raising $ for travel",
  "Auto leveling view with $",
  "Auto aiming drop $",
  "Auto carrying $",
  "Auto hovering $",
  "Auto complete",
  "Auto recovering",
] as const;
const S = {
  WAITING: 0, GRIPPING: 1, MOVING: 2, LIFTING_FOR: 3, RAISING_CLAW: 4, LEVELING_CLAW: 5, RETRACTING: 6, ROTATING: 7,
  AIMING: 8, CENTERING: 9, RE_RAISING: 10, LOWERING: 11, LIFTING: 12, SETTLING: 13, RELEASING: 14, RAISING_TRAVEL: 15,
  LEVELING_VIEW: 16, AIMING_DROP: 17, CARRYING: 18, HOVERING: 19, COMPLETE: 20, RECOVERING: 21,
} as const;

/** A point in the demo's basis (right, up, forward). */
class P {
  r = 0;
  u = 0;
  f = 0;
  set(r: number, u: number, f: number): this {
    this.r = r;
    this.u = u;
    this.f = f;
    return this;
  }
  copy(p: P): this {
    return this.set(p.r, p.u, p.f);
  }
}

const dist3 = (a: P, b: P) => Math.sqrt((a.r - b.r) * (a.r - b.r) + (a.u - b.u) * (a.u - b.u) + (a.f - b.f) * (a.f - b.f));
const planar = (ar: number, af: number, br: number, bf: number) => Math.sqrt((ar - br) * (ar - br) + (af - bf) * (af - bf));
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
function normalizeAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
/** shouldDriveAxis as a duty: 0 off, 1 always, else the pulse fraction */
function driveDuty(delta: number, tolerance: number, full: number): number {
  const m = Math.abs(delta);
  if (m <= tolerance) return 0;
  if (m >= full) return 1;
  return clamp((m - tolerance) / (full - tolerance), 0.28, 1);
}
const bitIndex = (bit: number) => 31 - Math.clz32(bit);

export class ArmAutopilot {
  enabled = false;
  /** keys held now, and each key's pulse duty (KEY bit order) */
  keys = 0;
  readonly duty = new Float32Array(8);
  status: number = S.WAITING;
  statusCan = -1;
  private cooldown = 0;
  private phaseTime = 0;
  private phase: number = PHASE.IDLE;
  private target = -1;
  private hasGoal = false;
  private readonly goal = new P();
  private hasGoalTarget = false;
  private readonly goalTarget = new P();
  private stableKeys = 0;
  private readonly stableDuty = new Float32Array(8);
  /** duties of the keys the current decision pressed */
  private readonly want = new Float32Array(8);
  private keyHoldTimer = 0;
  private grip = false;
  private interval = 1 / 60;
  // scratch: the state the demo read through getState()
  private readonly tip = new P();
  private readonly gripPos = new P();
  private readonly base = new P();
  private readonly cargoPos = new P();
  private readonly point = new P();
  private readonly cargoView = new View();
  private readonly pointView = new View();
  private aligned = false;

  constructor(private readonly game: RoboticArm) {}

  reset(demo: boolean): void {
    this.enabled = demo;
    this.cooldown = 0;
    this.phaseTime = 0;
    this.phase = PHASE.IDLE;
    this.setPhase(PHASE.MOVE_TO_PICKUP);
    this.target = -1;
    this.keys = 0;
    this.grip = false;
    this.status = S.WAITING;
    this.statusCan = -1;
  }

  takeGrip(): boolean {
    const g = this.grip;
    this.grip = false;
    return g;
  }

  private setPhase(phase: number): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.hasGoal = false;
    this.hasGoalTarget = false;
    this.phaseTime = 0;
    this.stableKeys = 0;
    this.keyHoldTimer = 0;
  }

  /** Every frame between decisions: the demo grips the frame the game says
   *  "Grip <can>", which a 3-frame cadence would miss while lowering. */
  react(): void {
    if (!this.enabled || this.cooldown > 0 || this.game.held >= 0) return;
    if (this.phase < PHASE.MOVE_TO_PICKUP || this.phase > PHASE.PICKUP_LOWER) return;
    if (this.target >= 0 && this.gripReadyFor(this.target)) {
      this.grip = true;
      this.cooldown = GRIP_COOLDOWN_SECONDS;
      this.keys = 0;
      this.status = S.GRIPPING;
    }
  }

  /** One decision; `dt` is the time since the last one. */
  step(dt: number): void {
    if (!this.enabled) return;
    this.interval = dt;
    this.phaseTime += dt;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.keyHoldTimer = Math.max(0, this.keyHoldTimer - dt);
    this.want.fill(1);
    // an attract-loop watchdog: a phase that stalls starts over from its top
    if (this.phaseTime > STALL_SECONDS && this.phase !== PHASE.MOVE_TO_PICKUP && this.phase !== PHASE.LIFT_CARGO) {
      this.setPhase(this.phase >= PHASE.LIFT_CARGO ? PHASE.LIFT_CARGO : PHASE.MOVE_TO_PICKUP);
    }
    const g = this.game;
    if (g.hud.delivered >= 3) {
      this.enabled = false;
      this.keys = 0;
      this.status = S.COMPLETE;
      return;
    }
    // what getState() reported: tip, grip and base in the demo's basis
    this.tip.set(g.tipx, g.tipy, -g.tipz);
    this.gripPos.set(g.gx, g.gy, -g.gz);
    this.base.set(g.bx, g.by, -g.bz);
    if (g.held >= 0) {
      if (this.target !== g.held || this.phase < PHASE.LIFT_CARGO) {
        this.target = g.held;
        this.setPhase(PHASE.LIFT_CARGO);
      }
      this.deliverHeldCargo(g.held);
      return;
    }
    const cargo = this.chooseCargo();
    if (cargo < 0) {
      this.setControls(0, S.WAITING, -1, false);
      return;
    }
    if (this.target !== cargo || this.phase < PHASE.MOVE_TO_PICKUP || this.phase > PHASE.PICKUP_LOWER) {
      this.target = cargo;
      this.setPhase(PHASE.MOVE_TO_PICKUP);
    }
    this.moveToPickup(cargo);
  }

  private loadCargo(i: number): void {
    const c = this.game.cargo[i];
    this.cargoPos.set(c.x, c.y, -c.z);
    this.game.view(c.x, c.y, -c.z, CAN_VIEW_RADIUS, this.cargoView);
  }

  private moveToPickup(i: number): void {
    const g = this.game;
    const c = g.cargo[i];
    this.loadCargo(i);
    const cargo = this.cargoPos;
    const targetF = clamp(cargo.f - PLAYER_PICKUP_BACKOFF, OPERATOR_FORWARD, PLAYER_PICKUP_MAX_FORWARD);
    const playerReady = this.playerAt(targetF);
    const playerKeys = playerReady ? 0 : this.playerKeysToward(targetF);
    const gripReady = this.gripReadyFor(i);
    const grip = this.gripPos;
    const travelLiftReady = grip.u >= PICKUP_TRAVEL_CLEARANCE_HEIGHT;

    if (gripReady) {
      this.setControls(0, S.GRIPPING, i, false);
      this.queueGrip();
      return;
    }
    if (!playerReady) {
      this.setControls(travelLiftReady ? playerKeys : playerKeys | KEY.I, travelLiftReady ? S.MOVING : S.LIFTING_FOR, i, !travelLiftReady);
      return;
    }
    if (this.phase === PHASE.MOVE_TO_PICKUP) {
      if (!travelLiftReady) {
        this.setControls(KEY.I, S.RAISING_CLAW, i, true);
        return;
      }
      this.setPhase(PHASE.PICKUP_HOVER);
    }
    if (this.phase === PHASE.PICKUP_HOVER) {
      if (grip.u < PICKUP_TRAVEL_CLEARANCE_HEIGHT) {
        this.setControls(KEY.I, S.RAISING_CLAW, i, true);
        return;
      }
      if (grip.u > PICKUP_TRAVEL_MAX_HEIGHT) {
        this.setControls(KEY.K, S.LEVELING_CLAW, i, true);
        return;
      }
      const centered = viewHorizontallyCentered(this.cargoView, VIEW_CENTER_TOLERANCE);
      if (g.reach > PICKUP_SWING_REACH && !centered) {
        this.setControls(KEY.Q, S.RETRACTING, i, true);
        return;
      }
      if (!centered) {
        this.setControls(horizontalViewKeys(this.cargoView), S.ROTATING, i, true);
        return;
      }
      const keys = this.armKeysTowardGripPlanar(cargo.r, cargo.f, PICKUP_HORIZONTAL_TOLERANCE, this.cargoView);
      if (!this.aligned) {
        this.setControls(keys, S.AIMING, i, true);
        return;
      }
      this.setPhase(PHASE.PICKUP_LOWER);
    }
    // lowering: centre the pocket, re-raise when it drifts, then go down
    const canCenterSafely = grip.u > cargo.u + PICKUP_CENTERING_HEIGHT_MARGIN;
    if (needsHorizontalGripCentering(c) && canCenterSafely) {
      // clawLocalHorizontalCorrectionPoint: claw X and Z in the demo's basis
      const xr = g.crx, xf = -g.crz;
      const zr = -g.tx, zf = g.tz;
      const pr = grip.r + xr * c.lateral + zr * c.depth;
      const pf = grip.f + xf * c.lateral + zf * c.depth;
      const keys = this.armKeysTowardGripPlanar(pr, pf, PICKUP_GRIP_TOLERANCE, this.cargoView);
      if (!this.aligned && keys !== 0) {
        this.setControls(keys, S.CENTERING, i, true);
        return;
      }
    }
    if (!this.pickupHorizontallyAligned(c, PICKUP_REAIM_TOLERANCE) && canCenterSafely) {
      this.setPhase(PHASE.PICKUP_HOVER);
      this.setControls(KEY.I, S.RE_RAISING, i, true);
      return;
    }
    // tipTargetForGrip: the tip goal that puts the grip on the can
    const gp = this.point.set(cargo.r + (this.tip.r - grip.r), cargo.u + (this.tip.u - grip.u), cargo.f + (this.tip.f - grip.f));
    const keys = this.armKeysTowardContiguous(gp, PICKUP_GRIP_TOLERANCE);
    if ((keys & YAW_KEYS) !== 0 && canCenterSafely) {
      this.setPhase(PHASE.PICKUP_HOVER);
      this.setControls(KEY.I, S.RE_RAISING, i, true);
      return;
    }
    let lower = keys & ~YAW_KEYS;
    if (grip.u > cargo.u + PICKUP_LOWER_HEIGHT_MARGIN && (lower & KEY.K) === 0) {
      lower |= KEY.K;
      this.want[bitIndex(KEY.K)] = 1;
    }
    this.setControls(lower, S.LOWERING, i, false);
  }

  private deliverHeldCargo(i: number): void {
    const g = this.game;
    this.loadCargo(i);
    const cargo = this.cargoPos;
    const dropR = DROP_RIGHT;
    const dropF = DROP_FORWARD[i];
    if (this.phase === PHASE.LIFT_CARGO) {
      if (cargo.u < CARRY_LIFT_READY_HEIGHT) {
        this.setControls(KEY.I, S.LIFTING, i, true);
        return;
      }
      this.setPhase(PHASE.MOVE_TO_DROP);
    }
    const onReceivingTable = g.status === STATUS.RELEASE;
    const releaseHeightReady = cargo.u <= DROP_RELEASE_HEIGHT + DROP_RELEASE_VERTICAL_MARGIN;
    const safe = insideTable(cargo.r, cargo.f, TABLES.receive, RECEIVE_SAFE_DROP_MARGIN);
    if (safe && releaseHeightReady) {
      if (this.phase !== PHASE.DROP_SETTLE) {
        this.setPhase(PHASE.DROP_SETTLE);
        this.setControls(0, S.SETTLING, i, false);
        return;
      }
      if (this.phaseTime < DROP_SETTLE_SECONDS) {
        this.setControls(0, S.SETTLING, i, false);
        return;
      }
      this.setControls(0, S.RELEASING, i, false);
      this.queueGrip();
      return;
    }
    if (safe && !releaseHeightReady) {
      this.setPhase(PHASE.DROP_LOWER);
      this.setControls(KEY.K, S.LOWERING, i, true);
      return;
    }
    if (!safe && cargo.u < CARRY_TRAVEL_CLEARANCE_HEIGHT && planar(cargo.r, cargo.f, dropR, dropF) > CARRY_HORIZONTAL_CLEARANCE_DISTANCE) {
      this.setPhase(PHASE.MOVE_TO_DROP);
      this.setControls(KEY.I, S.RAISING_TRAVEL, i, true);
      return;
    }
    if (!(g.pitch >= CARRY_MIN_VIEW_PITCH)) {
      this.setControls(KEY.I, S.LEVELING_VIEW, i, true);
      return;
    }
    const dropView = g.view(dropR, CARRY_DROP_LOOK_UP, dropF, VIEW_DROP_RADIUS, this.pointView);
    if (this.phase !== PHASE.DROP_SETTLE && !viewHorizontallyCentered(dropView, VIEW_DROP_NDC_LIMIT)) {
      // carryViewKeysTowardView: the pitch is already at or above the horizon
      this.setControls(horizontalViewKeys(dropView), S.AIMING_DROP, i, false);
      return;
    }
    const playerF = clamp(dropF - PLAYER_DROP_BACKOFF, OPERATOR_FORWARD, PLAYER_DROP_MAX_FORWARD);
    const playerReady = this.playerAt(playerF);
    const playerKeys = playerReady ? 0 : this.playerKeysToward(playerF);
    // heldCargoAimPoint: the tip goal that puts the can over the target
    const tip = this.tip;
    if (this.phase === PHASE.MOVE_TO_DROP) {
      const carry = this.point.set(dropR - (cargo.r - tip.r), CARRY_HEIGHT, dropF - (cargo.f - tip.f));
      const keys = this.armKeysTowardContiguous(carry, 0.58);
      if (!playerReady || !this.aligned) {
        this.setControls(playerKeys | keys, S.CARRYING, i, false);
        return;
      }
      this.setPhase(PHASE.DROP_HOVER);
    }
    if (this.phase === PHASE.DROP_HOVER) {
      const hover = this.point.set(dropR - (cargo.r - tip.r), CARRY_HEIGHT, dropF - (cargo.f - tip.f));
      const keys = this.armKeysTowardContiguous(hover, 0.42);
      if (!this.aligned) {
        this.setControls(keys, S.HOVERING, i, false);
        return;
      }
      this.setPhase(PHASE.DROP_LOWER);
    }
    const drop = this.point.set(dropR - (cargo.r - tip.r), DROP_RELEASE_HEIGHT, dropF - (cargo.f - tip.f));
    const keys = this.armKeysTowardContiguous(drop, onReceivingTable ? DROP_SAFE_LOWER_TOLERANCE : DROP_TOLERANCE);
    this.setControls(keys, S.LOWERING, i, false);
  }

  private chooseCargo(): number {
    for (let i = 0; i < 3; i++) if (this.isPickupCandidate(i) && this.gripReadyFor(i)) return i;
    for (let i = 0; i < 3; i++) if (this.isPickupCandidate(i)) return i;
    return -1;
  }

  private isPickupCandidate(i: number): boolean {
    const c = this.game.cargo[i];
    if (c.state !== CAN.LOOSE) return false;
    const f = -c.z;
    return insideTable(c.x, f, TABLES.serve, 0.08) || !insideTable(c.x, f, TABLES.receive, RECEIVE_SAFE_DROP_MARGIN);
  }

  /** aiGripReadyForCargo: the game says "Grip <can>" and the pocket is around it */
  private gripReadyFor(i: number): boolean {
    const g = this.game;
    if (g.status !== STATUS.GRIP || g.statusCan !== i) return false;
    const c = g.cargo[i];
    if (!c.aligned) return false;
    return true;
  }

  private pickupHorizontallyAligned(c: { lateral: number; depth: number; x: number; z: number }, tolerance: number): boolean {
    if (Math.abs(c.lateral) <= PICKUP_LOCAL_REAIM_TOLERANCE && Math.abs(c.depth) <= PICKUP_LOCAL_REAIM_TOLERANCE) return true;
    return planar(this.gripPos.r, this.gripPos.f, c.x, -c.z) <= tolerance;
  }

  private playerAt(forward: number): boolean {
    return Math.abs(OPERATOR_RIGHT - 0) <= PLAYER_TOLERANCE && Math.abs(forward - -this.game.pz) <= PLAYER_TOLERANCE;
  }

  private playerKeysToward(forward: number): number {
    const delta = forward - -this.game.pz;
    const d = driveDuty(delta, PLAYER_TOLERANCE, PLAYER_FINE_CONTROL_DISTANCE);
    if (d <= 0) return 0;
    const key = delta > 0 ? KEY.W : KEY.S;
    this.want[bitIndex(key)] = d;
    return key;
  }

  private reachKeys(reachDelta: number): number {
    const d = driveDuty(reachDelta, ARM_REACH_TOLERANCE, ARM_FINE_CONTROL_DISTANCE);
    if (reachDelta < -ARM_REACH_TOLERANCE && this.game.reach > ARM_MIN_REACH_LIMIT && d > 0) {
      this.want[bitIndex(KEY.Q)] = d;
      return KEY.Q;
    }
    if (reachDelta > ARM_REACH_TOLERANCE && d > 0) {
      this.want[bitIndex(KEY.E)] = d;
      return KEY.E;
    }
    return 0;
  }

  /** armKeysTowardGripPlanar; sets `aligned`. */
  private armKeysTowardGripPlanar(gr: number, gf: number, tolerance: number, view: View): number {
    const grip = this.gripPos, tip = this.tip, base = this.base;
    if (planar(grip.r, grip.f, gr, gf) <= tolerance) {
      this.aligned = true;
      return 0;
    }
    this.aligned = false;
    const tr = gr + (tip.r - grip.r);
    const tf = gf + (tip.f - grip.f);
    let keys = horizontalViewKeys(view);
    const brd = tr - base.r, bfd = tf - base.f;
    const trd = tip.r - base.r, tfd = tip.f - base.f;
    const yawDelta = normalizeAngle(Math.atan2(brd, bfd) - Math.atan2(trd, tfd));
    const reachDelta = Math.sqrt(brd * brd + bfd * bfd) - Math.sqrt(trd * trd + tfd * tfd);
    if (keys === 0) {
      const d = driveDuty(yawDelta, ARM_YAW_TOLERANCE, ARM_YAW_FINE_CONTROL_DISTANCE);
      if (d > 0) {
        const key = yawDelta > 0 ? KEY.L : KEY.J;
        this.want[bitIndex(key)] = d;
        keys |= key;
      }
    }
    return keys | this.reachKeys(reachDelta);
  }

  /** armKeysToward; sets `aligned`. */
  private armKeysToward(target: P, tolerance: number): number {
    const tip = this.tip, base = this.base;
    const upDelta = target.u - tip.u;
    if (dist3(target, tip) <= tolerance) {
      this.aligned = true;
      return 0;
    }
    this.aligned = false;
    const brd = target.r - base.r, bfd = target.f - base.f;
    const trd = tip.r - base.r, tfd = tip.f - base.f;
    const reachDelta = Math.sqrt(brd * brd + bfd * bfd) - Math.sqrt(trd * trd + tfd * tfd);
    const view = this.game.view(target.r, target.u, target.f, 0.05, this.pointView);
    let keys = horizontalViewKeys(view);
    if (view.y > VIEW_CENTER_TOLERANCE) keys |= KEY.I;
    else if (view.y < -VIEW_CENTER_TOLERANCE) keys |= KEY.K;
    if (keys === 0 && Math.abs(upDelta) > ARM_UP_TOLERANCE) keys |= upDelta > 0 ? KEY.I : KEY.K;
    return keys | this.reachKeys(reachDelta);
  }

  /** armKeysTowardContiguous: a goal that walks toward the target; sets `aligned`. */
  private armKeysTowardContiguous(target: P, tolerance: number): number {
    const tip = this.tip;
    const goal = this.goal;
    const changed = !this.hasGoalTarget || dist3(this.goalTarget, target) > ARM_GOAL_TARGET_RESET_DISTANCE;
    if (!this.hasGoal || changed || dist3(goal, tip) > ARM_GOAL_RESET_DISTANCE) {
      goal.copy(tip);
      this.hasGoal = true;
    }
    this.goalTarget.copy(target);
    this.hasGoalTarget = true;
    if (dist3(goal, tip) <= ARM_GOAL_LEAD_LIMIT) {
      const gd = dist3(goal, target);
      const step = ARM_PATH_STEP * Math.max(1, this.interval * 60);
      if (gd <= step) goal.copy(target);
      else {
        const k = step / gd;
        goal.set(goal.r + (target.r - goal.r) * k, goal.u + (target.u - goal.u) * k, goal.f + (target.f - goal.f) * k);
      }
    }
    const toTarget = dist3(tip, target);
    const targetAligned = toTarget <= tolerance;
    const smoothed = toTarget <= ARM_FINE_CONTROL_DISTANCE * 1.25;
    let keys = 0;
    if (!targetAligned) {
      keys = this.armKeysToward(smoothed ? goal : target, ARM_GOAL_TOLERANCE);
      if (keys === 0) keys = this.armKeysToward(target, tolerance);
    }
    this.aligned = targetAligned;
    return keys;
  }

  private queueGrip(): void {
    if (this.cooldown > 0) return;
    this.grip = true;
    this.cooldown = GRIP_COOLDOWN_SECONDS;
  }

  /** setControls: a new key set replaces the held one only after it has
   *  been held CONTROL_KEY_HOLD_SECONDS, unless it is immediate or empty. */
  private setControls(keys: number, status: number, can: number, immediate: boolean): void {
    if (immediate || keys === 0 || keys === this.stableKeys || this.keyHoldTimer <= 0) {
      this.stableKeys = keys;
      this.stableDuty.set(this.want);
      this.keyHoldTimer = keys !== 0 ? CONTROL_KEY_HOLD_SECONDS : 0;
    }
    this.keys = this.stableKeys;
    this.duty.set(this.stableDuty);
    this.status = status;
    this.statusCan = can;
  }
}

function insideTable(r: number, f: number, t: { centerRight: number; centerForward: number; halfRight: number; halfForward: number }, margin: number): boolean {
  return (
    r >= t.centerRight - t.halfRight + margin &&
    r <= t.centerRight + t.halfRight - margin &&
    f >= t.centerForward - t.halfForward + margin &&
    f <= t.centerForward + t.halfForward - margin
  );
}

function needsHorizontalGripCentering(c: { lateral: number; depth: number; vertical: number }): boolean {
  return (
    c.vertical < -AI_GRIP_LOCAL_VERTICAL_TOLERANCE &&
    c.vertical > -AI_GRIP_CENTERING_VERTICAL_WINDOW &&
    (Math.abs(c.lateral) > AI_GRIP_LOCAL_LATERAL_TOLERANCE || Math.abs(c.depth) > AI_GRIP_LOCAL_DEPTH_TOLERANCE)
  );
}

function viewHorizontallyCentered(view: View, limit: number): boolean {
  return view.depth > 0 && Math.abs(view.x) <= limit;
}

/** horizontalViewKeysTowardView */
function horizontalViewKeys(view: View): number {
  const x = view.x;
  if (view.depth <= 0 && Math.abs(x) <= VIEW_CENTER_TOLERANCE) return KEY.L;
  if (x > VIEW_CENTER_TOLERANCE) return KEY.L;
  if (x < -VIEW_CENTER_TOLERANCE) return KEY.J;
  return 0;
}
