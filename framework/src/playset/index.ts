// @pocketjs/framework/playset — small 3D games over native kernels.
//
// A game is three layers, cheapest first per frame (docs/PLAYSET.md):
//
//   1. content, at load: three.js-shaped Object3D trees become native models
//      (`model`), placed as scenery (`place`) or carried by archetypes;
//   2. behaviour as data, evaluated natively every step: archetypes pick a
//      motion kernel, a brain, weapons, joint drivers and collision layers;
//      rules say what a contact between two layers does;
//   3. gameplay in TypeScript, at event rate: `on()` handlers for hits,
//      deaths, pickups and gates, timers, waves, scoring and the HUD, plus
//      `script()` for per-slot logic on a budget.
//
// Per frame the guest crosses into native code once (`frame()` = one step),
// then reads event records and slot state from Float32Array views over
// native memory: reading `ent[s * 16 + ENT.X]` is an array load, not a call.
// Nothing in the per-frame path allocates.

import {
  PLAYSET_ARCH,
  PLAYSET_ARCH_FLAG,
  PLAYSET_ARCH_LENGTH,
  PLAYSET_ARCH_SOUND,
  PLAYSET_VOICE,
  PLAYSET_BOUNDS,
  PLAYSET_CAMERA,
  PLAYSET_CAMERA_LENGTH,
  PLAYSET_CAMERA_MODE,
  PLAYSET_EMITTER,
  PLAYSET_EMITTER_LENGTH,
  PLAYSET_ENT,
  PLAYSET_ENV,
  PLAYSET_EVENT,
  PLAYSET_GROUND,
  PLAYSET_INTENT,
  PLAYSET_NODE,
  PLAYSET_QUERY,
  PLAYSET_RULE,
  PLAYSET_STATE,
  PLAYSET_VIEW,
} from "../../../contracts/spec/playset.ts";
import { Color, describeModel, type Object3D } from "./three.ts";
import { encodeWeapon, type Brain, type JointDriver, type Motion, type Weapon } from "./kinds.ts";
import { encodeSound, type Sound, type SoundSpec } from "./sound.ts";

export * from "./kinds.ts";
export { sfx, type Sound, type SoundSpec } from "./sound.ts";
export {
  PLAYSET_ENT as ENT,
  PLAYSET_INTENT as INTENT,
  PLAYSET_EVENT as EVENT,
  PLAYSET_STATE as STATE,
  PLAYSET_STAT as STAT,
  PLAYSET_CAMERA_FIELD as CAMERA_FIELD,
  PLAYSET_MODULE as MODULE,
} from "../../../contracts/spec/playset.ts";

/** The host namespace (products/3ds/src/playset.c). */
export interface PlaysetNative {
  init(capacity: number, particles: number): boolean;
  view(which: number): Float32Array;
  model(desc: Float32Array): number;
  node(model: number, x: number, y: number, z: number, yaw: number, pitch: number, roll: number, scale: number, flags: number): number;
  nodeSet(node: number, x: number, y: number, z: number, yaw: number, pitch: number, roll: number, scale: number, flags: number): void;
  nodeMatrix(node: number, model: number, m: Float32Array, flags: number): number;
  nodeRemove(node: number): void;
  env(kind: number, params: Float32Array): void;
  terrain(w: number, h: number, cell: number, ox: number, oy: number, oz: number, heights: Float32Array, bands: Float32Array): void;
  collider(shape: number, params: Float32Array): number;
  collidersClear(): void;
  lod(radial: number, rings: number, tubular: number): void;
  arch(desc: Float32Array): number;
  archSet(id: number, desc: Float32Array): void;
  rule(a: number, b: number, flags: number, value: number): number;
  rulesClear(): void;
  path(points: Float32Array): number;
  emitter(desc: Float32Array): number;
  spawn(arch: number, x: number, y: number, z: number, yaw: number): number;
  kill(slot: number, mode: number): void;
  revive(slot: number, hp: number): void;
  attach(slot: number, parent: number, x: number, y: number, z: number, yaw: number, follow: number): void;
  layer(slot: number, layer: number, mask: number, team: number): void;
  emit(emitter: number, x: number, y: number, z: number, count: number): void;
  fire(slot: number, weapon: number): void;
  step(dt: number): number;
  camera(desc: Float32Array): void;
  query(kind: number, a: number, b: number, c: number, d: number): number;
  seed(seed: number): void;
  clear(): void;
  now(): number;
  renderStats(out: Float32Array): void;
  call(module: number, op: number, args?: Float32Array, out?: Float32Array): number;
  sound(desc: Float32Array): number;
  soundPlay(kind: number, sound: number, volume: number, pitch: number, panOrX: number, y: number, z: number, placed: number): number;
  volume(v: number): void;
}

export function nativePlayset(): PlaysetNative | null {
  return ((globalThis as { playset?: PlaysetNative }).playset) ?? null;
}

export interface Model {
  readonly id: number;
  readonly joints: readonly string[];
}

export interface Emitter {
  readonly id: number;
}

/** An archetype's description. Every field has a default. */
export interface ArchetypeSpec {
  model?: Model | null;
  scale?: number;
  motion?: Motion;
  brain?: Brain;
  /** collision layer bits it is on, and the bits it tests against */
  layer?: number;
  hits?: number;
  /** projectiles never hit their shooter's team; 0 = no team */
  team?: number;
  radius?: number;
  /** collision centre sits at half this above the position */
  height?: number;
  /** movers that are both solid push apart */
  solid?: boolean;
  mass?: number;
  hp?: number;
  /** what a DAMAGE rule takes from the other side */
  damage?: number;
  /** seconds; 0 = forever */
  lifetime?: number;
  /** DEATH event VALUE (score) */
  value?: number;
  death?: Emitter;
  trail?: Emitter;
  trailRate?: number;
  /** blob shadow radius */
  shadow?: number;
  bounds?: "none" | "clamp" | "kill" | "wrap" | "bounce";
  ground?: "none" | "snap" | "gravity" | "water";
  groundOffset?: number;
  /** seconds of white flash after a hit */
  flash?: number;
  /** seconds of invulnerability after a hit */
  invulnerable?: number;
  /** emit EXPIRE when the lifetime runs out */
  expireEvent?: boolean;
  faceVelocity?: boolean;
  alignGround?: boolean;
  immortal?: boolean;
  keepOnDeath?: boolean;
  hidden?: boolean;
  projectile?: boolean;
  targetable?: boolean;
  ghost?: boolean;
  weapons?: readonly (Weapon | undefined)[];
  joints?: readonly JointDriver[];
  /** played natively where they happen; weapons name their own shot sound */
  sounds?: { death?: Sound; hit?: Sound; spawn?: Sound; volume?: number };
  /** a loop while this archetype is the camera's target, its pitch rising
   *  to `pitch` times the base at `speed` */
  hum?: { sound: Sound; speed?: number; pitch?: number };
}

export interface Archetype {
  readonly id: number;
  readonly spec: ArchetypeSpec;
}

/** (a, b, data, x, y, z, value) — the event record's fields as numbers. */
export type EventHandler = (a: number, b: number, data: number, x: number, y: number, z: number, value: number) => void;

export interface RuleSpec {
  /** who loses hit points: the second layer's slot, the first's, or both */
  damage?: "a" | "b" | "both";
  kill?: "a" | "b" | "both";
  event?: boolean;
  push?: boolean;
  /** b is collected by a */
  pickup?: boolean;
  bounce?: boolean;
  /** damage amount; 0 takes the attacker's archetype DAMAGE */
  value?: number;
}

export interface EmitterSpec {
  count?: number;
  life?: number;
  lifeJitter?: number;
  speed?: number;
  speedJitter?: number;
  /** cone half angle around `dir`; Math.PI for every direction */
  spread?: number;
  dir?: readonly [number, number, number];
  gravity?: number;
  drag?: number;
  size?: number | readonly [number, number];
  color?: number | readonly [number, number];
  alpha?: number | readonly [number, number];
  blend?: "alpha" | "add";
  radius?: number;
  inherit?: boolean;
}

export interface CameraFollow {
  /** right, up, back from the target */
  offset?: readonly [number, number, number];
  lookAhead?: number;
  lookUp?: number;
  smooth?: number;
  smoothLook?: number;
  /** offsets turn with the target's yaw */
  heading?: boolean;
  /** offsets follow the target's whole attitude (flight) */
  attitude?: boolean;
  fov?: number;
  near?: number;
  far?: number;
}

function rgb(hex: number): [number, number, number] {
  const c = new Color(hex);
  return [c.r, c.g, c.b];
}

const pair = (v: number | readonly [number, number] | undefined, fallback: number): [number, number] =>
  v === undefined ? [fallback, fallback] : typeof v === "number" ? [v, v] : [v[0], v[1]];

export class Playset {
  readonly native: PlaysetNative;
  /** PLAYSET_STRIDE.ENT floats per slot (contracts/spec/playset.ts PLAYSET_ENT) */
  readonly ent: Float32Array;
  readonly intent: Float32Array;
  /** eight free floats per slot that only the guest reads and writes */
  readonly user: Float32Array;
  /** scale, r, g, b tint per slot */
  readonly look: Float32Array;
  /** four script-driven joint angles per slot */
  readonly joints: Float32Array;
  readonly events: Float32Array;
  /** query results */
  readonly list: Float32Array;
  readonly cameraView: Float32Array;
  readonly stats: Float32Array;
  readonly capacity: number;
  /** steps taken */
  tick = 0;
  /** events of the last step */
  eventCount = 0;
  private readonly handlers: (EventHandler | undefined)[] = [];
  private readonly scripts: { arch: number; fn: (slot: number) => void; every: number; phase: number }[] = [];
  private readonly scratch = new Float32Array(32);
  private readonly cameraDesc = new Float32Array(PLAYSET_CAMERA_LENGTH);

  constructor(options: { capacity?: number; particles?: number; seed?: number; lod?: readonly [number, number, number] } = {}) {
    const n = nativePlayset();
    if (!n) throw new Error("playset: this host has no game.playset (declare it in pocket.json engine.capabilities.requires)");
    this.native = n;
    n.init(options.capacity ?? 256, options.particles ?? 512);
    this.ent = n.view(PLAYSET_VIEW.ENT);
    this.intent = n.view(PLAYSET_VIEW.INTENT);
    this.user = n.view(PLAYSET_VIEW.USER);
    this.look = n.view(PLAYSET_VIEW.LOOK);
    this.joints = n.view(PLAYSET_VIEW.JOINT);
    this.events = n.view(PLAYSET_VIEW.EVENTS);
    this.list = n.view(PLAYSET_VIEW.LIST);
    this.cameraView = n.view(PLAYSET_VIEW.CAMERA);
    this.stats = n.view(PLAYSET_VIEW.STATS);
    this.capacity = this.ent.length / 16;
    if (options.seed !== undefined) n.seed(options.seed);
    if (options.lod) n.lod(options.lod[0], options.lod[1], options.lod[2]);
  }

  // --- content --------------------------------------------------------------

  /** A native model from a three.js-shaped tree. */
  model(root: Object3D, options?: { jitter?: number; seed?: number }): Model {
    const layout = describeModel(root, options);
    const id = this.native.model(layout.desc);
    if (id < 0) throw new Error(`playset: model ${root.name || "(unnamed)"} was rejected (${id})`);
    return { id, joints: layout.joints };
  }

  /** Scenery: `static` bakes it into world batches (it can never move);
   *  `collide` adds a box or cylinder collider from its bounds. */
  place(
    model: Model,
    at: readonly [number, number, number],
    o: { yaw?: number; pitch?: number; roll?: number; scale?: number; static?: boolean; collide?: "box" | "cylinder"; hidden?: boolean } = {},
  ): number {
    const flags =
      (o.static === false ? 0 : PLAYSET_NODE.STATIC) |
      (o.collide === "box" ? PLAYSET_NODE.COLLIDE_BOX : o.collide === "cylinder" ? PLAYSET_NODE.COLLIDE_CYL : 0) |
      (o.hidden ? PLAYSET_NODE.HIDDEN : 0);
    return this.native.node(model.id, at[0], at[1], at[2], o.yaw ?? 0, o.pitch ?? 0, o.roll ?? 0, o.scale ?? 1, flags);
  }

  /** Move a dynamic scenery node (one placed with static: false). */
  move(node: number, x: number, y: number, z: number, yaw = 0, pitch = 0, roll = 0, scale = 1, hidden = false): void {
    this.native.nodeSet(node, x, y, z, yaw, pitch, roll, scale, hidden ? PLAYSET_NODE.HIDDEN : 0);
  }

  sky(top: number, horizon: number, bottom = horizon): void {
    this.native.env(PLAYSET_ENV.SKY, new Float32Array([...rgb(top), ...rgb(horizon), ...rgb(bottom)]));
  }

  fog(color: number, start: number, end: number, max = 1): void {
    this.native.env(PLAYSET_ENV.FOG, new Float32Array([...rgb(color), start, end, max]));
  }

  /** `sun` points toward the sun; colours are sRGB hex scaled by intensity. */
  light(o: { sun?: readonly [number, number, number]; sunColor?: number; sunIntensity?: number; sky?: number; ground?: number; ambient?: number }): void {
    const k = o.sunIntensity ?? 1;
    const a = o.ambient ?? 1;
    const sun = rgb(o.sunColor ?? 0xfff4e6).map((v) => v * Math.sqrt(k));
    const sky = rgb(o.sky ?? 0x8aa0c0).map((v) => v * Math.sqrt(a));
    const ground = rgb(o.ground ?? 0x4a4038).map((v) => v * Math.sqrt(a));
    const d = o.sun ?? [0.4, 0.8, 0.35];
    this.native.env(PLAYSET_ENV.LIGHT, new Float32Array([d[0], d[1], d[2], ...sun, ...sky, ...ground]));
  }

  /** A flat checkered ground of `size` metres a side. */
  ground(o: { y?: number; size?: number; color?: number; color2?: number; cell?: number } = {}): void {
    const a = rgb(o.color ?? 0x5d7a4a);
    const b = rgb(o.color2 ?? o.color ?? 0x5d7a4a);
    this.native.env(PLAYSET_ENV.GROUND, new Float32Array([o.y ?? 0, (o.size ?? 100) / 2, ...a, ...b, o.cell ?? 4]));
  }

  water(o: { level?: number; amplitude?: number; wavelength?: number; speed?: number; size?: number; cells?: number; color?: number; deep?: number } = {}): void {
    this.native.env(
      PLAYSET_ENV.WATER,
      new Float32Array([o.level ?? 0, o.amplitude ?? 0.3, o.wavelength ?? 12, o.speed ?? 1, (o.size ?? 120) / 2, o.cells ?? 24, ...rgb(o.color ?? 0x2f7fb0), ...rgb(o.deep ?? 0x1a4f78)]),
    );
  }

  /** A heightfield `size` metres a side with `resolution` samples per side,
   *  from a height function (evaluated once, here) or a row-major array.
   *  `bands` colour by height: [[height, hex], ...] in rising order. */
  terrain(o: { size: number; resolution: number; height: ((x: number, z: number) => number) | Float32Array; bands?: readonly (readonly [number, number])[]; origin?: readonly [number, number, number] }): void {
    const n = Math.max(2, Math.min(129, o.resolution | 0));
    const cell = o.size / (n - 1);
    let heights: Float32Array;
    if (typeof o.height === "function") {
      heights = new Float32Array(n * n);
      const half = o.size / 2;
      for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) heights[z * n + x] = o.height(x * cell - half + (o.origin?.[0] ?? 0), z * cell - half + (o.origin?.[2] ?? 0));
    } else heights = o.height;
    const bands = new Float32Array((o.bands ?? [[-1e9, 0x5d7a4a]]).flatMap(([h, c]) => [h, ...rgb(c)]));
    const origin = o.origin ?? [0, 0, 0];
    this.native.terrain(n, n, cell, origin[0], origin[1], origin[2], heights, bands);
  }

  /** Movement bounds for archetypes whose `bounds` is not "none". */
  bounds(minX: number, maxX: number, minZ: number, maxZ: number, minY = -1e4, maxY = 1e4): void {
    this.native.env(PLAYSET_ENV.BOUNDS, new Float32Array([minX, maxX, minY, maxY, minZ, maxZ]));
  }

  gravity(g: number): void {
    this.native.env(PLAYSET_ENV.GRAVITY, new Float32Array([g]));
  }

  colliderBox(center: readonly [number, number, number], half: readonly [number, number, number], yaw = 0): number {
    return this.native.collider(1, new Float32Array([...center, ...half, yaw]));
  }

  colliderCylinder(center: readonly [number, number, number], radius: number, halfHeight: number): number {
    return this.native.collider(2, new Float32Array([...center, radius, halfHeight]));
  }

  /** Points (x, y, z) for path kernels and waypoint brains. */
  path(points: readonly (readonly [number, number, number])[]): number {
    return this.native.path(new Float32Array(points.flatMap((p) => [p[0], p[1], p[2]])));
  }

  emitter(o: EmitterSpec): Emitter {
    const d = new Float32Array(PLAYSET_EMITTER_LENGTH);
    const [s0, s1] = pair(o.size, 0.3);
    const [c0, c1] = pair(o.color, 0xffffff);
    const [a0, a1] = pair(o.alpha, 1);
    const dir = o.dir ?? [0, 1, 0];
    const E = PLAYSET_EMITTER;
    d[E.COUNT] = o.count ?? 12;
    d[E.LIFE] = o.life ?? 0.6;
    d[E.LIFE_JITTER] = o.lifeJitter ?? (o.life ?? 0.6) * 0.3;
    d[E.SPEED] = o.speed ?? 4;
    d[E.SPEED_JITTER] = o.speedJitter ?? (o.speed ?? 4) * 0.4;
    d[E.SPREAD] = o.spread ?? Math.PI;
    d[E.DX] = dir[0];
    d[E.DY] = dir[1];
    d[E.DZ] = dir[2];
    d[E.GRAVITY] = o.gravity ?? 0;
    d[E.DRAG] = o.drag ?? 1;
    d[E.SIZE] = s0;
    d[E.SIZE_END] = s1;
    const ca = rgb(c0), cb = rgb(c1);
    d[E.R] = ca[0];
    d[E.G] = ca[1];
    d[E.B] = ca[2];
    d[E.A] = a0;
    d[E.R2] = cb[0];
    d[E.G2] = cb[1];
    d[E.B2] = cb[2];
    d[E.A2] = a1;
    d[E.BLEND] = o.blend === "alpha" ? 1 : 2;
    d[E.RADIUS] = o.radius ?? 0;
    d[E.INHERIT] = o.inherit ? 1 : 0;
    return { id: this.native.emitter(d) };
  }

  /** Particles from an emitter at a point; `scale` multiplies its count. */
  burst(e: Emitter, x: number, y: number, z: number, scale = 1): void {
    this.native.emit(e.id, x, y, z, scale);
  }

  // --- behaviour ------------------------------------------------------------

  private encode(spec: ArchetypeSpec): Float32Array {
    const A = PLAYSET_ARCH;
    const F = PLAYSET_ARCH_FLAG;
    const behaviour = spec.brain?.behaviour;
    const d = new Float32Array(PLAYSET_ARCH_LENGTH + (behaviour ? behaviour.length : 0));
    if (behaviour) d.set(behaviour, PLAYSET_ARCH_LENGTH);
    d[A.MODEL] = spec.model ? spec.model.id + 1 : 0;
    d[A.SCALE] = spec.scale ?? 1;
    d[A.MOTION] = spec.motion?.kind ?? 0;
    d[A.BRAIN] = spec.brain?.kind ?? 0;
    d[A.LAYER] = spec.layer ?? 0;
    d[A.MASK] = spec.hits ?? 0;
    d[A.TEAM] = spec.team ?? 0;
    d[A.RADIUS] = spec.radius ?? 0;
    d[A.HEIGHT] = spec.height ?? 0;
    d[A.SOLID] = spec.solid ? 1 : 0;
    d[A.HP] = spec.hp ?? 0;
    d[A.DAMAGE] = spec.damage ?? 0;
    d[A.LIFETIME] = spec.lifetime ?? 0;
    d[A.DEATH_EMITTER] = spec.death ? spec.death.id + 1 : 0;
    d[A.TRAIL_EMITTER] = spec.trail ? spec.trail.id + 1 : 0;
    d[A.TRAIL_RATE] = spec.trailRate ?? 0;
    d[A.SHADOW] = spec.shadow ?? 0;
    d[A.FLAGS] =
      (spec.faceVelocity ? F.FACE_VELOCITY : 0) |
      (spec.alignGround ? F.ALIGN_GROUND : 0) |
      (spec.immortal ? F.INVULNERABLE : 0) |
      (spec.keepOnDeath ? F.KEEP_ON_DEATH : 0) |
      (spec.hidden ? F.NO_RENDER : 0) |
      (spec.projectile ? F.PROJECTILE : 0) |
      (spec.targetable ? F.TARGETABLE : 0) |
      (spec.ghost ? F.GHOST : 0);
    d[A.BOUNDS] = PLAYSET_BOUNDS[(spec.bounds ?? "none").toUpperCase() as keyof typeof PLAYSET_BOUNDS];
    d[A.GROUND] = PLAYSET_GROUND[(spec.ground ?? "none").toUpperCase() as keyof typeof PLAYSET_GROUND];
    d[A.GROUND_OFFSET] = spec.groundOffset ?? 0;
    d[A.MASS] = spec.mass ?? 1;
    d[A.FLASH] = spec.flash ?? 0.12;
    d[A.VALUE] = spec.value ?? 0;
    spec.motion?.p.forEach((v, i) => (d[A.MOTION_P + i] = v));
    spec.brain?.p.forEach((v, i) => (d[A.BRAIN_P + i] = v));
    spec.weapons?.forEach((w, i) => {
      if (!w || i > 1) return;
      encodeWeapon(w).forEach((v, k) => (d[(i === 0 ? A.WEAPON0 : A.WEAPON1) + k] = v));
    });
    spec.joints?.slice(0, 4).forEach((j, i) => {
      const index = spec.model?.joints.indexOf(j.joint) ?? -1;
      if (index < 0) throw new Error(`playset: joint "${j.joint}" is not in the archetype's model`);
      d[A.JOINTS + i * 4] = index;
      d[A.JOINTS + i * 4 + 1] = j.kind;
      d[A.JOINTS + i * 4 + 2] = j.axis;
      d[A.JOINTS + i * 4 + 3] = j.rate;
    });
    const AS = PLAYSET_ARCH_SOUND;
    d[AS.DEATH] = spec.sounds?.death ? spec.sounds.death.id + 1 : 0;
    d[AS.HIT] = spec.sounds?.hit ? spec.sounds.hit.id + 1 : 0;
    d[AS.SPAWN] = spec.sounds?.spawn ? spec.sounds.spawn.id + 1 : 0;
    d[AS.VOLUME] = spec.sounds?.volume ?? 0;
    d[AS.HUM] = spec.hum ? spec.hum.sound.id + 1 : 0;
    d[AS.HUM_SPEED] = spec.hum?.speed ?? 0;
    d[AS.HUM_PITCH] = spec.hum?.pitch ?? 0;
    d[A.EXTRA] = spec.invulnerable ?? 0;
    d[A.EXTRA + 1] = spec.expireEvent ? 1 : 0;
    return d;
  }

  archetype(spec: ArchetypeSpec): Archetype {
    return { id: this.native.arch(this.encode(spec)), spec };
  }

  /** Change an archetype's tuning; live slots use it from the next step. */
  retune(arch: Archetype, changes: Partial<ArchetypeSpec>): Archetype {
    const spec = { ...arch.spec, ...changes };
    this.native.archSet(arch.id, this.encode(spec));
    (arch as { spec: ArchetypeSpec }).spec = spec;
    return arch;
  }

  /** What a contact between a slot on `a` layers and one on `b` layers does. */
  rule(a: number, b: number, r: RuleSpec): number {
    const R = PLAYSET_RULE;
    const flags =
      (r.event ? R.EVENT : 0) |
      (r.damage === "b" || r.damage === "both" ? R.DAMAGE_B : 0) |
      (r.damage === "a" || r.damage === "both" ? R.DAMAGE_A : 0) |
      (r.kill === "a" || r.kill === "both" ? R.KILL_A : 0) |
      (r.kill === "b" || r.kill === "both" ? R.KILL_B : 0) |
      (r.push ? R.PUSH : 0) |
      (r.pickup ? R.PICKUP : 0) |
      (r.bounce ? R.BOUNCE : 0);
    return this.native.rule(a, b, flags, r.value ?? 0);
  }

  // --- sound ----------------------------------------------------------------

  /** Synthesize a sound once (see `sfx` for presets). */
  sound(spec: SoundSpec): Sound {
    return { id: this.native.sound(encodeSound(spec)) };
  }

  /** Play a sound now; `at` places it in the world (distance and pan). */
  play(s: Sound | undefined, volume = 1, pitch = 1, at?: readonly [number, number, number]): void {
    if (!s) return;
    if (at) this.native.soundPlay(PLAYSET_VOICE.PLAY, s.id, volume, pitch, at[0], at[1], at[2], 1);
    else this.native.soundPlay(PLAYSET_VOICE.PLAY, s.id, volume, pitch, 0, 0, 0, 0);
  }

  /** Play a sound at a slot's position. */
  playAt(s: Sound | undefined, slot: number, volume = 1, pitch = 1): void {
    if (!s || slot < 0) return;
    const o = slot * 16;
    this.native.soundPlay(PLAYSET_VOICE.PLAY, s.id, volume, pitch, this.ent[o], this.ent[o + 1], this.ent[o + 2], 1);
  }

  /** Start a loop (a sound made with loop: true); its voice. */
  loop(s: Sound, volume = 1, pitch = 1): number {
    return this.native.soundPlay(PLAYSET_VOICE.LOOP, s.id, volume, pitch, 0, 0, 0, 0);
  }

  setLoop(voice: number, volume: number, pitch = 1, pan = 0): void {
    if (voice > 0) this.native.soundPlay(PLAYSET_VOICE.SET, voice, volume, pitch, pan, 0, 0, 0);
  }

  stopLoop(voice: number): void {
    if (voice > 0) this.native.soundPlay(PLAYSET_VOICE.STOP, voice, 0, 1, 0, 0, 0, 0);
  }

  /** 0..1 for everything this playset plays. */
  volume(v: number): void {
    this.native.volume(v);
  }

  // --- slots ----------------------------------------------------------------

  spawn(arch: Archetype, x: number, y: number, z: number, yaw = 0): number {
    return this.native.spawn(arch.id, x, y, z, yaw);
  }

  /** "silent" removes; "effects" plays the death emitter; "event" also reports DEATH. */
  kill(slot: number, how: "silent" | "effects" | "event" = "silent"): void {
    this.native.kill(slot, how === "silent" ? 0 : how === "effects" ? 1 : 2);
  }

  revive(slot: number, hp: number): void {
    this.native.revive(slot, hp);
  }

  attach(slot: number, parent: number, offset: readonly [number, number, number], yaw = 0, follow = true): void {
    this.native.attach(slot, parent, offset[0], offset[1], offset[2], yaw, follow ? 1 : 0);
  }

  /** Move a slot to other collision layers (a shield is a layer change). */
  setLayer(slot: number, layer: number, hits: number, team = 0): void {
    this.native.layer(slot, layer, hits, team);
  }

  fire(slot: number, weapon = 0): void {
    this.native.fire(slot, weapon);
  }

  /** Every slot and particle goes; content, archetypes and rules stay. */
  clear(): void {
    this.native.clear();
  }

  alive(slot: number): boolean {
    if (slot < 0) return false;
    const o = slot * 16;
    return this.ent[o + PLAYSET_ENT.ARCH] >= 1 && (this.ent[o + PLAYSET_ENT.STATE] & PLAYSET_STATE.DEAD) === 0;
  }

  archetypeOf(slot: number): number {
    return this.ent[slot * 16 + PLAYSET_ENT.ARCH] - 1;
  }

  x(slot: number): number {
    return this.ent[slot * 16];
  }
  y(slot: number): number {
    return this.ent[slot * 16 + 1];
  }
  z(slot: number): number {
    return this.ent[slot * 16 + 2];
  }
  yaw(slot: number): number {
    return this.ent[slot * 16 + PLAYSET_ENT.YAW];
  }
  hp(slot: number): number {
    return this.ent[slot * 16 + PLAYSET_ENT.HP];
  }
  speed(slot: number): number {
    return this.ent[slot * 16 + PLAYSET_ENT.SPEED];
  }

  /** Write the four motion intents of a slot. */
  steer(slot: number, x: number, fwd: number, turn = 0, rise = 0): void {
    const o = slot * 8;
    this.intent[o + PLAYSET_INTENT.X] = x;
    this.intent[o + PLAYSET_INTENT.FWD] = fwd;
    this.intent[o + PLAYSET_INTENT.TURN] = turn;
    this.intent[o + PLAYSET_INTENT.RISE] = rise;
  }

  /** Write the button intents of a slot (1 = held). */
  buttons(slot: number, fire: number, alt = 0, jump = 0, aux = 0): void {
    const o = slot * 8;
    this.intent[o + PLAYSET_INTENT.FIRE] = fire;
    this.intent[o + PLAYSET_INTENT.ALT] = alt;
    this.intent[o + PLAYSET_INTENT.JUMP] = jump;
    this.intent[o + PLAYSET_INTENT.AUX] = aux;
  }

  /** Slots of an archetype into `list`; the count. */
  ofArchetype(arch: Archetype): number {
    return this.native.query(PLAYSET_QUERY.ARCH, arch.id, 0, 0, 0);
  }

  /** Slots on `layers` within `radius` of (x, z) into `list`; the count. */
  near(layers: number, x: number, z: number, radius: number): number {
    return this.native.query(PLAYSET_QUERY.NEAR, layers, x, z, radius);
  }

  nearest(layers: number, from: number, range = 0): number {
    return this.native.query(PLAYSET_QUERY.NEAREST, layers, from, range, 0);
  }

  groundHeight(x: number, z: number): number {
    return this.native.query(PLAYSET_QUERY.HEIGHT, x, z, 0, 0);
  }

  // --- camera ---------------------------------------------------------------

  private sendCamera(mode: number, target: number, f: (d: Float32Array) => void): void {
    const d = this.cameraDesc;
    d.fill(0);
    d[PLAYSET_CAMERA.MODE] = mode;
    d[PLAYSET_CAMERA.TARGET] = target;
    d[PLAYSET_CAMERA.FOV] = 55;
    d[PLAYSET_CAMERA.NEAR] = 0.5;
    d[PLAYSET_CAMERA.FAR] = 200;
    f(d);
    this.native.camera(d);
  }

  followCamera(target: number, o: CameraFollow = {}): void {
    const C = PLAYSET_CAMERA;
    this.sendCamera(PLAYSET_CAMERA_MODE.FOLLOW, target, (d) => {
      const off = o.offset ?? [0, 6, 12];
      d[C.OX] = off[0];
      d[C.OY] = off[1];
      d[C.OZ] = off[2];
      d[C.LOOK_AHEAD] = o.lookAhead ?? 4;
      d[C.LOOK_UP] = o.lookUp ?? 1;
      d[C.SMOOTH] = o.smooth ?? 6;
      d[C.SMOOTH_LOOK] = o.smoothLook ?? 10;
      d[C.HEADING] = o.heading === false ? 0 : 1;
      d[C.ROLL] = o.attitude ? 1 : 0;
      if (o.fov) d[C.FOV] = o.fov;
      if (o.near) d[C.NEAR] = o.near;
      if (o.far) d[C.FAR] = o.far;
    });
  }

  /** `near` well past 0.5 buys depth precision for a far camera. */
  fixedCamera(eye: readonly [number, number, number], look: readonly [number, number, number], fov = 55, far = 200, near = 0.5): void {
    const C = PLAYSET_CAMERA;
    this.sendCamera(PLAYSET_CAMERA_MODE.FIXED, -1, (d) => {
      d[C.EX] = eye[0];
      d[C.EY] = eye[1];
      d[C.EZ] = eye[2];
      d[C.LX] = look[0];
      d[C.LY] = look[1];
      d[C.LZ] = look[2];
      d[C.FOV] = fov;
      d[C.FAR] = far;
      d[C.NEAR] = near;
    });
  }

  /** Around the target at `distance`: yaw 0 looks from +Z, pitch up from the ground. */
  orbitCamera(target: number, yaw: number, pitch: number, distance: number, o: { lookUp?: number; fov?: number; far?: number; smooth?: number } = {}): void {
    const C = PLAYSET_CAMERA;
    this.sendCamera(PLAYSET_CAMERA_MODE.ORBIT, target, (d) => {
      d[C.EX] = yaw;
      d[C.EY] = pitch;
      d[C.OZ] = distance;
      d[C.LOOK_UP] = o.lookUp ?? 1;
      d[C.SMOOTH] = o.smooth ?? 8;
      d[C.SMOOTH_LOOK] = o.smooth ?? 8;
      if (o.fov) d[C.FOV] = o.fov;
      if (o.far) d[C.FAR] = o.far;
    });
  }

  firstPersonCamera(target: number, eyeHeight = 1.6, fov = 60, far = 200): void {
    const C = PLAYSET_CAMERA;
    this.sendCamera(PLAYSET_CAMERA_MODE.FIRST_PERSON, target, (d) => {
      d[C.OY] = eyeHeight;
      d[C.FOV] = fov;
      d[C.NEAR] = 0.1;
      d[C.FAR] = far;
    });
  }

  /** Add camera shake (decays at 2 per second). */
  shake(amount: number): void {
    const d = this.cameraDesc;
    d[PLAYSET_CAMERA.SHAKE] = amount;
    this.native.camera(d);
    d[PLAYSET_CAMERA.SHAKE] = 0;
  }

  // --- the frame -------------------------------------------------------------

  /** One handler per event type (PLAYSET_EVENT); a second call replaces it. */
  on(type: number, handler: EventHandler | undefined): void {
    this.handlers[type] = handler;
  }

  /** `fn(slot)` for the live slots of `arch`, every `every` steps
   *  (staggered by `phase`), before the native step. */
  script(arch: Archetype, fn: (slot: number) => void, every = 1, phase = 0): () => void {
    const entry = { arch: arch.id, fn, every: Math.max(1, every | 0), phase };
    this.scripts.push(entry);
    return () => {
      const i = this.scripts.indexOf(entry);
      if (i >= 0) this.scripts.splice(i, 1);
    };
  }

  /** Run the scripts, one native step, then the handlers. Returns the event count. */
  frame(dt = 1 / 60): number {
    const scripts = this.scripts;
    for (let i = 0; i < scripts.length; i++) {
      const s = scripts[i];
      if ((this.tick + s.phase) % s.every !== 0) continue;
      const n = this.native.query(PLAYSET_QUERY.ARCH, s.arch, 0, 0, 0);
      const list = this.list;
      for (let k = 0; k < n; k++) s.fn(list[k]);
    }
    const n = this.native.step(dt);
    this.tick++;
    this.eventCount = n;
    const ev = this.events;
    const handlers = this.handlers;
    for (let i = 0; i < n; i++) {
      const o = i * 8;
      const h = handlers[ev[o]];
      if (h) h(ev[o + 1], ev[o + 2], ev[o + 3], ev[o + 4], ev[o + 5], ev[o + 6], ev[o + 7]);
    }
    return n;
  }

  /** A module's call (PLAYSET_MODULE); module wrappers name the ops. */
  call(module: number, op: number, args?: Float32Array, out?: Float32Array): number {
    return this.native.call(module, op, args, out);
  }

  /** Microseconds on the host's clock, for profiling guest code. */
  now(): number {
    return this.native.now();
  }

  /** draws, bone matrices, uploads, dynamic vertices, triangles of the last render */
  renderStats(): Float32Array {
    this.native.renderStats(this.scratch);
    return this.scratch;
  }
}

export function createPlayset(options?: ConstructorParameters<typeof Playset>[0]): Playset {
  return new Playset(options);
}

/** Bit masks for layer names: `const L = layers("player", "enemy", "shot")`. */
export function layers<const N extends readonly string[]>(...names: N): { readonly [K in N[number]]: number } {
  const out: Record<string, number> = {};
  names.forEach((n, i) => (out[n] = 1 << i));
  return out as { readonly [K in N[number]]: number };
}
