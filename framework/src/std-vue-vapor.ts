// Browser and QuickJS implementations of the Pocket Vapor built-ins.
// Signatures and numeric aliases are generated from contracts/spec/vapor.ts.
export type * from "./numeric-vue-vapor.ts";
export type StyleClass = string & { readonly __style?: true };
import type { Color, f32, f64, i32, u32 } from "./numeric-vue-vapor.ts";
import { parseVaporColor } from "../../contracts/spec/vapor.ts";
export type VaporPlainNumber = number & { readonly __type?: never; readonly __newtype?: never };
export type VaporNumericResult<T extends number> = T extends VaporPlainNumber ? number : T;

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

export function idiv<T extends number>(value: T, other: NoInfer<T> | VaporPlainNumber): VaporNumericResult<T> {
  return (other === 0 ? 0 : Math.trunc(value / other)) as VaporNumericResult<T>;
}

export function imod<T extends number>(value: T, other: NoInfer<T> | VaporPlainNumber): VaporNumericResult<T> {
  return (other === 0 ? 0 : value % other) as VaporNumericResult<T>;
}

export function min<T extends number>(value: T, other: NoInfer<T> | VaporPlainNumber): VaporNumericResult<T> { return Math.min(value, other) as VaporNumericResult<T>; }
export function max<T extends number>(value: T, other: NoInfer<T> | VaporPlainNumber): VaporNumericResult<T> { return Math.max(value, other) as VaporNumericResult<T>; }
export function abs<T extends number>(value: T): VaporNumericResult<T> { return Math.abs(value) as VaporNumericResult<T>; }
export function clamp<T extends number>(value: T, other: NoInfer<T> | VaporPlainNumber, upper: NoInfer<T> | VaporPlainNumber): VaporNumericResult<T> {
  return Math.min(Math.max(value, other), upper) as VaporNumericResult<T>;
}
export function fixed(value: f32 | f64, digits: i32): string { return value.toFixed(digits); }

/** Internal lowering helpers: Color values compare by bits and display one spelling. */
export function __colorBits(value: Color): u32 { return parseVaporColor(value); }
export function __colorText(value: Color | undefined, missing = ""): string {
  if (value === undefined) return missing;
  const bits = __colorBits(value);
  return "#" + [bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, bits >>> 24].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
