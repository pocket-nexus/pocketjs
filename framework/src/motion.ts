// Fused motion state latched once per frame. A host's motion driver owns
// sampling, calibration and fusion; the runtime receives its newest estimate.
import {
  MOTION_DEFAULT_MIN_QUALITY, MOTION_MIN_QUALITIES, MOTION_VALUES, MotionLevel, MotionQuality, MotionReferenceFrame, motionValueParameters, sampleMotion,
  type MotionMinQualityName, type MotionQualityId, type MotionReferenceFrameId, type MotionState, type MotionValueName,
} from "../../contracts/spec/motion.ts";
export { MOTION_DEFAULT_MIN_QUALITY, MotionLevel, MotionQuality, MotionReferenceFrame, type MotionMinQualityName, type MotionState, type MotionValueName };

type Numbers<T extends readonly unknown[]> = { [K in keyof T]: number };
/** Handler payload: f32 components, then metadata (motionValueParameters order). */
export type MotionPayload<V extends MotionValueName> = [...Numbers<(typeof MOTION_VALUES)[V]["components"]>, ...Numbers<(typeof MOTION_VALUES)[V]["metadata"]>];

let pending: MotionState | null = null;
let current: MotionState | null = null;
const QUALITIES: readonly number[] = Object.values(MotionQuality);
const FRAMES: readonly number[] = Object.values(MotionReferenceFrame);

// Stored numbers carry no zero sign (`+ 0` turns -0 into +0): DevTools tapes
// are JSON, which cannot represent -0, and a recorded estimate must replay as
// the live handlers received it.
function fail(member: string, rule: string): never { throw new Error(`Motion state ${member} must be ${rule}`); }
function f32(value: unknown, member: string): number {
  const rounded = typeof value === "number" ? Math.fround(value) + 0 : NaN;
  return Number.isFinite(rounded) ? rounded : fail(member, "a finite f32");
}
function quality(value: unknown, member: string): MotionQualityId {
  return QUALITIES.includes(value as number) ? (value as number) + 0 as MotionQualityId : fail(`${member}.quality`, `a MotionQuality id (${QUALITIES.join(", ")})`);
}
function referenceFrame(value: unknown, member: string): MotionReferenceFrameId {
  return FRAMES.includes(value as number) ? (value as number) + 0 as MotionReferenceFrameId : fail(`${member}.referenceFrame`, `a MotionReferenceFrame id (${FRAMES.join(", ")})`);
}
function epoch(value: unknown, member: string): number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffffffff ? (value as number) + 0 : fail(`${member}.epoch`, "a u32");
}
function components<N extends number>(value: unknown, member: string, length: N): number[] {
  if (!Array.isArray(value) || value.length !== length) fail(`${member}.value`, `${length} numbers`);
  // Array.from visits holes, which map would skip, so a sparse array fails as undefined components.
  return Array.from(value, (component, index) => f32(component, `${member}.value[${index}]`));
}
function estimate(state: MotionState, member: keyof MotionState): Record<string, unknown> | undefined {
  const value = state[member] as unknown;
  if (value == null) return undefined;
  return typeof value === "object" ? value as Record<string, unknown> : fail(member, "an estimate object");
}

/**
 * A validated deep copy with every f32 member rounded to f32, as a native
 * driver stores it, and every zero unsigned. Unknown members are dropped.
 */
export function __copyMotionState(state: MotionState): MotionState {
  if (state === null || typeof state !== "object") throw new Error("A motion state must be an object");
  if (!Number.isSafeInteger(state.timestamp) || state.timestamp < 0) fail("timestamp", "non-negative integer microseconds");
  const out: MotionState = { timestamp: state.timestamp + 0 };
  for (const member of ["gravityDirection", "linearAcceleration", "rotationRate"] as const) {
    const value = estimate(state, member);
    if (value) out[member] = { value: components(value.value, member, 3) as [number, number, number], quality: quality(value.quality, member) };
  }
  for (const member of ["inclination", "screenRotation"] as const) {
    const value = estimate(state, member);
    if (value) out[member] = { value: f32(value.value, `${member}.value`), quality: quality(value.quality, member) };
  }
  const tilt = estimate(state, "tilt");
  if (tilt) out.tilt = { value: components(tilt.value, "tilt", 2) as [number, number], quality: quality(tilt.quality, "tilt") };
  const orientation = estimate(state, "orientation");
  if (orientation) {
    out.orientation = { value: components(orientation.value, "orientation", 4) as [number, number, number, number], quality: quality(orientation.quality, "orientation"),
      referenceFrame: referenceFrame(orientation.referenceFrame, "orientation"), epoch: epoch(orientation.epoch, "orientation") };
  }
  const angles = estimate(state, "angles");
  if (angles) {
    out.angles = { value: components(angles.value, "angles", 3) as [number, number, number], quality: quality(angles.quality, "angles"),
      referenceFrame: referenceFrame(angles.referenceFrame, "angles"), epoch: epoch(angles.epoch, "angles") };
  }
  const heading = estimate(state, "heading");
  if (heading) out.heading = { value: f32(heading.value, "heading.value"), accuracy: f32(heading.accuracy, "heading.accuracy"),
    quality: quality(heading.quality, "heading"), referenceFrame: referenceFrame(heading.referenceFrame, "heading") };
  return out;
}

/** A host can queue its driver's newest estimate before the next frame; a newer one replaces it. */
export function feedMotionState(state: MotionState): void { pending = __copyMotionState(state); }

/** Consume the queued estimate. An explicit frame argument, including null (no estimate), replaces the queue. */
export function __takeMotionState(state?: MotionState | null): MotionState | null {
  const result = state === undefined ? pending : state === null ? null : __copyMotionState(state);
  pending = null;
  return result;
}
export function __beginMotionFrame(state?: MotionState | null): void { current = __takeMotionState(state); }
export function __motionState(): MotionState | null { return current; }
export function __endMotionFrame(): void { current = null; }
export function __resetMotionInput(): void { pending = current = null; }

/** Resolve one subscription; the reader returns this frame's payload, or undefined when the value is absent or below minQuality. */
export function __motionReader(value: MotionValueName, minQuality: MotionMinQualityName = MOTION_DEFAULT_MIN_QUALITY): () => number[] | undefined {
  if (!Object.hasOwn(MOTION_VALUES, value)) throw new Error(`Unknown motion value ${value}`);
  if (!Object.hasOwn(MOTION_MIN_QUALITIES, minQuality)) throw new Error(`Unknown motion minQuality ${minQuality}`);
  const threshold = MOTION_MIN_QUALITIES[minQuality];
  const fields = motionValueParameters(value).map(parameter => parameter.field);
  return () => {
    const sample = current ? sampleMotion(current, value, threshold) : undefined;
    return sample && fields.map(field => field.startsWith("component") ? sample.components[Number(field.slice(9))]! : sample[field as "quality" | "referenceFrame" | "epoch" | "timestamp"]);
  };
}
