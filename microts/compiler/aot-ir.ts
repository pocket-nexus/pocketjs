/** Serializable, language-neutral boundary between view analysis and native code generation. */
import type { StyleRecord, AnimTimeline } from "../../contracts/spec/spec.ts";

export type NumericName = "i8" | "i16" | "i32" | "i64" | "u8" | "u16" | "u32" | "u64" | "usize" | "f32" | "f64";
export interface SourceLocation { file: string; line: number; column: number; offset: number }
export interface AotDiagnostic extends SourceLocation { severity: "error" | "warning"; message: string }
export type AotType =
  | { kind: "number"; name: NumericName }
  | { kind: "string"; capacity?: number }
  | { kind: "boolean" | "void" | "undefined" | "style" }
  | { kind: "option"; value: AotType }
  | { kind: "array"; element: AotType; length?: number; capacity?: number }
  | { kind: "tuple"; elements: AotType[] }
  | { kind: "named"; name: string };
export interface AotField { name: string; type: AotType }
export type AotTypeDeclaration =
  | { kind: "struct"; name: string; fields: AotField[] }
  | { kind: "enum"; name: string; variants: string[] }
  | { kind: "union"; name: string; discriminant: string; variants: { name: string; fields: AotField[] }[] }
  | { kind: "newtype"; name: string; base: AotType; unit?: "Px" | "Ms" | "Deg" | "Color" };
export type LiteralValue = string | number | boolean;
export interface AotConstant { name: string; sourceName?: string; type: AotType; value: LiteralValue | LiteralValue[]; rawNumber?: string; rawNumbers?: (string | undefined)[] }
export interface AotValue { name: string; sourceName: string; type: AotType; writable: boolean; memo?: boolean }
export interface AotFunction { name: string; sourceName: string; parameters: AotField[]; returns: AotType; binding: boolean; handler: boolean; optional?: boolean; async?: true }
export interface AotProp extends AotField { default?: LiteralValue; defaultRawNumber?: string; model?: string }
export interface AotEvent { name: string; parameters: AotField[]; optional?: true }
export interface AotSlot { name: string; parameters: AotField[] }
export interface AotSlotBinding extends AotField { prop: string }
export type BindingScope = "vm" | "prop" | "local" | "event" | "inject";
export type AotExpr = (
  | { kind: "literal"; value: LiteralValue; rawNumber?: string }
  | { kind: "undefined" }
  | { kind: "constant"; name: string }
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
  | { kind: "emit"; name: string; arguments: AotExpr[]; optional?: true }
  | { kind: "sequence"; steps: AotHandler[] }
  | { kind: "if"; condition: AotExpr; then: AotHandler[]; else?: AotHandler[] }
) & { id: number; loc: SourceLocation };
export interface AotMemo { id: number; expression: AotExpr }
export interface AotStyleBinding { prop: number; name: string; value: AotExpr; memo: number }
export type AotNode =
  | { kind: "input"; id: number; input: { kind: "button"; name: string; button: number; latched: boolean } | { kind: "axis"; name: string; axis: number }; active: AotExpr; handler: AotHandler; children: AotNode[]; loc: SourceLocation }
  | { kind: "element"; id: number; tag: "View" | "Text" | "Image"; style: number; dynamicStyle?: AotMemo; props: AotStyleBinding[]; text?: { parts: (string | AotExpr)[]; memo: number }; focusable: boolean; debugName?: string; src?: string; ref?: string; events: { name: string; handler: AotHandler }[]; children: AotNode[]; loc: SourceLocation }
  | { kind: "if"; id: number; branches: { condition?: AotExpr; children: AotNode[] }[]; loc: SourceLocation }
  | { kind: "for"; id: number; source: AotExpr; item: string; index?: string; itemType: AotType; key: AotExpr; children: AotNode[]; loc: SourceLocation }
  | { kind: "component"; id: number; component: string; props: { name: string; value: AotExpr }[]; events: { name: string; handler: AotHandler }[]; slots: { name: string; bindings?: AotSlotBinding[]; children: AotNode[] }[]; loc: SourceLocation }
  | { kind: "slot"; id: number; name: string; props?: { name: string; value: AotExpr }[]; fallback: AotNode[]; loc: SourceLocation };
export interface AotComponent {
  name: string; file: string; root: boolean;
  hooks?: { mount?: AotHandler; unmount?: AotHandler };
  provides?: { key: string; value: AotExpr; loc: SourceLocation }[];
  injections?: { key: string; name: string; type: AotType; loc: SourceLocation }[];
  context?: { key: string; type: AotType }[];
  factory?: { name: string; sourceName: string; module: string; params?: AotField[]; arguments?: AotExpr[] };
  refs?: { name: string; sourceName: string }[];
  props: AotProp[]; events: AotEvent[]; slots: string[];
  slotProps?: AotSlot[];
  values: AotValue[]; functions: AotFunction[]; constants: AotConstant[];
  children: string[]; nodes: AotNode[]; nodeCount: number; memoCount: number; handlerCount: number;
}
export interface AotProgram {
  version: 1; root: string; components: AotComponent[]; types: AotTypeDeclaration[];
  styles: { records: StyleRecord[]; anims: AnimTimeline[]; ids: Record<string, number>; bytes: number[]; usedFontSlots: number[] };
  diagnostics: AotDiagnostic[];
  model?: import("./aot-model-ir.ts").ModelProgram;
  modelProtocol?: true;
  demands?: { buttons: number[]; axes: number[]; capabilities: string[] };
}
/** Keep model bodies off the serializable view boundary. */
export function attachAotModel(program: AotProgram, model: import("./aot-model-ir.ts").ModelProgram): void {
  program.modelProtocol = true;
  Object.defineProperty(program, "model", { value: model, writable: true, configurable: true, enumerable: false });
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

/** All IR consumers reject unsupported versions before inspecting the payload. */
export function checkAotVersion(program: Pick<AotProgram, "version">): void {
  if (program.version !== 1) throw new Error(`Unsupported AOT IR version ${program.version}; expected 1`);
}
