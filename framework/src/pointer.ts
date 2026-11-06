// Desktop pointer facts (capability input.pointer): the frame's pointer
// position, with or without a button down, and its wheel and trackpad
// scrolling, as the host's pointer driver reported them.
//
// The guest receives them as the tenth frame argument and this module
// latches them for the frame. pointer() reads the position, so an app can
// tell hover from focus: hitNode(x, y) names the node under it. A pressed
// primary button also reaches the app as a touch contact (touch.ts), which
// is what gestures and onPress follow. Handlers registered with onScroll()
// run at the start of the frame, newest first, after text handlers and
// before button handlers; a handler that returns true keeps the delta from
// the handlers registered before it, so a nested scroll view registered
// after its parent takes the delta first.
//
// Coordinates are logical px of the pointer's surface, unclamped: a pointer
// held past the window edge reports positions outside the viewport. Scroll
// deltas are logical px; positive dy moves the view toward the content's
// end, as WheelEvent.deltaY.

/** The frame's pointer. */
export interface PointerState {
  /** UI output whose logical coordinate space contains the pointer. */
  readonly surface: "primary" | "auxiliary";
  readonly x: number;
  readonly y: number;
  /** Held buttons; bit 0 is the primary button. */
  readonly buttons: number;
}

/** One frame's wheel and trackpad scrolling at the pointer's position. */
export interface ScrollEvent {
  readonly surface: "primary" | "auxiliary";
  /** Pointer position, logical px. */
  readonly x: number;
  readonly y: number;
  /** Logical px; positive dx scrolls toward the right end, positive dy
   *  toward the bottom (the content moves up). */
  readonly dx: number;
  readonly dy: number;
}

/** The pointer as a guest binding hands it over (frame argument 10). */
export interface PointerRecord {
  surface?: number;
  x: number;
  y: number;
  buttons?: number;
  scrollX?: number;
  scrollY?: number;
}

export type ScrollHandler = (event: ScrollEvent) => boolean | void;

const handlers: ScrollHandler[] = [];
let current: PointerState | null = null;
let pending: ScrollEvent | null = null;

const finite = (value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value);

/** Latch the frame's pointer (the tenth frame argument); null or absent
 *  means the host reported none this frame. */
export function __setPointer(record: PointerRecord | null | undefined): void {
  pending = null;
  if (!record || !finite(record.x) || !finite(record.y)) {
    current = null;
    return;
  }
  const surface = record.surface === 1 ? "auxiliary" as const : "primary" as const;
  current = Object.freeze({ surface, x: record.x, y: record.y, buttons: (record.buttons ?? 0) >>> 0 });
  const dx = finite(record.scrollX) ? record.scrollX : 0;
  const dy = finite(record.scrollY) ? record.scrollY : 0;
  if (dx !== 0 || dy !== 0) pending = Object.freeze({ surface, x: record.x, y: record.y, dx, dy });
}

/** Run the frame's scroll through the handlers, newest first. */
export function __dispatchScroll(): void {
  const event = pending;
  if (event === null) return;
  pending = null;
  for (let i = handlers.length - 1; i >= 0; i--) {
    if (handlers[i]!(event) === true) break;
  }
}

export function __resetPointer(): void {
  handlers.length = 0;
  current = null;
  pending = null;
}

/** The frame's pointer, or null when the host reported none: no pointer
 *  device, the pointer outside the window, or a DevTools replay. */
export function pointer(): PointerState | null {
  return current;
}

/** Receive each frame's scrolling until the returned function runs. A
 *  handler that returns true consumes the delta. */
export function onScroll(handler: ScrollHandler): () => void {
  handlers.push(handler);
  return () => {
    const at = handlers.lastIndexOf(handler);
    if (at >= 0) handlers.splice(at, 1);
  };
}
