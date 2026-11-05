import { createSignal } from "solid-js";
import { push, len, copy, type i32 } from "@pocketjs/framework/solid/std";
const TABLE: i32[] = [3, 1, 4, 1, 5, 9, 2, 6];
const NEGATIVE: i32[] = [-1, -2];
function sum(values: i32[]): i32 { let total = 0; for (const v of values) total += v; return total; }
export const [result, setResult] = createSignal<i32[]>([]);
export function press(): void {
  const out: i32[] = [];
  for (let i = 0; i < len(TABLE); i += 2) push(out, TABLE[i]);
  let far = 90;
  far += 9;
  push(out, TABLE[far]);
  push(out, sum(TABLE));
  const local = copy(TABLE);
  local[0] = 100;
  push(out, local[0] + TABLE[0]);
  push(out, NEGATIVE[1]);
  setResult(out);
}
