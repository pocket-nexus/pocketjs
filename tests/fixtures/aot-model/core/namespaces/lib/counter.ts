import type { i32 } from "@pocketjs/framework/solid/std";
export * as limits from "./limits";
export let total: i32 = 0;
export function add(n: i32): void {
  total += n;
}
