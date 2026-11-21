/** Motion handler payloads, derived from the fused motion contract. */
import { MOTION_DEFAULT_MIN_QUALITY, MOTION_MIN_QUALITIES, MOTION_VALUES, motionValueParameters, type MotionValueName } from "../../contracts/spec/motion.ts";
import type { AotEvent } from "./aot-ir.ts";

export { MOTION_DEFAULT_MIN_QUALITY, MOTION_MIN_QUALITIES, MOTION_VALUES };

export function motionEvent(name: MotionValueName): AotEvent {
  return { name: "update", parameters: motionValueParameters(name).map(parameter => ({ name: parameter.name, type: { kind: "number", name: parameter.type } as AotEvent["parameters"][number]["type"] })) };
}
