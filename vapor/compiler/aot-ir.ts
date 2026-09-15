/** Serializable, language-neutral boundary between Vue analysis and native code generation. */
import type { StyleRecord, AnimTimeline } from "../../contracts/spec/spec.ts";

export type NumericName = "i8" | "i16" | "i32" | "i64" | "u8" | "u16" | "u32" | "u64" | "usize" | "f32" | "f64";
export interface SourceLocation { file: string; line: number; column: number; offset: number }
export interface AotDiagnostic extends SourceLocation { severity: "error" | "warning"; message: string }
export type AotType =
  | { kind: "number"; name: NumericName }
  | { kind: "string" | "boolean" | "void" | "undefined" }
  | { kind: "option"; value: AotType }
  | { kind: "array"; element: AotType; length?: number }
  | { kind: "tuple"; elements: AotType[] }
  | { kind: "named"; name: string };
export interface AotField { name: string; type: AotType }
export type AotTypeDeclaration =
  | { kind: "struct"; name: string; fields: AotField[] }
  | { kind: "enum"; name: string; variants: string[] }
  | { kind: "union"; name: string; discriminant: string; variants: { name: string; fields: AotField[] }[] }
  | { kind: "newtype"; name: string; base: AotType; unit?: "Px" | "Ms" | "Deg" | "Color" };
export type LiteralValue = string | number | boolean;
export interface AotConstant { name: string; sourceName?: string; type: AotType; value: LiteralValue; rawNumber?: string }
export interface AotValue { name: string; sourceName: string; type: AotType; writable: boolean }
export interface AotFunction { name: string; sourceName: string; parameters: AotField[]; returns: AotType; binding: boolean; handler: boolean; optional?: boolean }
export interface AotProp extends AotField { default?: LiteralValue; defaultRawNumber?: string; model?: string }
export interface AotEvent { name: string; parameters: AotField[] }
export type BindingScope = "vm" | "prop" | "local" | "event";
export type AotExpr = (
  | { kind: "literal"; value: LiteralValue; rawNumber?: string }
  | { kind: "undefined" }
  | { kind: "binding"; name: string; scope: BindingScope }
  | { kind: "field"; object: AotExpr; name: string; optional: boolean; variant?: string }
  | { kind: "index"; object: AotExpr; index: AotExpr }
  | { kind: "unary"; operator: "!" | "-" | "+"; operand: AotExpr }
  | { kind: "binary"; operator: string; left: AotExpr; right: AotExpr }
  | { kind: "conditional"; condition: AotExpr; consequent: AotExpr; alternate: AotExpr }
  | { kind: "call"; name: string; target: "vm" | "builtin"; arguments: AotExpr[] }
  | { kind: "template"; parts: (string | AotExpr)[] }
  | { kind: "cast"; value: AotExpr }
  | { kind: "narrow"; value: AotExpr; variant?: string }
) & { type: AotType; loc: SourceLocation };
export type AotHandler = (
  | { kind: "call"; expression: AotExpr }
  | { kind: "assign"; name: string; value: AotExpr }
  | { kind: "emit"; name: string; arguments: AotExpr[] }
) & { id: number; loc: SourceLocation };
export interface AotMemo { id: number; expression: AotExpr }
export interface AotStyleBinding { prop: number; name: string; value: AotExpr; memo: number }
export type AotNode =
  | { kind: "input"; id: number; input: { kind: "button"; name: string; button: number; latched: boolean } | { kind: "axis"; name: string; axis: number }; active: AotExpr; handler: AotHandler; children: AotNode[]; loc: SourceLocation }
  | { kind: "element"; id: number; tag: "View" | "Text" | "Image"; style: number; dynamicStyle?: AotMemo; props: AotStyleBinding[]; text?: { parts: (string | AotExpr)[]; memo: number }; focusable: boolean; debugName?: string; src?: string; events: { name: string; handler: AotHandler }[]; children: AotNode[]; loc: SourceLocation }
  | { kind: "if"; id: number; branches: { condition?: AotExpr; children: AotNode[] }[]; loc: SourceLocation }
  | { kind: "for"; id: number; source: AotExpr; item: string; index?: string; itemType: AotType; key: AotExpr; children: AotNode[]; loc: SourceLocation }
  | { kind: "component"; id: number; component: string; props: { name: string; value: AotExpr }[]; events: { name: string; handler: AotHandler }[]; slots: { name: string; children: AotNode[] }[]; loc: SourceLocation }
  | { kind: "slot"; id: number; name: string; fallback: AotNode[]; loc: SourceLocation };
export interface AotComponent {
  name: string; file: string; root: boolean;
  factory?: { name: string; sourceName: string; module: string };
  props: AotProp[]; events: AotEvent[]; slots: string[];
  values: AotValue[]; functions: AotFunction[]; constants: AotConstant[];
  children: string[]; nodes: AotNode[]; nodeCount: number; memoCount: number; handlerCount: number;
}
export interface AotProgram {
  version: 1; root: string; components: AotComponent[]; types: AotTypeDeclaration[];
  styles: { records: StyleRecord[]; anims: AnimTimeline[]; ids: Record<string, number>; bytes: number[]; usedFontSlots: number[] };
  diagnostics: AotDiagnostic[];
  demands?: { buttons: number[]; axes: number[]; capabilities: string[] };
}
export class AotCompileError extends Error {
  constructor(public readonly diagnostics: AotDiagnostic[]) {
    super(diagnostics.map(d => `${d.file}:${d.line}:${d.column}: ${d.severity}: ${d.message}`).join("\n"));
    this.name = "AotCompileError";
  }
}
export const BOOL: AotType = { kind: "boolean" };
export const STRING: AotType = { kind: "string" };
export const I32: AotType = { kind: "number", name: "i32" };
export const F64: AotType = { kind: "number", name: "f64" };
export function sameType(a: AotType, b: AotType): boolean { return JSON.stringify(a) === JSON.stringify(b); }
