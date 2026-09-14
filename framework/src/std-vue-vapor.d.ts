// GENERATED — do not edit; run `bun contracts/spec/gen-rust.ts`.
export type * from "./numeric-vue-vapor.ts";
import type { i32, f32, f64 } from "./numeric-vue-vapor.ts";
export declare function len<T>(value: string | readonly T[]): i32;
export declare function trunc(value: f32 | f64): i32;
export declare function floor(value: f32 | f64): i32;
export declare function ceil(value: f32 | f64): i32;
export declare function round(value: f32 | f64): i32;
export declare function idiv<T extends number>(value: T, other: T): T;
export declare function imod<T extends number>(value: T, other: T): T;
export declare function min<T extends number>(value: T, other: T): T;
export declare function max<T extends number>(value: T, other: T): T;
export declare function abs<T extends number>(value: T): T;
export declare function clamp<T extends number>(value: T, other: T, upper: T): T;
export declare function fixed(value: f32 | f64, digits: i32): string;
