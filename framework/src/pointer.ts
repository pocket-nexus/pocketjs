// Desktop pointer facts: the frame's pointer position, with or without a
// button down (capability input.pointer), and its wheel and trackpad
// scrolling (capability input.scroll), as the host's pointer driver
// reported them.
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
// Scrolling follows the build's input.scroll feature (hasFeature): true
// when the app lists input.scroll in app.features and the host contract
// provides it. Without it onScroll keeps no handler and the frame's scroll
// is not latched; the frame argument still carries it.
//
// Coordinates are logical px of the pointer's surface, unclamped: a pointer
// held past the window edge reports positions outside the viewport. Scroll
// deltas are logical px; positive dy moves the view toward the content's
// end, as WheelEvent.deltaY.

import { hasFeature } from "./platform.ts";
import { peekOps } from "./host.ts";

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

/** The build's input.scroll feature: whether onScroll delivers. */
const scrolls: boolean = hasFeature("input.scroll");
/** The build's input.pointer feature: whether the pointer drives `hover:`. */
const hovers: boolean = hasFeature("input.pointer");
let hovered = 0;

/** The node under the pointer takes `hover:` (spec op setHover): the
 *  topmost painted node at the frame's pointer, through hitTest, once per
 *  frame, so a panel that opens under a still pointer is hovered too. */
function updateHover(): void {
  if (!hovers) return;
  const ops = peekOps();
  if (!ops?.setHover || !ops.hitTest) return;
  const id = current !== null && current.surface === "primary" ? ops.hitTest(current.x, current.y) : 0;
  if (id === hovered) return;
  hovered = id;
  ops.setHover(id);
}
const ignore = (): void => {};

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
    updateHover();
    return;
  }
  const surface = record.surface === 1 ? "auxiliary" as const : "primary" as const;
  current = Object.freeze({ surface, x: record.x, y: record.y, buttons: (record.buttons ?? 0) >>> 0 });
  updateHover();
  if (!scrolls) return;
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
  hovered = 0;
}

/** The node's settled layout box in logical px (spec op layoutOf): x and y
 *  relative to its parent, its width and height; null for a host without
 *  the op or a node that is gone. A query for cold paths: the extent a
 *  scroll view clamps to, where a popover opens. */
export function nodeLayout(node: { readonly id: number }): { x: number; y: number; w: number; h: number } | null {
  const result = peekOps()?.layoutOf?.(node.id);
  if (!result) return null;
  // Guest bindings hand bytes over as an ArrayBuffer (the browser realm) or a Uint8Array.
  const bytes = result instanceof Uint8Array ? result : new Uint8Array(result);
  if (bytes.byteLength < 16) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { x: view.getFloat32(0, true), y: view.getFloat32(4, true), w: view.getFloat32(8, true), h: view.getFloat32(12, true) };
}

/** The frame's pointer, or null when the host reported none: no pointer
 *  device, the pointer outside the window, or a DevTools replay. */
export function pointer(): PointerState | null {
  return current;
}

/** Receive each frame's scrolling until the returned function runs. A
 *  handler that returns true consumes the delta. A build without the
 *  input.scroll feature keeps no handler, and the returned function does
 *  nothing. */
export function onScroll(handler: ScrollHandler): () => void {
  if (!scrolls) return ignore;
  handlers.push(handler);
  return () => {
    const at = handlers.lastIndexOf(handler);
    if (at >= 0) handlers.splice(at, 1);
  };
}
