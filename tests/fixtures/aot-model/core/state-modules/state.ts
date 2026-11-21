import { fill, push, len, type i32 } from "@pocketjs/framework/solid/std";
import { SIZE, weight } from "./table";
export let hits: i32[] = fill(SIZE, 0);
export let score: i32 = 0;
let log: i32[] = [];
export function hit(slot: i32): void {
  hits[slot] += 1;
  score += weight(slot);
  push(log, slot);
}
export function logged(): i32 { return len(log); }
