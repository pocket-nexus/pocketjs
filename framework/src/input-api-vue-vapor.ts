// Vue lifecycle owns subscriptions; the host-facing delta contract is shared.
export * from "./input-api.ts";
export { RelativeAxis, RelativeAxisUnits, feedAxisDelta, type RelativeAxisId, type AxisDelta } from "./relative-axis.ts";
export { MotionLevel, MotionQuality, MotionReferenceFrame, feedMotionState, type MotionMinQualityName, type MotionPayload, type MotionState, type MotionValueName } from "./motion.ts";
export { onAxisDelta, onMotion, type AxisDeltaOptions, type MotionOptions } from "./frame-vue-vapor.ts";
