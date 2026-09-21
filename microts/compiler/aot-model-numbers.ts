/** Numeric source tokens retain the distinction erased by TypeScript's scanner. */
import type { AotType, NumericName, SourceLocation } from "./aot-ir.ts";
import { fail } from "./aot-types.ts";
export function classifyModelNumber(raw: string): "i32" | "f64" {
  const spelling = raw.replaceAll("_", "").replace(/^[+-]/, "");
  return /^0[xob]/i.test(spelling) || !/[.eE]/.test(spelling) ? "i32" : "f64";
}
export function modelNumberType(raw: string, expected: AotType | undefined, loc: SourceLocation): AotType {
  const classification = classifyModelNumber(raw);
  expected ??= { kind: "number", name: classification };
  if (expected?.kind === "number") {
    if (classification === "f64" && !expected.name.startsWith("f")) fail(loc, `fractional literal ${raw} cannot adopt integer type ${expected.name}`);
    if (!expected.name.startsWith("f")) {
      const bits: Partial<Record<NumericName, number>> = { i8: 8, i16: 16, i32: 32, i64: 64, u8: 8, u16: 16, u32: 32, u64: 64, usize: 32 };
      const spelling = raw.replaceAll("_", ""), sign = spelling.startsWith("-") ? -1n : 1n;
      const n = sign * BigInt(spelling.replace(/^[+-]/, "")), size = BigInt(bits[expected.name]!);
      const signed = expected.name.startsWith("i"), low = signed ? -(1n << (size - 1n)) : 0n, high = signed ? (1n << (size - 1n)) - 1n : (1n << size) - 1n;
      if (n < low || n > high) fail(loc, `literal ${raw} is outside ${expected.name}`);
    }
    return expected;
  }
  return { kind: "number", name: classification };
}
