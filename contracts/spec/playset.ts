// The playset contract: the `globalThis.playset` namespace a guest gets when
// its plan declares `game.playset` (docs/PLAYSET.md).
//
// Every per-frame value crosses as a Float32Array view over native memory;
// every load-time description crosses as one Float32Array whose layout is
// below. `tools/playset-schema.ts` writes the same numbers into
// engine/crates/pocket-playset/src/schema.rs, so the TS SDK and the kernels
// read one table.

/** Views returned by `playset.view(id)`; each aliases native memory for the
 *  world's lifetime. `stride` floats per entity slot (or per record). */
export const PLAYSET_VIEW = {
  ENT: 0,
  INTENT: 1,
  USER: 2,
  EVENTS: 3,
  LIST: 4,
  JOINT: 5,
  LOOK: 6,
  CAMERA: 7,
  STATS: 8,
} as const;

export const PLAYSET_STRIDE = {
  ENT: 16,
  INTENT: 8,
  USER: 8,
  EVENTS: 8,
  JOINT: 4,
  LOOK: 4,
  CAMERA: 16,
  STATS: 16,
} as const;

/** ENT view: the simulated state of one slot. JS may write position, velocity
 *  and yaw/pitch/roll; kernels read them back on the next step. */
export const PLAYSET_ENT = {
  X: 0, Y: 1, Z: 2,
  VX: 3, VY: 4, VZ: 5,
  YAW: 6, PITCH: 7, ROLL: 8,
  SPEED: 9,
  HP: 10, HP_MAX: 11,
  AGE: 12,
  /** archetype id + 1; 0 marks a free slot */
  ARCH: 13,
  /** target slot, -1 for none */
  TARGET: 14,
  /** PLAYSET_STATE bits */
  STATE: 15,
} as const;

export const PLAYSET_STATE = {
  GROUNDED: 1,
  HIDDEN: 2,
  FROZEN: 4,
  DEAD: 8,
  IN_WATER: 16,
} as const;

/** INTENT view: what a brain (or the player's input) asks of a kernel. */
export const PLAYSET_INTENT = {
  X: 0, FWD: 1, TURN: 2, RISE: 3,
  FIRE: 4, ALT: 5, JUMP: 6, AUX: 7,
} as const;

/** EVENTS view: `step()` returns how many records it wrote. */
export const PLAYSET_EVENT_FIELD = {
  TYPE: 0, A: 1, B: 2, DATA: 3, X: 4, Y: 5, Z: 6, VALUE: 7,
} as const;

export const PLAYSET_EVENT = {
  /** a rule with the EVENT flag matched: a, b, DATA = rule id, VALUE = damage */
  HIT: 1,
  /** hp reached 0 or a rule killed it: a = slot, b = killer slot or -1, DATA = archetype */
  DEATH: 2,
  /** lifetime ran out: a = slot, DATA = archetype */
  EXPIRE: 3,
  /** a weapon fired: a = shooter, b = projectile, DATA = weapon index */
  FIRE: 4,
  /** a ballistic body met the ground or water: a = slot */
  GROUND: 5,
  /** left the bounds under bounds mode KILL: a = slot */
  BOUNDS: 6,
  /** a rule with the PICKUP flag: a = collector, b = item (removed) */
  PICKUP: 7,
  /** a waypoint brain passed a gate: a = slot, DATA = gate index, VALUE = lap */
  GATE: 8,
  /** a snake ate: a = head slot, b = food slot, VALUE = new length */
  EAT: 9,
  /** a snake died: a = head slot, b = slot it hit or -1 */
  CRASH: 10,
  /** a marble fell through a hole (DATA = hole index) or reached the goal (DATA = -1) */
  MARBLE: 11,
} as const;

/** CAMERA view (read-only): eye, forward and the frame's projection facts. */
export const PLAYSET_CAMERA_FIELD = {
  EX: 0, EY: 1, EZ: 2, FX: 3, FY: 4, FZ: 5, UX: 6, UY: 7, UZ: 8,
  FOV: 9, NEAR: 10, FAR: 11, ASPECT: 12,
} as const;

/** STATS view: the last step and render preparation, in microseconds and counts. */
export const PLAYSET_STAT = {
  STEP_US: 0, PREPARE_US: 1, LIVE: 2, DRAWS: 3, TRIS: 4, PARTICLES: 5,
  CULLED: 6, PAIRS: 7, STATIC_BATCHES: 8, RENDER_US: 9, MODELS: 10, NODES: 11,
} as const;

// ---------------------------------------------------------------------------
// Models: parts assembled from primitives, merged natively per draw pass.

export const PLAYSET_GEOM = {
  BOX: 1,
  SPHERE: 2,
  CYLINDER: 3,
  CAPSULE: 4,
  TORUS: 5,
  PLANE: 6,
  CIRCLE: 7,
  RING: 8,
  ICOSAHEDRON: 9,
  OCTAHEDRON: 10,
  DODECAHEDRON: 11,
  TETRAHEDRON: 12,
  /** positions from the model's raw tail: p0 = float offset, p1 = vertex count */
  RAW: 13,
} as const;

export const PLAYSET_BLEND = { OPAQUE: 0, ALPHA: 1, ADD: 2 } as const;

export const PLAYSET_MODEL = {
  /** [version, parts, joints, rawFloats] then joints then parts then raw */
  HEADER: 4,
  VERSION: 1,
  /** per joint: parent (-1 root), pivot x, y, z */
  JOINT_STRIDE: 4,
  PART_STRIDE: 32,
} as const;

/** Offsets inside one part record. P0..P7 are the geometry's parameters in
 *  three.js order (BoxGeometry(width, height, depth, ...)). */
export const PLAYSET_PART = {
  GEOM: 0,
  P0: 1, P1: 2, P2: 3, P3: 4, P4: 5, P5: 6, P6: 7, P7: 8,
  JOINT: 9,
  R: 10, G: 11, B: 12,
  /** 0 lit .. 1 unlit (emissive) */
  EMISSIVE: 13,
  OPACITY: 14,
  BLEND: 15,
  /** 3x4 row-major part-to-joint matrix */
  M: 16,
  /** 1 = faceted normals */
  FLAT: 28,
  /** per-vertex jitter radius (rocks), seeded by SEED */
  JITTER: 29,
  SEED: 30,
  /** 1 = this part casts no blob and skips culling bounds */
  NO_BOUNDS: 31,
} as const;

// ---------------------------------------------------------------------------
// Archetypes: one Float32Array of ARCH_LENGTH floats.

export const PLAYSET_ARCH_LENGTH = 128;

export const PLAYSET_ARCH = {
  MODEL: 0, SCALE: 1, MOTION: 2, BRAIN: 3,
  /** collision layer bits this archetype is on, and the bits it tests */
  LAYER: 4, MASK: 5, TEAM: 6,
  RADIUS: 7, HEIGHT: 8,
  /** 1 = movers push each other apart */
  SOLID: 9,
  HP: 10,
  /** damage a rule with DAMAGE applies to the other side */
  DAMAGE: 11,
  /** seconds; 0 lives forever */
  LIFETIME: 12,
  DEATH_EMITTER: 13,
  TRAIL_EMITTER: 14,
  TRAIL_RATE: 15,
  SHADOW: 16,
  FLAGS: 17,
  BOUNDS: 18,
  GROUND: 19,
  GROUND_OFFSET: 20,
  MASS: 21,
  /** seconds a hit flash lasts */
  FLASH: 22,
  /** kill reward copied to the DEATH event's VALUE */
  VALUE: 23,
  MOTION_P: 24,
  BRAIN_P: 48,
  WEAPON0: 64,
  WEAPON1: 80,
  JOINTS: 96,
  EXTRA: 112,
} as const;

export const PLAYSET_ARCH_FLAG = {
  FACE_VELOCITY: 1,
  ALIGN_GROUND: 2,
  INVULNERABLE: 4,
  /** the slot stays allocated after death (players) */
  KEEP_ON_DEATH: 8,
  NO_RENDER: 16,
  /** projectiles skip their shooter and its team */
  PROJECTILE: 32,
  /** brains may pick this as a target */
  TARGETABLE: 64,
  /** static colliders do not stop it */
  GHOST: 128,
  /** the kernel keeps pitch/roll at 0 */
  UPRIGHT: 256,
} as const;

export const PLAYSET_BOUNDS = { NONE: 0, CLAMP: 1, KILL: 2, WRAP: 3, BOUNCE: 4 } as const;
export const PLAYSET_GROUND = { NONE: 0, SNAP: 1, GRAVITY: 2, WATER: 3 } as const;

export const PLAYSET_MOTION = {
  NONE: 0,
  BALLISTIC: 1,
  LINEAR: 2,
  PLANAR: 3,
  CHARACTER: 4,
  CAR: 5,
  BOAT: 6,
  PLANE: 7,
  HOVER: 8,
  SNAKE: 9,
  MARBLE: 10,
  PATH: 11,
  TURRET: 12,
  RUNNER: 13,
  /** parented to another slot at a fixed offset (turrets on hulls, riders) */
  ATTACHED: 14,
} as const;

export const PLAYSET_BRAIN = {
  NONE: 0,
  SEEK: 1,
  FLEE: 2,
  ORBIT: 3,
  WANDER: 4,
  PURSUE: 5,
  PATH: 6,
  TURRET: 7,
  WAYPOINTS: 8,
  STRAFE: 9,
  HERD: 10,
  SNAKE: 11,
} as const;

/** One weapon: 16 floats at ARCH.WEAPON0 / WEAPON1. */
export const PLAYSET_WEAPON = {
  PROJECTILE: 0, COOLDOWN: 1, SPEED: 2, SPREAD: 3, COUNT: 4,
  MX: 5, MY: 6, MZ: 7,
  AIM: 8, RANGE: 9, INHERIT: 10, BURST: 11, BURST_GAP: 12,
  EVENT: 13, PITCH: 14, AUTO: 15,
} as const;

export const PLAYSET_AIM = { FORWARD: 0, LEAD: 1, ARC: 2, INTENT: 3 } as const;

/** Joint drivers: four of (joint, kind, axis, rate) at ARCH.JOINTS. */
export const PLAYSET_JOINT_DRIVER = {
  NONE: 0,
  /** constant spin at rate rad/s */
  SPIN: 1,
  /** spin scaled by forward speed (wheels): rate = 1 / wheel radius */
  ROLL: 2,
  /** yaw toward the target relative to the body (turrets) */
  AIM_YAW: 3,
  /** pitch toward the target (barrels) */
  AIM_PITCH: 4,
  /** steering angle from the TURN intent, rate = max radians */
  STEER: 5,
  /** walk swing by speed: rate = swing radians, phase from AUX */
  SWING: 6,
  /** the JOINT view's value for this driver index, in radians */
  SCRIPT: 7,
  /** bob along the axis: rate = amplitude, at 2 Hz */
  BOB: 8,
} as const;

// ---------------------------------------------------------------------------
// Rules: playset.rule(layersA, layersB, flags, value).

export const PLAYSET_RULE = {
  /** emit HIT */
  EVENT: 1,
  /** b loses a's DAMAGE (or value when nonzero) */
  DAMAGE_B: 2,
  /** a loses b's DAMAGE */
  DAMAGE_A: 4,
  KILL_A: 8,
  KILL_B: 16,
  /** push the two apart */
  PUSH: 32,
  /** b is collected by a: PICKUP event, b removed */
  PICKUP: 64,
  /** bounce a off b */
  BOUNCE: 128,
} as const;

// ---------------------------------------------------------------------------
// Environment: playset.env(kind, params).

export const PLAYSET_ENV = {
  /** top rgb, horizon rgb, bottom rgb */
  SKY: 1,
  /** rgb, start, end, max (0..1) */
  FOG: 2,
  /** sun dir xyz, sun rgb, sky rgb, ground rgb */
  LIGHT: 3,
  /** minX, maxX, minY, maxY, minZ, maxZ */
  BOUNDS: 4,
  /** flat ground: y, half size, r, g, b, r2, g2, b2 (checker), cell */
  GROUND: 5,
  /** level, amplitude, wavelength, speed, half size, cells, r, g, b, r2, g2, b2 */
  WATER: 6,
  /** gravity (positive down) */
  GRAVITY: 7,
} as const;

/** Camera descriptor: playset.camera(params) with CAMERA_LENGTH floats. */
export const PLAYSET_CAMERA_LENGTH = 24;
export const PLAYSET_CAMERA = {
  MODE: 0, TARGET: 1,
  /** offsets in the target's frame: right, up, back */
  OX: 2, OY: 3, OZ: 4,
  LOOK_AHEAD: 5, LOOK_UP: 6,
  SMOOTH: 7, SMOOTH_LOOK: 8,
  FOV: 9, NEAR: 10, FAR: 11,
  /** fixed eye and look point (MODE FIXED), or yaw/pitch for ORBIT */
  EX: 12, EY: 13, EZ: 14, LX: 15, LY: 16, LZ: 17,
  /** 1 = offsets follow the target's yaw, 0 = world axes */
  HEADING: 18,
  /** 1 = follow the target's full orientation (flight) */
  ROLL: 19,
  SHAKE: 20,
} as const;
export const PLAYSET_CAMERA_MODE = { FIXED: 0, FOLLOW: 1, ORBIT: 2, FIRST_PERSON: 3 } as const;

/** Particle emitters: playset.emitter(params) with EMITTER_LENGTH floats. */
export const PLAYSET_EMITTER_LENGTH = 24;
export const PLAYSET_EMITTER = {
  COUNT: 0, LIFE: 1, LIFE_JITTER: 2, SPEED: 3, SPEED_JITTER: 4,
  /** cone half angle around DIR; PI = sphere */
  SPREAD: 5, DX: 6, DY: 7, DZ: 8,
  GRAVITY: 9, DRAG: 10, SIZE: 11, SIZE_END: 12,
  R: 13, G: 14, B: 15, A: 16, R2: 17, G2: 18, B2: 19, A2: 20,
  BLEND: 21,
  /** spawn radius */
  RADIUS: 22,
  /** 1 = particles inherit the emitting slot's velocity */
  INHERIT: 23,
} as const;

/** Queries: playset.query(kind, a, b, c, d) writes slots into the LIST view
 *  and returns the count. */
export const PLAYSET_QUERY = {
  /** live slots of archetype a */
  ARCH: 1,
  /** live slots on layer bits a within radius d of (b, c) on the ground plane */
  NEAR: 2,
  /** nearest live slot on layer bits a to slot b: returns slot or -1 */
  NEAREST: 3,
  /** ground height at (a, b) */
  HEIGHT: 4,
} as const;

/** Static scenery and dynamic nodes: playset.node(model, x, y, z, yaw, pitch,
 *  roll, scale, flags) */
export const PLAYSET_NODE = {
  /** merged into world-space batches; cannot move afterwards */
  STATIC: 1,
  /** adds a box collider from the model's bounds */
  COLLIDE_BOX: 2,
  /** adds a cylinder collider from the model's bounds */
  COLLIDE_CYL: 4,
  HIDDEN: 8,
} as const;
