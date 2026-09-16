// Lifecycle-facing public API.

export {
  pushButtonHandlerBlock,
  onFrame,
  onButtonPress,
  createSpriteAnimation,
  analogX,
  analogY,
  analogRaw,
  rightAnalogRaw,
  rightAnalogX,
  rightAnalogY,
  type ButtonPressOptions,
  type SpriteAnimationOptions,
} from "./frame.ts";
export { onMount, onCleanup } from "./lifecycle-solid-aot.ts";
