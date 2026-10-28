// Typed builders for what the native step evaluates: motion kernels, brains,
// weapons and joint drivers. Each returns plain data that `archetype()`
// encodes into the archetype's float slots (contracts/spec/playset.ts); the
// numbers are the kernels' tuning, and changing them with `retune()` takes
// effect on the next step.
//
// Intent signs, for every kernel: X > 0 strafes right, FWD > 0 forward,
// TURN > 0 turns right, RISE > 0 climbs or pitches up.

import { PLAYSET_AIM, PLAYSET_BRAIN, PLAYSET_JOINT_DRIVER, PLAYSET_MOTION } from "../../../contracts/spec/playset.ts";

export interface Motion {
  readonly kind: number;
  readonly p: readonly number[];
}

export interface Brain {
  readonly kind: number;
  readonly p: readonly number[];
}

const frames = { world: 0, heading: 1, tank: 2 } as const;

export const motion = {
  none: (): Motion => ({ kind: PLAYSET_MOTION.NONE, p: [] }),
  /** Free flight under gravity: shells, arrows, debris. */
  ballistic(o: { gravity?: number; drag?: number; bounce?: number; dieOnGround?: boolean; align?: boolean } = {}): Motion {
    return { kind: PLAYSET_MOTION.BALLISTIC, p: [o.gravity ?? 1, o.drag ?? 0, o.bounce ?? 0, o.dieOnGround === false ? 0 : 1, o.align === false ? 0 : 1] };
  },
  /** Straight at a speed; `homing` turns toward the TARGET at rad/s. */
  linear(o: { speed?: number; homing?: number; accel?: number; maxSpeed?: number } = {}): Motion {
    return { kind: PLAYSET_MOTION.LINEAR, p: [o.speed ?? 0, o.homing ?? 0, o.accel ?? 0, o.maxSpeed ?? 0] };
  },
  /** A body on the ground plane (GameBlocks GeneralVehicleMotionController):
   *  `frame` world = stick axes are world axes, heading = relative to the
   *  facing, tank = TURN rotates and FWD drives. `face`: none, move (turn to
   *  the velocity), target, turn (TURN rotates in any frame). */
  planar(o: {
    accel?: number;
    maxSpeed?: number;
    damping?: number;
    frame?: keyof typeof frames;
    turnRate?: number;
    face?: "none" | "move" | "target" | "turn";
    boost?: number;
    vertical?: number;
    bank?: number;
  } = {}): Motion {
    const face = { none: 0, move: 1, target: 2, turn: 3 }[o.face ?? "move"];
    return {
      kind: PLAYSET_MOTION.PLANAR,
      p: [o.accel ?? 40, o.maxSpeed ?? 8, o.damping ?? 6, frames[o.frame ?? "world"], o.turnRate ?? 8, face, o.boost ?? 0, o.vertical ?? 0, o.bank ?? 0],
    };
  },
  /** A walker with gravity and jumps. `frame` world | heading | camera |
   *  tank | fps (TURN and RISE look around). */
  character(o: {
    walk?: number;
    run?: number;
    accel?: number;
    airControl?: number;
    jump?: number;
    gravity?: number;
    turnRate?: number;
    frame?: "world" | "heading" | "camera" | "tank" | "fps";
    face?: "keep" | "move";
    pitchRate?: number;
    pitchMax?: number;
  } = {}): Motion {
    const frame = { world: 0, heading: 1, camera: 2, tank: 3, fps: 4 }[o.frame ?? "world"];
    return {
      kind: PLAYSET_MOTION.CHARACTER,
      p: [o.walk ?? 5, o.run ?? 1.6, o.accel ?? 40, o.airControl ?? 0.3, o.jump ?? 8, o.gravity ?? 1, o.turnRate ?? 3, frame, (o.face ?? (frame === 0 || frame === 2 ? "move" : "keep")) === "move" ? 1 : 0, o.pitchRate ?? 2, o.pitchMax ?? 1.2],
    };
  },
  /** An arcade car: FWD throttle/brake, TURN steer, JUMP handbrake, AUX boost. */
  car(o: {
    accel?: number;
    maxSpeed?: number;
    reverse?: number;
    brake?: number;
    steer?: number;
    steerRate?: number;
    grip?: number;
    drag?: number;
    driftGrip?: number;
    wheelbase?: number;
    gravity?: number;
    boost?: number;
  } = {}): Motion {
    return {
      kind: PLAYSET_MOTION.CAR,
      p: [o.accel ?? 18, o.maxSpeed ?? 30, o.reverse ?? 8, o.brake ?? 30, o.steer ?? 0.55, o.steerRate ?? 3, o.grip ?? 8, o.drag ?? 0.15, o.driftGrip ?? 1.2, o.wheelbase ?? 2.4, o.gravity ?? 1, o.boost ?? 0],
    };
  },
  /** A hull on the water: FWD throttle, TURN rudder; rides the waves. */
  boat(o: { accel?: number; maxSpeed?: number; turnRate?: number; drag?: number; lateralDrag?: number; bob?: number; roll?: number; pitch?: number } = {}): Motion {
    return { kind: PLAYSET_MOTION.BOAT, p: [o.accel ?? 6, o.maxSpeed ?? 12, o.turnRate ?? 0.9, o.drag ?? 0.3, o.lateralDrag ?? 2, o.bob ?? 0.1, o.roll ?? 0.25, o.pitch ?? 1] };
  },
  /** An aircraft: RISE pitch, TURN roll, X rudder, FWD throttle. */
  plane(o: {
    minSpeed?: number;
    maxSpeed?: number;
    accel?: number;
    pitchRate?: number;
    rollRate?: number;
    yawRate?: number;
    bankTurn?: number;
    autoLevel?: number;
    gravity?: number;
    minAltitude?: number;
  } = {}): Motion {
    return {
      kind: PLAYSET_MOTION.PLANE,
      p: [o.minSpeed ?? 14, o.maxSpeed ?? 40, o.accel ?? 12, o.pitchRate ?? 1.4, o.rollRate ?? 2.6, o.yawRate ?? 0.5, o.bankTurn ?? 1.2, o.autoLevel ?? 1.2, o.gravity ?? 0.3, o.minAltitude ?? 3],
    };
  },
  /** A drone or a submarine: heading-relative X/FWD, TURN yaw, RISE vertical. */
  hover(o: {
    accel?: number;
    maxSpeed?: number;
    damping?: number;
    vertical?: number;
    maxVertical?: number;
    turnRate?: number;
    tilt?: number;
    gravity?: number;
    minY?: number;
    maxY?: number;
    frame?: "heading" | "world" | "camera";
  } = {}): Motion {
    const frame = { heading: 0, world: 1, camera: 2 }[o.frame ?? "heading"];
    return {
      kind: PLAYSET_MOTION.HOVER,
      p: [o.accel ?? 20, o.maxSpeed ?? 10, o.damping ?? 3, o.vertical ?? 12, o.maxVertical ?? 6, o.turnRate ?? 2.2, o.tilt ?? 3, o.gravity ?? 0, o.minY ?? 0.5, o.maxY ?? 0, frame],
    };
  },
  /** Along a path at SPEED (ENT.SPEED; the guest may change it per slot). */
  path(o: { path: number; speed?: number; loop?: boolean; turnRate?: number; jitter?: number }): Motion {
    return { kind: PLAYSET_MOTION.PATH, p: [o.speed ?? 3, o.path, o.loop ? 1 : 0, o.turnRate ?? 6, o.jitter ?? 0] };
  },
  /** Fixed in place; turns toward its TARGET, or by TURN/RISE without one. */
  turret(o: { yawRate?: number; pitchRate?: number; minPitch?: number; maxPitch?: number } = {}): Motion {
    return { kind: PLAYSET_MOTION.TURRET, p: [o.yawRate ?? 3, o.pitchRate ?? 2, o.minPitch ?? -0.3, o.maxPitch ?? 1] };
  },
  /** Lanes toward -Z: X changes lane on the press, JUMP/RISE jumps, RISE < 0 slides. */
  runner(o: { speed?: number; accel?: number; maxSpeed?: number; laneWidth?: number; lanes?: number; laneRate?: number; jump?: number; gravity?: number; slide?: number } = {}): Motion {
    return {
      kind: PLAYSET_MOTION.RUNNER,
      p: [o.speed ?? 12, o.accel ?? 0.25, o.maxSpeed ?? 30, o.laneWidth ?? 2.5, o.lanes ?? 3, o.laneRate ?? 14, o.jump ?? 9, o.gravity ?? 1.4, o.slide ?? 0.7],
    };
  },
  /** Rides another slot (Playset.attach sets the parent and offset). */
  attached: (): Motion => ({ kind: PLAYSET_MOTION.ATTACHED, p: [] }),
  /** A grid snake head (see Playset.board). */
  snake(o: { speed?: number; cell?: number; turns?: "relative" | "absolute"; length?: number; segment?: number; grow?: number } = {}): Motion {
    return { kind: PLAYSET_MOTION.SNAKE, p: [o.speed ?? 6, o.cell ?? 1, o.turns === "absolute" ? 1 : 0, o.length ?? 4, o.segment ?? -1, o.grow ?? 1] };
  },
  /** A ball on the tilting board (see Playset.board). */
  marble(o: { tilt?: number; tiltRate?: number; gravity?: number; friction?: number; bounce?: number; radius?: number } = {}): Motion {
    return { kind: PLAYSET_MOTION.MARBLE, p: [o.tilt ?? 0.3, o.tiltRate ?? 2, o.gravity ?? 1, o.friction ?? 0.6, o.bounce ?? 0.4, o.radius ?? 0.5] };
  },
};

/** What a brain looks at. */
export type Target =
  | { readonly nearest: number; readonly sight?: number; readonly every?: number }
  | { readonly slot: true }
  | { readonly point: readonly [number, number, number] };

interface BrainCommon {
  target?: Target;
  /** fire weapon 0 when the target is within range and inside the cone */
  fireRange?: number;
  fireCone?: number;
  /** distance to keep (seek stops, orbit circles, strafe holds) */
  distance?: number;
  /** fraction of the kernel's speed */
  speed?: number;
}

function common(o: BrainCommon, extra: number[] = []): number[] {
  const p = new Array(16).fill(0);
  const t = o.target;
  if (t && "nearest" in t) {
    p[0] = 1;
    p[1] = t.nearest;
    p[5] = t.sight ?? 0;
    p[8] = t.every ?? 0.5;
  } else if (t && "slot" in t) {
    p[0] = 2;
  } else if (t && "point" in t) {
    p[0] = 3;
    p[2] = t.point[0];
    p[3] = t.point[1];
    p[4] = t.point[2];
  }
  p[6] = o.fireRange ?? 0;
  p[7] = o.fireCone ?? 0.25;
  p[9] = o.distance ?? 0;
  p[10] = o.speed ?? 1;
  extra.forEach((v, i) => (p[11 + i] = v));
  return p;
}

export const brain = {
  none: (): Brain => ({ kind: PLAYSET_BRAIN.NONE, p: [] }),
  seek: (o: BrainCommon = {}): Brain => ({ kind: PLAYSET_BRAIN.SEEK, p: common(o) }),
  flee: (o: BrainCommon = {}): Brain => ({ kind: PLAYSET_BRAIN.FLEE, p: common(o) }),
  orbit: (o: BrainCommon & { clockwise?: boolean } = {}): Brain => ({ kind: PLAYSET_BRAIN.ORBIT, p: common(o, [o.clockwise ? -1 : 1]) }),
  /** Ambles about its spawn point; `leash` pulls it home. */
  wander: (o: BrainCommon & { every?: number; turn?: number; leash?: number } = {}): Brain => ({
    kind: PLAYSET_BRAIN.WANDER,
    p: common(o, [0, o.every ?? 2, o.turn ?? 1.5, o.leash ?? 0]),
  }),
  /** Wanders, and bolts from anything on the target layers within sight. */
  herd: (o: BrainCommon & { panic?: number; every?: number; turn?: number; leash?: number } = {}): Brain => ({
    kind: PLAYSET_BRAIN.HERD,
    p: common(o, [o.panic ?? 3, o.every ?? 2.5, o.turn ?? 1.2, o.leash ?? 0]),
  }),
  /** Flight pursuit with lead; keeps off the ground. */
  pursue: (o: BrainCommon = {}): Brain => ({ kind: PLAYSET_BRAIN.PURSUE, p: common(o) }),
  turret: (o: BrainCommon = {}): Brain => ({ kind: PLAYSET_BRAIN.TURRET, p: common(o) }),
  /** Circles the target at `distance`, switching sides every few seconds. */
  strafe: (o: BrainCommon & { every?: number } = {}): Brain => ({ kind: PLAYSET_BRAIN.STRAFE, p: common(o, [o.every ?? 1.6]) }),
  /** Drives a path's points in order and reports GATE events with laps. */
  waypoints: (o: BrainCommon & { path: number; look?: number; gate?: number }): Brain => ({
    kind: PLAYSET_BRAIN.WAYPOINTS,
    p: common(o, [o.path, o.look ?? 6, o.gate ?? 8]),
  }),
  snake: (o: BrainCommon & { caution?: number } = {}): Brain => ({ kind: PLAYSET_BRAIN.SNAKE, p: common(o, [o.caution ?? 0.5]) }),
};

export interface Weapon {
  /** the projectile's archetype */
  projectile: { readonly id: number };
  cooldown?: number;
  speed?: number;
  spread?: number;
  count?: number;
  muzzle?: readonly [number, number, number];
  aim?: "forward" | "lead" | "arc";
  /** add the shooter's velocity */
  inherit?: boolean;
  burst?: number;
  burstGap?: number;
  /** emit a FIRE event per shot */
  event?: boolean;
  /** extra pitch, radians */
  pitch?: number;
  /** played at the muzzle on every shot */
  sound?: { readonly id: number };
}

export function encodeWeapon(w: Weapon): number[] {
  const aim = { forward: PLAYSET_AIM.FORWARD, lead: PLAYSET_AIM.LEAD, arc: PLAYSET_AIM.ARC }[w.aim ?? "forward"];
  const m = w.muzzle ?? [0, 0, -1];
  return [w.projectile.id + 1, w.cooldown ?? 0.25, w.speed ?? 30, w.spread ?? 0, w.count ?? 1, m[0], m[1], m[2], aim, w.sound ? w.sound.id + 1 : 0, w.inherit ? 1 : 0, w.burst ?? 0, w.burstGap ?? 0.08, w.event ? 1 : 0, w.pitch ?? 0, 0];
}

export interface JointDriver {
  readonly joint: string;
  readonly kind: number;
  readonly axis: number;
  readonly rate: number;
}

const axes = { x: 0, y: 1, z: 2 } as const;
type Axis = keyof typeof axes;

export const joint = {
  spin: (name: string, axis: Axis = "y", rate = 10): JointDriver => ({ joint: name, kind: PLAYSET_JOINT_DRIVER.SPIN, axis: axes[axis], rate }),
  /** wheels: angle from forward speed, rate = 1 / wheel radius */
  roll: (name: string, radius = 0.4, axis: Axis = "x"): JointDriver => ({ joint: name, kind: PLAYSET_JOINT_DRIVER.ROLL, axis: axes[axis], rate: 1 / radius }),
  aimYaw: (name: string): JointDriver => ({ joint: name, kind: PLAYSET_JOINT_DRIVER.AIM_YAW, axis: 1, rate: 0 }),
  aimPitch: (name: string): JointDriver => ({ joint: name, kind: PLAYSET_JOINT_DRIVER.AIM_PITCH, axis: 0, rate: 0 }),
  steer: (name: string, max = 1): JointDriver => ({ joint: name, kind: PLAYSET_JOINT_DRIVER.STEER, axis: 1, rate: max }),
  swing: (name: string, amplitude = 0.6, axis: Axis = "x"): JointDriver => ({ joint: name, kind: PLAYSET_JOINT_DRIVER.SWING, axis: axes[axis], rate: amplitude }),
  bob: (name: string, amplitude = 0.1, axis: Axis = "y"): JointDriver => ({ joint: name, kind: PLAYSET_JOINT_DRIVER.BOB, axis: axes[axis], rate: amplitude }),
  /** the JOINT view's value for this driver's index, written by the guest */
  script: (name: string, axis: Axis = "y"): JointDriver => ({ joint: name, kind: PLAYSET_JOINT_DRIVER.SCRIPT, axis: axes[axis], rate: 0 }),
};
