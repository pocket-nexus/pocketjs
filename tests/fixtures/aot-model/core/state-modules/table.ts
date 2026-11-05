import type { i32 } from "@pocketjs/framework/solid/std";
export const SIZE = 4;
const WEIGHTS: i32[] = [10, 20, 30, 40];
export function weight(slot: i32): i32 { return WEIGHTS[slot] * 2; }
