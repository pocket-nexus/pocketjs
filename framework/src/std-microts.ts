// Browser and QuickJS implementations of the MicroTS built-ins.
// Signatures and numeric aliases are generated from contracts/spec/microts.ts.
export type * from "./numeric-microts.ts";
export type StyleClass = string & { readonly __style?: true };
export type Cap<T extends string | readonly unknown[], N extends number> = T & { readonly __capacity?: N };
export { copy, equals } from "./model-reactive.ts";
export { capacity as __capacity } from "./model-reactive.ts";
export { frames, after, until, join, all, any, cancel, type Join } from "./model-tasks.ts";
import type { Color, f32, f64, i32, u32 } from "./numeric-microts.ts";
import { parseMicroTsColor } from "../../contracts/spec/microts.ts";
export type MicroTsPlainNumber = number & { readonly __type?: never; readonly __newtype?: never };
export type MicroTsNumericResult<T extends number> = T extends MicroTsPlainNumber ? number : T;

export function len<T>(value: string | readonly T[]): i32 {
  if (typeof value !== "string") return value.length;
  let count = 0;
  for (const _ of value) count++;
  return count;
}

export function map<T, U>(value: readonly T[], fn: (value: T, index: i32) => U): U[] { return value.map(fn); }
export function filter<T>(value: readonly T[], fn: (value: T, index: i32) => boolean): T[] { return value.filter(fn); }
export function find<T>(value: readonly T[], fn: (value: T, index: i32) => boolean): T | undefined { return value.find(fn); }
export function some<T>(value: readonly T[], fn: (value: T, index: i32) => boolean): boolean { return value.some(fn); }

function saturateI32(value: number): i32 {
  if (Number.isNaN(value) || value === 0) return 0;
  return Math.min(2147483647, Math.max(-2147483648, value));
}

export function trunc(value: f32 | f64): i32 { return saturateI32(Math.trunc(value)); }
export function floor(value: f32 | f64): i32 { return saturateI32(Math.floor(value)); }
export function ceil(value: f32 | f64): i32 { return saturateI32(Math.ceil(value)); }
export function round(value: f32 | f64): i32 { return saturateI32(Math.round(value)); }

export function idiv<T extends number>(value: T, other: NoInfer<T> | MicroTsPlainNumber): MicroTsNumericResult<T> {
  return (other === 0 ? 0 : Math.trunc(value / other)) as MicroTsNumericResult<T>;
}

export function imod<T extends number>(value: T, other: NoInfer<T> | MicroTsPlainNumber): MicroTsNumericResult<T> {
  return (other === 0 ? 0 : value % other) as MicroTsNumericResult<T>;
}

export function min<T extends number>(value: T, other: NoInfer<T> | MicroTsPlainNumber): MicroTsNumericResult<T> { return Math.min(value, other) as MicroTsNumericResult<T>; }
export function max<T extends number>(value: T, other: NoInfer<T> | MicroTsPlainNumber): MicroTsNumericResult<T> { return Math.max(value, other) as MicroTsNumericResult<T>; }
export function abs<T extends number>(value: T): MicroTsNumericResult<T> { return Math.abs(value) as MicroTsNumericResult<T>; }
export function clamp<T extends number>(value: T, other: NoInfer<T> | MicroTsPlainNumber, upper: NoInfer<T> | MicroTsPlainNumber): MicroTsNumericResult<T> {
  return Math.min(Math.max(value, other), upper) as MicroTsNumericResult<T>;
}
export function fixed(value: f32 | f64, digits: i32): string { return value.toFixed(digits); }

/** Internal compiled-view helpers keep arithmetic at the declared storage width. */
export function __modelNumber(value: number, type: string): number {
  switch (type) {
    case "i8": return value << 24 >> 24;
    case "u8": return value & 255;
    case "i16": return value << 16 >> 16;
    case "u16": return value & 65535;
    case "i32": return value | 0;
    case "u32": case "usize": return value >>> 0;
    case "f32": return Math.fround(value);
    default: throw new Error(`Invalid compiled view numeric type ${type}`);
  }
}
export function __modelMultiply(left: number, right: number): number { return Math.imul(left, right); }

/** Internal lowering helpers: Color values compare by bits and display one spelling. */
export function __colorBits(value: Color): u32 { return parseMicroTsColor(value); }
export function __colorText(value: Color | undefined, missing = ""): string {
  if (value === undefined) return missing;
  const bits = __colorBits(value);
  return "#" + [bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, bits >>> 24].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
