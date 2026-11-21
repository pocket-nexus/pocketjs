import { createSignal } from "solid-js";
import type { i32 } from "@pocketjs/framework/solid/std";

export const [outer, setOuter] = createSignal(true);
export const [inner, setInner] = createSignal(true);
export const [hits, setHits] = createSignal<i32>(0);
export function toggle(): void { setOuter(!outer()); }
export function press(): void {
  setHits(value => value + 1);
  console.log("hit");
}
