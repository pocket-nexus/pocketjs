import type { i32 } from "@pocketjs/framework/solid/std";
export const MAX = 10;
export function clampTo(n: i32): i32 {
  return n > MAX ? MAX : n;
}
