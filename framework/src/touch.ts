// Target-neutral touch snapshot delivered at the start of each host frame.
// Coordinates are logical PocketJS pixels, so applications never compensate
// for a Vita panel's sampling grid or the target raster density.

export interface TouchContact {
  /** UI output whose logical coordinate space contains this contact. */
  readonly surface: "primary" | "auxiliary";
  /** Stable while this contact remains down; ids may be reused after release. */
  readonly id: number;
  /** Logical viewport X coordinate. */
  readonly x: number;
  /** Logical viewport Y coordinate. */
  readonly y: number;
  /**
   * Touch hit FACT: the node id the host bounds-hit at this contact's DOWN
   * edge (against the committed frame the user was looking at), carried for
   * the contact's lifetime. `undefined` when the host predates the fact
   * channel or during devtools replay — the gesture layer then falls back to
   * a query (spec op 42 hitTestBounds, else op 27, else region rects).
   * 0 means the host resolved and nothing claimed (off-screen edge cases).
   */
  readonly hit?: number;
}

const LEGACY_COORD_BITS = 9;
const LEGACY_COORD_MASK = (1 << LEGACY_COORD_BITS) - 1;
const LEGACY_ID_SHIFT = LEGACY_COORD_BITS * 2;
const WIDE_MARKER = 0x80000000;
const WIDE_COORD_BITS = 10;
const WIDE_COORD_MASK = (1 << WIDE_COORD_BITS) - 1;
const WIDE_ID_SHIFT = WIDE_COORD_BITS * 2;
const CANCEL_MARKER = 0x40000000;
const EMPTY: readonly TouchContact[] = Object.freeze([]);

let primarySnapshot: readonly TouchContact[] = EMPTY;
let auxiliarySnapshot: readonly TouchContact[] = EMPTY;
let allSnapshot: readonly TouchContact[] = EMPTY;
let cancelledSnapshot: readonly TouchContact[] = EMPTY;

/**
 * Internal host-frame hook.
 *
 * Existing hosts pack x:9, y:9, id:8 with bit 31 clear. Native viewports
 * wider than 512 use the append-only wide form: bit31=1, x:10, y:10, id:8.
 * Bit 30 carries a terminal CANCEL; at most eight active contacts plus eight
 * cancellations fit in one frame. Existing words keep their byte encoding.
 */
export function __setTouches(
  packed: readonly number[] | undefined,
  hits?: readonly number[],
  surfaces?: readonly number[],
): void {
  cancelledSnapshot = EMPTY;
  if (!packed || packed.length === 0) {
    primarySnapshot = EMPTY;
    auxiliarySnapshot = EMPTY;
    allSnapshot = EMPTY;
    return;
  }
  const all: TouchContact[] = [], cancelled: TouchContact[] = [];
  for (let index = 0; index < Math.min(packed.length, 16); index++) {
    const value = packed[index];
    const output = value & CANCEL_MARKER ? cancelled : all;
    if (output.length >= 8) continue;
    const wide = (value & WIDE_MARKER) !== 0;
    const coordBits = wide ? WIDE_COORD_BITS : LEGACY_COORD_BITS;
    const coordMask = wide ? WIDE_COORD_MASK : LEGACY_COORD_MASK;
    const idShift = wide ? WIDE_ID_SHIFT : LEGACY_ID_SHIFT;
    output.push(Object.freeze({
      surface: surfaces?.[index] === 1 ? "auxiliary" as const : "primary" as const,
      id: (value >>> idShift) & 0xff,
      x: value & coordMask,
      y: (value >>> coordBits) & coordMask,
      hit: hits?.[index],
    }));
  }
  cancelledSnapshot = Object.freeze(cancelled);
  allSnapshot = Object.freeze(all);
  primarySnapshot = Object.freeze(all.filter((contact) => contact.surface === "primary"));
  auxiliarySnapshot = Object.freeze(all.filter((contact) => contact.surface === "auxiliary"));
}

/** Front-panel contacts for the current frame, in logical viewport pixels. */
export function touches(): readonly TouchContact[] {
  return primarySnapshot;
}

/** Auxiliary-output contacts for the current frame, in that surface's pixels. */
export function auxiliaryTouches(): readonly TouchContact[] {
  return auxiliarySnapshot;
}

/** Terminal system cancellations; never exposed as active touches. */
export function __cancelledTouches(): readonly TouchContact[] { return cancelledSnapshot; }

/** Internal gesture stream across every simultaneously presented surface. */
export function __allTouches(): readonly TouchContact[] {
  return allSnapshot;
}

export function __resetTouches(): void {
  cancelledSnapshot = EMPTY;
  primarySnapshot = EMPTY;
  auxiliarySnapshot = EMPTY;
  allSnapshot = EMPTY;
}

/** Test/capture helper matching the native frame wire format. */
export function __packTouch(id: number, x: number, y: number): number {
  return (
    ((id & 0xff) << LEGACY_ID_SHIFT) |
    ((y & LEGACY_COORD_MASK) << LEGACY_COORD_BITS) |
    (x & LEGACY_COORD_MASK)
  ) >>> 0;
}

/**
 * TS-host helper: the host-side per-contact capture table behind frame()
 * argument 4 (Rust twin: pocketjs_core::Ui::touch_hits). Each NEW contact id
 * is resolved ONCE through `query` (the bounds hit, spec op 42) and the node
 * id is carried until the id lifts. Hosts call this right before invoking the
 * guest frame; `undefined` (no contacts) keeps arg 4 absent.
 */
export function createTouchHitFacts(
  query: (x: number, y: number) => number,
): (packed: readonly number[] | undefined) => number[] | undefined {
  const table = new Map<number, number>();
  return (packed) => {
    if (!packed || packed.length === 0) {
      table.clear();
      return undefined;
    }
    const seen = new Set<number>();
    const hits = packed.slice(0, 16).map((value) => {
      if (value & CANCEL_MARKER) return 0;
      const wide = (value & WIDE_MARKER) !== 0;
      const coordBits = wide ? WIDE_COORD_BITS : LEGACY_COORD_BITS;
      const coordMask = wide ? WIDE_COORD_MASK : LEGACY_COORD_MASK;
      const id = (value >>> (coordBits * 2)) & 0xff;
      seen.add(id);
      let hit = table.get(id);
      if (hit === undefined) {
        hit = query(value & coordMask, (value >>> coordBits) & coordMask);
        table.set(id, hit);
      }
      return hit;
    });
    for (const id of [...table.keys()]) if (!seen.has(id)) table.delete(id);
    return hits;
  };
}

/** Test/native helper for logical viewports up to 1024 pixels per axis. */
export function __packTouchWide(id: number, x: number, y: number): number {
  return (
    WIDE_MARKER |
    ((id & 0xff) << WIDE_ID_SHIFT) |
    ((y & WIDE_COORD_MASK) << WIDE_COORD_BITS) |
    (x & WIDE_COORD_MASK)
  ) >>> 0;
}

/** Test/TS-host helper for a terminal cancellation on the touch wire. */
export function __packTouchCancel(id: number): number { return (CANCEL_MARKER | ((id & 255) << LEGACY_ID_SHIFT)) >>> 0; }
