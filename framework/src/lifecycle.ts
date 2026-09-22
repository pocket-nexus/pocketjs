// Lifecycle-facing public API.

export {
  pushButtonHandlerBlock,
  onFrame,
  onButtonPress,
  onAxisDelta,
  createSpriteAnimation,
  analogX,
  analogY,
  analogRaw,
  rightAnalogRaw,
  rightAnalogX,
  rightAnalogY,
  type ButtonPressOptions,
  type AxisDeltaOptions,
  type SpriteAnimationOptions,
} from "./frame.ts";
export { onMount, onCleanup } from "./lifecycle-solid-aot.ts";
