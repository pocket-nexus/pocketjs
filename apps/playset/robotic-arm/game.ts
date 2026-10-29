// Robotic Arm's gameplay over the playset kernels, ported from GameBlocks'
// robotic-arm demo (https://gb-robotic-arm.vercel.app/, MIT, xt4d/GameBlocks).
//
// The operator walks the aisle between a serving and a receiving table and
// looks around; a two-segment arm hangs from the view and reaches for the
// look point; the claw grips the three cans and drops them on the
// receiving table. The job is done when all three rest there.
//
// What runs where:
//   native, every step — the first-person camera on the operator slot, a
//     held can riding the claw (attached kernel), falling cans (ballistic
//     kernel, the floor landing and its GROUND event), the finger hinges
//     (joint.script drivers), the servo loop and every sound;
//   here, every frame — the operator's walk and look, the demo's two-bone
//     IK and claw frame (one solve, no allocation), the slot transforms of
//     the two arm segments, landings on the table tops, the delivery
//     timers and the status line;
//   here, every 3rd frame — the autopilot (ai.ts).
//
// Deviations: Rapier is gone. The arm's sweep against the tables becomes
// the demo's own floor on the claw goal (table top + 0.12 m), the arm
// passes through cans, and a released can falls straight (with the claw's
// velocity) and lands upright on a table top or the floor instead of
// tumbling. Sprint and crouch are dropped.
//
// Coordinates: the demo's (right, up, forward) is (x, y, -z) here.

import { ENT, EVENT, STATE, createPlayset, joint, motion, sfx, type Archetype, type Playset, type Sound } from "@pocketjs/framework/playset";
import type { GameStatus, Pad, PlaysetGame } from "../kit/game.ts";
import { AI_STATUS_TEXT, ArmAutopilot, CAN, KEY, STATUS, View } from "./ai.ts";
import * as V from "./visuals.ts";

const DT = 1 / 60;
const EYE_HEIGHT = 1.56;
const WALK_SPEED = 2.15;
const ACCEL_LAG = 0.08;
const DECEL_LAG = 0.1;
/** the demo's look keys: 520 px/s of mouse at 0.0022 / 0.0018 rad per px */
const YAW_RATE = 520 * 0.0022;
const PITCH_RATE = 520 * 0.0018;
const PITCH_MIN = -1.16;
const PITCH_MAX = 0.58;
const REACH_RATE = 1.35;
const MIN_REACH = 0.86;
const MAX_REACH = 1.64;
const START_REACH = 1.18;
const LIFT_OFFSET = 0.146;
const PLAYER_MIN_FORWARD = -2;
const PLAYER_MAX_FORWARD = 2;
const PICKUP_RADIUS = 0.62;
const GRIP_LATERAL = 0.32;
const GRIP_DEPTH = 0.32;
const GRIP_VERTICAL = 0.18;
const DELIVERY_SETTLE_SECONDS = 0.28;
const AI_RELEASE_MAX_SPEED = 0.05;
const MAX_IK = V.UPPER_LENGTH + V.FOREARM_LENGTH - 0.035;
const MIN_IK = Math.abs(V.UPPER_LENGTH - V.FOREARM_LENGTH) + 0.08;
const ASPECT = 400 / 240;
export const FOV = 72;
const TAN_HALF_FOV = Math.tan((FOV * Math.PI) / 360);
const DPAD = 0x0010 | 0x0020 | 0x0040 | 0x0080;
const BTN_L = 0x0100;
const BTN_R = 0x0200;
const BTN_A = 0x2000;


export class Cargo {
  slot = -1;
  state: number = CAN.LOOSE;
  airborne = false;
  settle = 0;
  /** the can's centre (the model stands on its bottom) */
  x = 0;
  y = 0;
  z = 0;
  prevY = 0;
  /** claw-local grip alignment, refreshed every frame */
  lateral = 0;
  vertical = 0;
  depth = 0;
  distance = 0;
  aligned = false;
}

export interface Hud {
  status: "title" | "playing" | "gameover";
  demo: boolean;
  delivered: number;
  seconds: number;
}

export class RoboticArm {
  readonly play: Playset;
  readonly hud: Hud = { status: "title", demo: true, delivered: 0, seconds: 0 };
  readonly cargo: Cargo[] = [new Cargo(), new Cargo(), new Cargo()];
  readonly ai: ArmAutopilot;
  // operator: right is pinned at 0 by the demo's clamp; forward = -z
  pz = 1.62;
  vf = 0;
  yaw = 0;
  pitch = -0.28;
  // view frame: forward F, right R, up U, eye
  fx = 0; fy = 0; fz = -1;
  rx = 1; ry = 0; rz = 0;
  ux = 0; uy = 1; uz = 0;
  ex = 0; ey = EYE_HEIGHT; ez = 0;
  // arm pose
  reach = START_REACH;
  bx = 0; by = 0; bz = 0;
  dx = 0; dy = 0; dz = 0;
  elx = 0; ely = 0; elz = 0;
  wx = 0; wy = 0; wz = 0;
  tipx = 0; tipy = 0; tipz = 0;
  /** tool forward T, claw right Cr, claw up Cu */
  tx = 0; ty = 0; tz = -1;
  crx = 1; cry = 0; crz = 0;
  cux = 0; cuy = 1; cuz = 0;
  gx = 0; gy = 0; gz = 0;
  private pgx = 0;
  private pgy = 0;
  private pgz = 0;
  reachable = true;
  held = -1;
  clawClosed = false;
  clawGap = V.CLAW_OPEN_GAP;
  missedGrip = 0;
  status: number = STATUS.READY;
  statusCan = -1;
  private operator = -1;
  private upper = -1;
  private forearm = -1;
  private ghostSlot = -1;
  private forearmYaw = 0;
  private forearmPitch = 0;
  private readonly heldArch: Archetype[] = [];
  private readonly looseArch: Archetype[] = [];
  private readonly operatorArch: Archetype;
  private readonly upperArch: Archetype;
  private readonly forearmArch: Archetype;
  private readonly ghostArch: Archetype;
  private readonly dust: { id: number };
  private readonly sparkle: { id: number };
  private readonly sounds: Record<"grab" | "release" | "miss" | "thud" | "step" | "moved" | "missed" | "complete", Sound>;
  private readonly servoVoice: number;
  private servoLevel = 0;
  private servoSent = -1;
  private pwx = 0;
  private pwy = 0;
  private pwz = 0;
  private stride = 0;

  constructor() {
    const play = createPlayset({ capacity: 32, particles: 160, seed: 20260617 });
    this.play = play;
    const bg = V.PALETTE.background;
    play.sky(bg, bg, bg);
    play.fog(bg, 12, 31);
    // the demo's hemisphere (1.65) and key light (2.9) through three.js'
    // 1/pi Lambert term, before ACES; fill and point lights fold into ambient
    play.light({ sun: [-3.8, 7.4, 2.6], sunColor: 0xfff4d6, sunIntensity: 0.95, sky: 0xe4f7ff, ground: 0x2b2118, ambient: 0.62 });
    play.gravity(9.81);
    play.place(play.model(V.factory()), [0, 0, 0], { static: true });
    play.place(play.model(V.wallGlow()), [0, 0, 0], { static: false });

    this.operatorArch = play.archetype({ model: play.model(V.crosshair()), motion: motion.none() });
    this.upperArch = play.archetype({ model: play.model(V.upperArm()), motion: motion.none() });
    const forearm = play.model(V.forearmClaw());
    this.forearmArch = play.archetype({ model: forearm, motion: motion.none(), joints: [joint.script("left", "y"), joint.script("right", "y")] });
    this.ghostArch = play.archetype({ model: play.model(V.ghost()), motion: motion.none() });
    for (const c of V.CARGO) {
      const m = play.model(V.can(c.color));
      this.heldArch.push(play.archetype({ model: m, motion: motion.attached() }));
      this.looseArch.push(play.archetype({ model: m, motion: motion.ballistic({ gravity: 1, drag: 0.08, bounce: 0, dieOnGround: false, align: false }) }));
    }
    this.dust = play.emitter({ count: 10, life: 0.45, speed: 1.2, spread: 1.2, dir: [0, 1, 0], gravity: 0.4, size: [0.06, 0.12], color: [0x8a9894, 0x5d6a67], alpha: [0.55, 0], blend: "alpha", drag: 3, radius: 0.12 });
    this.sparkle = play.emitter({ count: 18, life: 0.6, speed: 1.6, spread: 0.9, dir: [0, 1, 0], size: [0.07, 0.01], color: [0x9ff6ff, 0x6ce5f0], alpha: [1, 0], blend: "add", drag: 2 });
    this.sounds = {
      grab: play.sound(sfx.grab()),
      release: play.sound({ ...sfx.grab(), freq: 190, to: 320, volume: 0.26 }),
      miss: play.sound({ ...sfx.grab(), freq: 420, to: 150, duty: 0.35, volume: 0.24 }),
      thud: play.sound(sfx.thud()),
      step: play.sound({ ...sfx.step(), volume: 0.12 }),
      moved: play.sound(sfx.checkpoint()),
      missed: play.sound({ wave: "square", freq: 196, to: 147, sustain: 0.1, decay: 0.14, duty: 0.5, volume: 0.24 }),
      complete: play.sound(sfx.win()),
    };
    this.servoVoice = play.loop(play.sound(sfx.servo()), 0, 1);
    this.ai = new ArmAutopilot(this);
    this.reset(true);
  }

  reset(demo: boolean): void {
    const play = this.play;
    play.clear();
    this.hud.status = demo ? "title" : "playing";
    this.hud.demo = demo;
    this.hud.delivered = 0;
    this.hud.seconds = 0;
    this.pz = 1.62;
    this.vf = 0;
    this.yaw = 0;
    this.pitch = -0.28;
    this.reach = START_REACH;
    this.held = -1;
    this.clawClosed = false;
    this.clawGap = V.CLAW_OPEN_GAP;
    this.missedGrip = 0;
    this.status = STATUS.READY;
    this.statusCan = -1;
    this.stride = 0;
    this.operator = play.spawn(this.operatorArch, 0, EYE_HEIGHT, this.pz);
    this.upper = play.spawn(this.upperArch, 0, 1, 0);
    this.forearm = play.spawn(this.forearmArch, 0, 1, 0);
    this.ghostSlot = play.spawn(this.ghostArch, 0, 1, 0);
    for (let i = 0; i < 3; i++) {
      const c = this.cargo[i];
      const spec = V.CARGO[i];
      c.state = CAN.LOOSE;
      c.airborne = false;
      c.settle = 0;
      c.slot = this.restingCan(i, spec.right, V.TABLE_TOP, -spec.forward, 0);
      c.x = spec.right;
      c.y = V.TABLE_TOP + V.CAN_LIFT;
      c.z = -spec.forward;
      c.prevY = c.y;
    }
    play.firstPersonCamera(this.operator, 0, FOV, 40);
    this.pose(0, 0, 0, 0, false);
    this.pgx = this.gx;
    this.pgy = this.gy;
    this.pgz = this.gz;
    this.pwx = this.wx;
    this.pwy = this.wy;
    this.pwz = this.wz;
    this.ai.reset(demo);
    this.updateStatus();
  }

  /** A loose can standing still: a ballistic slot frozen until it moves. */
  private restingCan(i: number, x: number, y: number, z: number, yaw: number): number {
    const s = this.play.spawn(this.looseArch[i], x, y, z, yaw);
    if (s >= 0) this.play.ent[s * 16 + ENT.STATE] = STATE.FROZEN;
    return s;
  }

  get live(): boolean {
    return this.hud.status === "playing" || (this.hud.status === "title" && this.hud.demo);
  }

  /** One frame of the operator's (or the autopilot's) controls. */
  frame(pad: Pad): void {
    const play = this.play;
    const live = this.live;
    let walk = 0, lookX = 0, lookY = 0, reachIn = 0, grip = false;
    if (live && this.hud.demo) {
      if (play.tick % 3 === 0) this.ai.step(3 * DT);
      else this.ai.react();
      const k = this.ai.keys;
      const d = this.ai.duty;
      // the demo AI's pulse-width control (shouldDriveAxis), at the frame rate
      const pulse = ((play.tick % 6) + 0.5) / 6;
      walk = ((k & KEY.W) !== 0 && d[0] >= pulse ? 1 : 0) - ((k & KEY.S) !== 0 && d[1] >= pulse ? 1 : 0);
      lookY = ((k & KEY.K) !== 0 && d[3] >= pulse ? 1 : 0) - ((k & KEY.I) !== 0 && d[2] >= pulse ? 1 : 0);
      lookX = ((k & KEY.L) !== 0 && d[5] >= pulse ? 1 : 0) - ((k & KEY.J) !== 0 && d[4] >= pulse ? 1 : 0);
      reachIn = ((k & KEY.E) !== 0 && d[7] >= pulse ? 1 : 0) - ((k & KEY.Q) !== 0 && d[6] >= pulse ? 1 : 0);
      grip = this.ai.takeGrip();
    } else if (live) {
      if (pad.held & DPAD) {
        walk = pad.y;
        lookX = pad.x;
      } else {
        lookX = Math.abs(pad.x) > 0.12 ? pad.x : 0;
        lookY = Math.abs(pad.y) > 0.12 ? -pad.y : 0;
      }
      reachIn = (pad.held & BTN_R ? 1 : 0) - (pad.held & BTN_L ? 1 : 0);
      grip = (pad.pressed & BTN_A) !== 0;
    }
    if (live) this.hud.seconds += DT;
    this.pose(walk, lookX, lookY, reachIn, live);
    if (grip && live) {
      if (this.held >= 0) this.release();
      else this.attemptPickup();
    }
    this.writeArm();
    play.frame(DT);
    this.afterStep(live);
  }

  private pose(walk: number, lookX: number, lookY: number, reachIn = 0, live = false): void {
    if (live) {
      // MouseLookCharacterMotionController: yaw/pitch from the look keys,
      // a smoothed walk along the heading, clamped to the aisle
      this.yaw -= lookX * YAW_RATE * DT;
      const p = this.pitch - lookY * PITCH_RATE * DT;
      this.pitch = p < PITCH_MIN ? PITCH_MIN : p > PITCH_MAX ? PITCH_MAX : p;
      const want = walk === 0 ? 0 : (walk > 0 ? WALK_SPEED : -WALK_SPEED) * Math.min(1, Math.abs(walk)) * Math.cos(this.yaw);
      this.vf += (want - this.vf) * (1 - Math.exp(-DT / (walk === 0 ? DECEL_LAG : ACCEL_LAG)));
      let f = -this.pz + this.vf * DT;
      if (f < PLAYER_MIN_FORWARD || f > PLAYER_MAX_FORWARD) {
        f = f < PLAYER_MIN_FORWARD ? PLAYER_MIN_FORWARD : PLAYER_MAX_FORWARD;
        this.vf = 0;
      }
      this.pz = -f;
      const r = this.reach + reachIn * REACH_RATE * DT;
      this.reach = r < MIN_REACH ? MIN_REACH : r > MAX_REACH ? MAX_REACH : r;
    }
    // the view frame (WorldBasis.yawPitchRollFrame) and the eye on its up
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const sp = Math.sin(this.pitch), cp = Math.cos(this.pitch);
    const fx = -sy * cp, fy = sp, fz = -cy * cp;
    const rx = cy, rz = -sy;
    const ux = sy * sp, uy = cp, uz = cy * sp;
    this.fx = fx; this.fy = fy; this.fz = fz;
    this.rx = rx; this.ry = 0; this.rz = rz;
    this.ux = ux; this.uy = uy; this.uz = uz;
    const ex = ux * EYE_HEIGHT, ey = uy * EYE_HEIGHT, ez = this.pz + uz * EYE_HEIGHT;
    this.ex = ex; this.ey = ey; this.ez = ez;
    // computeArmBase and buildArmPose
    const bx = ex + fx * 0.62, by = ey + fy * 0.62 - 0.72, bz = ez + fz * 0.62;
    const reach = this.reach;
    const dx = bx + fx * reach;
    let dy = by + fy * reach + LIFT_OFFSET;
    const dz = bz + fz * reach;
    dy = dy < V.TABLE_TOP + 0.12 ? V.TABLE_TOP + 0.12 : dy > 2.55 ? 2.55 : dy;
    this.bx = bx; this.by = by; this.bz = bz;
    this.dx = dx; this.dy = dy; this.dz = dz;
    // solveArmIkForPose: two bones, bent up and to the right
    let ox = dx - bx, oy = dy - by, oz = dz - bz;
    const raw = Math.max(Math.sqrt(ox * ox + oy * oy + oz * oz), 0.001);
    const dist = raw < MIN_IK ? MIN_IK : raw > MAX_IK ? MAX_IK : raw;
    ox /= raw; oy /= raw; oz /= raw;
    this.reachable = raw <= MAX_IK + 0.02;
    const wx = bx + ox * dist, wy = by + oy * dist, wz = bz + oz * dist;
    const U = V.UPPER_LENGTH, F = V.FOREARM_LENGTH;
    const a = (U * U - F * F + dist * dist) / (2 * dist);
    const h = Math.sqrt(Math.max(0, U * U - a * a));
    let hx = rx * 0.56 - fx * 0.06, hy = 1.15 - fy * 0.06, hz = rz * 0.56 - fz * 0.06;
    let hl = Math.sqrt(hx * hx + hy * hy + hz * hz);
    hx /= hl; hy /= hl; hz /= hl;
    const hd = hx * ox + hy * oy + hz * oz;
    hx -= ox * hd; hy -= oy * hd; hz -= oz * hd;
    hl = Math.sqrt(hx * hx + hy * hy + hz * hz);
    if (hl < 1e-3) {
      hx = rx; hy = 0; hz = rz; hl = 1;
    }
    hx /= hl; hy /= hl; hz /= hl;
    const elx = bx + ox * a + hx * h, ely = by + oy * a + hy * h, elz = bz + oz * a + hz * h;
    this.wx = wx; this.wy = wy; this.wz = wz;
    this.elx = elx; this.ely = ely; this.elz = elz;
    // the tool frame: forward along the forearm, right level, up between
    let tx = wx - elx, ty = wy - ely, tz = wz - elz;
    const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    let crx = -tz, crz = tx;
    let cl = Math.sqrt(crx * crx + crz * crz);
    if (cl < 1e-3) {
      crx = rx; crz = rz; cl = 1;
    }
    crx /= cl; crz /= cl;
    // Cu = Cr x T
    const cux = -crz * ty, cuy = crz * tx - crx * tz, cuz = crx * ty;
    this.tx = tx; this.ty = ty; this.tz = tz;
    this.crx = crx; this.cry = 0; this.crz = crz;
    this.cux = cux; this.cuy = cuy; this.cuz = cuz;
    this.tipx = wx + tx * 0.46; this.tipy = wy + ty * 0.46; this.tipz = wz + tz * 0.46;
    this.gx = wx + cux * V.CLAW_GRIP_LOCAL_Y - tx * V.CLAW_GRIP_LOCAL_Z;
    this.gy = wy + cuy * V.CLAW_GRIP_LOCAL_Y - ty * V.CLAW_GRIP_LOCAL_Z;
    this.gz = wz + cuz * V.CLAW_GRIP_LOCAL_Y - tz * V.CLAW_GRIP_LOCAL_Z;
    this.forearmYaw = Math.atan2(-tx, -tz);
    this.forearmPitch = Math.asin(ty < -1 ? -1 : ty > 1 ? 1 : ty);
    // the claw closes on a held can or after a missed grip
    if (this.missedGrip > 0) this.missedGrip = Math.max(0, this.missedGrip - DT);
    const gap = this.clawClosed || this.held >= 0 || this.missedGrip > 0 ? V.CLAW_HOLD_GAP : V.CLAW_OPEN_GAP;
    this.clawGap += (gap - this.clawGap) * (1 - Math.exp(-DT / 0.035));
  }

  /** The operator, both arm segments, the fingers and the reach ghost. */
  private writeArm(): void {
    const ent = this.play.ent;
    let o = this.operator * 16;
    ent[o] = this.ex;
    ent[o + 1] = this.ey;
    ent[o + 2] = this.ez;
    ent[o + 6] = this.yaw;
    ent[o + 7] = this.pitch;
    o = this.upper * 16;
    const ux = this.elx - this.bx, uy = this.ely - this.by, uz = this.elz - this.bz;
    ent[o] = this.bx;
    ent[o + 1] = this.by;
    ent[o + 2] = this.bz;
    ent[o + 6] = Math.atan2(-ux, -uz);
    ent[o + 7] = Math.atan2(uy, Math.sqrt(ux * ux + uz * uz));
    o = this.forearm * 16;
    ent[o] = this.elx;
    ent[o + 1] = this.ely;
    ent[o + 2] = this.elz;
    ent[o + 6] = this.forearmYaw;
    ent[o + 7] = this.forearmPitch;
    // the pads travel (open - gap) toward each other
    const angle = (V.CLAW_OPEN_GAP - this.clawGap) / V.FINGER_HINGE_REACH;
    const j = this.play.joints;
    j[this.forearm * 4] = -angle;
    j[this.forearm * 4 + 1] = angle;
    o = this.ghostSlot * 16;
    const show = this.hud.status === "playing" && !this.reachable;
    ent[o] = this.dx;
    ent[o + 1] = this.dy;
    ent[o + 2] = this.dz;
    ent[o + ENT.STATE] = show ? 0 : STATE.HIDDEN;
  }

  /** The demo's cargoGripAlignment for every can still on a table. */
  private align(): void {
    const ent = this.play.ent;
    const wx = this.wx, wy = this.wy, wz = this.wz;
    const crx = this.crx, crz = this.crz;
    const cux = this.cux, cuy = this.cuy, cuz = this.cuz;
    const tx = this.tx, ty = this.ty, tz = this.tz;
    for (let i = 0; i < 3; i++) {
      const c = this.cargo[i];
      if (c.slot < 0) continue;
      if (i === this.held) {
        // a held can's centre is the grip point
        c.x = this.gx;
        c.y = this.gy;
        c.z = this.gz;
      } else {
        const o = c.slot * 16;
        c.x = ent[o];
        c.y = ent[o + 1] + V.CAN_LIFT;
        c.z = ent[o + 2];
      }
      const lx = c.x - wx, ly = c.y - wy, lz = c.z - wz;
      const localX = lx * crx + lz * crz;
      const localY = lx * cux + ly * cuy + lz * cuz;
      const localZ = -(lx * tx + ly * ty + lz * tz);
      c.lateral = localX;
      c.vertical = localY - V.CLAW_GRIP_LOCAL_Y;
      c.depth = localZ - V.CLAW_GRIP_LOCAL_Z;
      c.distance = Math.sqrt(c.lateral * c.lateral + c.vertical * c.vertical + c.depth * c.depth);
      c.aligned = Math.abs(c.lateral) <= GRIP_LATERAL && Math.abs(c.depth) <= GRIP_DEPTH && Math.abs(c.vertical) <= GRIP_VERTICAL;
    }
  }

  /** The nearest can the claw could take, or -1. */
  nearestCan(): number {
    let best = -1;
    let d = Infinity;
    for (let i = 0; i < 3; i++) {
      const c = this.cargo[i];
      if (c.state !== CAN.LOOSE || c.slot < 0) continue;
      if (c.distance < d) {
        d = c.distance;
        best = i;
      }
    }
    return best;
  }

  private attemptPickup(): void {
    const n = this.nearestCan();
    const play = this.play;
    if (n >= 0 && this.cargo[n].aligned && this.cargo[n].distance <= PICKUP_RADIUS) {
      const c = this.cargo[n];
      const o = c.slot * 16;
      const x = play.ent[o], y = play.ent[o + 1], z = play.ent[o + 2], yaw = play.ent[o + 6];
      play.kill(c.slot);
      c.slot = play.spawn(this.heldArch[n], x, y, z, yaw);
      // setSafeGripLocalMatrix: the can's centre on the grip point, square to the claw
      play.attach(c.slot, this.forearm, [0, V.CLAW_GRIP_LOCAL_Y - V.CAN_LIFT, -V.FOREARM_LENGTH + V.CLAW_GRIP_LOCAL_Z], 0, true);
      c.state = CAN.HELD;
      c.airborne = false;
      c.settle = 0;
      this.held = n;
      this.clawClosed = true;
      play.play(this.sounds.grab, 0.9, 1, [this.gx, this.gy, this.gz]);
    } else {
      this.clawClosed = false;
      if (!(n >= 0 && this.cargo[n].distance <= PICKUP_RADIUS)) this.missedGrip = 0.34;
      play.play(this.sounds.miss, 0.8, 1, [this.gx, this.gy, this.gz]);
    }
  }

  private release(): void {
    const i = this.held;
    const c = this.cargo[i];
    const play = this.play;
    // the receiving table is the nearer one to the claw tip
    const receive = this.nearerIsReceive(this.tipx, this.tipz);
    this.held = -1;
    this.clawClosed = false;
    c.state = receive ? CAN.SETTLING : CAN.LOOSE;
    c.settle = 0;
    c.airborne = true;
    // the can leaves with the grip point's velocity (the AI's capped)
    let vx = (this.gx - this.pgx) / DT, vy = (this.gy - this.pgy) / DT, vz = (this.gz - this.pgz) / DT;
    if (this.hud.demo) {
      const s = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (s > AI_RELEASE_MAX_SPEED) {
        const k = AI_RELEASE_MAX_SPEED / s;
        vx *= k; vy *= k; vz *= k;
      }
    }
    play.kill(c.slot);
    const x = this.gx - this.cux * V.CAN_LIFT, y = this.gy - this.cuy * V.CAN_LIFT, z = this.gz - this.cuz * V.CAN_LIFT;
    c.slot = play.spawn(this.looseArch[i], x, y, z, this.forearmYaw);
    c.prevY = y;
    if (c.slot >= 0) {
      const o = c.slot * 16;
      play.ent[o + 3] = vx;
      play.ent[o + 4] = vy;
      play.ent[o + 5] = vz;
      play.ent[o + 7] = this.forearmPitch;
    }
    play.play(this.sounds.release, 0.8, 1, [this.gx, this.gy, this.gz]);
  }

  private nearerIsReceive(x: number, z: number): boolean {
    const s = V.TABLES.serve, r = V.TABLES.receive;
    const sd = Math.hypot(x - s.centerRight, -z - s.centerForward);
    const rd = Math.hypot(x - r.centerRight, -z - r.centerForward);
    return rd < sd;
  }

  /** Whether (x, z) is over either table top. */
  private overTable(x: number, z: number): boolean {
    const s = V.TABLES.serve, r = V.TABLES.receive;
    const f = -z;
    if (Math.abs(f - s.centerForward) > s.halfForward) return false;
    return Math.abs(x - s.centerRight) <= s.halfRight || Math.abs(x - r.centerRight) <= r.halfRight;
  }

  private landed(i: number, speed: number): void {
    const c = this.cargo[i];
    c.airborne = false;
    const o = c.slot * 16;
    const ent = this.play.ent;
    ent[o + 7] = 0;
    ent[o + 8] = 0;
    this.play.play(this.sounds.thud, Math.min(1, 0.35 + speed * 0.2), 1, [ent[o], ent[o + 1], ent[o + 2]]);
    this.play.burst(this.dust, ent[o], ent[o + 1] + 0.02, ent[o + 2]);
  }

  private afterStep(live: boolean): void {
    const play = this.play;
    const ent = play.ent;
    const top = V.TABLE_TOP;
    // falling cans: tilt back upright, land on a table top (the floor is
    // the ballistic kernel's own GROUND event)
    for (let i = 0; i < 3; i++) {
      const c = this.cargo[i];
      if (!c.airborne || c.slot < 0) continue;
      const o = c.slot * 16;
      const y = ent[o + 1];
      ent[o + 7] *= 0.88;
      if (ent[o + 4] <= 0 && y <= top && c.prevY >= top - 1e-3 && this.overTable(ent[o], ent[o + 2])) {
        const speed = -ent[o + 4];
        ent[o + 1] = top;
        ent[o + 3] = 0;
        ent[o + 4] = 0;
        ent[o + 5] = 0;
        ent[o + ENT.STATE] = STATE.FROZEN;
        this.landed(i, speed);
      } else if (ent[o + 4] === 0 && y <= 0.001) {
        // the ballistic kernel stopped it on the floor
        this.landed(i, 2);
      }
      c.prevY = y;
    }
    this.align();
    // updateCargoDelivery: settled on the receiving table for 0.28 s
    const r = V.TABLES.receive;
    for (let i = 0; i < 3; i++) {
      const c = this.cargo[i];
      if (c.state === CAN.DELIVERED || c.state === CAN.HELD) continue;
      const f = -c.z;
      const onReceive = this.nearerIsReceive(c.x, c.z) && Math.abs(c.x - r.centerRight) <= r.halfRight - V.CAN_RADIUS && Math.abs(f - r.centerForward) <= r.halfForward - V.CAN_RADIUS;
      const settled = !c.airborne;
      c.settle = onReceive && settled ? c.settle + DT : 0;
      if (c.settle >= DELIVERY_SETTLE_SECONDS) {
        c.state = CAN.DELIVERED;
        this.hud.delivered += 1;
        play.play(this.sounds.moved, 0.9);
        play.burst(this.sparkle, c.x, c.y + 0.3, c.z);
      } else if (!onReceive && settled && c.state === CAN.SETTLING) {
        c.state = CAN.LOOSE;
        play.play(this.sounds.missed, 0.8);
      }
    }
    if (live && this.hud.delivered >= 3) {
      this.hud.status = "gameover";
      play.play(this.sounds.complete, 0.9);
    }
    this.updateStatus();
    // the servo hum follows how fast the claw moves
    const mx = this.wx - this.pwx, my = this.wy - this.pwy, mz = this.wz - this.pwz;
    const speed = Math.sqrt(mx * mx + my * my + mz * mz) / DT;
    const want = speed > 0.04 ? Math.min(1, speed / 1.4) : 0;
    this.servoLevel += (want - this.servoLevel) * (want > this.servoLevel ? 0.35 : 0.12);
    if (play.tick % 2 === 0) {
      const v = this.servoLevel < 0.02 ? 0 : 0.18 + this.servoLevel * 0.55;
      if (Math.abs(v - this.servoSent) > 0.015) {
        play.setLoop(this.servoVoice, v, 0.8 + this.servoLevel * 0.55);
        this.servoSent = v;
      }
    }
    // footsteps along the aisle
    const step = Math.abs(this.vf) * DT;
    if (step > 0.004) {
      this.stride += step;
      if (this.stride > 0.62) {
        this.stride = 0;
        play.play(this.sounds.step, 0.7, play.tick & 64 ? 1.08 : 0.94);
      }
    }
    this.pwx = this.wx;
    this.pwy = this.wy;
    this.pwz = this.wz;
    this.pgx = this.gx;
    this.pgy = this.gy;
    this.pgz = this.gz;
  }

  /** updateStatusFromContext */
  private updateStatus(): void {
    if (this.hud.delivered >= 3) {
      this.status = STATUS.COMPLETE;
      return;
    }
    if (this.held >= 0) {
      const c = this.cargo[this.held];
      this.status = this.nearerIsReceive(c.x, c.z) ? STATUS.RELEASE : STATUS.CARRY;
      this.statusCan = this.held;
      return;
    }
    const n = this.nearestCan();
    this.statusCan = n;
    if (n >= 0 && this.cargo[n].aligned && this.cargo[n].distance <= PICKUP_RADIUS) this.status = STATUS.GRIP;
    else if (!this.reachable) this.status = STATUS.BEYOND;
    else this.status = STATUS.ALIGN;
  }

  /** Pause: the servo goes quiet. */
  silence(): void {
    this.play.setLoop(this.servoVoice, 0, 1);
    this.servoSent = 0;
    this.servoLevel = 0;
  }

  /** The demo's cameraFrustumPayload for a point in demo coordinates. */
  view(right: number, up: number, forward: number, radius: number, out: View): View {
    const dx = right - this.ex, dy = up - this.ey, dz = -forward - this.ez;
    const lx = dx * this.rx + dz * this.rz;
    const ly = dx * this.ux + dy * this.uy + dz * this.uz;
    const depth = dx * this.fx + dy * this.fy + dz * this.fz;
    const vh = Math.abs(depth * TAN_HALF_FOV);
    const hh = vh * ASPECT;
    const inFront = depth - radius > 0.04 && depth + radius < 80;
    out.centerIn = inFront && Math.abs(lx) <= hh && Math.abs(ly) <= vh;
    out.fullyIn = inFront && Math.abs(lx) + radius <= hh && Math.abs(ly) + radius <= vh;
    out.x = hh > 1e-5 ? lx / hh : 0;
    out.y = vh > 1e-5 ? ly / vh : 0;
    out.depth = depth;
    return out;
  }

  statusText(): string {
    if (this.hud.demo && this.ai.enabled) return aiStatus(this.ai.status, this.ai.statusCan);
    switch (this.status) {
      case STATUS.RELEASE:
        return "Release on receiving table";
      case STATUS.CARRY:
        return "Carry to receiving table";
      case STATUS.GRIP:
        return `Grip ${V.CARGO[this.statusCan].label}`;
      case STATUS.BEYOND:
        return "Claw goal beyond arm reach";
      case STATUS.ALIGN:
        return "Align claw with cargo";
      case STATUS.COMPLETE:
        return "Job complete";
      default:
        return "Ready";
    }
  }
}

function aiStatus(code: number, can: number): string {
  const name = can >= 0 ? V.CARGO[can].id : "";
  return AI_STATUS_TEXT[code].replace("$", name);
}

function clock(seconds: number): string {
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? "0" : ""}${r}`;
}

/** The game as the playset shell and the headless runner drive it. */
export function createGame(): PlaysetGame {
  const game = new RoboticArm();
  (globalThis as { __playsetGame?: unknown }).__playsetGame = game;
  let paused = false;
  let overAt = -1;
  return {
    title: "Robotic Arm",
    tagline: "Move every can to the receiving table\nwith the claw.",
    accent: "#e09a10",
    controls: [
      ["Circle Pad", "Aim view and claw"],
      ["D-Pad", "Walk / turn"],
      ["L / R", "Arm reach in / out"],
      ["A", "Grip / release"],
      ["START", "Pause"],
    ],
    readouts: [
      { label: "Moved", value: () => `${game.hud.delivered} / 3`, bar: () => game.hud.delivered / 3, color: "#ffc63f" },
      { label: "Claw", value: () => (game.held >= 0 ? `Holding ${V.CARGO[game.held].id}` : "Empty") },
      { label: "Reach", value: () => `${game.reach.toFixed(1)} m`, bar: () => (game.reach - MIN_REACH) / (MAX_REACH - MIN_REACH), color: "#7de7f3" },
      { label: "Time", value: () => clock(game.hud.seconds) },
      { label: "Status", value: () => (game.status === STATUS.GRIP ? "Grip ready" : game.held >= 0 ? "Carrying" : game.reachable ? "Aligning" : "Out of reach") },
    ],
    play: game.play,
    status(): GameStatus {
      if (game.hud.status === "title") return "title";
      if (game.hud.status === "gameover") return game.hud.demo ? "title" : "gameover";
      return paused ? "paused" : "playing";
    },
    start(demo: boolean) {
      paused = false;
      overAt = -1;
      game.reset(demo);
    },
    pause(p: boolean) {
      paused = p;
      if (p) game.silence();
    },
    frame(pad: Pad) {
      // the attract loop starts over two seconds after the demo's job is done
      if (game.hud.demo && game.hud.status === "gameover") {
        if (overAt < 0) overAt = game.play.tick;
        else if (game.play.tick - overAt > 120) {
          overAt = -1;
          game.reset(true);
        }
      }
      if (paused) return;
      game.frame(pad);
    },
    topLine: () => `MOVED ${game.hud.delivered}/3    ${game.statusText()}`,
    result: () => `Job complete · 3 / 3 moved in ${clock(game.hud.seconds)}`,
  };
}
