// vapor/host/input.ts — the Pocket Vapor input contract.
//
// One module, two lives. Under the oracle (real Vue Vapor on a JS host) this
// file executes: handlers register here and the test harness feeds button
// edges/repeats through the dispatch helpers. Under the Pocket Vapor compiler
// the module is never executed — the compiler recognizes button and
// relative-axis registrations from this path and emits hooks fed by each
// target runtime.
//
// Button values ARE the shared Pocket pad ABI. RelativeAxis values are the
// hardware-neutral ABI for incremental controls: a Playdate crank, rotary
// encoder, or wheel host converts physical motion into signed canonical
// units. Apps never depend on GPIO pulses or a specific device, and apps
// choose their own detents and sensitivity.
//
// Playdate directly exposes A/B/Right/Left/Up/Down plus RelativeAxis.Primary
// through its crank. It rejects unsupported demands at compile time; it
// never invents chords for missing physical inputs.

export const Button = {
  A: 0,
  B: 1,
  Select: 2,
  Start: 3,
  Right: 4,
  Left: 5,
  Up: 6,
  Down: 7,
  R: 8,
  L: 9,
} as const;

export type ButtonId = (typeof Button)[keyof typeof Button];

type ButtonHandler = (button: number) => void;

const handlers: ButtonHandler[] = [];
const repeatHandlers: ButtonHandler[] = [];

export const RelativeAxis = {
  Primary: 0,
  Secondary: 1,
} as const;

/**
 * Canonical rotary-axis resolution. Hosts preserve signed motion in
 * millidegrees; applications own detents, acceleration, and interaction
 * thresholds.
 */
export const RelativeAxisUnits = {
  PerDegree: 1_000,
  PerTurn: 360_000,
} as const;

export type RelativeAxisId = (typeof RelativeAxis)[keyof typeof RelativeAxis];
type AxisDeltaHandler = (delta: number) => void;

const axisHandlers = new Map<RelativeAxisId, AxisDeltaHandler[]>();

function assertRelativeAxis(axis: number): asserts axis is RelativeAxisId {
  if (axis !== RelativeAxis.Primary && axis !== RelativeAxis.Secondary) {
    throw new Error(`unknown relative axis ${axis}`);
  }
}

/** Register a handler called once per button press edge (per frame). */
export function onButton(handler: ButtonHandler): void {
  handlers.push(handler);
}

/**
 * Register for normalized D-pad repeat events after the initial press edge.
 *
 * The GBA host currently supplies this capability: after a short hold delay,
 * it emits repeats at a fixed frame cadence. Applications decide which modes
 * consume them, so a world can keep moving without making menus auto-repeat.
 */
export function onButtonRepeat(handler: ButtonHandler): void {
  repeatHandlers.push(handler);
}

/**
 * Register a handler for signed, relative movement on one logical axis.
 *
 * `delta` is a non-zero integer in canonical axis units. Rotary adapters use
 * millidegrees (`RelativeAxisUnits.PerDegree`) and preserve sub-unit motion
 * between frames. Applications, not hosts, choose detents and sensitivity.
 */
export function onAxisDelta(axis: RelativeAxisId, handler: AxisDeltaHandler): void {
  assertRelativeAxis(axis);
  const registered = axisHandlers.get(axis);
  if (registered) registered.push(handler);
  else axisHandlers.set(axis, [handler]);
}

/** Oracle-only: deliver one button press edge to every registered handler. */
export function __dispatchButton(button: number): void {
  for (const handler of handlers) handler(button);
}

/** Oracle-only: deliver one normalized held-D-pad repeat event. */
export function __dispatchButtonRepeat(button: number): void {
  for (const handler of repeatHandlers) handler(button);
}

/** Oracle-only: deliver one non-zero, integral relative-axis delta. */
export function __dispatchAxisDelta(axis: RelativeAxisId, delta: number): void {
  assertRelativeAxis(axis);
  if (!Number.isInteger(delta) || delta === 0) {
    throw new Error(`relative axis delta must be a non-zero integer, got ${delta}`);
  }
  for (const handler of axisHandlers.get(axis) ?? []) handler(delta);
}

/** Oracle-only: drop all registered input handlers (fresh boot between tests). */
export function __resetButtons(): void {
  handlers.length = 0;
  repeatHandlers.length = 0;
  axisHandlers.clear();
}
