// Gesture recognition over the per-frame touch snapshot (touch.ts).
//
// touches() is a stateless snapshot; this module turns it into contact
// LIFECYCLES — down / move / up / cancel edges with per-contact history and
// release velocity — and runs registered recognizers over them: tap,
// long-press, axis-lockable pan (whose end velocity feeds flings), and
// two-contact pinch.
//
// Ownership model (the UIKit shape, sized for a handheld):
//   - On a down edge each recognizer that matches the contact's region
//     becomes an OWNER; owners observe down/move/up concurrently.
//   - Priority is registration order, last-registered first (the same
//     convention as the focus controller stack) — deterministic because
//     mount order is deterministic.
//   - Discrete gestures single-fire on the highest-priority owner: the first
//     owner whose pan crosses slop CLAIMS the contact and every other owner
//     is cancelled (a list pan cancels the row's press-highlight); tap and
//     long-press resolve to the first owner carrying that handler.
//   - A pinch claims BOTH member contacts at once, and the pinch pass runs
//     before the per-contact pan pass, so two diverging fingers become a
//     pinch even when each finger alone would satisfy a pan; two fingers
//     travelling together (span steady, centroid moving) stay available to
//     the pan recognizers.
//   - Region hit-testing goes through resolveTouchHit (input.ts): the host's
//     down-edge hit FACT first, then hitTestBounds (op 42) in preference to
//     the ink-claiming hitTest (op 27). A `rect` is the geometry fallback for
//     hosts with neither op AND the complement for hit misses inside the
//     region (gaps between rows still pan the list). A non-null hit OUTSIDE
//     the subtree never rect-matches — what paints above the region
//     occludes it.
//
// The gesture layer never touches focus itself. Components translate
// gestures into focus/press explicitly via setActiveNode()/pressNode()
// (input.ts), so d-pad, cursor, and touch share one authority over the
// `focus:`/`active:` native variants and a pressed look can never strand.
//
// Determinism: the pump runs once per frame from the framework entry — after
// effect delivery, before app frame hooks — so app code always observes this
// frame's completed gesture output. Velocity is an integer position delta
// over k fixed-dt frames (one IEEE division; bit-identical everywhere).
// Long-press deadlines are virtual-frame counts derived from simulationHz().
// Pinch spans on a locked axis are integers; the "any" axis span uses one
// Math.sqrt, which IEEE 754 specifies exactly. On hosts without touch (PSP)
// touches() is always empty and the pump costs two comparisons; recognizers
// stay inert.
//
// Steady state allocates nothing: contact tracks are a fixed pool of 8
// (the wire cap), position history lives in preallocated Int16Array rings,
// per-owner recognition state is a flag byte per pool slot, and pinch events
// reuse one module-scratch record (valid only during the callback).
//
// This module is framework-neutral. The per-framework shims (gesture.ts for
// Solid, gesture.vue-vapor.ts for Vue Vapor) re-export it and add the
// scope-disposing createGesture() flavor of attachGesture().

import { simulationHz, virtualFrame } from "./clock.ts";
import type { SurfaceId } from "./display.ts";
import { resolveTouchHit } from "./input.ts";
import type { NodeMirror } from "./renderer.ts";
import { __allTouches, __cancelledTouches } from "./touch.ts";

export type GesturePhase = "down" | "move" | "up" | "cancel";

/** A live view of one contact, valid during the frame it is delivered. */
export interface GestureContact {
  /** UI output whose logical coordinate space contains this contact. */
  readonly surface: SurfaceId;
  /** Stable while the contact is down; ids may be reused after release. */
  readonly id: number;
  /** Current position, logical viewport px. */
  readonly x: number;
  readonly y: number;
  /** Position at the down edge. */
  readonly startX: number;
  readonly startY: number;
  /** Total travel since down. */
  readonly dx: number;
  readonly dy: number;
  /** Travel THIS frame (what a finger-follow drag consumes). */
  readonly fdx: number;
  readonly fdy: number;
  /** Velocity in logical px per VIRTUAL second (release velocity on up). */
  readonly vx: number;
  readonly vy: number;
  /** virtualFrame() at the down edge. */
  readonly downFrame: number;
  /** The down edge's hit FACT (TouchContact.hit): the node id the host
   *  bounds-resolved under the finger when it landed, carried for the
   *  contact's lifetime. undefined on hosts without the fact channel. */
  readonly hit?: number;
  /** Frames since down (0 on the down frame). */
  readonly frames: number;
}

/** A live view of one two-contact pinch, valid during the callback. */
export interface GesturePinch {
  /** The two member contacts' current positions, logical viewport px. */
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
  /** Centroid of the two contacts. */
  readonly cx: number;
  readonly cy: number;
  /** Current span: the distance between the contacts, projected onto the
   *  recognizer's locked axis ("x"/"y"), Euclidean for "any". */
  readonly span: number;
  /** Span when the pair formed (both fingers down, before the slop). */
  readonly startSpan: number;
  /** span - startSpan: positive when the fingers moved apart. */
  readonly dspan: number;
  /** Span change THIS frame (what an insert-gap grow consumes). */
  readonly fdspan: number;
}

export interface GestureRegion {
  /** Own contacts whose resolved hit lands inside this node's subtree. The
   *  hit comes from resolveTouchHit (input.ts): the down-edge fact, else
   *  hitTestBounds (op 42) in preference to the ink hitTest (op 27). */
  node?: () => NodeMirror | null | undefined;
  /** Geometry fallback: used when the host provides neither hit op, and as
   *  the complement when the hit misses (nothing under the finger) inside
   *  the region. Logical px. */
  rect?: () => { x: number; y: number; w: number; h: number } | null | undefined;
}

export interface GestureOptions {
  /** Output to observe. Existing recognizers remain primary-only. */
  surface?: SurfaceId;
  /** Omit for a whole-screen recognizer (lowest specificity, not lowest
   *  priority — priority is registration order). */
  region?: GestureRegion;
  /** Pan axis lock. "y"/"x" reject cross-axis movement (the contact's tap
   *  may still die, but this recognizer never pans it). A pinch recognizer
   *  measures its span on the same axis. Default "any". */
  axis?: "x" | "y" | "any";
  /** Max total travel (per axis) for the contact to still count as a tap. */
  tapSlop?: number;
  /** Travel that starts a pan (and claims the contact). */
  panSlop?: number;
  /** Span change that starts a pinch (and claims both contacts). */
  pinchSlop?: number;
  /** Hold duration for onLongPress, in VIRTUAL seconds. */
  longPressSeconds?: number;
  /** Survive pushTouchBlock (the OSK's own recognizer sets this). */
  allowWhenBlocked?: boolean;
  onDown?(c: GestureContact): void;
  onMove?(c: GestureContact): void;
  onUp?(c: GestureContact): void;
  onCancel?(c: GestureContact): void;
  /** Up within tapSlop, nothing claimed, no long-press fired. Single-fires
   *  on the highest-priority owner with a handler. */
  onTap?(c: GestureContact): void;
  /** Held longPressSeconds within tapSlop. Fires once, then claims. */
  onLongPress?(c: GestureContact): void;
  /** Slop exceeded on the (locked) axis — claims the contact. */
  onPanStart?(c: GestureContact): void;
  /** Every frame while panning (fdx/fdy may be 0 on hold frames). */
  onPanMove?(c: GestureContact): void;
  /** Release while panning; c.vx/vy is the fling velocity. */
  onPanEnd?(c: GestureContact): void;
  /** Two owned contacts' span change beat pinchSlop AND the centroid's
   *  travel — claims both contacts. */
  onPinchStart?(p: GesturePinch): void;
  /** Every frame while pinching (fdspan may be 0 on hold frames). */
  onPinchMove?(p: GesturePinch): void;
  /** Either member released or cancelled; p carries the final geometry. */
  onPinchEnd?(p: GesturePinch): void;
}

export interface GestureHandle {
  dispose(): void;
  /** Force-cancel this recognizer's in-flight contacts (fires onCancel). */
  cancel(): void;
  /** True while any contact is mid-pan under this recognizer. */
  readonly panning: boolean;
  /** True while a pinch is in flight under this recognizer. */
  readonly pinching: boolean;
}

const MAX_TRACKS = 8; // the touch wire cap (touch.ts)
const HIST = 8; // position history ring length
const VELOCITY_WINDOW = 3; // frames spanned by the velocity estimate
const DEFAULT_TAP_SLOP = 8;
const DEFAULT_PAN_SLOP = 6;
const DEFAULT_PINCH_SLOP = 10;
const DEFAULT_LONG_PRESS_S = 0.5;

// Per-(recognizer, pool slot) recognition state flags.
const OBSERVING = 1;
const TAP_DEAD = 2;
const LONGPRESS_FIRED = 4;
const PANNING = 8;

interface Recognizer {
  opts: GestureOptions;
  disposed: boolean;
  /** One flag byte per contact pool slot. */
  flags: Uint8Array;
  /** Candidate pinch pair (pool slots) and its formation geometry. */
  pairA: number;
  pairB: number;
  baseSpan: number;
  baseCx: number;
  baseCy: number;
  prevSpan: number;
  /** Pool slots of the active pinch members; -1 while not pinching. */
  pinchA: number;
  pinchB: number;
}

interface Track extends GestureContact {
  slot: number;
  used: boolean;
  /** Seen in the current frame's snapshot (mark/sweep). */
  present: boolean;
  hit?: number;
  surface: SurfaceId;
  id: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  dx: number;
  dy: number;
  fdx: number;
  fdy: number;
  vx: number;
  vy: number;
  downFrame: number;
  frames: number;
  histX: Int16Array;
  histY: Int16Array;
  histHead: number;
  histLen: number;
  owners: Recognizer[];
  claimedBy: Recognizer | null;
}

const recognizers: Recognizer[] = [];
let blockDepth = 0;
let liveCount = 0;

const tracks: Track[] = Array.from({ length: MAX_TRACKS }, (_, slot) => ({
  slot,
  used: false,
  present: false,
  surface: "primary",
  id: 0,
  x: 0,
  y: 0,
  startX: 0,
  startY: 0,
  dx: 0,
  dy: 0,
  fdx: 0,
  fdy: 0,
  vx: 0,
  vy: 0,
  downFrame: 0,
  frames: 0,
  histX: new Int16Array(HIST),
  histY: new Int16Array(HIST),
  histHead: 0,
  histLen: 0,
  owners: [],
  claimedBy: null,
}));

/** The one pinch record, reused across events; valid during the callback. */
const pinchScratch = {
  ax: 0,
  ay: 0,
  bx: 0,
  by: 0,
  cx: 0,
  cy: 0,
  span: 0,
  startSpan: 0,
  dspan: 0,
  fdspan: 0,
};

function withinSubtree(node: NodeMirror, ancestor: NodeMirror): boolean {
  let n: NodeMirror | null = node;
  while (n) {
    if (n === ancestor) return true;
    n = n.parent;
  }
  return false;
}

/** Region match for a down at (x, y). `hit` memoizes the down's resolution:
 *  the host FACT when delivered (`fact` — TouchContact.hit), else one cold
 *  bounds/ink query. undefined = not yet resolved, null = resolved-miss. */
function regionMatches(
  rec: Recognizer,
  x: number,
  y: number,
  hitBox: {
    hit: NodeMirror | null | undefined;
    fact: number | undefined;
    surface: SurfaceId;
  },
): boolean {
  if ((rec.opts.surface ?? "primary") !== hitBox.surface) return false;
  const region = rec.opts.region;
  if (!region) return true;
  const target = region.node?.();
  if (target) {
    if (hitBox.hit === undefined) {
      hitBox.hit = resolveTouchHit(x, y, hitBox.fact, hitBox.surface);
    }
    const hit = hitBox.hit;
    if (hit) return withinSubtree(hit, target);
    // Miss (bare screen on a fact host, or no hit channel at all): the rect
    // decides, when provided. A hit OUTSIDE the subtree already returned
    // above — occluders win.
  }
  const r = region.rect?.();
  if (!r) return false;
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

function hasPinchHandlers(rec: Recognizer): boolean {
  return !!(rec.opts.onPinchStart || rec.opts.onPinchMove || rec.opts.onPinchEnd);
}

function pinchSpan(axis: "x" | "y" | "any", a: Track, b: Track): number {
  if (axis === "y") {
    const d = a.y - b.y;
    return d < 0 ? -d : d;
  }
  if (axis === "x") {
    const d = a.x - b.x;
    return d < 0 ? -d : d;
  }
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function fillPinchScratch(rec: Recognizer, a: Track, b: Track): void {
  const axis = rec.opts.axis ?? "any";
  const span = pinchSpan(axis, a, b);
  pinchScratch.ax = a.x;
  pinchScratch.ay = a.y;
  pinchScratch.bx = b.x;
  pinchScratch.by = b.y;
  pinchScratch.cx = (a.x + b.x) / 2;
  pinchScratch.cy = (a.y + b.y) / 2;
  pinchScratch.span = span;
  pinchScratch.startSpan = rec.baseSpan;
  pinchScratch.dspan = span - rec.baseSpan;
  pinchScratch.fdspan = span - rec.prevSpan;
}

function clearPinchPair(rec: Recognizer): void {
  rec.pairA = -1;
  rec.pairB = -1;
}

/** Ends an active pinch (release, cancel, or dispose). Fires onPinchEnd with
 *  the final geometry while both member tracks still carry positions. */
function endPinch(rec: Recognizer): void {
  if (rec.pinchA < 0) return;
  const a = tracks[rec.pinchA];
  const b = tracks[rec.pinchB];
  rec.pinchA = -1;
  rec.pinchB = -1;
  clearPinchPair(rec);
  fillPinchScratch(rec, a, b);
  rec.opts.onPinchEnd?.(pinchScratch);
}

function fireCancel(rec: Recognizer, t: Track): void {
  rec.flags[t.slot] = 0;
  if (t.claimedBy === rec) t.claimedBy = null;
  if (rec.pinchA === t.slot || rec.pinchB === t.slot) endPinch(rec);
  rec.opts.onCancel?.(t);
}

/** The winner keeps the contact; every other observing owner is cancelled. */
function claim(t: Track, winner: Recognizer): void {
  t.claimedBy = winner;
  for (const o of t.owners) {
    if (o !== winner && o.flags[t.slot] & OBSERVING) fireCancel(o, t);
  }
}

function releaseTrack(t: Track): void {
  for (const o of t.owners) o.flags[t.slot] = 0;
  t.owners.length = 0;
  t.claimedBy = null;
  t.used = false;
  liveCount--;
}

function beginTrack(
  t: Track,
  surface: SurfaceId,
  id: number,
  x: number,
  y: number,
  fact: number | undefined,
): void {
  t.used = true;
  t.present = true;
  t.hit = fact;
  t.surface = surface;
  t.id = id;
  t.x = x;
  t.y = y;
  t.startX = x;
  t.startY = y;
  t.dx = 0;
  t.dy = 0;
  t.fdx = 0;
  t.fdy = 0;
  t.vx = 0;
  t.vy = 0;
  t.downFrame = virtualFrame();
  t.frames = 0;
  t.histX[0] = x;
  t.histY[0] = y;
  t.histHead = 1;
  t.histLen = 1;
  t.owners.length = 0;
  t.claimedBy = null;
  liveCount++;

  // Resolve owners in priority order (last-registered first); the down's hit
  // — the host fact, or at most one query — is shared across recognizers.
  const hitBox: {
    hit: NodeMirror | null | undefined;
    fact: number | undefined;
    surface: SurfaceId;
  } = {
    hit: undefined,
    fact,
    surface,
  };
  for (let i = recognizers.length - 1; i >= 0; i--) {
    const rec = recognizers[i];
    if (rec.disposed) continue;
    if (blockDepth > 0 && !rec.opts.allowWhenBlocked) continue;
    if (!regionMatches(rec, x, y, hitBox)) continue;
    rec.flags[t.slot] = OBSERVING;
    t.owners.push(rec);
  }
  for (const o of t.owners) o.opts.onDown?.(t);
}

function updateTrack(t: Track, x: number, y: number): void {
  t.present = true;
  t.fdx = x - t.x;
  t.fdy = y - t.y;
  t.x = x;
  t.y = y;
  t.dx = x - t.startX;
  t.dy = y - t.startY;
  t.frames++;
  t.histX[t.histHead] = x;
  t.histY[t.histHead] = y;
  t.histHead = (t.histHead + 1) % HIST;
  if (t.histLen < HIST) t.histLen++;
  const k = Math.min(VELOCITY_WINDOW, t.histLen - 1);
  if (k <= 0) {
    t.vx = 0;
    t.vy = 0;
    return;
  }
  // Integer px over k frames of 1/hz virtual seconds each — px per virtual
  // second with a single exactly-specified IEEE division per axis.
  const hz = simulationHz();
  const last = (t.histHead - 1 + HIST) % HIST;
  const prev = (last - k + HIST) % HIST;
  t.vx = ((t.histX[last] - t.histX[prev]) * hz) / k;
  t.vy = ((t.histY[last] - t.histY[prev]) * hz) / k;
}

/** The two-contact pass. Runs BEFORE the per-contact pan pass so a forming
 *  pinch wins the claim race against its own (or a sibling's) pan. */
function recognizePinches(): void {
  for (let i = recognizers.length - 1; i >= 0; i--) {
    const rec = recognizers[i];
    if (rec.disposed || !hasPinchHandlers(rec)) continue;

    if (rec.pinchA >= 0) {
      // Active pinch: both members still present (finishTrack ends the pinch
      // before a member is released), report this frame's geometry.
      const a = tracks[rec.pinchA];
      const b = tracks[rec.pinchB];
      fillPinchScratch(rec, a, b);
      rec.opts.onPinchMove?.(pinchScratch);
      rec.prevSpan = pinchScratch.span;
      continue;
    }

    // Candidate pair: the first two unclaimed contacts this recognizer still
    // observes, in pool-slot order (slots are recycled lowest-free-first, so
    // this is not necessarily the two earliest-landed contacts). Slot order
    // makes the choice deterministic.
    let a: Track | null = null;
    let b: Track | null = null;
    for (const t of tracks) {
      if (!t.used || !t.present || t.claimedBy) continue;
      if (!(rec.flags[t.slot] & OBSERVING)) continue;
      if (!a) a = t;
      else if (!b) b = t;
      else break;
    }
    if (!a || !b) {
      clearPinchPair(rec);
      continue;
    }

    const axis = rec.opts.axis ?? "any";
    if (rec.pairA !== a.slot || rec.pairB !== b.slot) {
      // Pair formed (or membership changed): record the base geometry and
      // decide from the next frame's motion.
      rec.pairA = a.slot;
      rec.pairB = b.slot;
      rec.baseSpan = pinchSpan(axis, a, b);
      rec.baseCx = (a.x + b.x) / 2;
      rec.baseCy = (a.y + b.y) / 2;
      rec.prevSpan = rec.baseSpan;
      continue;
    }

    const span = pinchSpan(axis, a, b);
    const dspan = span - rec.baseSpan;
    const absDspan = dspan < 0 ? -dspan : dspan;
    const slop = rec.opts.pinchSlop ?? DEFAULT_PINCH_SLOP;
    if (absDspan <= slop) continue;
    // The span change must dominate the common-mode movement: two fingers
    // travelling together are a scroll, not a pinch.
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const travelX = cx - rec.baseCx;
    const travelY = cy - rec.baseCy;
    const travel =
      axis === "y"
        ? (travelY < 0 ? -travelY : travelY)
        : axis === "x"
          ? (travelX < 0 ? -travelX : travelX)
          : Math.sqrt(travelX * travelX + travelY * travelY);
    if (absDspan < travel) continue;

    rec.pinchA = a.slot;
    rec.pinchB = b.slot;
    rec.flags[a.slot] |= TAP_DEAD;
    rec.flags[b.slot] |= TAP_DEAD;
    claim(a, rec);
    claim(b, rec);
    fillPinchScratch(rec, a, b);
    rec.opts.onPinchStart?.(pinchScratch);
    rec.prevSpan = pinchScratch.span;
  }
}

function recognize(t: Track): void {
  const moved = t.fdx !== 0 || t.fdy !== 0;
  const adx = t.dx < 0 ? -t.dx : t.dx;
  const ady = t.dy < 0 ? -t.dy : t.dy;

  for (const rec of t.owners) {
    const f = rec.flags[t.slot];
    if (!(f & OBSERVING)) continue;
    if (moved) rec.opts.onMove?.(t);
    // Tap death is per-owner: each recognizer has its own slop.
    const slop = rec.opts.tapSlop ?? DEFAULT_TAP_SLOP;
    if (!(f & TAP_DEAD) && (adx > slop || ady > slop)) {
      rec.flags[t.slot] |= TAP_DEAD;
    }
  }

  // Long-press: first (highest-priority) owner still tap-alive past its
  // deadline fires once, then claims.
  if (!t.claimedBy) {
    for (const rec of t.owners) {
      const f = rec.flags[t.slot];
      if (!(f & OBSERVING) || f & (TAP_DEAD | LONGPRESS_FIRED)) continue;
      if (!rec.opts.onLongPress) continue;
      const deadline = Math.max(
        1,
        Math.round((rec.opts.longPressSeconds ?? DEFAULT_LONG_PRESS_S) * simulationHz()),
      );
      if (t.frames < deadline) continue;
      rec.flags[t.slot] |= LONGPRESS_FIRED;
      rec.opts.onLongPress(t);
      claim(t, rec);
      break;
    }
  }

  // Pan start: first owner whose (locked) axis crosses slop claims.
  if (!t.claimedBy) {
    for (const rec of t.owners) {
      const f = rec.flags[t.slot];
      if (!(f & OBSERVING) || f & PANNING) continue;
      if (!rec.opts.onPanStart && !rec.opts.onPanMove && !rec.opts.onPanEnd) continue;
      const slop = rec.opts.panSlop ?? DEFAULT_PAN_SLOP;
      if (adx <= slop && ady <= slop) continue;
      const axis = rec.opts.axis ?? "any";
      if (axis === "y" ? ady < adx : axis === "x" ? adx < ady : false) {
        // The locked axis is not dominant YET — defer, don't kill. Deciding
        // permanently at the first slop crossing (6 logical px = 24 Vita
        // panel px) killed real-world swipes: a script moves in a pure
        // line, but a real thumb lands with wobble and arcs, so the wrong
        // axis often wins the first few pixels (found on hardware — the
        // motions pager never fired). Re-evaluated every frame while
        // unclaimed: the recognizer claims the moment its axis dominates,
        // and a drag whose dominant axis never matches simply never pans
        // here — a vertical scroll still cannot turn a horizontal pager.
        continue;
      }
      rec.flags[t.slot] |= PANNING | TAP_DEAD;
      rec.opts.onPanStart?.(t);
      claim(t, rec);
      break;
    }
  }

  for (const rec of t.owners) {
    if ((rec.flags[t.slot] & (OBSERVING | PANNING)) === (OBSERVING | PANNING)) {
      rec.opts.onPanMove?.(t);
    }
  }
}

function finishTrack(t: Track): void {
  for (const rec of t.owners) {
    if (rec.pinchA === t.slot || rec.pinchB === t.slot) endPinch(rec);
  }
  for (const rec of t.owners) {
    const f = rec.flags[t.slot];
    if (!(f & OBSERVING)) continue;
    rec.opts.onUp?.(t);
    if (f & PANNING) rec.opts.onPanEnd?.(t);
  }
  // Tap single-fires on the highest-priority owner still qualifying.
  if (!t.claimedBy) {
    for (const rec of t.owners) {
      const f = rec.flags[t.slot];
      if (!(f & OBSERVING) || f & (TAP_DEAD | LONGPRESS_FIRED | PANNING)) continue;
      if (!rec.opts.onTap) continue;
      rec.opts.onTap(t);
      break;
    }
  }
  releaseTrack(t);
}

/** One gesture frame. Called from the frame pump (the framework entry) after
 *  __setTouches/__drainEffects and before app frame hooks. */
export function __runGestures(): void {
  const snap = __allTouches();
  if (snap.length === 0 && liveCount === 0) return;

  // Retire old lifetimes before allocating new ones: cancellation must stop
  // a pending Space before a new DOWN can consume it as a two-thumb chord.
  // This also frees all eight slots when every contact changes in one frame.
  const cancelled = __cancelledTouches();
  for (const t of tracks) {
    if (t.used && cancelled.some(c => c.surface === t.surface && c.id === t.id)) {
      for (const rec of t.owners) if (rec.flags[t.slot] & OBSERVING) fireCancel(rec, t);
      releaseTrack(t);
    } else if (t.used && !snap.some(c => c.surface === t.surface && c.id === t.id)) finishTrack(t);
    t.present = false;
  }

  for (const c of snap) {
    let found: Track | null = null;
    for (const t of tracks) {
      if (t.used && t.surface === c.surface && t.id === c.id) {
        found = t;
        break;
      }
    }
    if (found) {
      updateTrack(found, c.x, c.y);
      continue;
    }
    let free: Track | null = null;
    for (const t of tracks) {
      if (!t.used) {
        free = t;
        break;
      }
    }
    if (free) beginTrack(free, c.surface, c.id, c.x, c.y, c.hit);
  }

  // Up edges first (a released contact must not be re-recognized), then the
  // two-contact pass (a forming pinch claims before any pan can), then the
  // per-frame recognition pass over surviving contacts.
  for (const t of tracks) {
    if (t.used && !t.present) finishTrack(t);
  }
  recognizePinches();
  for (const t of tracks) {
    if (t.used && t.present) recognize(t);
  }
}

function cancelContactsFor(rec: Recognizer): void {
  for (const t of tracks) {
    if (t.used && rec.flags[t.slot] & OBSERVING) fireCancel(rec, t);
  }
}

/**
 * Register a recognizer. Framework-neutral: the caller owns disposal. Most
 * component code wants createGesture() (gesture.ts / gesture.vue-vapor.ts),
 * which scopes disposal to the owner's cleanup hook.
 */
export function attachGesture(opts: GestureOptions): GestureHandle {
  const rec: Recognizer = {
    opts,
    disposed: false,
    flags: new Uint8Array(MAX_TRACKS),
    pairA: -1,
    pairB: -1,
    baseSpan: 0,
    baseCx: 0,
    baseCy: 0,
    prevSpan: 0,
    pinchA: -1,
    pinchB: -1,
  };
  recognizers.push(rec);
  return {
    dispose(): void {
      if (rec.disposed) return;
      cancelContactsFor(rec);
      endPinch(rec);
      rec.disposed = true;
      const i = recognizers.lastIndexOf(rec);
      if (i >= 0) recognizers.splice(i, 1);
    },
    cancel(): void {
      if (!rec.disposed) cancelContactsFor(rec);
    },
    get panning(): boolean {
      for (const t of tracks) {
        if (t.used && rec.flags[t.slot] & PANNING) return true;
      }
      return false;
    },
    get pinching(): boolean {
      return rec.pinchA >= 0;
    },
  };
}

/**
 * Modal touch mute — the touch mirror of pushButtonHandlerBlock (frame.ts).
 * Pushing SYNCHRONOUSLY cancels the in-flight contacts of every non-exempt
 * recognizer (the list under an opening OSK sees onCancel this frame, not a
 * phantom release later) and suppresses new downs for them while held.
 * Recognizers with allowWhenBlocked keep working. Returns a disposer.
 */
export function pushTouchBlock(): () => void {
  blockDepth++;
  for (const rec of recognizers) {
    if (!rec.opts.allowWhenBlocked) cancelContactsFor(rec);
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    blockDepth = Math.max(0, blockDepth - 1);
  };
}

/** Fresh gesture state for a fresh mount (framework entry render()/dispose). */
export function resetGestures(): void {
  recognizers.length = 0;
  blockDepth = 0;
  liveCount = 0;
  for (const t of tracks) {
    t.used = false;
    t.present = false;
    t.owners.length = 0;
    t.claimedBy = null;
  }
}
