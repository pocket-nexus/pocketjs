// micro/compiler/ir.ts — Micro IR: the typed, structured program the Micro TS
// frontend produces and every backend consumes.
//
// The IR is plain JSON data. Expressions carry their static type; template
// bindings carry the signal ids they read; every element has a compiler-
// assigned index (its `NodeId` field in the generated app) and a document-
// order key (focus traversal). Nothing here names a JS runtime concept:
// signals are numbered slots, handlers are numbered bodies, components have
// been inlined at their use sites, and props are gone.

export type Ty = "int" | "num" | "bool" | "str" | "undef" | "node" | "void";

export type BinOp =
  | "+" | "-" | "*" | "/" | "%"
  | "<" | "<=" | ">" | ">="
  | "==" | "!="
  | "&&" | "||";

export type Builtin = "floor" | "ceil" | "round" | "trunc" | "abs" | "min" | "max";

export type Expr =
  | { k: "int"; v: number }
  | { k: "num"; v: number }
  | { k: "bool"; v: boolean }
  | { k: "str"; v: string }
  | { k: "undef" }
  /** `count()` — a signal read. */
  | { k: "signal"; id: number; ty: Ty }
  /** A `let`/`const` declared in the enclosing body. */
  | { k: "local"; name: string; ty: Ty }
  /** A `ref`-bound template element (`let underline: NodeMirror | undefined`). */
  | { k: "noderef"; element: number; name: string }
  | { k: "unary"; op: "!" | "-"; e: Expr; ty: Ty }
  | { k: "binary"; op: BinOp; l: Expr; r: Expr; ty: Ty }
  | { k: "cond"; c: Expr; t: Expr; f: Expr; ty: Ty }
  /** JS truthiness of `e`, as a bool. */
  | { k: "truthy"; e: Expr }
  /** Template literal / string `+`: every part is a str. */
  | { k: "concat"; parts: Expr[] }
  /** `String(e)` and text interpolation. */
  | { k: "tostr"; e: Expr }
  | { k: "call"; fn: Builtin; args: Expr[]; ty: Ty };

export type Stmt =
  | { k: "let"; name: string; ty: Ty; init: Expr }
  | { k: "assign"; name: string; e: Expr }
  /** `setCount(e)` */
  | { k: "set"; signal: number; e: Expr }
  | { k: "if"; c: Expr; then: Stmt[]; else?: Stmt[] }
  | {
      k: "animate";
      target: number;
      prop: string;
      propId: number;
      to: Expr;
      durMs: Expr;
      easing: number;
      delayMs: Expr;
    }
  | { k: "jump"; target: number; prop: string; propId: number; value: Expr }
  | { k: "return" }
  /** A statement the frontend folded away (an absent optional callback). */
  | { k: "nop"; note: string };

export interface Binding {
  expr: Expr;
  /** Signal ids the expression reads, ascending. Empty = static. */
  deps: number[];
}

export interface StyleBinding {
  prop: string;
  propId: number;
  value: Binding;
}

export interface ElementNode {
  k: "element";
  /** Index into the generated app's `NodeId` table. */
  id: number;
  tag: "view" | "text" | "image";
  /** Template pre-order position: the focus traversal key. */
  order: number;
  /** Source component and JSX tag, for readers of the generated code. */
  origin: string;
  class?: Binding;
  style?: StyleBinding[];
  /** The text run of a `text` element (children concatenated). */
  text?: Binding;
  src?: string;
  sprite?: { key: string; frameStep?: number };
  focusable?: boolean;
  /** Press handler id of this element or of its nearest ancestor with one. */
  handler?: number;
  /** Handler declared on this very element (before bubbling resolution). */
  ownHandler?: number;
  debugName?: string;
  refs?: string[];
  children: Node[];
}

export interface ShowNode {
  k: "show";
  id: number;
  when: Binding;
  /** Element id of the next static sibling, or null to append. */
  anchor: number | null;
  /** Element ids of every focusable inside, with their handler ids. */
  focusables: { element: number; order: number; handler?: number }[];
  children: Node[];
}

export type Node = ElementNode | ShowNode;

export interface Signal {
  id: number;
  name: string;
  ty: Ty;
  init: Expr;
}

export interface Program {
  version: 1;
  title: string;
  entry: string;
  module: string;
  component: string;
  signals: Signal[];
  refs: { name: string; element: number }[];
  effects: { id: number; deps: number[]; body: Stmt[] }[];
  mounts: { id: number; body: Stmt[] }[];
  handlers: { id: number; element: number; body: Stmt[] }[];
  /** `createEffect`/`onMount` order as declared — the order they first run. */
  setupOrder: { kind: "effect" | "mount"; id: number }[];
  root: Node[];
  elements: number;
  shows: number;
  /** Root-level focusables (outside any Show block). */
  focusables: { element: number; order: number; handler?: number }[];
  assets: {
    /** Every class literal, in first-seen order (styles.bin record source). */
    classes: string[];
    /** Every string literal the app can display (font glyph coverage). */
    strings: string[];
    images: string[];
    sprites: string[];
  };
}

export function tyOf(e: Expr): Ty {
  switch (e.k) {
    case "int": return "int";
    case "num": return "num";
    case "bool": return "bool";
    case "str": return "str";
    case "undef": return "undef";
    case "noderef": return "node";
    case "truthy": return "bool";
    case "concat": return "str";
    case "tostr": return "str";
    default: return e.ty;
  }
}

export function isNumeric(t: Ty): boolean {
  return t === "int" || t === "num";
}

/** The type a value of `a` or `b` takes when both flow into one place. */
export function joinTy(a: Ty, b: Ty): Ty | null {
  if (a === b) return a;
  if (isNumeric(a) && isNumeric(b)) return "num";
  if (a === "undef") return b;
  if (b === "undef") return a;
  return null;
}

export function collectDeps(e: Expr, out: Set<number>): void {
  switch (e.k) {
    case "signal": out.add(e.id); return;
    case "unary": collectDeps(e.e, out); return;
    case "binary": collectDeps(e.l, out); collectDeps(e.r, out); return;
    case "cond": collectDeps(e.c, out); collectDeps(e.t, out); collectDeps(e.f, out); return;
    case "truthy": collectDeps(e.e, out); return;
    case "concat": for (const p of e.parts) collectDeps(p, out); return;
    case "tostr": collectDeps(e.e, out); return;
    case "call": for (const a of e.args) collectDeps(a, out); return;
    default: return;
  }
}

export function collectStmtDeps(stmts: Stmt[], out: Set<number>): void {
  for (const s of stmts) {
    switch (s.k) {
      case "let": collectDeps(s.init, out); break;
      case "assign": collectDeps(s.e, out); break;
      case "set": collectDeps(s.e, out); break;
      case "if":
        collectDeps(s.c, out);
        collectStmtDeps(s.then, out);
        if (s.else) collectStmtDeps(s.else, out);
        break;
      case "animate": collectDeps(s.to, out); collectDeps(s.durMs, out); collectDeps(s.delayMs, out); break;
      case "jump": collectDeps(s.value, out); break;
      default: break;
    }
  }
}

export function binding(expr: Expr): Binding {
  const deps = new Set<number>();
  collectDeps(expr, deps);
  return { expr, deps: [...deps].sort((a, b) => a - b) };
}

/** String literals reachable from an expression (class leaves, text parts). */
export function strLeaves(e: Expr, out: string[]): boolean {
  switch (e.k) {
    case "str": out.push(e.v); return true;
    case "cond": return strLeaves(e.t, out) && strLeaves(e.f, out);
    default: return false;
  }
}

export function walkNodes(nodes: Node[], visit: (n: Node) => void): void {
  for (const n of nodes) {
    visit(n);
    walkNodes(n.children, visit);
  }
}
