// Vue Vapor flavor of the gesture layer. The recognizer machinery lives in
// gesture-core.ts (framework-neutral); this shim adds a createGesture()
// scoped to the current Vue effect scope. Outside any scope (the entry's
// installTouchActivation) disposal falls to resetGestures() at the next
// mount, which is why onScopeDispose is called with failSilently.

import { onScopeDispose } from "vue";
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

/** attachGesture + onScopeDispose(dispose) for Vue component scopes. */
export function createGesture(opts: GestureOptions): GestureHandle {
  const handle = attachGesture(opts);
  onScopeDispose(() => handle.dispose(), true);
  return handle;
}
