/** The Rust backend's structural output. Source syntax belongs to rust-printer.ts. */
export interface RustModule { items: RustItem[]; attributes?: { name: string; args: string[] }[] }
export interface RustGeneric { name: string; lifetime?: boolean; bounds?: RustType[] }
export type RustType =
  | { kind: "path"; path: string[]; args?: RustType[] }
  | { kind: "ref"; type: RustType; mutable?: boolean; lifetime?: string }
  | { kind: "tuple"; elements: RustType[] }
  | { kind: "slice"; element: RustType }
  | { kind: "array"; element: RustType; length: number }
  | { kind: "lifetime"; name: string }
  | { kind: "infer" };
export interface RustField { name: string; type: RustType; public?: boolean }
export interface RustParam { pattern: RustPattern; type?: RustType }
export interface RustFunction {
  kind: "fn"; name: string; public?: boolean; generics?: RustGeneric[];
  params: RustParam[]; returns?: RustType; body?: RustBlock;
}
export type RustItem =
  | { kind: "use"; path: string[]; names?: string[]; public?: boolean }
  | { kind: "mod"; name: string; public?: boolean }
  | { kind: "extern"; name: string }
  | { kind: "struct"; name: string; public?: boolean; derives?: string[]; generics?: RustGeneric[]; fields?: RustField[]; tuple?: RustType[] }
  | { kind: "enum"; name: string; public?: boolean; derives?: string[]; variants: { name: string; fields?: RustField[]; tuple?: RustType[] }[] }
  | { kind: "trait"; name: string; public?: boolean; generics?: RustGeneric[]; methods: RustFunction[] }
  | { kind: "impl"; type: RustType; trait?: RustType; generics?: RustGeneric[]; methods: RustFunction[] }
  | { kind: "const"; name: string; public?: boolean; type: RustType; value: RustExpr }
  | RustFunction;
export interface RustBlock { statements: RustStatement[]; result?: RustExpr }
export type RustPattern =
  | { kind: "name"; name: string; mutable?: boolean; reference?: boolean }
  | { kind: "wildcard" }
  | { kind: "tuple"; elements: RustPattern[] }
  | { kind: "variant"; path: string[]; fields?: { name: string; pattern?: RustPattern }[]; tuple?: RustPattern[]; rest?: boolean }
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "reference"; pattern: RustPattern }
  | { kind: "or"; patterns: RustPattern[] };
export type RustStatement =
  | { kind: "let"; pattern: RustPattern; type?: RustType; value?: RustExpr }
  | { kind: "expr"; expr: RustExpr; semicolon?: boolean }
  | { kind: "assign"; target: RustExpr; value: RustExpr; operator?: string }
  | { kind: "for"; pattern: RustPattern; iterable: RustExpr; body: RustBlock }
  | { kind: "while"; condition: RustExpr; body: RustBlock }
  | { kind: "return"; value?: RustExpr }
  | { kind: "break" };
export type RustExpr =
  | { kind: "path"; path: string[]; typeArgs?: RustType[] }
  | { kind: "literal"; value: string | number | boolean; suffix?: string; rawNumber?: string }
  | { kind: "call"; callee: RustExpr; args: RustExpr[] }
  | { kind: "method"; object: RustExpr; method: string; args: RustExpr[]; typeArgs?: RustType[] }
  | { kind: "field"; object: RustExpr; field: string | number }
  | { kind: "index"; object: RustExpr; index: RustExpr }
  | { kind: "ref"; expr: RustExpr; mutable?: boolean }
  | { kind: "unary"; operator: string; expr: RustExpr }
  | { kind: "binary"; operator: string; left: RustExpr; right: RustExpr }
  | { kind: "cast"; expr: RustExpr; type: RustType }
  | { kind: "tuple"; elements: RustExpr[] }
  | { kind: "array"; elements: RustExpr[] }
  | { kind: "struct"; path: string[]; fields: { name: string; value?: RustExpr }[]; rest?: RustExpr }
  | { kind: "block"; block: RustBlock }
  | { kind: "if"; condition: RustExpr; then: RustBlock; otherwise?: RustBlock | RustExpr }
  | { kind: "ifLet"; pattern: RustPattern; value: RustExpr; then: RustBlock; otherwise?: RustBlock | RustExpr }
  | { kind: "match"; value: RustExpr; arms: { pattern: RustPattern; guard?: RustExpr; body: RustExpr }[] }
  | { kind: "closure"; params: RustPattern[]; body: RustExpr; move?: boolean }
  | { kind: "macro"; name: string[]; args: RustExpr[] }
  | { kind: "matches"; value: RustExpr; pattern: RustPattern };

export const rt = (name: string, ...args: RustType[]): RustType => ({ kind: "path", path: name.split("::"), ...(args.length ? { args } : {}) });
export const rr = (type: RustType, mutable = false, lifetime?: string): RustType => ({ kind: "ref", type, mutable, lifetime });
export const rp = (...path: string[]): RustExpr => ({ kind: "path", path });
export const rl = (value: string | number | boolean, suffix?: string, rawNumber?: string): RustExpr => ({ kind: "literal", value, suffix, rawNumber });
export const rf = (object: RustExpr, field: string | number): RustExpr => ({ kind: "field", object, field });
export const rm = (object: RustExpr, method: string, ...args: RustExpr[]): RustExpr => ({ kind: "method", object, method, args });
export const rc = (callee: RustExpr, ...args: RustExpr[]): RustExpr => ({ kind: "call", callee, args });
export const ref = (expr: RustExpr, mutable = false): RustExpr => ({ kind: "ref", expr, mutable });
export const rn = (name: string, mutable = false): RustPattern => ({ kind: "name", name, mutable });
export const re = (expr: RustExpr): RustStatement => ({ kind: "expr", expr });
export const rb = (statements: RustStatement[] = [], result?: RustExpr): RustBlock => ({ statements, result });
