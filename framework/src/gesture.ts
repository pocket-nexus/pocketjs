// Solid flavor of the gesture layer. The recognizer machinery — contact
// lifecycles, tap/long-press/pan/pinch recognition, the ownership model, and
// the frame pump — is framework-neutral and lives in gesture-core.ts; this
// shim adds the Solid-scoped createGesture(). Vue Vapor builds resolve
// gesture.vue-vapor.ts instead (the compiler's framework-variant rule).

import { onCleanup } from "solid-js";
import { attachGesture, type GestureHandle, type GestureOptions } from "./gesture-core.ts";

export type {
  GestureContact,
  GestureHandle,
  GestureOptions,
  GesturePhase,
  GesturePinch,
  GestureRegion,
} from "./gesture-core.ts";
export { __runGestures, attachGesture, pushTouchBlock, resetGestures } from "./gesture-core.ts";

/** attachGesture + onCleanup(dispose) for Solid component scopes. */
export function createGesture(opts: GestureOptions): GestureHandle {
  const handle = attachGesture(opts);
  onCleanup(() => handle.dispose());
  return handle;
}
