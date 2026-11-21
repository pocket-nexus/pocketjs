import { createSignal } from "solid-js";
import { push, len, type i32 } from "@pocketjs/framework/solid/std";
export const [result, setResult] = createSignal<i32[]>([]);
function collatz(start: i32): i32 {
  let n = start, steps = 0;
  while (n !== 1) {
    n = n % 2 === 0 ? n >> 1 : 3 * n + 1;
    steps++;
  }
  return steps;
}
export function press(): void {
  const out: i32[] = [];
  push(out, collatz(27));
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    if (i % 3 === 0) continue;
    if (i > 7) break;
    sum += i;
  }
  push(out, sum);
  let evens = 0;
  for (let j = 20; j > 0; j -= 3) { if ((j & 1) === 1) continue; evens += j; }
  push(out, evens);
  let k = 0;
  do { k += 5; if (k === 15) continue; } while (k < 30);
  push(out, k);
  for (const v of [4, 8, 15, 16, 23, 42]) { if (v === 23) break; if (v === 8) continue; push(out, v); }
  let x = 0, y = 10;
  for (; x < y; x++, y--) {}
  push(out, x * 100 + y);
  push(out, len(out));
  setResult(out);
}
