import { createSignal } from "solid-js";
import { push, fill, fillRange, len, copyRange, i32, u8, type i32 as I32, type u8 as U8 } from "@pocketjs/framework/solid/std";
export const [result, setResult] = createSignal<I32[]>([]);
let banks: U8[][] = [[], [], []];
let screen: U8[] = fill(12, u8(0));
function blit(img: I32, di: I32, si: I32, n: I32, key: I32): void {
  for (let i = 0; i < n; i++) {
    const c = banks[img][si + i];
    if (i32(c) !== key) screen[di + i] = c;
  }
}
function bump(): void {
  banks[0][0] = u8(i32(banks[0][0]) + 1);
}
export function press(): void {
  banks[0] = [1, 2, 3, 4, 5, 6];
  banks[1] = [9, 0, 9, 0];
  blit(0, 0, 1, 5, 4);
  blit(1, 6, 0, 4, 0);
  blit(5, 10, 0, 2, 7);
  const out: I32[] = [];
  for (const c of screen) push(out, i32(c));
  for (let b = 0; b < 4; b++) push(out, len(banks[b]));
  // Rows read in nested loops, with the outer index invariant only in the inner loop.
  const grid: I32[][] = [[1, 2], [3, 4, 5]];
  let sum = 0;
  for (let y = 0; y < len(grid); y++) for (let x = 0; x < len(grid[y]); x++) sum = sum * 3 + grid[y][x];
  push(out, sum);
  // A loop that writes its root or calls a function keeps reading through the root.
  let k = 0;
  while (k < 3) {
    banks[0][k + 1] = u8(i32(banks[0][k]) * 2);
    k++;
  }
  for (let i = 0; i < 2; i++) {
    bump();
    push(out, i32(banks[0][0]));
  }
  for (const v of banks[0]) push(out, i32(v));
  // copyRange skipping a value, from stored arrays, rows and clipped windows.
  const dst: U8[] = fill(8, u8(1));
  copyRange(dst, 1, banks[1], 0, 4, u8(0));
  copyRange(dst, -1, banks[0], 0, 3, u8(2));
  copyRange(dst, 6, screen, 0, 5, u8(0));
  for (let r = 0; r < 2; r++) copyRange(dst, r * 2, banks[1], r, 2, u8(9));
  copyRange(dst, 0, dst, 4, 4, u8(1));
  copyRange(dst, 2147483000, banks[1], -2147483000, 2147483647, u8(0));
  copyRange(dst, -2147483000, banks[1], 2147483000, 5);
  for (const v of dst) push(out, i32(v));
  copyRange(grid[1], 0, grid[0], 0, 2, 2);
  for (const v of grid[1]) push(out, v);
  setResult(out);
}
export function fills(): void {
  const out: I32[] = [];
  const bytes: U8[] = fill(6, u8(0));
  fillRange(bytes, -2, 2, u8(7));
  fillRange(bytes, 4, 99, u8(3));
  fillRange(bytes, 3, 2, u8(9));
  for (const b of bytes) push(out, i32(b));
  const names: string[] = ["a", "b", "c"];
  fillRange(names, 1, 3, "z");
  for (const n of names) push(out, len(n) + (n === "z" ? 10 : 0));
  // A skipping copy longer than its unrolled steps, with a tail.
  const wide: U8[] = [1, 2, 0, 4, 0, 6, 7, 0, 9, 10, 0];
  const into: U8[] = fill(11, u8(5));
  copyRange(into, 0, wide, 0, 11, u8(0));
  for (const b of into) push(out, i32(b));
  // Windows long enough for memcpy and memset.
  const long: I32[] = fill(20, 0);
  for (let i = 0; i < 20; i++) long[i] = i;
  const wider: I32[] = fill(24, -1);
  copyRange(wider, 2, long, 0, 20);
  let sum = 0;
  for (const v of wider) sum += v;
  push(out, sum);
  fillRange(wider, 0, 18, 7);
  sum = 0;
  for (const v of wider) sum += v;
  push(out, sum);
  setResult(out);
}
