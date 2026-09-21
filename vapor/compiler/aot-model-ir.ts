/** Bound, typed model IR for state, expressions, reactions and task continuations. */
import type { AotDiagnostic, AotType, AotTypeDeclaration, SourceLocation } from "./aot-ir.ts";

export interface Ledger {
  reads: number[];
  writes: number[];
  subscriptions: number[];
  external: boolean;
  maySubscribe?: number[];
  mustSubscribe?: number[];
}
export const emptyLedger = (): Ledger => ({ reads: [], writes: [], subscriptions: [], external: false });
export interface ModelBinder {
  id: number; name: string; type: AotType; owned: boolean;
  capacity?: number; viewOf?: number; loc?: SourceLocation;
}
export interface ModelProgram {
  version: 1;
  modules: ModelModule[];
  types: AotTypeDeclaration[];
  diagnostics: AotDiagnostic[];
  recursionLimit: number;
}
export interface ModelSignal {
  id: number; name: string; setter?: string; exported: boolean; type: AotType;
  capacity?: number; seed: ModelExpr; loc?: SourceLocation;
}
export interface ModelField {
  id: number; name: string; type: AotType; capacity?: number; seed: ModelExpr; loc?: SourceLocation;
}
export interface ModelMemo {
  id: number; name: string; exported: boolean; type: AotType;
  body: ModelExpr; inputs: number[]; loc?: SourceLocation;
}
export interface ModelEffect {
  id: number; subscriptions: number[]; declared: boolean; defer: boolean;
  body: ModelBlock; ledger: Ledger; loc?: SourceLocation;
  /** Vue watch parameters are bound from the source values at each run. */
  watch?: { sources: number[]; value?: ModelBinder; previous?: ModelBinder };
}
export interface ModelFunction {
  id: number; name: string; exported: boolean; async: boolean;
  params: ModelBinder[]; returns: AotType; body: ModelBlock; ledger: Ledger;
  loc?: SourceLocation;
}
export interface ModelModule {
  name: string; file: string; kind: "root" | "factory" | "pure";
  factory?: string;
  params: ModelBinder[];
  signals: ModelSignal[];
  fields: ModelField[];
  memos: ModelMemo[];
  effects: ModelEffect[];
  functions: ModelFunction[];
  schedule: number[];
  refs: { id: number; name: string }[];
  tasks: ModelTask[];
  constants?: { id: number; name: string; value: ModelExpr; exported?: boolean }[];
}
export type ModelExpr = (
  | { kind: "literal"; value: string | number | boolean; rawNumber?: string }
  | { kind: "undefined" }
  | { kind: "local" | "signal" | "memo" | "field"; id: number }
  | { kind: "member"; object: ModelExpr; name: string; optional?: boolean; variant?: string }
  | { kind: "index"; object: ModelExpr; index: ModelExpr }
  | { kind: "unary"; operator: "!" | "-" | "+"; operand: ModelExpr }
  | { kind: "binary"; operator: string; left: ModelExpr; right: ModelExpr }
  | { kind: "conditional"; condition: ModelExpr; consequent: ModelExpr; alternate: ModelExpr }
  | { kind: "template"; parts: (string | ModelExpr)[] }
  | { kind: "cast" | "copy"; value: ModelExpr }
  | { kind: "struct"; name: string; fields: { name: string; value: ModelExpr }[]; variant?: string }
  | { kind: "array"; element: AotType; items: ModelExpr[] }
  | { kind: "invoke"; callee: number; args: ModelExpr[] }
  | { kind: "builtin"; name: string; args: ModelExpr[] }
  | { kind: "lambda"; params: ModelBinder[]; body: ModelBlock }
  | { kind: "sequence"; body: ModelBlock; value: ModelExpr }
) & { type: AotType; ledger: Ledger; loc: SourceLocation };
export type ModelTarget =
  | { kind: "local" | "field"; id: number }
  | { kind: "element"; owner: number; index: ModelExpr }
  | { kind: "member"; owner: number; name: string };
export type ModelStmt = (
  | { kind: "let"; binder: ModelBinder; init: ModelExpr }
  | { kind: "assign"; target: ModelTarget; value: ModelExpr }
  | { kind: "set"; signal: number; value: ModelExpr; pre?: ModelBinder; writeBack?: true }
  | { kind: "if"; condition: ModelExpr; then: ModelBlock; else?: ModelBlock }
  | { kind: "for"; binder: ModelBinder; start?: ModelExpr; bound: ModelExpr; inclusive?: boolean; body: ModelBlock }
  | { kind: "forOf"; binder: ModelBinder; source: ModelExpr; body: ModelBlock }
  | { kind: "switch"; value: ModelExpr; cases: { value?: ModelExpr; body: ModelBlock }[] }
  | { kind: "return"; value?: ModelExpr }
  | { kind: "call"; callee: number; args: ModelExpr[] }
  | { kind: "expr"; value: ModelExpr }
  | { kind: "external"; op: "animate" | "jump" | "log" | "request" | "cancel"; args: ModelExpr[] }
  | { kind: "untrack" | "batch"; body: ModelBlock }
  | { kind: "await"; source: ModelAwaitable; binder?: ModelBinder }
  | { kind: "start"; task: number; args: ModelExpr[] }
) & { loc?: SourceLocation; ledger?: Ledger };
export interface ModelBlock { stmts: ModelStmt[]; ledger?: Ledger }
export interface ModelTaskState {
  id: number; body: ModelBlock;
  /** Measurement marker at the entry to one source loop iteration. */
  loop?: true;
  suspend?: ModelAwaitable;
  /** Result of this state's suspension; bound before entering next. */
  resume?: ModelBinder;
  next?: number;
  branch?: { condition: ModelExpr; then: number; else: number };
}
export interface ModelTask {
  id: number; fn: number; fields: ModelBinder[]; states: ModelTaskState[];
}
export type ModelAwaitable =
  | { kind: "frames"; count: ModelExpr }
  | { kind: "after"; ms: ModelExpr }
  | { kind: "service"; module: string; call: string; args: ModelExpr[]; result: AotType; capacity?: number }
  | { kind: "until"; predicate: ModelExpr }
  | { kind: "join"; task: number; wrapped: boolean; args?: ModelExpr[] }
  | { kind: "animate"; args: ModelExpr[] }
  | { kind: "all" | "any"; members: ModelAwaitable[] };

export function checkModelVersion(program: Pick<ModelProgram, "version">): void {
  if (program.version !== 1) throw new Error(`Unsupported Model IR version ${program.version}; expected 1`);
}
