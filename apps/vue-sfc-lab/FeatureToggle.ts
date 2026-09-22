import { ref } from "vue";
import type { i32 } from "@pocketjs/framework/vue-vapor/std";

/** Each mounted toggle retains its own activation count. */
export function createFeatureToggle() {
  const presses = ref<i32>(0);
  function press(): i32 {
    presses.value += 1;
    return presses.value;
  }
  return { presses, press };
}
