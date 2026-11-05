import { createSignal } from "solid-js";
import type { i32 } from "@pocketjs/framework/solid/std";

export const [presses, setPresses] = createSignal<i32>(0);

export function press(): void {
  setPresses(presses() + 1);
}

export function reset(): void {
  setPresses(0);
}
