import { createSignal } from "solid-js";
import { codePoints, copyRange, copyRect, embedBytes, fill, fillRange, fillRect, fromCodePoint, idiv, imod, len, pow, push, removeAt, truncate, f32, f64, i8, i16, i32, i64, u8, u16, usize, type Cap, type f64 as F64, type i32 as I32, type u8 as U8, type i8 as I8, type u16 as U16 } from "@pocketjs/framework/solid/std";
type Id = I32 & { readonly __newtype?: "Id" };
type Name = string & { readonly __newtype?: "Name" };
type Byte = I8 & { readonly __newtype?: "Byte" };
interface P { x: I32 }
interface E { tag?: I32 }
interface Bank { data: I32[] }
export const [result, setResult] = createSignal<I32[]>([]);
const TABLE: Cap<I32[], 4> = [1, 2];
export const [table, setTable] = createSignal<Cap<I32[], 4>>(TABLE);
const PLAIN: I32[] = [3, 4, 5];
const PAIR: [I32, I32] = [1, 2];
export const [plain, setPlain] = createSignal<Cap<I32[], 4>>(PLAIN);
const NAMES: Name[] = ["ab", "c"];
const BYTES: U8[] = embedBytes("./bytes.bin");
let rows: I32[][] = [[1, 2, 3]];
let bank: Bank = { data: [1, 2, 3, 4, 5, 6] };
function bump(): I32 {
  rows[0] = [7, 8, 9];
  return 1;
}
let counter = 1;
function next(): F64 {
  counter += 1;
  return f64(counter);
}
let src: I32[] = [1, 2, 3];
function swap(): I32 {
  src = [9, 9, 9];
  return 3;
}
function five() {
  while (true) {
    return 5;
  }
}
function six() {
  do {
    return 6;
  } while (true);
}
function seven() {
  do {
    return 7;
  } while (false);
}
function pick(k: I32) {
  switch (k) {
    case 1:
      return 10;
    default:
      return 20;
  }
}
function maybe(flag: boolean): I32 | undefined {
  if (flag) return 5;
}
function blank(): undefined {}
function nothing(flag: boolean) {
  if (flag) return undefined;
}
let target: I32[] = [0];
function replace(): I32[] {
  target = [5];
  return [7];
}
let grid: I32[][] = [[0]];
function regrid(): I32 {
  grid = [[5]];
  return 7;
}
let sourced = 0;
function source(): I32[] {
  sourced += 1;
  return [1];
}
export function press(): void {
  const out: I32[] = [];
  // Conversions follow the argument's static type: floats saturate, integers wrap.
  push(out, i32(f64(1e10)));
  push(out, i32(i8(f32(200))));
  push(out, i32(u8(i32(300))));
  push(out, i32(f64(usize(-1)) / f64(65536)));
  // Remainders by zero are zero.
  push(out, i32(i64(7) % i64(0)));
  // idiv and imod truncate toward zero; a zero divisor gives 0.
  const m = -7;
  push(out, imod(m, 2));
  push(out, idiv(m, 2));
  push(out, i32(idiv(i64(7), i64(0))));
  // 8- and 16-bit shifts run on 32-bit values.
  const a: U8 = u8(200), b: I8 = i8(-1), c: U16 = u16(1);
  push(out, i32(a >>> 8));
  push(out, i32(u8(1) << 8));
  push(out, i32(a >> 8));
  push(out, i32(b >>> 1));
  push(out, i32(i8(-128) >> 1));
  push(out, i32(c << 16));
  // for…of reads a copy of its source.
  const xs: I32[] = [1, 2];
  for (const v of xs) push(xs, v);
  push(out, len(xs));
  // Out-of-range removeAt returns the element type's default; a negative truncate clears.
  const empty: I32[] = [];
  push(out, removeAt(empty, 0) + 1);
  const ps: P[] = [];
  push(out, removeAt(ps, 3).x + 1);
  const t: I32[] = [1, 2, 3];
  truncate(t, -1);
  push(out, len(t));
  // fillRange and fillRect store a copy in each element.
  const qs: P[] = fill(4, { x: 0 });
  fillRange(qs, 0, 2, { x: 1 });
  fillRect(qs, 2, 1, 1, 2, { x: 2 });
  qs[0].x = 5;
  qs[2].x = 6;
  for (const q of qs) push(out, q.x);
  // An index that calls a function is evaluated after its row is read.
  push(out, rows[0][bump()]);
  // Optional fields of elements, in and out of range.
  const es: E[] = [{ tag: 4 }, {}];
  push(out, es[0].tag ?? -1);
  push(out, es[1].tag ?? -1);
  const far = len(es) + 3;
  push(out, es[far].tag ?? -1);
  // Newtype elements.
  const ids: Id[] = fill(2, 3 as Id);
  push(out, ids[1] + len(NAMES) + len(NAMES[0]));
  // A copy within a field of a struct.
  copyRange(bank.data, 0, bank.data, 1, 5);
  copyRect(bank.data, 3, 1, bank.data, 0, 1, 1, 2);
  for (const v of bank.data) push(out, v);
  // A for loop whose body changes its counter re-evaluates its condition.
  let count = 0;
  for (let i = 0; i < 10; i++) {
    i += 2;
    count++;
  }
  push(out, count);
  for (const byte of BYTES) push(out, i32(byte));
  // Built-in arguments run in source order: the source is read before swap() replaces it.
  push(out, i32(pow(next(), next() + 1.0)));
  push(out, idiv(i32(next()) * 10, i32(next()) + 1));
  const dst: I32[] = [0, 0, 0];
  copyRange(dst, 0, src, 0, swap());
  for (const v of dst) push(out, v);
  // Cap constants seed Cap signals; values stored into Cap string arrays are bounded.
  push(out, len(table()));
  const words: Cap<string, 3>[] = [];
  const word: string = "ab";
  push(words, word);
  fillRange(words, 0, 1, word);
  push(out, len(words[0]));
  // Newtypes compute in their base type.
  const byte: Byte = -1 as Byte;
  push(out, i32(byte >>> 1));
  type Big = I32 & { readonly __newtype?: "Big" };
  const big: Big = 2147483647 as Big;
  push(out, i32(big * big));
  // Returns inside loops set the inferred return type.
  push(out, five() + six());
  push(out, seven() + pick(1) + pick(2));
  // Plain constants and fill() seed Cap arrays.
  const filled: Cap<I32[], 4> = fill(2, 1);
  push(out, len(plain()) + len(filled) + filled[1]);
  // Arguments run even when the target element is missing.
  const holes: I32[][] = [];
  const gap = len(holes) + 1;
  copyRange(holes[gap], 0, source(), 0, 1);
  push(holes[gap], i32(next()));
  push(out, sourced);
  push(out, i32(next()));
  // An optional return type falls off the end as undefined.
  push(out, (maybe(false) ?? 9) + (maybe(true) ?? 9));
  blank();
  nothing(false);
  nothing(true);
  // Writes read their target place after their value and arguments.
  copyRange(target, 0, replace(), 0, 1);
  grid[0][0] = regrid();
  push(out, target[0] + grid[0][0]);
  // Fixed-length constants, and built-ins that return arrays or strings, in Cap places.
  const pair: [I32, I32] = PAIR;
  const points: Cap<I32[], 4> = codePoints("ab");
  const embedded: Cap<U8[], 4> = embedBytes("./bytes.bin");
  const letter: Cap<string, 2> = fromCodePoint(65);
  const chosen: Cap<I32[], 4> = len(points) > 1 ? codePoints("xyz") : codePoints("x");
  push(out, pair[0] + pair[1] + len(points) + len(embedded) + len(letter) + len(chosen));
  setResult(out);
}
