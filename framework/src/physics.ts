// @pocketjs/framework/physics — 2D bodies stepped by the UI core
// (capability ui.physics; contracts/spec/physics.ts holds the wire contract).
//
// A world is created once; bodies, colliders, zones and emitters are declared
// against it with node refs for their views. From then on the core integrates
// every tick and writes each body's pose into its views as paint-only props.
// Application code issues commands at interaction edges — a launch, a hop, a
// stylus grab — and receives landings, hits and zone crossings as
// frame-boundary events through the service pump, before its frame hooks run.
//
// Framework-neutral: no reactive primitive is used. Pair `createWorld` with
// the framework's cleanup (`onCleanup(() => world.destroy())` in Solid).

import {
  PHYSICS_ALPHA_CURVE,
  PHYSICS_ANCHOR,
  PHYSICS_AXIS,
  PHYSICS_CMD,
  PHYSICS_EVENT,
  PHYSICS_EVENT_WORDS,
  PHYSICS_GRAB,
  PHYSICS_KEY,
  PHYSICS_KIND,
  PHYSICS_QUERY,
  PHYSICS_SCALE_CURVE,
  PHYSICS_SHAPE,
  PHYSICS_SQUASH_AXIS,
} from "../../contracts/spec/physics.ts";
import { getOps, type HostOps } from "./host.ts";
import { textureHandle, type NodeMirror } from "./native-tree.ts";
import { registerServicePump } from "./services.ts";

export type NodeLike = NodeMirror | number;
export type Vec = readonly [number, number];
export type Surface = "primary" | "auxiliary";

type PhysicsOps = Required<Pick<HostOps, "physicsCreate" | "physicsApply" | "physicsDestroy" | "physicsEvents" | "physicsQuery">>;

/** True when the host implements ui.physics. */
export function hasPhysics(): boolean {
  const ops = getOps();
  return !!(ops.physicsCreate && ops.physicsApply && ops.physicsDestroy && ops.physicsEvents && ops.physicsQuery);
}

function physicsOps(): PhysicsOps {
  if (!hasPhysics()) throw new Error("Host does not implement ui.physics; declare it in pocket.json engine.capabilities.requires");
  return getOps() as PhysicsOps;
}

const nodeId = (node: NodeLike): number => (typeof node === "number" ? node : node.id);
const surfaceIndex = (surface: Surface | undefined): number => (surface === "auxiliary" ? 1 : 0);

/** [key, value] parameter builder. */
class Params {
  readonly values: number[] = [];
  set(key: number, value: number | boolean | undefined): this {
    if (value !== undefined) this.values.push(key, typeof value === "boolean" ? (value ? 1 : 0) : value);
    return this;
  }
  buffer(): ArrayBuffer {
    return new Float64Array(this.values).buffer;
  }
}

// ---- options ------------------------------------------------------------------

export interface WorldOptions {
  /** px/s², +y down. Default [0, 980]. */
  gravity?: Vec;
  /** Integrations per core tick, 1..8. Default 2. */
  substeps?: number;
  /** Seed of the world's generator (particle spread, landing wobble side). */
  seed?: number;
  /** Where each surface's top-left sits in world space. */
  surfaces?: { primary?: Vec; auxiliary?: Vec };
  /** Body speed clamp, px/s. Default 6000. */
  maxSpeed?: number;
}

export type ViewSpec = NodeLike | { node: NodeLike; offset?: Vec };

export type ShapeSpec =
  | { circle: number }
  | { box: Vec; corner?: number };

export interface Spring {
  stiffness: number;
  damping: number;
}

export interface AnchorOptions {
  /** "layout" rests the body on its first view's layout centre. */
  to: "layout" | Vec;
  /** Rest angle, degrees. */
  angle?: number;
  /** Axes the springs hold. Default all. */
  axes?: readonly ("x" | "y" | "angle")[];
  /** Position spring. */
  spring?: Spring;
  /** Angle spring. */
  spin?: Spring;
  /** Downward px/s² while a hop is airborne. */
  airGravity?: number;
}

export interface JellyOptions {
  /** Squash spring; `limit` clamps |squash|. */
  squash?: Spring & {
    limit?: number;
    /** Scale gained across the squash axis per unit squash (default 0.6). */
    across?: number;
    /** Scale lost along the squash axis per unit squash (default 1). */
    along?: number;
    /** "body": the body's own vertical axis; "impact": the last contact normal. */
    axis?: "body" | "impact";
  };
  /** Squash velocity per px/s of contact velocity change. */
  impact?: number;
  /** Squash set directly per px/s of impact speed, up to `limit`. */
  dent?: { gain: number; limit?: number };
  /** Landing squash: velocity per px/s, clamped, plus a spin kick per unit (°/s). */
  land?: { gain: number; min?: number; max?: number; spin?: number };
  /** Lean (skewX) spring toward -vx·gain degrees, clamped to ±limit. */
  lean?: Spring & { gain: number; limit?: number; impact?: number };
  /** Scale spring toward the press target. */
  pulse?: Spring;
  /** Stretch per px/s while airborne or in flight. */
  stretch?: { gain: number; limit?: number };
  /** px below the centre that rotation and squash pivot about. */
  pivot?: number;
}

export interface BodyOptions {
  views?: readonly ViewSpec[];
  shape?: ShapeSpec;
  position?: Vec;
  angle?: number;
  velocity?: Vec;
  /** Degrees per second. */
  spin?: number;
  density?: number;
  /** Explicit mass; 0 = immovable. */
  mass?: number;
  /** Multiplier on the shape's moment of inertia. */
  inertia?: number;
  restitution?: number;
  friction?: number;
  gravityScale?: number;
  linearDamping?: number;
  angularDamping?: number;
  maxSpin?: number;
  /** Contacts slower than this do not bounce. Default 110 px/s. */
  bounceSpeed?: number;
  /** Contacts at least this fast emit `hit` events. */
  hitSpeed?: number;
  pickable?: boolean;
  /** Parked until a motion command. */
  asleep?: boolean;
  layer?: number;
  mask?: number;
  /** Ignore this collider until the body has left it (spawning from inside). */
  ghost?: Collider;
  anchor?: AnchorOptions;
  jelly?: JellyOptions;
}

export type GeometrySpec =
  | { circle: number; at: Vec }
  | { box: Vec; at: Vec; corner?: number }
  | { chain: readonly Vec[]; radius?: number; closed?: boolean }
  | { node: NodeLike; pad?: number; corner?: number };

export interface ColliderOptions {
  shape: GeometrySpec;
  restitution?: number;
  friction?: number;
  layer?: number;
  mask?: number;
  /** A body whose jelly absorbs impacts: squash per px/s, spin °/s per px/s. */
  owner?: { body: Body; squash?: number; squashLimit?: number; spin?: number; spinLimit?: number };
}

export interface ZoneOptions {
  shape: GeometrySpec;
  /** Body layers the zone watches. */
  mask?: number;
}

export interface EmitterOptions {
  /** Pool of image nodes the particles wear. */
  views: readonly ViewSpec[];
  /** Image keys (`src` strings) a particle may take. */
  textures?: readonly string[];
  life?: Vec;
  speed?: Vec;
  size?: Vec;
  /** Degrees per second, sign chosen per particle. */
  spin?: Vec;
  drag?: number;
  gravity?: Vec;
  scale?: "constant" | "pop" | "shrink";
  alpha?: "constant" | "fade" | "twinkle";
  /** Direction and cone of streamed particles, degrees. */
  stream?: { angle?: number; spread?: number };
}

export interface LaunchOptions {
  from: Vec;
  /** Default: the anchor. */
  to?: Vec;
  /** Seconds. */
  duration: number;
  /** Degrees turned during the flight (signed). */
  turn?: number;
  /** Degrees past the rest angle the flight ends at. */
  endOffset?: number;
  /** Downward px/s at arrival. */
  arrive?: number;
  /** View scale at take-off, grown to 1 over 0.2 s. */
  grow?: number;
  /** View scale at arrival. */
  endScale?: number;
}

export interface Hit {
  body: Body;
  /** The other body, or the collider it struck. */
  other: Body | Collider | undefined;
  x: number;
  y: number;
  nx: number;
  ny: number;
  speed: number;
}

// ---- objects ------------------------------------------------------------------

const worlds = new Map<number, World>();
let stopPump: (() => void) | null = null;

function pump(): void {
  const raw = physicsOps().physicsEvents();
  if (!raw) return;
  const records = new Float64Array(raw);
  for (let i = 0; i + PHYSICS_EVENT_WORDS <= records.length; i += PHYSICS_EVENT_WORDS) {
    const kind = records[i];
    const a = records[i + 1];
    const b = records[i + 2];
    for (const world of worlds.values()) {
      if (world.deliver(kind, a, b, records[i + 3], records[i + 4], records[i + 5], records[i + 6], records[i + 7])) break;
    }
  }
}

export class World {
  readonly handle: number;
  readonly bodies = new Map<number, Body>();
  readonly colliders = new Map<number, Collider>();
  readonly zones = new Map<number, Zone>();
  readonly emitters = new Set<Emitter>();
  private hitHandlers = new Set<(hit: Hit) => void>();
  private landHandlers = new Set<(body: Body, speed: number) => void>();

  constructor(options: WorldOptions = {}) {
    const p = new Params()
      .set(PHYSICS_KEY.gravityX, options.gravity?.[0])
      .set(PHYSICS_KEY.gravityY, options.gravity?.[1])
      .set(PHYSICS_KEY.substeps, options.substeps)
      .set(PHYSICS_KEY.seed, options.seed)
      .set(PHYSICS_KEY.primaryX, options.surfaces?.primary?.[0])
      .set(PHYSICS_KEY.primaryY, options.surfaces?.primary?.[1])
      .set(PHYSICS_KEY.auxiliaryX, options.surfaces?.auxiliary?.[0])
      .set(PHYSICS_KEY.auxiliaryY, options.surfaces?.auxiliary?.[1])
      .set(PHYSICS_KEY.maxSpeed, options.maxSpeed);
    this.handle = physicsOps().physicsCreate(PHYSICS_KIND.world, p.buffer());
    if (!this.handle) throw new Error("PocketJS: physicsCreate refused the world");
    worlds.set(this.handle, this);
    stopPump ??= registerServicePump(pump);
  }

  private create(kind: number, p: Params): number {
    p.set(PHYSICS_KEY.world, this.handle);
    const handle = physicsOps().physicsCreate(kind, p.buffer());
    if (!handle) throw new Error("PocketJS: physicsCreate refused the object");
    return handle;
  }

  body(options: BodyOptions): Body {
    const p = new Params();
    for (const view of options.views ?? []) {
      const spec = typeof view === "object" && "node" in view ? view : { node: view as NodeLike };
      p.set(PHYSICS_KEY.view, nodeId(spec.node));
      if (spec.offset) p.set(PHYSICS_KEY.viewOffsetX, spec.offset[0]).set(PHYSICS_KEY.viewOffsetY, spec.offset[1]);
    }
    const shape = options.shape;
    if (shape && "circle" in shape) p.set(PHYSICS_KEY.shape, PHYSICS_SHAPE.circle).set(PHYSICS_KEY.radius, shape.circle);
    if (shape && "box" in shape) {
      p.set(PHYSICS_KEY.shape, PHYSICS_SHAPE.box)
        .set(PHYSICS_KEY.halfWidth, shape.box[0])
        .set(PHYSICS_KEY.halfHeight, shape.box[1])
        .set(PHYSICS_KEY.corner, shape.corner);
    }
    p.set(PHYSICS_KEY.x, options.position?.[0])
      .set(PHYSICS_KEY.y, options.position?.[1])
      .set(PHYSICS_KEY.angle, options.angle)
      .set(PHYSICS_KEY.vx, options.velocity?.[0])
      .set(PHYSICS_KEY.vy, options.velocity?.[1])
      .set(PHYSICS_KEY.spin, options.spin)
      .set(PHYSICS_KEY.density, options.density)
      .set(PHYSICS_KEY.mass, options.mass)
      .set(PHYSICS_KEY.inertia, options.inertia)
      .set(PHYSICS_KEY.restitution, options.restitution)
      .set(PHYSICS_KEY.friction, options.friction)
      .set(PHYSICS_KEY.gravityScale, options.gravityScale)
      .set(PHYSICS_KEY.linearDamping, options.linearDamping)
      .set(PHYSICS_KEY.angularDamping, options.angularDamping)
      .set(PHYSICS_KEY.maxSpin, options.maxSpin)
      .set(PHYSICS_KEY.bounceSpeed, options.bounceSpeed)
      .set(PHYSICS_KEY.hitSpeed, options.hitSpeed)
      .set(PHYSICS_KEY.pickable, options.pickable)
      .set(PHYSICS_KEY.asleep, options.asleep)
      .set(PHYSICS_KEY.layer, options.layer)
      .set(PHYSICS_KEY.mask, options.mask)
      .set(PHYSICS_KEY.ghost, options.ghost?.handle);
    const anchor = options.anchor;
    if (anchor) {
      if (anchor.to === "layout") p.set(PHYSICS_KEY.anchor, PHYSICS_ANCHOR.layout);
      else p.set(PHYSICS_KEY.anchor, PHYSICS_ANCHOR.point).set(PHYSICS_KEY.anchorX, anchor.to[0]).set(PHYSICS_KEY.anchorY, anchor.to[1]);
      if (anchor.axes) {
        let bits = 0;
        for (const axis of anchor.axes) bits |= PHYSICS_AXIS[axis];
        p.set(PHYSICS_KEY.anchorAxes, bits);
      }
      p.set(PHYSICS_KEY.anchorAngle, anchor.angle)
        .set(PHYSICS_KEY.stiffness, anchor.spring?.stiffness)
        .set(PHYSICS_KEY.damping, anchor.spring?.damping)
        .set(PHYSICS_KEY.spinStiffness, anchor.spin?.stiffness)
        .set(PHYSICS_KEY.spinDamping, anchor.spin?.damping)
        .set(PHYSICS_KEY.airGravity, anchor.airGravity);
    }
    const jelly = options.jelly;
    if (jelly) {
      const sq = jelly.squash;
      if (sq) {
        p.set(PHYSICS_KEY.squashStiffness, sq.stiffness)
          .set(PHYSICS_KEY.squashDamping, sq.damping)
          .set(PHYSICS_KEY.squashLimit, sq.limit)
          .set(PHYSICS_KEY.squashX, sq.across)
          .set(PHYSICS_KEY.squashY, sq.along)
          .set(PHYSICS_KEY.squashAxis, sq.axis === "impact" ? PHYSICS_SQUASH_AXIS.impact : sq.axis === "body" ? PHYSICS_SQUASH_AXIS.body : undefined);
      }
      p.set(PHYSICS_KEY.squashImpact, jelly.impact)
        .set(PHYSICS_KEY.dent, jelly.dent?.gain)
        .set(PHYSICS_KEY.dentLimit, jelly.dent?.limit)
        .set(PHYSICS_KEY.landGain, jelly.land?.gain)
        .set(PHYSICS_KEY.landMin, jelly.land?.min)
        .set(PHYSICS_KEY.landMax, jelly.land?.max)
        .set(PHYSICS_KEY.landSpin, jelly.land?.spin)
        .set(PHYSICS_KEY.leanStiffness, jelly.lean?.stiffness)
        .set(PHYSICS_KEY.leanDamping, jelly.lean?.damping)
        .set(PHYSICS_KEY.leanGain, jelly.lean?.gain)
        .set(PHYSICS_KEY.leanLimit, jelly.lean?.limit)
        .set(PHYSICS_KEY.leanImpact, jelly.lean?.impact)
        .set(PHYSICS_KEY.pulseStiffness, jelly.pulse?.stiffness)
        .set(PHYSICS_KEY.pulseDamping, jelly.pulse?.damping)
        .set(PHYSICS_KEY.stretchGain, jelly.stretch?.gain)
        .set(PHYSICS_KEY.stretchLimit, jelly.stretch?.limit)
        .set(PHYSICS_KEY.pivot, jelly.pivot);
    }
    const body = new Body(this, this.create(PHYSICS_KIND.body, p));
    this.bodies.set(body.handle, body);
    return body;
  }

  collider(options: ColliderOptions): Collider {
    const p = geometry(options.shape)
      .set(PHYSICS_KEY.restitution, options.restitution)
      .set(PHYSICS_KEY.friction, options.friction)
      .set(PHYSICS_KEY.layer, options.layer)
      .set(PHYSICS_KEY.mask, options.mask);
    if (options.owner) {
      p.set(PHYSICS_KEY.owner, options.owner.body.handle)
        .set(PHYSICS_KEY.ownerSquash, options.owner.squash)
        .set(PHYSICS_KEY.ownerSquashLimit, options.owner.squashLimit)
        .set(PHYSICS_KEY.ownerSpin, options.owner.spin)
        .set(PHYSICS_KEY.ownerSpinLimit, options.owner.spinLimit);
    }
    const collider = new Collider(this, this.create(PHYSICS_KIND.collider, p));
    this.colliders.set(collider.handle, collider);
    return collider;
  }

  zone(options: ZoneOptions): Zone {
    const p = geometry(options.shape).set(PHYSICS_KEY.mask, options.mask);
    const zone = new Zone(this, this.create(PHYSICS_KIND.zone, p));
    this.zones.set(zone.handle, zone);
    return zone;
  }

  emitter(options: EmitterOptions): Emitter {
    const p = new Params();
    for (const view of options.views) {
      const spec = typeof view === "object" && "node" in view ? view : { node: view as NodeLike };
      p.set(PHYSICS_KEY.view, nodeId(spec.node));
      if (spec.offset) p.set(PHYSICS_KEY.viewOffsetX, spec.offset[0]).set(PHYSICS_KEY.viewOffsetY, spec.offset[1]);
    }
    for (const key of options.textures ?? []) {
      const handle = textureHandle(key);
      if (handle >= 0) p.set(PHYSICS_KEY.texture, handle);
    }
    p.set(PHYSICS_KEY.lifeMin, options.life?.[0])
      .set(PHYSICS_KEY.lifeMax, options.life?.[1])
      .set(PHYSICS_KEY.speedMin, options.speed?.[0])
      .set(PHYSICS_KEY.speedMax, options.speed?.[1])
      .set(PHYSICS_KEY.sizeMin, options.size?.[0])
      .set(PHYSICS_KEY.sizeMax, options.size?.[1])
      .set(PHYSICS_KEY.spinMin, options.spin?.[0])
      .set(PHYSICS_KEY.spinMax, options.spin?.[1])
      .set(PHYSICS_KEY.drag, options.drag)
      .set(PHYSICS_KEY.gravityX, options.gravity?.[0])
      .set(PHYSICS_KEY.gravityY, options.gravity?.[1])
      .set(PHYSICS_KEY.scaleCurve, options.scale ? PHYSICS_SCALE_CURVE[options.scale] : undefined)
      .set(PHYSICS_KEY.alphaCurve, options.alpha ? PHYSICS_ALPHA_CURVE[options.alpha] : undefined)
      .set(PHYSICS_KEY.streamAngle, options.stream?.angle)
      .set(PHYSICS_KEY.streamSpread, options.stream?.spread);
    const emitter = new Emitter(this, this.create(PHYSICS_KIND.emitter, p));
    this.emitters.add(emitter);
    return emitter;
  }

  /** Topmost pickable body under a surface point. */
  pick(x: number, y: number, surface: Surface = "primary", slop = 0): Body | undefined {
    const handle = physicsOps().physicsQuery(PHYSICS_QUERY.pick, this.handle, x, y, surfaceIndex(surface), slop);
    return this.bodies.get(handle);
  }

  setGravity(gx: number, gy: number): void {
    apply(this.handle, PHYSICS_CMD.gravity, gx, gy);
  }

  /** Every hit in the world, after the body's own handlers. */
  onHit(handler: (hit: Hit) => void): () => void {
    this.hitHandlers.add(handler);
    return () => this.hitHandlers.delete(handler);
  }

  /** Every landing in the world, after the body's own handlers. */
  onLand(handler: (body: Body, speed: number) => void): () => void {
    this.landHandlers.add(handler);
    return () => this.landHandlers.delete(handler);
  }

  /** @internal Route one event record; false when it is not this world's. */
  deliver(kind: number, a: number, b: number, x: number, y: number, nx: number, ny: number, speed: number): boolean {
    switch (kind) {
      case PHYSICS_EVENT.land: {
        const body = this.bodies.get(a);
        if (!body) return false;
        body.landHandlers.forEach((handler) => handler(speed));
        this.landHandlers.forEach((handler) => handler(body, speed));
        return true;
      }
      case PHYSICS_EVENT.hit: {
        const body = this.bodies.get(a);
        if (!body) return false;
        const hit: Hit = { body, other: this.bodies.get(b) ?? this.colliders.get(b), x, y, nx, ny, speed };
        body.hitHandlers.forEach((handler) => handler(hit));
        this.hitHandlers.forEach((handler) => handler(hit));
        return true;
      }
      case PHYSICS_EVENT.enter:
      case PHYSICS_EVENT.leave: {
        const zone = this.zones.get(a);
        if (!zone) return false;
        const body = this.bodies.get(b);
        if (body) (kind === PHYSICS_EVENT.enter ? zone.enterHandlers : zone.leaveHandlers).forEach((handler) => handler(body));
        return true;
      }
      case PHYSICS_EVENT.clear: {
        const body = this.bodies.get(a);
        if (!body) return false;
        body.clearHandlers.forEach((handler) => handler());
        return true;
      }
    }
    return false;
  }

  /** Destroy the world with every object in it; views get their styles back. */
  destroy(): void {
    if (!worlds.delete(this.handle)) return;
    physicsOps().physicsDestroy(this.handle);
    this.bodies.clear();
    this.colliders.clear();
    this.zones.clear();
    this.emitters.clear();
    if (worlds.size === 0 && stopPump) {
      stopPump();
      stopPump = null;
    }
  }
}

function apply(handle: number, cmd: number, ...args: number[]): void {
  physicsOps().physicsApply(new Float64Array([handle, cmd, args.length, ...args]).buffer);
}

function geometry(shape: GeometrySpec): Params {
  const p = new Params();
  if ("circle" in shape) {
    p.set(PHYSICS_KEY.shape, PHYSICS_SHAPE.circle).set(PHYSICS_KEY.radius, shape.circle).set(PHYSICS_KEY.x, shape.at[0]).set(PHYSICS_KEY.y, shape.at[1]);
  } else if ("box" in shape) {
    p.set(PHYSICS_KEY.shape, PHYSICS_SHAPE.box)
      .set(PHYSICS_KEY.halfWidth, shape.box[0])
      .set(PHYSICS_KEY.halfHeight, shape.box[1])
      .set(PHYSICS_KEY.x, shape.at[0])
      .set(PHYSICS_KEY.y, shape.at[1])
      .set(PHYSICS_KEY.corner, shape.corner);
  } else if ("chain" in shape) {
    p.set(PHYSICS_KEY.shape, PHYSICS_SHAPE.chain).set(PHYSICS_KEY.radius, shape.radius).set(PHYSICS_KEY.closed, shape.closed);
    for (const [x, y] of shape.chain) p.set(PHYSICS_KEY.pointX, x).set(PHYSICS_KEY.pointY, y);
  } else {
    p.set(PHYSICS_KEY.shape, PHYSICS_SHAPE.node).set(PHYSICS_KEY.node, nodeId(shape.node)).set(PHYSICS_KEY.pad, shape.pad).set(PHYSICS_KEY.corner, shape.corner);
  }
  return p;
}

export class Body {
  /** @internal */ readonly landHandlers = new Set<(speed: number) => void>();
  /** @internal */ readonly hitHandlers = new Set<(hit: Hit) => void>();
  /** @internal */ readonly clearHandlers = new Set<() => void>();

  constructor(readonly world: World, readonly handle: number) {}

  impulse(vx: number, vy: number, spin = 0): void {
    apply(this.handle, PHYSICS_CMD.impulse, vx, vy, spin);
  }
  setVelocity(vx: number, vy: number, spin = 0): void {
    apply(this.handle, PHYSICS_CMD.velocity, vx, vy, spin);
  }
  teleport(x: number, y: number, angle = 0): void {
    apply(this.handle, PHYSICS_CMD.teleport, x, y, angle);
  }
  /** Ballistic flight that arrives on time; ends with a `land` event. */
  launch(o: LaunchOptions): void {
    apply(
      this.handle,
      PHYSICS_CMD.launch,
      o.from[0],
      o.from[1],
      o.to?.[0] ?? NaN,
      o.to?.[1] ?? NaN,
      o.duration,
      o.turn ?? 0,
      o.endOffset ?? 0,
      o.arrive ?? 0,
      o.grow ?? 0,
      o.endScale ?? 0,
    );
  }
  /** Jump off the anchor line; `stretch` squash velocity, `spin` °/s back toward rest. */
  hop(up: number, stretch = 0, spin = 0): void {
    apply(this.handle, PHYSICS_CMD.hop, up, stretch, spin);
  }
  kick(k: { squash?: number; lean?: number; spin?: number; pulse?: number }): void {
    apply(this.handle, PHYSICS_CMD.kick, k.squash ?? 0, k.lean ?? 0, k.spin ?? 0, k.pulse ?? 0);
  }
  grab(x: number, y: number, o: { surface?: Surface; mode?: "tether" | "carry"; strength?: number } = {}): void {
    apply(this.handle, PHYSICS_CMD.grab, x, y, surfaceIndex(o.surface), PHYSICS_GRAB[o.mode ?? "tether"], o.strength ?? 0);
  }
  drag(x: number, y: number, surface: Surface = "primary"): void {
    apply(this.handle, PHYSICS_CMD.drag, x, y, surfaceIndex(surface));
  }
  release(): void {
    apply(this.handle, PHYSICS_CMD.release);
  }
  /** Jelly rest targets while held: squash, and scale (1 = none). */
  press(squash: number, pulse = 1): void {
    apply(this.handle, PHYSICS_CMD.press, squash, pulse);
  }
  /** Damp the next floor contact: vx·vxScale, spin·spinScale. */
  settle(vxScale: number, spinScale: number): void {
    apply(this.handle, PHYSICS_CMD.settle, vxScale, spinScale);
  }
  setAnchor(x: number, y: number, angle = 0): void {
    apply(this.handle, PHYSICS_CMD.anchor, x, y, angle);
  }
  wake(): void {
    apply(this.handle, PHYSICS_CMD.wake);
  }

  private q(query: number): number {
    return physicsOps().physicsQuery(query, this.handle);
  }
  get x(): number {
    return this.q(PHYSICS_QUERY.x);
  }
  get y(): number {
    return this.q(PHYSICS_QUERY.y);
  }
  /** Degrees. */
  get angle(): number {
    return this.q(PHYSICS_QUERY.angle);
  }
  get vx(): number {
    return this.q(PHYSICS_QUERY.vx);
  }
  get vy(): number {
    return this.q(PHYSICS_QUERY.vy);
  }
  /** Degrees per second. */
  get spin(): number {
    return this.q(PHYSICS_QUERY.spin);
  }
  get speed(): number {
    return this.q(PHYSICS_QUERY.speed);
  }
  /** Seconds since the last floor-like contact, -1 if none. */
  get grounded(): number {
    return this.q(PHYSICS_QUERY.grounded);
  }
  get airborne(): boolean {
    return this.q(PHYSICS_QUERY.airborne) !== 0;
  }
  /** The rest position the anchor holds, once the layout has placed it. */
  get home(): Vec | undefined {
    const x = this.q(PHYSICS_QUERY.anchorX);
    return Number.isNaN(x) ? undefined : [x, this.q(PHYSICS_QUERY.anchorY)];
  }
  get mode(): "free" | "anchored" | "flight" | "grabbed" {
    return (["free", "anchored", "flight", "grabbed"] as const)[this.q(PHYSICS_QUERY.mode)] ?? "free";
  }

  onLand(handler: (speed: number) => void): () => void {
    this.landHandlers.add(handler);
    return () => this.landHandlers.delete(handler);
  }
  onHit(handler: (hit: Hit) => void): () => void {
    this.hitHandlers.add(handler);
    return () => this.hitHandlers.delete(handler);
  }
  /** The body left its ghost collider. */
  onClear(handler: () => void): () => void {
    this.clearHandlers.add(handler);
    return () => this.clearHandlers.delete(handler);
  }

  destroy(): void {
    if (!this.world.bodies.delete(this.handle)) return;
    physicsOps().physicsDestroy(this.handle);
  }
}

export class Collider {
  constructor(readonly world: World, readonly handle: number) {}
  destroy(): void {
    if (!this.world.colliders.delete(this.handle)) return;
    physicsOps().physicsDestroy(this.handle);
  }
}

export class Zone {
  /** @internal */ readonly enterHandlers = new Set<(body: Body) => void>();
  /** @internal */ readonly leaveHandlers = new Set<(body: Body) => void>();
  constructor(readonly world: World, readonly handle: number) {}
  onEnter(handler: (body: Body) => void): () => void {
    this.enterHandlers.add(handler);
    return () => this.enterHandlers.delete(handler);
  }
  onLeave(handler: (body: Body) => void): () => void {
    this.leaveHandlers.add(handler);
    return () => this.leaveHandlers.delete(handler);
  }
  destroy(): void {
    if (!this.world.zones.delete(this.handle)) return;
    physicsOps().physicsDestroy(this.handle);
  }
}

export class Emitter {
  constructor(readonly world: World, readonly handle: number) {}
  /** `count` particles from a world point; `spread` is the full cone in degrees. */
  burst(x: number, y: number, count: number, o: { angle?: number; spread?: number; speed?: number } = {}): void {
    apply(this.handle, PHYSICS_CMD.burst, x, y, count, o.angle ?? -90, o.spread ?? 360, o.speed ?? 1);
  }
  /** Emit `rate` particles per second over a world rect until `stop()`. */
  stream(rate: number, x: number, y: number, w: number, h: number): void {
    apply(this.handle, PHYSICS_CMD.stream, rate, x, y, w, h);
  }
  stop(): void {
    apply(this.handle, PHYSICS_CMD.stream, 0, 0, 0, 0, 0);
  }
  get live(): number {
    return physicsOps().physicsQuery(PHYSICS_QUERY.particles, this.handle);
  }
  destroy(): void {
    if (!this.world.emitters.delete(this)) return;
    physicsOps().physicsDestroy(this.handle);
  }
}

/** Create a world stepped by the core. Destroy it with the component. */
export function createWorld(options: WorldOptions = {}): World {
  return new World(options);
}
