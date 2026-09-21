// Vue lifecycle owns subscriptions; the host-facing delta contract is shared.
export * from "./input-api.ts";
export { RelativeAxis, RelativeAxisUnits, feedAxisDelta, type RelativeAxisId, type AxisDelta } from "./relative-axis.ts";
export { onAxisDelta, type AxisDeltaOptions } from "./frame-vue-vapor.ts";
