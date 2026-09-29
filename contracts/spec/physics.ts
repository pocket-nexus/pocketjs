// PocketJS physics spec — 2D bodies stepped by the UI core (capability
// `ui.physics`, ops 52..56 in spec.ts OP).
//
// A WORLD is a fixed-step rigid-body simulation owned by pocketjs-core and
// advanced inside `Ui::tick`, SUBSTEPS integrations per core tick at the
// realm's fixed dt. A BODY is bound to one or more retained nodes (VIEWS);
// after every tick the core writes the body's pose into each view's physics
// layer as the paint-only props translateX/translateY, rotate, skewX, scaleX,
// scaleY and originY. The physics layer resolves after styles, overrides and
// animation tracks, so a view's own `animate()` and `cancelAnim()` never see
// or freeze a pose, and destroying the body returns the view to its styled
// pose. Painting, clipping and hit testing reuse the tree; motion never runs
// layout.
//
// Coordinates are logical pixels with +y down. One world spans every UI
// output: each surface (PHYSICS_SURFACE) is a window placed at an origin in
// world space, and a view is positioned relative to the surface its root
// ancestor belongs to, by the sum of its ancestors' layout offsets. The space
// between the windows (a hinge) is world space that neither output shows.
//
// A body can rest at an ANCHOR — a point, or the layout centre of its first
// view — held by damped springs, and carries JELLY state: squash, lean and
// pulse springs that contacts, landings and flight speed excite. COLLIDERS
// are static shapes (boxes, circles, chains, or a node's layout box); a
// collider may name an OWNER body whose jelly absorbs the collider's impacts.
// ZONES report bodies entering and leaving. EMITTERS drive pools of image
// nodes as particles, from their own seeded generators.
//
// Boundary (all synchronous, all numbers):
//
//   physicsCreate(kind, params)  -> handle | 0   params = f64 [key, value]*
//   physicsApply(records)                        records = f64 [handle, cmd, argc, arg*]*
//   physicsDestroy(handle)                       a world takes its objects with it
//   physicsEvents()              -> f64 records | undefined   EVENT_WORDS each
//   physicsQuery(query, handle, a, b, c, d) -> f64
//
// Every f64 list crosses as a little-endian byte buffer (an ArrayBuffer in
// JavaScript), the setPropBatch convention. Non-finite parameters and command
// arguments are ignored, except where NaN is given a meaning below.
//
// Frame contract: JS creates objects and issues commands at interaction
// edges; integration, collision, deformation, particles and event detection
// run natively every tick. A world records events only while it LISTENS
// (command `listen`); the ticks of frame N record them and the guest drains
// them at the start of frame N+1, so they enter the app as frame-boundary
// facts. Time inside a world is an integer substep count. All randomness comes
// from seeded generators, so a run is a pure function of (build, params,
// command stream, input tape).
//
// Angles cross this boundary in DEGREES (and degrees per second), matching
// the `rotate` prop; the core integrates in radians.
//
// Contacts combine the two sides' coefficients: restitution is the smaller
// one, friction the mean. A collider's defaults (restitution 1, friction 0.55)
// leave the body's restitution in charge.
//
// Fixed behaviour (not parameters):
//   - Each substep runs 3 contact passes. A pair of bodies is separated by 70%
//     of its penetration per contact, a body and a collider by 100%.
//   - A body emits at most one `hit` per 0.12 s.
//   - `launch` grows the view scale over its first 0.2 s with an overshoot of
//     1.9; its flight stretch uses 40% of `stretchGain`. Arrival on an anchor
//     hands over 10% of the horizontal speed, 30% of `arrive` downward and 12%
//     of the spin, and kicks the jelly as a landing at 85% of `arrive`, the
//     speed its `land` event reports. The view keeps `endScale` afterwards.
//   - A hop lands with an 8% rebound. A carried body released onto its anchor
//     lands when it passes within 5% of its size at more than 60% of its size
//     per second.
//   - `tether` pulls the grab point, placed at 75% of the offset from the body
//     centre, at 28.8 /s of its error, limited to 40000·strength px/s², and
//     damps spin at 4.3 /s. `carry` smooths the pointer velocity at 41.6 /s.
//   - An impact squash kick is at most 5.5 per contact, an impact lean kick
//     at most 172 °/s, and a dent below 0.035 is ignored.
//   - `anchorFree` bodies spring only after 0.15 s without floor contact.
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

/** Handle layout: kind in bits 28..30, generation in 16..27, slot in 0..15.
 *  Freed slots are reused oldest-first. */
export const PHYSICS_HANDLE_KIND_SHIFT = 28;
export const PHYSICS_HANDLE_GEN_SHIFT = 16;
export const PHYSICS_HANDLE_GEN_MASK = 0xfff;
export const PHYSICS_HANDLE_SLOT_MASK = 0xffff;

/** Surface indices used by views, picks, grabs and origins. */
export const PHYSICS_SURFACE = { primary: 0, auxiliary: 1 } as const;

/** `mode` query results. */
export const PHYSICS_MODE = { free: 0, anchored: 1, flight: 2, grabbed: 3 } as const;

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
  /** Squash compresses the body's own vertical axis. */
  body: 0,
  /** Squash compresses along the last impact normal, in world space; before
   *  the first impact, and after a `kick`, along world vertical. */
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
 * Defaults in brackets; "body/collider" gives both kinds' defaults. Lengths
 * are px, times seconds, angles degrees.
 */
export const PHYSICS_KEY = {
  // -- shared -----------------------------------------------------------------
  world: 1, //          world handle (every kind but world) [required]
  layer: 2, //          collision layer bits [1]
  mask: 3, //           layers this object collides with / watches [0xffff]
  view: 4, //           node id bound to a body or emitter (repeatable, at
  //                    most PHYSICS_MAX_VIEWS per body, PHYSICS_MAX_POOL per
  //                    emitter)
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
  pointX: 15, //        chain vertex (repeatable, in order, at most
  pointY: 16, //        PHYSICS_MAX_POINTS)
  closed: 17, //        chain closes back to its first vertex [0]
  node: 18, //          layout-box source node for PHYSICS_SHAPE.node
  pad: 19, //           px grown on every side of a node box [0]
  restitution: 20, //   bounce factor [body 0.3 / collider 1]
  friction: 21, //      Coulomb coefficient [body 0.4 / collider 0.55]
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
  squashStiffness: 55, // jelly squash spring; 0 disables squash [0]
  squashDamping: 56, // [0]
  squashLimit: 57, //   |squash| clamp [0.42]
  squashX: 58, //       scale gained across the squash axis per unit squash [0.6]
  squashY: 59, //       scale lost along the squash axis per unit squash [1]
  squashAxis: 60, //    PHYSICS_SQUASH_AXIS [body]
  squashImpact: 61, //  squash velocity per px/s of contact velocity change,
  //                    weighted by how vertical the contact is in the body
  //                    frame [0]
  dent: 62, //          squash set per px/s of impact speed, along the impact
  //                    normal [0]
  dentLimit: 63, //     largest dent [0.3]
  landGain: 64, //      squash velocity per px/s of landing speed [0]
  landMin: 65, //       landing squash velocity clamp [0]
  landMax: 66, //       [0]
  landSpin: 67, //      spin kick per unit landing squash, degrees/s, with a
  //                    side from the world's generator [0]
  leanStiffness: 68, // lean (skewX) spring; 0 disables lean [0]
  leanDamping: 69, //   [0]
  leanGain: 70, //      lean target, degrees per px/s of horizontal speed [0]
  leanLimit: 71, //     |lean target| clamp, degrees [14]
  leanImpact: 72, //    lean velocity, degrees/s per px/s of velocity change
  //                    across the body frame [0]
  pulseStiffness: 73, // scale spring toward the press target; 0 disables [0]
  pulseDamping: 74, //  [0]
  stretchGain: 75, //   negative squash per px/s of speed while airborne [0]
  stretchLimit: 76, //  largest stretch [0.16]
  pivot: 77, //         px below the body centre that rotation and squash
  //                    turn about [0]
  // -- collider ---------------------------------------------------------------
  owner: 78, //         body whose jelly absorbs this collider's impacts [0]
  ownerSquash: 79, //   owner squash velocity per px/s of impact speed [0]
  ownerSquashLimit: 80, // [3]
  ownerSpin: 81, //     owner spin away from the impact side, degrees/s per
  //                    px/s of impact speed [0]
  ownerSpinLimit: 82, // degrees/s [50]
  // -- emitter ----------------------------------------------------------------
  texture: 83, //       texture handle a particle may wear (repeatable, at
  //                    most PHYSICS_MAX_TEXTURES)
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
  // particles use gravityX / gravityY as their own acceleration [0, 0]
  // -- body, continued --------------------------------------------------------
  asleep: 97, //        body starts parked: no integration, no contacts, until
  //                    a motion command (launch, hop, impulse, velocity,
  //                    teleport, grab, wake) [0]
  jellySpeed: 98, //    contact speed below which contacts leave the jelly
  //                    alone (squashImpact, leanImpact, dent) [0]
  anchorFree: 99, //    the anchor springs act only while the body is free:
  //                    not grabbed, no floor contact for 0.15 s [0]
  // -- collider, continued ----------------------------------------------------
  ownerSpeed: 100, //   impact speed below which the owner is left alone [0]
} as const;

/**
 * Commands. `physicsApply` takes [handle, cmd, argc, arg*] records; missing
 * trailing arguments read as 0. Commands on stale handles are no-ops.
 * Append-only.
 */
export const PHYSICS_CMD = {
  impulse: 1, //   (vx, vy, spin°/s) add to the velocity
  velocity: 2, //  (vx, vy, spin°/s) replace the velocity
  teleport: 3, //  (x, y, angle°) move without sweeping; clears velocity;
  //               NaN angle keeps the angle
  launch: 4, //    (x0, y0, x1, y1, duration, turn°, endOffset°, arrive, grow,
  //               endScale, solid) kinematic ballistic flight from (x0,y0) to
  //               (x1,y1), arriving `duration` s later moving down at
  //               `arrive` px/s. NaN x1 or y1 = the anchor (the start point
  //               while the anchor is unknown). A body anchored in position
  //               turns `turn` degrees to rest at anchorAngle + endOffset;
  //               otherwise it turns `turn` from its current angle. The view
  //               scale grows from `grow` (0 = no grow) and ends at
  //               `endScale` (0 = 1). `solid` 1 keeps the flying body a
  //               kinematic obstacle for free bodies; 0 lets it pass through.
  //               Arrival emits `land` and hands the body to its anchor, or to
  //               free motion without one.
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
  stream: 14, //   (rate/s, x, y, w, h) continuous emission over a world rect,
  //               at most one pool of particles per tick; rate 0 stops
  anchor: 15, //   (x, y, angle°) make the anchor a point; NaN angle keeps the
  //               rest angle
  wake: 16, //     () start integrating a parked body in place
  listen: 17, //   (on) world: record events while on [on]
} as const;

/** Event record: [type, a, b, x, y, nx, ny, speed]. */
export const PHYSICS_EVENT_WORDS = 8;
/** Records a world keeps per tick; the rest are counted in one `overflow`. */
export const PHYSICS_EVENT_MAX = 128;
/** Ticks of records held while nobody drains; older ticks' records are kept,
 *  later ones counted as overflow. */
export const PHYSICS_EVENT_BACKLOG = 8;

export const PHYSICS_EVENT = {
  /** A launch or hop came down on its target. a = body, (x, y) position,
   *  speed = the landing speed its jelly took. */
  land: 1,
  /** A contact reached the body's hitSpeed. a = body, b = other body or
   *  collider, (x, y) contact point, (nx, ny) normal toward a. */
  hit: 2,
  /** A body's centre entered a zone. a = zone, b = body, (x, y) position,
   *  (nx, ny) its velocity, speed = |velocity|. */
  enter: 3,
  /** A body's centre left a zone, or the body was destroyed inside it.
   *  a = zone, b = body. */
  leave: 4,
  /** A body left its ghost collider. a = body, b = collider. */
  clear: 5,
  /** Records dropped this tick past PHYSICS_EVENT_MAX or the backlog; speed =
   *  the count. */
  overflow: 6,
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
  /** Seconds since the last contact with a collider whose normal points up;
   *  -1 if none. */
  grounded: 9,
  /** 1 while a hop is airborne. */
  airborne: 10,
  /** PHYSICS_MODE. */
  mode: 11,
  /** Live particles of an emitter. */
  particles: 12,
  /** The body's rest position: its point anchor, or the layout centre of its
   *  first view for a layout anchor. NaN until the layout is known. */
  anchorX: 13,
  anchorY: 14,
} as const;

/** Per-body view limit, emitter pool limit, chain vertex limit, emitter
 *  texture limit. Creation past a limit is refused (handle 0). */
export const PHYSICS_MAX_VIEWS = 4;
export const PHYSICS_MAX_POOL = 64;
export const PHYSICS_MAX_POINTS = 32;
export const PHYSICS_MAX_TEXTURES = 16;
