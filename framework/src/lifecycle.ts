// Lifecycle-facing public API.

export {
  pushButtonHandlerBlock,
  onFrame,
  onButtonPress,
  onAxisDelta,
  onMotion,
  createSpriteAnimation,
  analogX,
  analogY,
  analogRaw,
  rightAnalogRaw,
  rightAnalogX,
  rightAnalogY,
  type ButtonPressOptions,
  type AxisDeltaOptions,
  type MotionOptions,
  type SpriteAnimationOptions,
} from "./frame.ts";
export { onMount, onCleanup } from "./lifecycle-solid-aot.ts";
