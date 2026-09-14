// Browser and QuickJS implementations of the Pocket Vapor built-ins.
// Signatures and numeric aliases are generated from contracts/spec/vapor.ts.
export type * from "./numeric-vue-vapor.ts";
import type { f32, f64, i32 } from "./numeric-vue-vapor.ts";

export function len<T>(value: string | readonly T[]): i32 {
  if (typeof value !== "string") return value.length;
  let count = 0;
  for (const _ of value) count++;
  return count;
}

function saturateI32(value: number): i32 {
  if (Number.isNaN(value) || value === 0) return 0;
  return Math.min(2147483647, Math.max(-2147483648, value));
}

export function trunc(value: f32 | f64): i32 { return saturateI32(Math.trunc(value)); }
export function floor(value: f32 | f64): i32 { return saturateI32(Math.floor(value)); }
export function ceil(value: f32 | f64): i32 { return saturateI32(Math.ceil(value)); }
export function round(value: f32 | f64): i32 { return saturateI32(Math.round(value)); }

export function idiv<T extends number>(value: T, other: T): T {
  return (other === 0 ? 0 : Math.trunc(value / other)) as T;
}

export function imod<T extends number>(value: T, other: T): T {
  return (other === 0 ? 0 : value % other) as T;
}

export function min<T extends number>(value: T, other: T): T { return Math.min(value, other) as T; }
export function max<T extends number>(value: T, other: T): T { return Math.max(value, other) as T; }
export function abs<T extends number>(value: T): T { return Math.abs(value) as T; }
export function clamp<T extends number>(value: T, other: T, upper: T): T {
  return Math.min(Math.max(value, other), upper) as T;
}
export function fixed(value: f32 | f64, digits: i32): string { return value.toFixed(digits); }
