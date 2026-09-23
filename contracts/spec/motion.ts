// Fused motion state: the contract between a native motion driver and an app.
//
// The native driver owns sampling, calibration and sensor fusion and publishes
// one MotionState per estimate. Applications receive fused state only, never
// accelerometer, gyroscope or magnetometer readings.
//
// Vectors use the device frame of W3C DeviceMotionEvent and Android: +x toward
// the right edge, +y toward the top edge, +z out of the screen. World frames
// have +z up, opposite gravity.

/** Fusion depth a driver provides; each level adds state to the previous one. */
export const MotionLevel = { Gravity: 1, Inertial: 2, Geomagnetic: 3 } as const;
export type MotionLevelId = (typeof MotionLevel)[keyof typeof MotionLevel];
export const MOTION_LEVELS = { gravity: MotionLevel.Gravity, inertial: MotionLevel.Inertial, geomagnetic: MotionLevel.Geomagnetic } as const;
export type MotionLevelName = keyof typeof MOTION_LEVELS;

/** Trust in one estimate. `Unavailable` means the value is absent and zeroed. */
export const MotionQuality = { Unavailable: 0, Unreliable: 1, Low: 2, Medium: 3, High: 4 } as const;
export type MotionQualityId = (typeof MotionQuality)[keyof typeof MotionQuality];
/** Thresholds an app may require; an unavailable value never reaches a handler. */
export const MOTION_MIN_QUALITIES = { unreliable: MotionQuality.Unreliable, low: MotionQuality.Low, medium: MotionQuality.Medium, high: MotionQuality.High } as const;
export type MotionMinQualityName = keyof typeof MOTION_MIN_QUALITIES;
export const MOTION_DEFAULT_MIN_QUALITY: MotionMinQualityName = "low";

/**
 * Frame an estimate is expressed in. `Local` has +z up and a horizontal origin
 * fixed when the driver last aligned; `MagneticNorth` and `TrueNorth` are
 * east-north-up frames.
 */
export const MotionReferenceFrame = { Device: 0, Local: 1, MagneticNorth: 2, TrueNorth: 3 } as const;
export type MotionReferenceFrameId = (typeof MotionReferenceFrame)[keyof typeof MotionReferenceFrame];

export interface MotionVectorEstimate { value: readonly [number, number, number]; quality: MotionQualityId }
export interface MotionScalarEstimate { value: number; quality: MotionQualityId }
export interface MotionOrientationEstimate {
  /** Unit quaternion (w, x, y, z) rotating device-frame vectors into `referenceFrame`. */
  value: readonly [number, number, number, number];
  quality: MotionQualityId;
  referenceFrame: MotionReferenceFrameId;
  /** Increments whenever the driver re-establishes the reference frame. */
  epoch: number;
}
export interface MotionHeadingEstimate {
  /** Degrees clockwise from north, [0, 360). */
  value: number;
  /** Estimated error in degrees; -1 when the driver has no estimate. */
  accuracy: number;
  quality: MotionQualityId;
  referenceFrame: MotionReferenceFrameId;
}

/**
 * One fused estimate. Omitted members are unavailable. All numbers except
 * `timestamp` and `epoch` are f32 values.
 */
export interface MotionState {
  /** u64 microseconds on the driver's monotonic clock: newest sample in the estimate. */
  timestamp: number;
  /** Unit vector toward the ground, device frame. Gravity level. */
  gravityDirection?: MotionVectorEstimate;
  /** Degrees between the screen normal and up: 0 face up, 90 upright, 180 face down. */
  inclination?: MotionScalarEstimate;
  /** Acceleration without gravity in m/s², device frame. Inertial level. */
  linearAcceleration?: MotionVectorEstimate;
  /** Bias-corrected angular velocity in degrees per second, right-hand rule, device frame. */
  rotationRate?: MotionVectorEstimate;
  /** Local frame at the inertial level; a north frame at the geomagnetic level. */
  orientation?: MotionOrientationEstimate;
  /**
   * Heading of whichever of +y (the top edge) and -z (the back of the screen)
   * lies closer to the horizontal plane, projected onto it. Geomagnetic level.
   */
  heading?: MotionHeadingEstimate;
}

type Metadata = "quality" | "referenceFrame" | "epoch" | "timestamp";
interface MotionValueSpec {
  readonly id: number;
  readonly level: MotionLevelName;
  /** Derived values are computed by the runtime from a core member. */
  readonly source?: "gravityDirection" | "orientation";
  readonly components: readonly string[];
  readonly metadata: readonly Metadata[];
}

/**
 * Values an app can subscribe to. Core values mirror MotionState members;
 * derived values are conveniences the runtime computes from them.
 */
export const MOTION_VALUES = {
  gravityDirection: { id: 0, level: "gravity", components: ["x", "y", "z"], metadata: ["quality", "timestamp"] },
  inclination: { id: 1, level: "gravity", components: ["degrees"], metadata: ["quality", "timestamp"] },
  linearAcceleration: { id: 2, level: "inertial", components: ["x", "y", "z"], metadata: ["quality", "timestamp"] },
  rotationRate: { id: 3, level: "inertial", components: ["x", "y", "z"], metadata: ["quality", "timestamp"] },
  orientation: { id: 4, level: "inertial", components: ["w", "x", "y", "z"], metadata: ["quality", "referenceFrame", "epoch", "timestamp"] },
  heading: { id: 5, level: "geomagnetic", components: ["degrees", "accuracy"], metadata: ["quality", "referenceFrame", "timestamp"] },
  /** CSS rotation (clockwise, degrees in (-180, 180]) that keeps content upright. */
  screenRotation: { id: 6, level: "gravity", source: "gravityDirection", components: ["degrees"], metadata: ["quality", "timestamp"] },
  /** W3C DeviceOrientation beta and gamma, in degrees. */
  tilt: { id: 7, level: "gravity", source: "gravityDirection", components: ["beta", "gamma"], metadata: ["quality", "timestamp"] },
  /** W3C DeviceOrientation alpha, beta and gamma (intrinsic Z-X'-Y''), in degrees. */
  angles: { id: 8, level: "inertial", source: "orientation", components: ["alpha", "beta", "gamma"], metadata: ["quality", "referenceFrame", "epoch", "timestamp"] },
} as const satisfies Record<string, MotionValueSpec>;
export type MotionValueName = keyof typeof MOTION_VALUES;
export const MOTION_METADATA_TYPES = { quality: "u8", referenceFrame: "u8", epoch: "u32", timestamp: "u64" } as const;

/** Handler parameters: f32 components, then metadata in declaration order. */
export function motionValueParameters(name: MotionValueName): { name: string; type: string; field: string }[] {
  const spec: MotionValueSpec = MOTION_VALUES[name];
  return [
    ...spec.components.map((component, index) => ({ name: component, type: "f32", field: `component${index}` })),
    ...spec.metadata.map(field => ({ name: field, type: MOTION_METADATA_TYPES[field], field })),
  ];
}

/** Below this screen-plane gravity component (sin 10 degrees) screenRotation is unreliable. */
export const SCREEN_ROTATION_MIN_PLANAR = 0.17364817766693033;

export interface MotionSample {
  components: number[];
  quality: MotionQualityId;
  referenceFrame: MotionReferenceFrameId;
  epoch: number;
  timestamp: number;
}

const f32 = Math.fround;
const DEGREES = 180 / Math.PI;
const lower = (quality: MotionQualityId, bound: MotionQualityId) => Math.min(quality, bound) as MotionQualityId;

function screenRotation(g: readonly number[]): number {
  return f32(Math.atan2(-g[0]!, -g[1]!) * DEGREES);
}

function tilt(g: readonly number[]): [number, number] {
  const [ux, uy, uz] = [-g[0]!, -g[1]!, -g[2]!];
  const facing = uz >= 0 ? 1 : -1;
  return [f32(Math.atan2(uy, facing * Math.sqrt(ux * ux + uz * uz)) * DEGREES), f32(Math.atan2(-facing * ux, facing * uz) * DEGREES)];
}

/** The W3C DeviceOrientation worked example over the device-to-world matrix. */
function angles(q: readonly number[]): [number, number, number] {
  const [w, x, y, z] = q as [number, number, number, number];
  const r12 = 2 * (x * y - w * z), r22 = 1 - 2 * (x * x + z * z), r32 = 2 * (y * z + w * x);
  const r31 = 2 * (x * z - w * y), r33 = 1 - 2 * (x * x + y * y), r11 = 1 - 2 * (y * y + z * z), r21 = 2 * (x * y + w * z);
  const asin = (value: number) => Math.asin(Math.min(1, Math.max(-1, value)));
  const flip = (beta: number) => beta + (beta >= 0 ? -Math.PI : Math.PI);
  let alpha: number, beta: number, gamma: number;
  if (r33 > 0) { alpha = Math.atan2(-r12, r22); beta = asin(r32); gamma = Math.atan2(-r31, r33); }
  else if (r33 < 0) { alpha = Math.atan2(r12, -r22); beta = flip(-asin(r32)); gamma = Math.atan2(r31, -r33); }
  else if (r31 > 0) { alpha = Math.atan2(-r12, r22); beta = asin(r32); gamma = -Math.PI / 2; }
  else if (r31 < 0) { alpha = Math.atan2(r12, -r22); beta = flip(-asin(r32)); gamma = -Math.PI / 2; }
  else { alpha = Math.atan2(r21, r11); beta = r32 > 0 ? Math.PI / 2 : -Math.PI / 2; gamma = 0; }
  if (alpha < 0) alpha += 2 * Math.PI;
  return [f32(alpha * DEGREES), f32(beta * DEGREES), f32(gamma * DEGREES)];
}

/**
 * One value of a state as a handler sees it, or undefined when it is
 * unavailable or below `minQuality`. Derived values inherit their source's
 * metadata; engines compute them in f64 and round once to f32.
 */
export function sampleMotion(state: MotionState, name: MotionValueName, minQuality: number = MotionQuality.Unreliable): MotionSample | undefined {
  const at = (components: number[], quality: MotionQualityId, referenceFrame: MotionReferenceFrameId = MotionReferenceFrame.Device, epoch = 0): MotionSample | undefined =>
    quality === MotionQuality.Unavailable || quality < minQuality ? undefined : { components, quality, referenceFrame, epoch, timestamp: state.timestamp };
  const gravity = state.gravityDirection, orientation = state.orientation;
  switch (name) {
    case "gravityDirection": case "linearAcceleration": case "rotationRate": {
      const estimate = state[name];
      return estimate && at([...estimate.value], estimate.quality);
    }
    case "inclination": return state.inclination && at([state.inclination.value], state.inclination.quality);
    case "orientation": return orientation && at([...orientation.value], orientation.quality, orientation.referenceFrame, orientation.epoch);
    case "heading": return state.heading && at([state.heading.value, state.heading.accuracy], state.heading.quality, state.heading.referenceFrame);
    case "screenRotation": {
      if (!gravity) return undefined;
      const [gx, gy] = gravity.value, planar = Math.sqrt(gx * gx + gy * gy);
      return at([screenRotation(gravity.value)], planar < SCREEN_ROTATION_MIN_PLANAR ? lower(gravity.quality, MotionQuality.Unreliable) : gravity.quality);
    }
    case "tilt": return gravity && at(tilt(gravity.value), gravity.quality);
    case "angles": return orientation && at(angles(orientation.value), orientation.quality, orientation.referenceFrame, orientation.epoch);
  }
}
