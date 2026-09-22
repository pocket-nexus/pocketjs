import { createSignal } from "solid-js";
import type { i32 } from "@pocketjs/framework/solid/std";

/** Each mounted toggle keeps its own press count. */
export function createFeatureToggle() {
  const [presses, setPresses] = createSignal<i32>(0);
  function press(): i32 {
    setPresses(presses() + 1);
    return presses();
  }
  return { presses, press };
}
