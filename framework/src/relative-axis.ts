// Hardware-neutral relative input latched once per frame; deltas are millidegrees.
import { RelativeAxis, RelativeAxisUnits, type RelativeAxisId } from "../../contracts/spec/microts.ts";
import type { i32 } from "./numeric-microts.ts";
export { RelativeAxis, RelativeAxisUnits, type RelativeAxisId };
export interface AxisDelta { axis: RelativeAxisId; delta: i32 }

const pending = [0, 0];
const current = [0, 0];
export const EMPTY_AXIS_DELTAS: readonly AxisDelta[] = Object.freeze([]);

function validate(axis: number, delta: number): asserts axis is RelativeAxisId {
  if (axis !== RelativeAxis.Primary && axis !== RelativeAxis.Secondary) throw new Error(`Unknown relative axis ${axis}`);
  if (!Number.isInteger(delta) || delta < -2147483648 || delta > 2147483647) throw new Error("Relative-axis deltas must be signed i32 millidegrees");
}
function sum(a: number, b: number): number { return Math.min(2147483647, Math.max(-2147483648, a + b)); }

/** A host can queue motion before its next frame instead of supplying frame deltas. */
export function feedAxisDelta(axis: RelativeAxisId, delta: i32): void {
  validate(axis, delta);
  pending[axis] = sum(pending[axis]!, delta);
}

/** Consume a host sample before recording it. Explicit input isolates replays. */
export function __takeAxisDeltas(deltas?: readonly AxisDelta[]): readonly AxisDelta[] {
  if (deltas !== undefined) {
    for (const { axis, delta } of deltas) validate(axis, delta);
    pending[0] = pending[1] = 0;
    return deltas;
  }
  const result = pending.some(delta => delta !== 0)
    ? pending.flatMap((delta, axis) => delta === 0 ? [] : [{ axis: axis as RelativeAxisId, delta }])
    : EMPTY_AXIS_DELTAS;
  pending[0] = pending[1] = 0;
  return result;
}
/** An explicit frame sample, including [], replaces queued motion for replay. */
export function __beginAxisFrame(deltas?: readonly AxisDelta[]): void {
  current[0] = current[1] = 0;
  for (const { axis, delta } of __takeAxisDeltas(deltas)) {
    current[axis] = sum(current[axis]!, delta);
  }
}
export function __axisDelta(axis: RelativeAxisId): i32 { return current[axis]!; }
export function __endAxisFrame(): void { current[0] = current[1] = 0; }
export function __resetAxisInput(): void { pending[0] = pending[1] = current[0] = current[1] = 0; }
