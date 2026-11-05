import { createSignal } from "solid-js";
import { codePoints, fill, len, push, type i32 as I32 } from "@pocketjs/framework/solid/std";
export const [result, setResult] = createSignal<I32[]>([]);
const BASE = 10;
const W = 3;
// Nested arithmetic on constants binds temporaries that stay constant.
let grid: I32[] = fill(2 * W * BASE, 1);
function scaled(x: I32, factor: I32 = BASE * 2 + 1): I32 {
  return x * factor;
}
interface Point {
  x: I32;
  y: I32;
}
function total(a: I32, b: I32 = 2, list: I32[] = [], flag: boolean = false, p: Point = { x: 1, y: 2 }, c: I32 = BASE + 1): I32 {
  let sum = a + b + c + p.x + p.y;
  for (const v of list) sum += v;
  return flag ? -sum : sum;
}
// Parameters are the callee's own copies, which it may change.
function stepped(x: I32, list: I32[]): I32 {
  x += 4;
  push(list, x);
  list[0] = 9;
  return x + len(list) + list[0];
}
let words: string[] = ["ab", "cde"];
let label: string = "xyz";
export function press(): void {
  const out: I32[] = [];
  push(out, total(1));
  push(out, total(1, 5));
  push(out, total(1, 5, [3, 4]));
  push(out, total(1, 5, [3, 4], true));
  push(out, total(0, 0, [], false, { x: 5, y: 5 }, 0));
  push(out, len(grid));
  push(out, scaled(2));
  const mine: I32[] = [1];
  push(out, stepped(1, mine));
  push(out, len(mine));
  push(out, len(codePoints(words[1])) + len(codePoints(label)));
  setResult(out);
}
