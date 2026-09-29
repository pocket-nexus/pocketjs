// PocketJS physics spec — 2D bodies stepped by the UI core (capability
// `ui.physics`, ops 52..56 in spec.ts OP).
//
// A WORLD is a fixed-step rigid-body simulation owned by pocketjs-core and
// advanced inside `Ui::tick`, SUBSTEPS integrations per core tick at the
// realm's fixed dt. A BODY is bound to one or more retained nodes (VIEWS);
// after every tick the core writes the body's pose into each view as the
// paint-only props translateX/translateY, rotate, skewX, scaleX, scaleY and
// originY, so painting, clipping and hit testing reuse the tree.
// Nothing is laid out again for motion.
//
// Coordinates are logical pixels with +y down. One world spans every UI
// output: each surface (primary, auxiliary) is a window placed at an origin
// in world space, and a view is positioned relative to the surface its root
// ancestor belongs to. A body whose views sit on two surfaces is drawn by
// whichever window it is inside; the space between the windows (a hinge) is
// world space that neither output shows.
//
// A body can rest at an ANCHOR — a point, or the layout centre of its first
// view — held there by damped springs, and carries JELLY state: squash,
// lean and pulse springs that impacts, landings and flight speed excite.
// Colliders are static shapes (boxes, circles, chains, or a node's layout
// box). A collider may name an OWNER body whose jelly absorbs the collider's
// impacts. Zones report bodies entering and leaving. Emitters drive pools of
// image nodes as particles.
//
// Boundary (all synchronous, all numbers):
//
//   physicsCreate(kind, params)  -> handle | 0   params = f64 [key, value]*
//   physicsApply(records)                        records = f64 [handle, cmd, argc, arg*]*
//
// Every f64 list crosses as a little-endian byte buffer (an ArrayBuffer in
// JavaScript), the setPropBatch convention.
//   physicsDestroy(handle)                       world destroy frees its objects
//   physicsEvents()              -> f64 records | undefined   EVENT_WORDS each
//   physicsQuery(query, handle, a, b, c, d) -> f64
//
// JS creates objects and issues commands at interaction edges. Integration,
// collision, deformation, particles and event detection run natively every
// tick. Events produced by the ticks of frame N are drained by the guest at
// the start of frame N+1, so they enter the app as frame-boundary facts. All
// randomness comes from the world's seeded generator, so a run is a pure
// function of (build, params, command stream, input tape).
//
// Angles cross this boundary in DEGREES (and degrees per second), matching
// the `rotate` prop; the core integrates in radians.
//
// If you change ANY value here: run `bun contracts/spec/gen-rust.ts` and
// commit the regenerated engine/core/src/spec.rs (tests/contract.ts
// byte-compares).

/** Object kinds created by `physicsCreate(kind, params)`. */
export const PHYSICS_KIND = {
  world: 1,
  body: 2,
  collider: 3,
  zone: 4,
  emitter: 5,
} as const;

/** Handle layout: kind in bits 28..30, generation in 20..27, slot in 0..19. */
export const PHYSICS_HANDLE_KIND_SHIFT = 28;
export const PHYSICS_HANDLE_GEN_SHIFT = 20;
export const PHYSICS_HANDLE_SLOT_MASK = 0xfffff;

/** Surface indices used by views, picks, grabs and origins. */
export const PHYSICS_SURFACE = { primary: 0, auxiliary: 1 } as const;

/** `shape` values. */
export const PHYSICS_SHAPE = {
  none: 0,
  circle: 1,
  /** Rounded rectangle: halfWidth, halfHeight, corner radius. */
  box: 2,
  /** Polyline of repeated pointX/pointY pairs, thickened by `radius`. */
  chain: 3,
  /** The layout box of `node`, grown by `pad`, rounded by `corner`. */
  node: 4,
} as const;

/** `anchor` values. */
export const PHYSICS_ANCHOR = {
  none: 0,
  /** The layout centre of the body's first view. */
  layout: 1,
  /** anchorX / anchorY in world space. */
  point: 2,
} as const;

/** `anchorAxes` bits (default all three). */
export const PHYSICS_AXIS = { x: 1, y: 2, angle: 4 } as const;

/** `squashAxis` values. */
export const PHYSICS_SQUASH_AXIS = {
  /** Squash compresses the body's own vertical axis (letters, props). */
  body: 0,
  /** Squash compresses along the last impact normal, in world space (toys). */
  impact: 1,
} as const;

/** Grab modes (`grab` command). */
export const PHYSICS_GRAB = {
  /** A soft joint pulls the grabbed point toward the pointer; the body keeps
   *  its dynamics and swings. */
  tether: 0,
  /** The body follows the pointer rigidly; release hands it the pointer's
   *  smoothed velocity. */
  carry: 1,
} as const;

/** Emitter particle curves. */
export const PHYSICS_SCALE_CURVE = { constant: 0, pop: 1, shrink: 2 } as const;
export const PHYSICS_ALPHA_CURVE = { constant: 0, fade: 1, twinkle: 2 } as const;

/**
 * Creation parameter keys. `params` is a flat f64 list of [key, value] pairs;
 * unlisted keys keep their defaults and unknown keys are ignored. `view`,
 * `texture` and `pointX`/`pointY` repeat; `viewOffsetX`/`viewOffsetY` apply
 * to the view before them. Append-only: never renumber, never reuse.
 *
 * Defaults in brackets. Lengths are px, times seconds, angles degrees.
 */
export const PHYSICS_KEY = {
  // -- shared -----------------------------------------------------------------
  world: 1, //          world handle (every kind but world) [required]
  layer: 2, //          collision layer bits [1]
  mask: 3, //           layers this object collides with / watches [0xffff]
  view: 4, //           node id bound to a body or emitter (repeatable, max 4
  //                    per body, 64 per emitter)
  viewOffsetX: 5, //    px added to the preceding view's position [0]
  viewOffsetY: 6, //    [0]
  x: 7, //              initial / static position [0]
  y: 8, //              [0]
  angle: 9, //          initial angle, degrees [0]
  shape: 10, //         PHYSICS_SHAPE [none]
  radius: 11, //        circle radius; chain thickness [0]
  halfWidth: 12, //     box half extents [0]
  halfHeight: 13, //    [0]
  corner: 14, //        box corner radius [0]
  pointX: 15, //        chain vertex (repeatable, in order, max 32)
  pointY: 16, //
  closed: 17, //        chain closes back to its first vertex [0]
  node: 18, //          layout-box source node for PHYSICS_SHAPE.node
  pad: 19, //           px grown on every side of a node box [0]
  restitution: 20, //   bounce factor [0.3]
  friction: 21, //      Coulomb coefficient [0.4]
  // -- world ------------------------------------------------------------------
  gravityX: 22, //      px/s² [0]
  gravityY: 23, //      px/s² [980]
  substeps: 24, //      integrations per core tick, 1..8 [2]
  seed: 25, //          generator seed, non-zero [1]
  primaryX: 26, //      world origin of the primary surface [0]
  primaryY: 27, //      [0]
  auxiliaryX: 28, //    world origin of the auxiliary surface [0]
  auxiliaryY: 29, //    [0]
  maxSpeed: 30, //      body speed clamp, px/s [6000]
  // -- body -------------------------------------------------------------------
  density: 31, //       mass per px² of shape area [1]
  mass: 32, //          explicit mass; 0 = immovable, <0 = from density [-1]
  inertia: 33, //       multiplier on the shape's moment of inertia [1]
  gravityScale: 34, //  [1]
  linearDamping: 35, // velocity loss per second [0.08]
  angularDamping: 36, // spin loss per second [0.7]
  maxSpin: 37, //       spin clamp, degrees/s [1600]
  bounceSpeed: 38, //   normal speed below which contacts do not bounce [110]
  hitSpeed: 39, //      normal speed at which a contact emits a hit event;
  //                    0 = never [0]
  vx: 40, //            initial velocity [0]
  vy: 41, //            [0]
  spin: 42, //          initial spin, degrees/s [0]
  pickable: 43, //      `pick` queries may return this body [0]
  ghost: 44, //         collider handle ignored until the body's bounds leave
  //                    it; a `clear` event reports the exit [0]
  anchor: 45, //        PHYSICS_ANCHOR [none]
  anchorX: 46, //       point anchor [0]
  anchorY: 47, //       [0]
  anchorAngle: 48, //   rest angle, degrees [0]
  anchorAxes: 49, //    PHYSICS_AXIS bits the anchor springs hold [7]
  stiffness: 50, //     anchor position spring, 1/s² [0]
  damping: 51, //       anchor position damping, 1/s [0]
  spinStiffness: 52, // anchor angle spring [0]
  spinDamping: 53, //   anchor angle damping [0]
  airGravity: 54, //    downward px/s² while a hop is airborne [980]
  squashStiffness: 55, // jelly squash spring; 0 disables jelly [0]
  squashDamping: 56, // [0]
  squashLimit: 57, //   |squash| clamp [0.42]
  squashX: 58, //       scale gained across the squash axis per unit squash [0.6]
  squashY: 59, //       scale lost along the squash axis per unit squash [1]
  squashAxis: 60, //    PHYSICS_SQUASH_AXIS [body]
  squashImpact: 61, //  squash velocity per px/s of contact velocity change [0]
  dent: 62, //          squash set directly per px/s of impact speed [0]
  dentLimit: 63, //     largest dent [0.3]
  landGain: 64, //      squash velocity per px/s of landing speed [0]
  landMin: 65, //       landing squash velocity clamp [0]
  landMax: 66, //       [0]
  landSpin: 67, //      spin kick per unit landing squash, degrees/s [0]
  leanStiffness: 68, // lean (skew) spring [0]
  leanDamping: 69, //   [0]
  leanGain: 70, //      target lean, degrees per px/s of horizontal speed [0]
  leanLimit: 71, //     |lean| clamp, degrees [14]
  leanImpact: 72, //    lean velocity per px/s of horizontal velocity change [0]
  pulseStiffness: 73, // scale spring toward the pulse target [0]
  pulseDamping: 74, //  [0]
  stretchGain: 75, //   flight / hop stretch per px/s of speed [0]
  stretchLimit: 76, //  largest stretch [0.16]
  pivot: 77, //         px below the body centre that rotation and squash
  //                    pivot about (a letter's foot) [0]
  // -- collider ---------------------------------------------------------------
  owner: 78, //         body whose jelly absorbs this collider's impacts [0]
  ownerSquash: 79, //   owner squash velocity per px/s of impact speed [0]
  ownerSquashLimit: 80, // [3]
  ownerSpin: 81, //     owner spin kick, degrees/s per px/s of impact speed [0]
  ownerSpinLimit: 82, // degrees/s [50]
  // -- emitter ----------------------------------------------------------------
  texture: 83, //       texture handle a particle may wear (repeatable, max 16)
  lifeMin: 84, //       particle life, seconds [0.6]
  lifeMax: 85, //       [0.8]
  speedMin: 86, //      launch speed, px/s [100]
  speedMax: 87, //      [200]
  sizeMin: 88, //       scale of the pooled view [1]
  sizeMax: 89, //       [1]
  spinMin: 90, //       degrees/s [0]
  spinMax: 91, //       [0]
  drag: 92, //          exponential velocity decay per second [0]
  scaleCurve: 93, //    PHYSICS_SCALE_CURVE [constant]
  alphaCurve: 94, //    PHYSICS_ALPHA_CURVE [fade]
  streamAngle: 95, //   launch direction of streamed particles, degrees [-90]
  streamSpread: 96, //  full cone width of streamed particles, degrees [30]
  asleep: 97, //        body starts parked: no integration, no contacts, until
  //                    a motion command (launch, hop, impulse, velocity,
  //                    teleport, grab, wake) [0]
  // particles use gravityX / gravityY as their own acceleration [0, 0]
} as const;

/**
 * Commands. `physicsApply` takes [handle, cmd, argc, arg*] records; missing
 * trailing arguments read as 0 (NaN where noted). Commands on stale handles
 * are no-ops. Append-only.
 */
export const PHYSICS_CMD = {
  impulse: 1, //   (vx, vy, spin°/s) add to the velocity
  velocity: 2, //  (vx, vy, spin°/s) replace the velocity
  teleport: 3, //  (x, y, angle°) move without sweeping; clears velocity
  launch: 4, //    (x0, y0, x1, y1, duration, turn°, endOffset°, arrive, grow, endScale)
  //               Kinematic ballistic flight from (x0,y0) to (x1,y1) — NaN x1
  //               or y1 = the anchor — arriving `duration` s later moving
  //               down at `arrive` px/s after turning `turn` degrees to rest
  //               at anchorAngle + endOffset. The view scale grows from
  //               `grow` (0 = no grow) to 1 over the first 0.2 s and ends at
  //               `endScale` (0 = 1). Arrival emits `land` and hands the body
  //               back to its anchor, or to free flight without one.
  hop: 5, //       (up, stretch, spin°/s) airborne excursion from the anchor
  //               line: y velocity -= up, squash velocity -= stretch, spin
  //               toward the anchor angle; lands on the anchor line.
  kick: 6, //      (squash, lean°/s, spin°/s, pulse) add to the jelly velocities
  grab: 7, //      (x, y, surface, mode, strength) PHYSICS_GRAB at a surface
  //               point; strength 0 = 1
  drag: 8, //      (x, y, surface) move the grab target
  release: 9, //   () end a grab
  press: 10, //    (squash, pulse) jelly rest targets while held; (0, 1) resets
  settle: 11, //   (vxScale, spinScale) one-shot damping at the next floor contact
  gravity: 12, //  (gx, gy) world gravity
  burst: 13, //    (x, y, count, angle°, spread°, speedScale) emitter burst
  stream: 14, //   (rate/s, x, y, w, h) continuous emission over a world rect;
  //               rate 0 stops
  anchor: 15, //   (x, y, angle°) move a point anchor
  wake: 16, //     () start integrating a parked body in place
} as const;

/** Event record: [type, a, b, x, y, nx, ny, speed]. */
export const PHYSICS_EVENT_WORDS = 8;
/** Events kept per drain; later ones in the same frame are dropped. */
export const PHYSICS_EVENT_MAX = 128;

export const PHYSICS_EVENT = {
  /** A launch or hop came down on its target. a = body, speed = landing speed. */
  land: 1,
  /** A contact reached the body's hitSpeed. a = body, b = other body or
   *  collider, (x, y) contact point, (nx, ny) normal toward a. */
  hit: 2,
  /** A body's centre entered a zone. a = zone, b = body, (x, y) body. */
  enter: 3,
  /** A body's centre left a zone. a = zone, b = body. */
  leave: 4,
  /** A body left its ghost collider. a = body, b = collider. */
  clear: 5,
} as const;

/** `physicsQuery(query, handle, a, b, c, d)`. */
export const PHYSICS_QUERY = {
  /** (world, x, y, surface, slop) -> topmost pickable body under a surface
   *  point, or 0. Bodies grabbed last are on top. */
  pick: 1,
  x: 2,
  y: 3,
  /** Degrees. */
  angle: 4,
  vx: 5,
  vy: 6,
  /** Degrees per second. */
  spin: 7,
  speed: 8,
  /** Seconds since the last floor-like contact (normal pointing up), -1 if none. */
  grounded: 9,
  /** 1 while a hop is airborne. */
  airborne: 10,
  /** 0 free, 1 anchored, 2 flight, 3 grabbed. */
  mode: 11,
  /** Live particles of an emitter. */
  particles: 12,
  /** The body's rest position: its point anchor, or the layout centre of its
   *  first view for a layout anchor. NaN until the layout is known. */
  anchorX: 13,
  anchorY: 14,
} as const;

/** Per-body view limit, emitter pool limit, chain vertex limit. */
export const PHYSICS_MAX_VIEWS = 4;
export const PHYSICS_MAX_POOL = 64;
export const PHYSICS_MAX_POINTS = 32;
export const PHYSICS_MAX_TEXTURES = 16;
