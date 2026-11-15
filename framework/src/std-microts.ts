// Browser and QuickJS implementations of the MicroTS built-ins.
// Signatures and numeric aliases are generated from contracts/spec/microts.ts.
import type * as N from "./numeric-microts.ts";
export type i8 = N.i8;
export type i16 = N.i16;
export type i32 = N.i32;
export type i64 = N.i64;
export type u8 = N.u8;
export type u16 = N.u16;
export type u32 = N.u32;
export type u64 = N.u64;
export type usize = N.usize;
export type f32 = N.f32;
export type f64 = N.f64;
export type Px = N.Px;
export type Ms = N.Ms;
export type Deg = N.Deg;
export type Color = N.Color;
export type StyleClass = string & { readonly __style?: true };
export type Cap<T extends string | readonly unknown[], N extends number> = T & { readonly __capacity?: N };
export { copy, equals } from "./model-reactive.ts";
import { copy } from "./model-reactive.ts";
export { capacity as __capacity } from "./model-reactive.ts";
export { frames, after, until, join, all, any, cancel, type Join } from "./model-tasks.ts";
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

// Numeric conversions are named after their target type and use
// Rust `as` semantics: floats truncate toward zero and saturate, integers wrap.
// usize converts as u32 on every target. Called directly, a conversion treats
// a value with a fraction as a float; compiled models pass the static type.
function integerConversion(value: number, bits: number, signed: boolean, float = !Number.isInteger(value)): number {
  if (float) {
    if (Number.isNaN(value)) return 0;
    const limit = 2 ** (signed ? bits - 1 : bits);
    return Math.min(limit - 1, Math.max(signed ? -limit : 0, Math.trunc(value)));
  }
  const wrapped = BigInt.asUintN(bits, BigInt(value));
  return Number(signed ? BigInt.asIntN(bits, wrapped) : wrapped);
}
const CONVERSIONS: Record<string, [bits: number, signed: boolean]> = { i8: [8, true], i16: [16, true], i32: [32, true], i64: [64, true], u8: [8, false], u16: [16, false], u32: [32, false], u64: [64, false], usize: [32, false] };
export function i8(value: number): i8 { return integerConversion(value, 8, true); }
export function i16(value: number): i16 { return integerConversion(value, 16, true); }
export function i32(value: number): i32 { return integerConversion(value, 32, true); }
export function i64(value: number): i64 { return integerConversion(value, 64, true); }
export function u8(value: number): u8 { return integerConversion(value, 8, false); }
export function u16(value: number): u16 { return integerConversion(value, 16, false); }
export function u32(value: number): u32 { return integerConversion(value, 32, false); }
export function u64(value: number): u64 { return integerConversion(value, 64, false); }
export function usize(value: number): usize { return integerConversion(value, 32, false); }
export function f32(value: number): f32 { return Math.fround(value); }
export function f64(value: number): f64 { return value; }
/** Internal lowering helper: a conversion to `type` of a value whose static type is a float or not. */
export function __convert(value: number, type: string, float: boolean): number {
  if (type === "f32") return Math.fround(value);
  if (type === "f64") return value;
  const [bits, signed] = CONVERSIONS[type]!;
  return integerConversion(value, bits, signed, float);
}

type Float = f32 | f64;
export function sqrt<T extends Float>(value: T): T { return Math.sqrt(value) as T; }
export function sin<T extends Float>(value: T): T { return Math.sin(value) as T; }
export function cos<T extends Float>(value: T): T { return Math.cos(value) as T; }
export function tan<T extends Float>(value: T): T { return Math.tan(value) as T; }
export function asin<T extends Float>(value: T): T { return Math.asin(value) as T; }
export function acos<T extends Float>(value: T): T { return Math.acos(value) as T; }
export function atan<T extends Float>(value: T): T { return Math.atan(value) as T; }
export function exp<T extends Float>(value: T): T { return Math.exp(value) as T; }
export function log<T extends Float>(value: T): T { return Math.log(value) as T; }
export function atan2<T extends Float>(value: T, other: NoInfer<T> | MicroTsPlainNumber): T { return Math.atan2(value, other) as T; }
export function pow<T extends Float>(value: T, other: NoInfer<T> | MicroTsPlainNumber): T { return Math.pow(value, other) as T; }
export function hypot<T extends Float>(value: T, other: NoInfer<T> | MicroTsPlainNumber): T { return Math.hypot(value, other) as T; }

function defaultLike<T>(sample: T | undefined): T {
  if (typeof sample === "number") return 0 as T;
  if (typeof sample === "boolean") return false as T;
  if (typeof sample === "string") return "" as T;
  return undefined as unknown as T;
}
export function fill<T>(count: i32, value: T): T[] { return Array.from({ length: Math.max(0, count) }, () => copy(value)); }
export function push<T>(target: T[], value: T): void { target.push(value); }
export function pop<T>(target: T[]): T { return target.length ? target.pop()! : defaultLike<T>(undefined); }
export function insert<T>(target: T[], index: i32, value: T): void { target.splice(Math.max(0, Math.min(index, target.length)), 0, value); }
export function removeAt<T>(target: T[], index: i32): T { return index >= 0 && index < target.length ? target.splice(index, 1)[0]! : defaultLike(target[0]); }
export function clear<T>(target: T[]): void { target.length = 0; }
/** Keeps the first `length` elements; a negative length keeps none. */
export function truncate<T>(target: T[], length: i32): void { if (length < target.length) target.length = Math.max(0, length); }
/** Each element in the window receives its own copy of `value`. */
export function fillRange<T>(target: T[], start: i32, end: i32, value: T): void {
  for (let i = Math.max(0, start); i < Math.min(end, target.length); i++) target[i] = copy(value);
}
export function copyRange<T>(target: T[], targetStart: i32, source: readonly T[], sourceStart: i32, count: i32, ...skip: [T?]): void {
  let n = count, from = sourceStart, to = targetStart;
  if (from < 0) { n += from; to -= from; from = 0; }
  if (to < 0) { n += to; from -= to; to = 0; }
  n = Math.min(n, source.length - from, target.length - to);
  if (n <= 0) return;
  // A copy of the window first, so a source that is the target reads its old elements.
  const values = source.slice(from, from + n);
  for (let i = 0; i < n; i++) if (!skip.length || values[i] !== skip[0]) target[to + i] = values[i]!;
}
/** Row r of the rectangle is fillRange(target, start + r * stride, start + r * stride + width, value). */
export function fillRect<T>(target: T[], start: i32, stride: i32, width: i32, height: i32, value: T): void {
  for (let r = 0; r < height; r++) fillRange(target, start + r * stride, start + r * stride + width, value);
}
/**
 * Row r of the rectangle is copyRange(target, targetStart + r * targetStride, source,
 * sourceStart + r * sourceStride, width, ...skip); every row is read before any is written.
 */
export function copyRect<T>(target: T[], targetStart: i32, targetStride: i32, source: readonly T[], sourceStart: i32, sourceStride: i32, width: i32, height: i32, ...skip: [T?]): void {
  const from = source === target ? source.slice() : source;
  for (let r = 0; r < height; r++) copyRange(target, targetStart + r * targetStride, from, sourceStart + r * sourceStride, width, ...skip);
}
export function codePoints(value: string): i32[] { return Array.from(value, c => c.codePointAt(0)!); }
export function fromCodePoint(code: i32): string { return code >= 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "\ufffd"; }
/** Guest builds replace calls with the file contents at compile time. */
export function embedBytes(path: string): u8[] { throw new Error(`embedBytes(${JSON.stringify(path)}) must be resolved by the compiler`); }
