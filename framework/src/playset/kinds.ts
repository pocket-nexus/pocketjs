// Typed builders for what the native step evaluates: motion kernels, brains,
// weapons and joint drivers. Each returns plain data that `archetype()`
// encodes into the archetype's float slots (contracts/spec/playset.ts); the
// numbers are the kernels' tuning, and changing them with `retune()` takes
// effect on the next step.
//
// Intent signs, for every kernel: X > 0 strafes right, FWD > 0 forward,
// TURN > 0 turns right, RISE > 0 climbs or pitches up.

import {
  PLAYSET_AIM,
  PLAYSET_BEHAVIOUR,
  PLAYSET_BEHAVIOUR_LENGTH,
  PLAYSET_BEHAVIOUR_STATE,
  PLAYSET_BEHAVIOUR_STATE_LENGTH,
  PLAYSET_BRAIN,
  PLAYSET_JOINT_DRIVER,
  PLAYSET_MOTION,
  PLAYSET_STEER,
  PLAYSET_STEER_WHEN,
} from "../../../contracts/spec/playset.ts";

export interface Motion {
  readonly kind: number;
  readonly p: readonly number[];
}

export interface Brain {
  readonly kind: number;
  readonly p: readonly number[];
  /** the encoded behaviour a STEER brain evaluates (PLAYSET_BEHAVIOUR_LENGTH floats) */
  readonly behaviour?: readonly number[];
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
    /** top speed while boosting, times maxSpeed */
    boostTop?: number;
  } = {}): Motion {
    return {
      kind: PLAYSET_MOTION.CAR,
      p: [o.accel ?? 18, o.maxSpeed ?? 30, o.reverse ?? 8, o.brake ?? 30, o.steer ?? 0.55, o.steerRate ?? 3, o.grip ?? 8, o.drag ?? 0.15, o.driftGrip ?? 1.2, o.wheelbase ?? 2.4, o.gravity ?? 1, o.boost ?? 0, o.boostTop ?? 1.25],
    };
  },
  /** A hull on the water: FWD throttle, TURN rudder; rides the waves. */
  boat(o: { accel?: number; maxSpeed?: number; turnRate?: number; drag?: number; lateralDrag?: number; bob?: number; roll?: number; pitch?: number } = {}): Motion {
    return { kind: PLAYSET_MOTION.BOAT, p: [o.accel ?? 6, o.maxSpeed ?? 12, o.turnRate ?? 0.9, o.drag ?? 0.3, o.lateralDrag ?? 2, o.bob ?? 0.1, o.roll ?? 0.25, o.pitch ?? 1] };
  },
  /** An aircraft: RISE pitch, TURN roll, X rudder, FWD throttle.
   *
   *  With `banked`, GameBlocks' AirplaneMotionController instead: TURN holds
   *  a bank angle (up to `maxBank`) that turns the heading at `bankTurn`,
   *  RISE pitches the flight path at `pitchRate`, X yaws at `yawRate`, FWD
   *  moves a throttle (`throttleRate` per second) that sets the cruise speed
   *  between min and max, AUX starts a boost; the plane stays `minAltitude`
   *  over the ground and at or above `floor`. */
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
    banked?: {
      throttleRate?: number;
      /** seconds the speed takes toward the cruise speed (smoothing lag) */
      speedLag?: number;
      boostSpeedLag?: number;
      maxBank?: number;
      bankLag?: number;
      /** the roll at which the bank turn reaches `bankTurn` */
      bankTurnReference?: number;
      boostDuration?: number;
      boostMultiplier?: number;
      /** throttle at spawn, 0..1 */
      throttle?: number;
      /** least height, world units; 0 = none */
      floor?: number;
      /** least pitch while held on the floor */
      floorPitch?: number;
    };
  } = {}): Motion {
    const p = [o.minSpeed ?? 14, o.maxSpeed ?? 40, o.accel ?? 12, o.pitchRate ?? 1.4, o.rollRate ?? 2.6, o.yawRate ?? 0.5, o.bankTurn ?? 1.2, o.autoLevel ?? 1.2, o.gravity ?? 0.3, o.minAltitude ?? 3];
    const b = o.banked;
    if (b) {
      p.push(1, b.throttleRate ?? 0.42, b.speedLag ?? 0.56, b.boostSpeedLag ?? 0.26, b.maxBank ?? 1.1868, b.bankLag ?? 0.21, b.bankTurnReference ?? 0.9774, b.boostDuration ?? 1.7, b.boostMultiplier ?? 1.28, b.throttle ?? 0, b.floor ?? 0, b.floorPitch ?? 0);
    }
    return { kind: PLAYSET_MOTION.PLANE, p };
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
    /** speed while AUX is held, times maxSpeed */
    boost?: number;
    /** most pitch and roll the lean into acceleration reaches, radians */
    lean?: number;
  } = {}): Motion {
    const frame = { heading: 0, world: 1, camera: 2 }[o.frame ?? "heading"];
    return {
      kind: PLAYSET_MOTION.HOVER,
      p: [o.accel ?? 20, o.maxSpeed ?? 10, o.damping ?? 3, o.vertical ?? 12, o.maxVertical ?? 6, o.turnRate ?? 2.2, o.tilt ?? 3, o.gravity ?? 0, o.minY ?? 0.5, o.maxY ?? 0, frame, o.boost ?? 1.6, o.lean ?? 0.5],
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
  runner(o: { speed?: number; accel?: number; maxSpeed?: number; laneWidth?: number; lanes?: number; laneRate?: number; jump?: number; gravity?: number; slide?: number; slideLean?: number } = {}): Motion {
    return {
      kind: PLAYSET_MOTION.RUNNER,
      p: [o.speed ?? 12, o.accel ?? 0.25, o.maxSpeed ?? 30, o.laneWidth ?? 2.5, o.lanes ?? 3, o.laneRate ?? 14, o.jump ?? 9, o.gravity ?? 1.4, o.slide ?? 0.7, o.slideLean ?? 1.1],
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

/** What a brain looks at: the nearest slot on some layers, the one on some
 *  layers furthest along its path kernel's path (tower defense), the
 *  slot's own TARGET, or a point. */
export type Target =
  | { readonly nearest: number; readonly sight?: number; readonly every?: number }
  | { readonly leading: number; readonly sight?: number; readonly every?: number }
  | { readonly slot: true }
  | { readonly point: readonly [number, number, number] };

/** One steering term: kind, weight and four parameters (PLAYSET_STEER). */
export type SteerTerm = readonly [kind: number, weight: number, a: number, b: number, c: number, d: number];
/** One transition: condition, value, the state it moves to (PLAYSET_STEER_WHEN). */
export type SteerTransition = readonly [condition: number, value: number, next: number];

/** Steering terms. A state sums its terms by weight; the sum's length is
 *  capped at 1 and scaled by the state's speed. */
export const steer = {
  /** toward the target, slowing inside `slow` metres of `stop` and halting there */
  seek: (weight = 1, o: { slow?: number; stop?: number } = {}): SteerTerm => [PLAYSET_STEER.SEEK, weight, o.slow ?? 0, o.stop ?? 0, 0, 0],
  flee: (weight = 1): SteerTerm => [PLAYSET_STEER.FLEE, weight, 0, 0, 0, 0],
  /** around the target at `radius`; `flip` seconds between side changes
   *  (0 keeps `side`); `correction` weighs the pull back to the radius */
  orbit: (radius: number, o: { weight?: number; side?: 1 | -1; flip?: number; correction?: number } = {}): SteerTerm => [
    PLAYSET_STEER.ORBIT, o.weight ?? 1, radius, o.side ?? 1, o.flip ?? 0, o.correction ?? 1,
  ],
  /** a heading that turns by up to `turn` radians every `every` seconds; at
   *  each turn it rests with probability `idle` */
  wander: (o: { weight?: number; turn?: number; every?: number; idle?: number } = {}): SteerTerm => [
    PLAYSET_STEER.WANDER, o.weight ?? 1, o.turn ?? 1.5, o.every ?? 2, o.idle ?? 0, 0,
  ],
  /** back toward the spawn point while further than `radius` */
  home: (radius: number, weight = 1): SteerTerm => [PLAYSET_STEER.HOME, weight, radius, 0, 0, 0],
  /** toward where the target will be in `seconds` */
  lead: (seconds: number, weight = 1): SteerTerm => [PLAYSET_STEER.LEAD, weight, seconds, 0, 0, 0],
  /** up while lower than `metres` over the ground */
  altitude: (metres: number, weight = 1): SteerTerm => [PLAYSET_STEER.ALTITUDE, weight, metres, 0, 0, 0],
  /** along the current heading */
  forward: (weight = 1): SteerTerm => [PLAYSET_STEER.FORWARD, weight, 0, 0, 0, 0],
  /** up and down at `rate` rad/s, each slot at its own phase */
  weave: (rate: number, weight: number): SteerTerm => [PLAYSET_STEER.WEAVE, weight, rate, 0, 0, 0],
};

/** Transitions, checked in order before a state's terms; the first that
 *  holds moves the slot to state `to`. */
export const when = {
  near: (metres: number, to: number): SteerTransition => [PLAYSET_STEER_WHEN.NEAR, metres, to],
  /** beyond `metres`, or no target */
  far: (metres: number, to: number): SteerTransition => [PLAYSET_STEER_WHEN.FAR, metres, to],
  after: (seconds: number, to: number): SteerTransition => [PLAYSET_STEER_WHEN.AFTER, seconds, to],
  /** hit points below `fraction` of the archetype's */
  hurt: (fraction: number, to: number): SteerTransition => [PLAYSET_STEER_WHEN.HURT, fraction, to],
  noTarget: (to: number): SteerTransition => [PLAYSET_STEER_WHEN.NO_TARGET, 0, to],
  target: (to: number): SteerTransition => [PLAYSET_STEER_WHEN.TARGET, 0, to],
  /** with probability `perSecond` each second */
  chance: (perSecond: number, to: number): SteerTransition => [PLAYSET_STEER_WHEN.CHANCE, perSecond, to],
};

export interface SteerState {
  /** fraction of the kernel's speed */
  speed?: number;
  /** hold AUX (boost, run) */
  boost?: boolean;
  /** fire weapon 0 when the target is within range and inside the cone (radians) */
  fireRange?: number;
  fireCone?: number;
  /** the FWD intent instead of the steered one (a plane's throttle) */
  fwd?: number;
  terms?: readonly SteerTerm[];
  next?: readonly SteerTransition[];
}

export function encodeBehaviour(states: readonly SteerState[]): number[] {
  const L = PLAYSET_BEHAVIOUR;
  const H = PLAYSET_BEHAVIOUR_STATE;
  if (states.length > L.STATES) throw new Error(`playset: a behaviour has at most ${L.STATES} states`);
  const b = new Array<number>(PLAYSET_BEHAVIOUR_LENGTH).fill(0);
  states.forEach((st, i) => {
    const at = L.HEADER + i * PLAYSET_BEHAVIOUR_STATE_LENGTH;
    b[at + H.SPEED] = st.speed ?? 1;
    b[at + H.BOOST] = st.boost ? 1 : 0;
    b[at + H.FIRE_RANGE] = st.fireRange ?? 0;
    b[at + H.FIRE_CONE] = st.fireCone ?? 0.25;
    if (st.fwd !== undefined) {
      b[at + H.SET_FWD] = 1;
      b[at + H.FWD] = st.fwd;
    }
    const terms = st.terms ?? [];
    const next = st.next ?? [];
    if (terms.length > L.TERMS || next.length > L.TRANSITIONS) throw new Error(`playset: a state has at most ${L.TERMS} terms and ${L.TRANSITIONS} transitions`);
    terms.forEach((t, k) => t.forEach((v, j) => (b[at + L.STATE_HEAD + k * L.TERM_LEN + j] = v)));
    next.forEach((t, k) => t.forEach((v, j) => (b[at + L.STATE_HEAD + L.TERMS * L.TERM_LEN + k * L.TRANSITION_LEN + j] = v)));
  });
  return b;
}

/** BRAIN_P: the target choice (brains.rs). */
function targetFloats(t: Target | undefined): number[] {
  const p = new Array(16).fill(0);
  if (t && "nearest" in t) {
    p[0] = 1;
    p[1] = t.nearest;
    p[5] = t.sight ?? 0;
    p[8] = t.every ?? 0.5;
  } else if (t && "leading" in t) {
    p[0] = 4;
    p[1] = t.leading;
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
  return p;
}

interface BrainCommon {
  target?: Target;
  /** fire weapon 0 when the target is within range and inside the cone */
  fireRange?: number;
  fireCone?: number;
  /** distance to keep (seek stops, orbit circles, strafe holds, pursue breaks away) */
  distance?: number;
  /** fraction of the kernel's speed */
  speed?: number;
}

const fire = (o: BrainCommon) => ({ fireRange: o.fireRange ?? 0, fireCone: o.fireCone ?? 0.25 });

/** A behaviour from steering states (`steer`, `when`). The presets below
 *  are written with it; a game composes its own the same way. */
function steering(target: Target | undefined, states: readonly SteerState[]): Brain {
  return { kind: PLAYSET_BRAIN.STEER, p: targetFloats(target), behaviour: encodeBehaviour(states) };
}

export const brain = {
  none: (): Brain => ({ kind: PLAYSET_BRAIN.NONE, p: [] }),
  steer: (o: { target?: Target; states: readonly SteerState[] }): Brain => steering(o.target, o.states),
  /** Toward the target, stopping at `distance`; inside `near` metres its
   *  speed scales by `nearSpeed` (above 1 the kernel's maxSpeed must leave
   *  room: speed * nearSpeed <= 1). */
  seek(o: BrainCommon & { near?: number; nearSpeed?: number } = {}): Brain {
    const d = o.distance ?? 0;
    const term = steer.seek(1, { slow: d > 0 ? Math.max(d * 0.5, 0.5) : 0, stop: d });
    const speed = o.speed ?? 1;
    if (!o.near) return steering(o.target, [{ speed, ...fire(o), terms: [term] }]);
    return steering(o.target, [
      { speed, ...fire(o), terms: [term], next: [when.near(o.near, 1)] },
      { speed: speed * (o.nearSpeed ?? 1), ...fire(o), terms: [term], next: [when.far(o.near, 0)] },
    ]);
  },
  flee: (o: BrainCommon = {}): Brain => steering(o.target, [{ speed: o.speed ?? 1, terms: [steer.flee()] }]),
  orbit: (o: BrainCommon & { clockwise?: boolean } = {}): Brain =>
    steering(o.target, [{ speed: o.speed ?? 1, ...fire(o), terms: [steer.orbit(o.distance ?? 0, { side: o.clockwise ? -1 : 1, correction: 0.5 })] }]),
  /** Ambles about its spawn point at half speed, resting now and then;
   *  `leash` pulls it home; with a target it drifts toward it. */
  wander(o: BrainCommon & { every?: number; turn?: number; leash?: number } = {}): Brain {
    const terms: SteerTerm[] = [steer.wander({ turn: o.turn ?? 1.5, every: o.every ?? 2, idle: 0.3 })];
    if (o.leash) terms.push(steer.home(o.leash, 2));
    if (o.target) terms.push(steer.seek(0.3));
    return steering(o.target, [{ speed: (o.speed ?? 1) * 0.5, ...fire(o), terms }]);
  },
  /** Wanders, and bolts at full speed with AUX held for `panic` seconds
   *  from anything on the target layers within sight. */
  herd(o: BrainCommon & { panic?: number; every?: number; turn?: number; leash?: number } = {}): Brain {
    const graze: SteerTerm[] = [steer.wander({ turn: o.turn ?? 1.2, every: o.every ?? 2.5, idle: 0.3 })];
    if (o.leash) graze.push(steer.home(o.leash, 2));
    return steering(o.target, [
      { speed: (o.speed ?? 1) * 0.5, terms: graze, next: [when.target(1)] },
      { speed: 1, boost: true, terms: [steer.flee()], next: [when.after(Math.max(o.panic ?? 3, 1), 0)] },
    ]);
  },
  /** Flight pursuit: toward where the target will be in `lead` seconds,
   *  climbing below `floor` metres. With `distance` it breaks away inside
   *  that range and holds fire; with `throttleDistance` FWD opens the
   *  throttle beyond it and eases it inside; `weave` adds a pitch weave. */
  pursue(o: BrainCommon & { lead?: number; floor?: number; throttleDistance?: number; weave?: number } = {}): Brain {
    const lead = o.lead ?? 0.6;
    const terms: SteerTerm[] = [lead > 0 ? steer.lead(lead) : steer.seek()];
    const cruise: SteerTerm[] = [steer.forward()];
    const extra: SteerTerm[] = [];
    if ((o.floor ?? 12) > 0) extra.push(steer.altitude(o.floor ?? 12));
    if (o.weave) extra.push(steer.weave(0.9, o.weave));
    terms.push(...extra);
    cruise.push(...extra);
    const t = o.throttleDistance;
    const open = t ? 1 : undefined;
    const ease = t ? -0.25 : undefined;
    const away = o.distance ?? 0;
    if (!away && !t) {
      return steering(o.target, [
        { speed: o.speed ?? 1, ...fire(o), terms, next: [when.noTarget(1)] },
        { speed: o.speed ?? 1, terms: cruise, next: [when.target(0)] },
      ]);
    }
    // 0 closing, 1 inside the throttle distance, 2 breaking away, 3 no target
    const breakaway = away ? [when.near(away, 2)] : [];
    return steering(o.target, [
      { speed: o.speed ?? 1, ...fire(o), fwd: open, terms, next: [...breakaway, ...(t ? [when.near(t, 1)] : []), when.noTarget(3)] },
      { speed: o.speed ?? 1, ...fire(o), fwd: ease, terms, next: [...breakaway, when.far(t ?? 0, 0)] },
      { speed: o.speed ?? 1, fwd: ease, terms: [steer.flee(), ...extra.filter((x) => x[0] === PLAYSET_STEER.WEAVE)], next: [when.far(away, t ? 1 : 0)] },
      { speed: o.speed ?? 1, fwd: ease, terms: cruise, next: [when.target(0)] },
    ]);
  },
  turret: (o: BrainCommon = {}): Brain => steering(o.target, [{ ...fire(o) }]),
  /** Circles the target at `distance`, switching sides every few seconds. */
  strafe: (o: BrainCommon & { every?: number } = {}): Brain =>
    steering(o.target, [{ speed: o.speed ?? 1, ...fire(o), terms: [steer.orbit(o.distance ?? 0, { flip: o.every ?? 1.6, correction: 1.25 })] }]),
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
