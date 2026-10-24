// Animation public API.

export { createCaretBlink, type CaretBlinkOptions } from "./caret-blink.ts";
export { createNodeRef, type NodeSlot } from "./model-node-ref.ts";

export {
  animate,
  animationClass,
  spring,
  cancelAnim,
  jump,
  createJumpBatch,
  type AnimateOptions,
  type EasingName,
  type JumpBatch,
} from "./anim.ts";
export { ANIMATION_CLASSES, type AnimationClass } from "../../contracts/spec/animation.ts";
