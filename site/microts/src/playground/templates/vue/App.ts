import { ref } from "vue";
import type { i32 } from "@pocketjs/framework/vue-vapor/std";

export const presses = ref<i32>(0);

export function press(): void {
  presses.value = presses.value + 1;
}

export function reset(): void {
  presses.value = 0;
}
