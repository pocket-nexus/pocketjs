// Fused motion state: the contract between a native motion driver and an app.
//
// The native driver owns sampling, calibration and sensor fusion and publishes
// one MotionState per estimate, including the angle conveniences it derives
// from its core members. Applications receive fused state only, never
// accelerometer, gyroscope or magnetometer readings, and the runtime reads the
// state without computing on it.
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
export interface MotionPairEstimate { value: readonly [number, number]; quality: MotionQualityId }
export interface MotionAnglesEstimate {
  value: readonly [number, number, number];
  quality: MotionQualityId;
  referenceFrame: MotionReferenceFrameId;
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
  /**
   * Derived from gravityDirection: the clockwise rotation in degrees,
   * (-180, 180], that keeps content upright. The driver marks it unreliable
   * while the screen lies near horizontal, where the direction is undefined.
   */
  screenRotation?: MotionScalarEstimate;
  /** Derived from gravityDirection: W3C DeviceOrientation beta and gamma in degrees. */
  tilt?: MotionPairEstimate;
  /**
   * Derived from orientation: W3C DeviceOrientation alpha, beta and gamma
   * (intrinsic Z-X'-Y'') in degrees, in the orientation's frame and epoch.
   */
  angles?: MotionAnglesEstimate;
}

type Metadata = "quality" | "referenceFrame" | "epoch" | "timestamp";
interface MotionValueSpec {
  readonly id: number;
  readonly level: MotionLevelName;
  /** The core member a driver derives this convenience value from. */
  readonly derivedFrom?: "gravityDirection" | "orientation";
  readonly components: readonly string[];
  readonly metadata: readonly Metadata[];
}

/**
 * Values an app can subscribe to, one per MotionState member. Derived values
 * are conveniences the driver computes from a core member.
 */
export const MOTION_VALUES = {
  gravityDirection: { id: 0, level: "gravity", components: ["x", "y", "z"], metadata: ["quality", "timestamp"] },
  inclination: { id: 1, level: "gravity", components: ["degrees"], metadata: ["quality", "timestamp"] },
  linearAcceleration: { id: 2, level: "inertial", components: ["x", "y", "z"], metadata: ["quality", "timestamp"] },
  rotationRate: { id: 3, level: "inertial", components: ["x", "y", "z"], metadata: ["quality", "timestamp"] },
  orientation: { id: 4, level: "inertial", components: ["w", "x", "y", "z"], metadata: ["quality", "referenceFrame", "epoch", "timestamp"] },
  heading: { id: 5, level: "geomagnetic", components: ["degrees", "accuracy"], metadata: ["quality", "referenceFrame", "timestamp"] },
  /** CSS rotation (clockwise, degrees in (-180, 180]) that keeps content upright. */
  screenRotation: { id: 6, level: "gravity", derivedFrom: "gravityDirection", components: ["degrees"], metadata: ["quality", "timestamp"] },
  /** W3C DeviceOrientation beta and gamma, in degrees. */
  tilt: { id: 7, level: "gravity", derivedFrom: "gravityDirection", components: ["beta", "gamma"], metadata: ["quality", "timestamp"] },
  /** W3C DeviceOrientation alpha, beta and gamma (intrinsic Z-X'-Y''), in degrees. */
  angles: { id: 8, level: "inertial", derivedFrom: "orientation", components: ["alpha", "beta", "gamma"], metadata: ["quality", "referenceFrame", "epoch", "timestamp"] },
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

export interface MotionSample {
  components: number[];
  quality: MotionQualityId;
  referenceFrame: MotionReferenceFrameId;
  epoch: number;
  timestamp: number;
}

/** One value as a handler sees it, or undefined when it is absent or below `minQuality`. */
export function sampleMotion(state: MotionState, name: MotionValueName, minQuality: number = MotionQuality.Unreliable): MotionSample | undefined {
  const at = (components: number[], quality: MotionQualityId, referenceFrame: MotionReferenceFrameId = MotionReferenceFrame.Device, epoch = 0): MotionSample | undefined =>
    quality === MotionQuality.Unavailable || quality < minQuality ? undefined : { components, quality, referenceFrame, epoch, timestamp: state.timestamp };
  switch (name) {
    case "gravityDirection": case "linearAcceleration": case "rotationRate": case "tilt": {
      const estimate = state[name];
      return estimate && at([...estimate.value], estimate.quality);
    }
    case "inclination": case "screenRotation": {
      const estimate = state[name];
      return estimate && at([estimate.value], estimate.quality);
    }
    case "orientation": case "angles": {
      const estimate = state[name];
      return estimate && at([...estimate.value], estimate.quality, estimate.referenceFrame, estimate.epoch);
    }
    case "heading": return state.heading && at([state.heading.value, state.heading.accuracy], state.heading.quality, state.heading.referenceFrame);
  }
}
