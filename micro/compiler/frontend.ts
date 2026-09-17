// micro/compiler/frontend.ts — the Micro TS frontend: one Solid component
// module (plus its mounting entry) in the Micro TS subset -> Micro IR.
//
// Micro TS is the part of TypeScript + Solid + the PocketJS component API that
// has a static shape: signals with a closed set of write sites, effects and
// lifecycle hooks with block bodies, JSX over the host primitives, class
// strings that are literals or ternaries of literals, style objects of
// numeric expressions, and components that inline at their use sites. The
// subset is enforced here with file:line:column diagnostics; membership has
// the same operational definition as Pocket Vapor: the same file runs
// unmodified under real Solid on a JS host.
//
// What the frontend does that a JS runtime does at run time:
//   - resolves every `props.x` read against the use site (root props from
//     `mount(() => <Hero .../>)`), so props and components have no runtime
//     existence;
//   - numbers every `createSignal` as a slot and every binding, effect and
//     handler as a body with a static signal dependency set;
//   - infers `int` (i32) vs `num` (f64) for numbers from literals and write
//     sites, iterating to a fixpoint so a signal widens if any write is
//     fractional;
//   - assigns each template element its `NodeId` index and document-order
//     key, resolves onPress bubbling statically, and turns `<Show>` /
//     `cond ? <A/> : null` into conditional blocks with static anchors.

import ts from "typescript";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { abgr, animBit, ENUMS, PROP, PROP_VALUE_KIND, VALUE_KIND, type PropName } from "../../contracts/spec/spec.ts";
import {
  binding,
  collectStmtDeps,
  isNumeric,
  joinTy,
  strLeaves,
  tyOf,
  type Binding,
  type Builtin,
  type ElementNode,
  type Expr,
  type Node,
  type Program,
  type ShowNode,
  type Stmt,
  type Ty,
} from "./ir.ts";

export class MicroCompileError extends Error {
  constructor(sf: ts.SourceFile, node: ts.Node, message: string) {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    super(`${sf.fileName}:${line + 1}:${character + 1} — ${message}`);
    this.name = "MicroCompileError";
  }
}

// ---------------------------------------------------------------------------
// Module model
// ---------------------------------------------------------------------------

const FRAMEWORK = "@pocketjs/framework";
const COMPONENT_MODULES = new Set([`${FRAMEWORK}/components`, `${FRAMEWORK}/solid/components`]);
const ANIMATION_MODULES = new Set([`${FRAMEWORK}/animation`, `${FRAMEWORK}/solid/animation`]);
const RUNTIME_MODULES = new Set([FRAMEWORK, `${FRAMEWORK}/solid`]);
const CLOCK_MODULES = new Set([`${FRAMEWORK}/clock`, `${FRAMEWORK}/solid/clock`]);
const HOST_TAGS: Record<string, "view" | "text" | "image"> = { View: "view", Text: "text", Image: "image", Sprite: "image" };
const SOLID_ALLOWED = new Set(["createSignal", "createEffect", "onMount", "onCleanup", "Show"]);
const EASING_BY_NAME: Record<string, number> = {
  linear: ENUMS.Easing.Linear,
  in: ENUMS.Easing.EaseIn,
  out: ENUMS.Easing.EaseOut,
  "in-out": ENUMS.Easing.EaseInOut,
  "out-back": ENUMS.Easing.OutBack,
  spring: ENUMS.Easing.Spring,
  "spring-bouncy": ENUMS.Easing.SpringBouncy,
};
const BUILTINS = new Set<string>(["floor", "ceil", "round", "trunc", "abs", "min", "max"]);

interface Import {
  module: string;
  name: string;
}

type FnLike = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

interface ModuleInfo {
  path: string;
  sf: ts.SourceFile;
  imports: Map<string, Import>;
  /** Module-level component/helper functions by local name. */
  functions: Map<string, FnLike>;
  /** Module-level `const X = <expr>` initializers. */
  consts: Map<string, ts.Expression>;
  defaultExport?: FnLike;
}

type PropValue =
  | { k: "expr"; e: Expr }
  | { k: "fn"; node: FnLike; scope: Scope }
  | { k: "jsx"; nodes: readonly ts.JsxChild[]; scope: Scope };

interface Scope {
  mod: ModuleInfo;
  componentName: string;
  propsName?: string;
  props: Map<string, PropValue>;
  signals: Map<string, number>;
  setters: Map<string, number>;
  refs: Map<string, { element: number | null }>;
  derived: Map<string, FnLike>;
  consts: Map<string, Expr>;
}

interface Body {
  locals: Map<string, Ty>;
  /** Inlined function parameters bound to caller expressions. */
  params: Map<string, Expr>;
}

interface Focusable {
  element: number;
  order: number;
  handler?: number;
}

interface Ctx {
  program: Program;
  nextElement: number;
  nextOrder: number;
  nextShow: number;
  nextHandler: number;
  nextEffect: number;
  nextMount: number;
  nextSignal: number;
  classes: string[];
  strings: Set<string>;
  images: Set<string>;
  sprites: Set<string>;
  /** Signal types widened by write sites in a previous pass. */
  signalTy: Map<number, Ty>;
  handlerStack: (number | undefined)[];
  focusTargets: Focusable[][];
  deferred: (() => void)[];
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export interface CompileOptions {
  /** Override the file reader (tests). */
  read?: (path: string) => string;
  /** Override the existence check (tests with virtual files). */
  exists?: (path: string) => boolean;
}

/** Compile `apps/<app>/main.tsx` (the mounting entry) to Micro IR. */
export function compileMicro(entryPath: string, options: CompileOptions = {}): Program {
  const read = options.read ?? ((p: string) => readFileSync(p, "utf8"));
  const exists = options.exists ?? existsSync;
  const entry = loadModule(resolve(entryPath), read, exists);
  const mountInfo = findMount(entry, exists);
  const componentModule = loadModule(mountInfo.modulePath, read, exists);
  const component = componentModule.defaultExport;
  if (!component) {
    throw new MicroCompileError(componentModule.sf, componentModule.sf, "the component module needs one default-exported function");
  }
  let signalTy = new Map<number, Ty>();
  for (let pass = 0; pass < 4; pass++) {
    const ctx = newCtx(entryPath, componentModule.path, mountInfo.title, signalTy);
    const rootScope = emptyScope(entry, "<entry>");
    const props = new Map<string, PropValue>();
    for (const attr of mountInfo.attributes) {
      props.set(attr.name, propValueOf(attr.value, rootScope, ctx, entry));
    }
    const nodes = lowerComponent(component, componentModule, props, ctx, componentName(component, "App"));
    for (const run of ctx.deferred) run();
    ctx.program.root = nodes;
    ctx.program.component = componentName(component, "App");
    finalize(ctx);
    const widened = widenSignals(ctx.program, signalTy);
    if (!widened) return ctx.program;
    signalTy = widened;
  }
  throw new Error("Micro TS: signal types did not converge");
}

function newCtx(entry: string, module: string, title: string, signalTy: Map<number, Ty>): Ctx {
  const rel = (p: string) => relative(process.cwd(), p).replace(/\\/g, "/");
  return {
    program: {
      version: 1,
      title,
      entry: rel(resolve(entry)),
      module: rel(module),
      component: "",
      signals: [],
      refs: [],
      effects: [],
      mounts: [],
      handlers: [],
      setupOrder: [],
      root: [],
      elements: 0,
      shows: 0,
      focusables: [],
      assets: { classes: [], strings: [], images: [], sprites: [] },
    },
    nextElement: 0,
    nextOrder: 0,
    nextShow: 0,
    nextHandler: 0,
    nextEffect: 0,
    nextMount: 0,
    nextSignal: 0,
    classes: [],
    strings: new Set(),
    images: new Set(),
    sprites: new Set(),
    signalTy,
    handlerStack: [],
    focusTargets: [],
    deferred: [],
  };
}

function finalize(ctx: Ctx): void {
  const p = ctx.program;
  p.elements = ctx.nextElement;
  p.shows = ctx.nextShow;
  p.assets.classes = ctx.classes;
  p.assets.strings = [...ctx.strings];
  p.assets.images = [...ctx.images];
  p.assets.sprites = [...ctx.sprites];
}

/** A signal's type is the join of its seed and every write; return the
 *  widened map when a pass changed one, else null. */
function widenSignals(p: Program, current: Map<number, Ty>): Map<number, Ty> | null {
  const next = new Map(current);
  let changed = false;
  const visit = (stmts: Stmt[]) => {
    for (const s of stmts) {
      if (s.k === "set") {
        const sig = p.signals[s.signal];
        const j = joinTy(sig.ty, tyOf(s.e));
        if (j && j !== sig.ty && j !== next.get(s.signal)) {
          next.set(s.signal, j);
          changed = true;
        }
      } else if (s.k === "if") {
        visit(s.then);
        if (s.else) visit(s.else);
      }
    }
  };
  for (const h of p.handlers) visit(h.body);
  for (const e of p.effects) visit(e.body);
  for (const m of p.mounts) visit(m.body);
  return changed ? next : null;
}

function componentName(fn: FnLike, fallback: string): string {
  if (ts.isFunctionDeclaration(fn) && fn.name) return fn.name.text;
  return fallback;
}

function emptyScope(mod: ModuleInfo, name: string): Scope {
  return {
    mod,
    componentName: name,
    props: new Map(),
    signals: new Map(),
    setters: new Map(),
    refs: new Map(),
    derived: new Map(),
    consts: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Module loading
// ---------------------------------------------------------------------------

function loadModule(path: string, read: (p: string) => string, exists: (p: string) => boolean): ModuleInfo {
  if (!exists(path)) throw new Error(`Micro TS: cannot find module ${path}`);
  const source = read(path);
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const diagnostics = (sf as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const d = diagnostics[0];
    const { line, character } = sf.getLineAndCharacterOfPosition(d.start ?? 0);
    throw new Error(`${path}:${line + 1}:${character + 1} — ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
  }
  const mod: ModuleInfo = { path, sf, imports: new Map(), functions: new Map(), consts: new Map() };
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      const clause = st.importClause;
      if (!clause || clause.isTypeOnly || !ts.isStringLiteral(st.moduleSpecifier)) continue;
      const module = st.moduleSpecifier.text;
      if (clause.name) mod.imports.set(clause.name.text, { module, name: "default" });
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          if (el.isTypeOnly) continue;
          mod.imports.set(el.name.text, { module, name: (el.propertyName ?? el.name).text });
        }
      }
      continue;
    }
    if (ts.isFunctionDeclaration(st) && st.name) {
      mod.functions.set(st.name.text, st);
      if (st.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) mod.defaultExport = st;
      continue;
    }
    if (ts.isExportAssignment(st) && !st.isExportEquals) {
      const e = unwrap(st.expression);
      if (ts.isIdentifier(e)) {
        const fn = mod.functions.get(e.text);
        if (fn) mod.defaultExport = fn;
      } else if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
        mod.defaultExport = e;
      }
      continue;
    }
    if (ts.isVariableStatement(st)) {
      for (const decl of st.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const init = unwrap(decl.initializer);
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) mod.functions.set(decl.name.text, init);
        else mod.consts.set(decl.name.text, init);
      }
    }
  }
  return mod;
}

function unwrap(e: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isTypeAssertionExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

interface MountInfo {
  modulePath: string;
  title: string;
  attributes: { name: string; value: ts.JsxAttributeValue | undefined }[];
}

/** `mount(() => <Hero .../>)` / `mount(Hero)` / `render(...)` in the entry. */
function findMount(entry: ModuleInfo, exists: (p: string) => boolean): MountInfo {
  const title = entry.sf.getFullText().match(/^\/\/\s*@title\s+(.+)$/m)?.[1].trim() ?? "Pocket Micro";
  for (const st of entry.sf.statements) {
    if (!ts.isExpressionStatement(st) || !ts.isCallExpression(st.expression)) continue;
    const call = st.expression;
    if (!ts.isIdentifier(call.expression)) continue;
    const imp = entry.imports.get(call.expression.text);
    if (!imp || !RUNTIME_MODULES.has(imp.module) || (imp.name !== "mount" && imp.name !== "render")) continue;
    if (call.arguments.length < 1) throw new MicroCompileError(entry.sf, call, "mount() takes the root component");
    let arg = unwrap(call.arguments[0]);
    let tagName: string;
    let attributes: MountInfo["attributes"] = [];
    if (ts.isArrowFunction(arg)) arg = unwrap(arg.body as ts.Expression);
    if (ts.isJsxSelfClosingElement(arg) || ts.isJsxElement(arg)) {
      const opening = ts.isJsxElement(arg) ? arg.openingElement : arg;
      if (!ts.isIdentifier(opening.tagName)) throw new MicroCompileError(entry.sf, opening, "the root element must name an imported component");
      tagName = opening.tagName.text;
      for (const a of opening.attributes.properties) {
        if (!ts.isJsxAttribute(a) || !ts.isIdentifier(a.name)) throw new MicroCompileError(entry.sf, a, "root props are plain attributes");
        attributes.push({ name: a.name.text, value: a.initializer });
      }
    } else if (ts.isIdentifier(arg)) {
      tagName = arg.text;
    } else {
      throw new MicroCompileError(entry.sf, arg, "mount() takes `() => <Component />` or the component itself");
    }
    const compImport = entry.imports.get(tagName);
    if (!compImport || compImport.name !== "default" || !compImport.module.startsWith(".")) {
      throw new MicroCompileError(entry.sf, call, `${tagName} must be the default import of a relative component module`);
    }
    let modulePath = resolve(dirname(entry.path), compImport.module);
    if (!exists(modulePath)) {
      for (const ext of [".tsx", ".ts"]) if (exists(modulePath + ext)) modulePath += ext;
    }
    return { modulePath, title, attributes };
  }
  throw new MicroCompileError(entry.sf, entry.sf, "the entry needs a `mount(() => <Component />)` statement");
}

// ---------------------------------------------------------------------------
// Component lowering
// ---------------------------------------------------------------------------

function fnBody(fn: FnLike): readonly ts.Statement[] | ts.Expression {
  if (!fn.body) return [];
  if (ts.isBlock(fn.body)) return fn.body.statements;
  return fn.body;
}

function lowerComponent(fn: FnLike, mod: ModuleInfo, props: Map<string, PropValue>, ctx: Ctx, name: string): Node[] {
  const scope = emptyScope(mod, name);
  scope.props = props;
  const param = fn.parameters[0];
  if (param) {
    if (!ts.isIdentifier(param.name)) throw new MicroCompileError(mod.sf, param, "the props parameter must be a plain identifier");
    scope.propsName = param.name.text;
  }
  if (fn.parameters.length > 1) throw new MicroCompileError(mod.sf, fn.parameters[1], "a component takes one props parameter");
  const body = fnBody(fn);
  if (!Array.isArray(body)) {
    return lowerTemplate(body as ts.Expression, scope, ctx);
  }
  const statements = body as readonly ts.Statement[];
  let template: ts.Expression | undefined;
  const lifecycle: { kind: "effect" | "mount"; fn: FnLike; node: ts.Node }[] = [];
  for (const st of statements) {
    if (ts.isReturnStatement(st)) {
      if (!st.expression) throw new MicroCompileError(mod.sf, st, "a component returns JSX");
      template = st.expression;
      continue;
    }
    if (template) throw new MicroCompileError(mod.sf, st, "the JSX return is the last statement of a component");
    if (ts.isVariableStatement(st)) {
      const isLet = (st.declarationList.flags & ts.NodeFlags.Let) !== 0;
      for (const decl of st.declarationList.declarations) {
        if (ts.isArrayBindingPattern(decl.name)) {
          registerSignal(decl, scope, ctx);
          continue;
        }
        if (!ts.isIdentifier(decl.name)) throw new MicroCompileError(mod.sf, decl, "destructuring is outside Micro TS");
        const local = decl.name.text;
        if (!decl.initializer) {
          if (!isLet) throw new MicroCompileError(mod.sf, decl, "a const needs an initializer");
          scope.refs.set(local, { element: null });
          continue;
        }
        const init = unwrap(decl.initializer);
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          scope.derived.set(local, init);
          continue;
        }
        if (isLet) throw new MicroCompileError(mod.sf, decl, "setup-level `let` is a ref slot and takes no initializer; use const for values");
        const e = lowerExpr(init, scope, null, ctx);
        const deps = binding(e).deps;
        if (deps.length > 0) {
          throw new MicroCompileError(mod.sf, decl, `\`${local}\` reads a signal once at setup, which is not reactive; wrap it in a function`);
        }
        scope.consts.set(local, e);
      }
      continue;
    }
    if (ts.isFunctionDeclaration(st) && st.name) {
      scope.derived.set(st.name.text, st);
      continue;
    }
    if (ts.isExpressionStatement(st) && ts.isCallExpression(st.expression) && ts.isIdentifier(st.expression.expression)) {
      const call = st.expression;
      const imp = mod.imports.get((call.expression as ts.Identifier).text);
      if (imp && imp.module === "solid-js") {
        const arg = call.arguments[0] ? unwrap(call.arguments[0]) : undefined;
        if (imp.name === "createEffect" || imp.name === "onMount") {
          if (!arg || !(ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) {
            throw new MicroCompileError(mod.sf, call, `${imp.name} takes an inline function`);
          }
          lifecycle.push({ kind: imp.name === "createEffect" ? "effect" : "mount", fn: arg, node: call });
          continue;
        }
        if (imp.name === "onCleanup") continue; // the root never unmounts
      }
      throw new MicroCompileError(mod.sf, st, "setup statements are signals, refs, derived functions, createEffect, onMount and the JSX return");
    }
    throw new MicroCompileError(mod.sf, st, "statement is outside the Micro TS setup subset");
  }
  if (!template) throw new MicroCompileError(mod.sf, fn, "a component returns JSX");
  const nodes = lowerTemplate(template, scope, ctx);
  // Effects, mounts and handlers see every ref bound; they lower after the
  // whole template, in declaration order.
  for (const item of lifecycle) {
    const body = newBody();
    const stmts = lowerFnBody(item.fn, scope, body, ctx);
    if (item.kind === "effect") {
      const deps = new Set<number>();
      collectStmtDeps(stmts, deps);
      const id = ctx.nextEffect++;
      ctx.program.effects.push({ id, deps: [...deps].sort((a, b) => a - b), body: stmts });
      ctx.program.setupOrder.push({ kind: "effect", id });
    } else {
      const id = ctx.nextMount++;
      ctx.program.mounts.push({ id, body: stmts });
      ctx.program.setupOrder.push({ kind: "mount", id });
    }
  }
  return nodes;
}

function registerSignal(decl: ts.VariableDeclaration, scope: Scope, ctx: Ctx): void {
  const sf = scope.mod.sf;
  const pattern = decl.name as ts.ArrayBindingPattern;
  const init = decl.initializer ? unwrap(decl.initializer) : undefined;
  if (
    !init ||
    !ts.isCallExpression(init) ||
    !ts.isIdentifier(init.expression) ||
    scope.mod.imports.get(init.expression.text)?.name !== "createSignal"
  ) {
    throw new MicroCompileError(sf, decl, "array destructuring is only `const [get, set] = createSignal(init)`");
  }
  const names = pattern.elements.map((el) => {
    if (!ts.isBindingElement(el) || !ts.isIdentifier(el.name)) throw new MicroCompileError(sf, el, "createSignal binds two identifiers");
    return el.name.text;
  });
  if (names.length !== 2) throw new MicroCompileError(sf, pattern, "createSignal binds [accessor, setter]");
  if (init.arguments.length < 1) throw new MicroCompileError(sf, init, "createSignal needs an initial value in Micro TS");
  const seed = lowerExpr(init.arguments[0], scope, null, ctx);
  const seedTy = tyOf(seed);
  if (!isNumeric(seedTy) && seedTy !== "bool" && seedTy !== "str") {
    throw new MicroCompileError(sf, init, "signals hold numbers, booleans or strings");
  }
  if (binding(seed).deps.length > 0) throw new MicroCompileError(sf, init, "a signal seed cannot read another signal");
  const id = ctx.nextSignal++;
  const ty = ctx.signalTy.get(id) ?? seedTy;
  ctx.program.signals.push({ id, name: names[0], ty, init: seed });
  scope.signals.set(names[0], id);
  scope.setters.set(names[1], id);
}

function newBody(): Body {
  return { locals: new Map(), params: new Map() };
}

// ---------------------------------------------------------------------------
// Template lowering
// ---------------------------------------------------------------------------

function lowerTemplate(expr: ts.Expression, scope: Scope, ctx: Ctx): Node[] {
  const e = unwrap(expr);
  if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e) || ts.isJsxFragment(e)) {
    return lowerJsx(e, scope, ctx);
  }
  if (e.kind === ts.SyntaxKind.NullKeyword) return [];
  throw new MicroCompileError(scope.mod.sf, e, "a component returns a JSX element, a fragment or null");
}

type JsxLike = ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment;

function lowerJsx(el: JsxLike, scope: Scope, ctx: Ctx): Node[] {
  const sf = scope.mod.sf;
  if (ts.isJsxFragment(el)) return lowerChildren(el.children, scope, ctx, "view");
  const opening = ts.isJsxElement(el) ? el.openingElement : el;
  const children: readonly ts.JsxChild[] = ts.isJsxElement(el) ? el.children : [];
  if (!ts.isIdentifier(opening.tagName)) throw new MicroCompileError(sf, opening, "JSX tags are imported components or host primitives");
  const tagName = opening.tagName.text;
  const imp = scope.mod.imports.get(tagName);
  if (imp && COMPONENT_MODULES.has(imp.module)) {
    const tag = HOST_TAGS[imp.name];
    if (!tag) throw new MicroCompileError(sf, opening, `${imp.name} has no native lowering in Micro TS (View, Text, Image and Sprite do)`);
    return [lowerElement(tag, imp.name, opening, children, scope, ctx)];
  }
  if (imp && imp.module === "solid-js") {
    if (imp.name === "Show") return [lowerShow(opening, children, scope, ctx)];
    throw new MicroCompileError(sf, opening, `solid-js <${imp.name}> is outside Micro TS`);
  }
  if (imp && imp.module.startsWith(".")) {
    throw new MicroCompileError(sf, opening, "child components from other modules are outside Micro TS v1; define them in the component module");
  }
  const fn = scope.mod.functions.get(tagName);
  if (fn) {
    const props = new Map<string, PropValue>();
    for (const a of opening.attributes.properties) {
      if (!ts.isJsxAttribute(a) || !ts.isIdentifier(a.name)) throw new MicroCompileError(sf, a, "spread props are outside Micro TS");
      props.set(a.name.text, propValueOf(a.initializer, scope, ctx, scope.mod));
    }
    if (children.length > 0) {
      const meaningful = children.filter((c) => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces));
      if (meaningful.length > 0) props.set("children", { k: "jsx", nodes: meaningful, scope });
    }
    return lowerComponent(fn, scope.mod, props, ctx, tagName);
  }
  throw new MicroCompileError(sf, opening, `unknown JSX tag <${tagName}>`);
}

function propValueOf(init: ts.JsxAttributeValue | undefined, scope: Scope, ctx: Ctx, mod: ModuleInfo): PropValue {
  if (init === undefined) return { k: "expr", e: { k: "bool", v: true } };
  if (ts.isStringLiteral(init)) {
    ctx.strings.add(init.text);
    return { k: "expr", e: { k: "str", v: init.text } };
  }
  if (ts.isJsxExpression(init)) {
    if (!init.expression) throw new MicroCompileError(mod.sf, init, "empty JSX expression");
    const e = unwrap(init.expression);
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return { k: "fn", node: e, scope };
    if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e) || ts.isJsxFragment(e)) return { k: "jsx", nodes: [e], scope };
    return { k: "expr", e: lowerExpr(e, scope, null, ctx) };
  }
  if (ts.isJsxElement(init) || ts.isJsxSelfClosingElement(init) || ts.isJsxFragment(init)) return { k: "jsx", nodes: [init], scope };
  throw new MicroCompileError(mod.sf, init, "unsupported attribute value");
}

function lowerChildren(children: readonly ts.JsxChild[], scope: Scope, ctx: Ctx, parentTag: "view" | "image"): Node[] {
  const sf = scope.mod.sf;
  const out: Node[] = [];
  for (const child of children) {
    if (ts.isJsxText(child)) {
      if (child.containsOnlyTriviaWhiteSpaces || cleanJsxText(child.text) === "") continue;
      throw new MicroCompileError(sf, child, "text belongs inside <Text>");
    }
    if (ts.isJsxExpression(child)) {
      if (!child.expression) continue;
      const e = unwrap(child.expression);
      if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e) || ts.isJsxFragment(e)) {
        out.push(...lowerJsx(e, scope, ctx));
        continue;
      }
      if (ts.isConditionalExpression(e)) {
        const whenTrue = unwrap(e.whenTrue);
        const whenFalse = unwrap(e.whenFalse);
        const isJsx = (n: ts.Expression) => ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n);
        const isNull = (n: ts.Expression) => n.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(n) && n.text === "undefined");
        if (isJsx(whenTrue) && isNull(whenFalse)) {
          out.push(makeShow(lowerExpr(e.condition, scope, null, ctx), () => lowerJsx(whenTrue as JsxLike, scope, ctx), ctx));
          continue;
        }
        if (isNull(whenTrue) && isJsx(whenFalse)) {
          const c = lowerExpr(e.condition, scope, null, ctx);
          out.push(makeShow({ k: "unary", op: "!", e: truthy(c), ty: "bool" }, () => lowerJsx(whenFalse as JsxLike, scope, ctx), ctx));
          continue;
        }
        throw new MicroCompileError(sf, e, "a conditional child is `cond ? <Element/> : null`");
      }
      if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        const right = unwrap(e.right);
        if (ts.isJsxElement(right) || ts.isJsxSelfClosingElement(right) || ts.isJsxFragment(right)) {
          out.push(makeShow(lowerExpr(e.left, scope, null, ctx), () => lowerJsx(right, scope, ctx), ctx));
          continue;
        }
      }
      if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === scope.propsName) {
        const pv = scope.props.get(e.name.text);
        if (pv === undefined) continue; // absent optional children
        if (pv.k === "jsx") {
          out.push(...lowerChildren(pv.nodes, pv.scope, ctx, parentTag));
          continue;
        }
        throw new MicroCompileError(sf, e, `props.${e.name.text} is not JSX at this use site`);
      }
      if (e.kind === ts.SyntaxKind.NullKeyword) continue;
      throw new MicroCompileError(sf, e, "view children are elements, `cond ? <Element/> : null` blocks, or JSX props");
    }
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) {
      out.push(...lowerJsx(child, scope, ctx));
      continue;
    }
    throw new MicroCompileError(sf, child, "unsupported JSX child");
  }
  // Conditional blocks anchor on their next static sibling.
  for (let i = 0; i < out.length; i++) {
    const n = out[i];
    if (n.k !== "show") continue;
    const next = out[i + 1];
    if (next === undefined) n.anchor = null;
    else if (next.k === "element") n.anchor = next.id;
    else throw new Error(`Micro TS: two conditional blocks in a row need a static element between them (block ${n.id})`);
  }
  return out;
}

function makeShow(cond: Expr, lowerBody: () => Node[], ctx: Ctx): ShowNode {
  const id = ctx.nextShow++;
  const focusables: Focusable[] = [];
  ctx.focusTargets.push(focusables);
  const children = lowerBody();
  ctx.focusTargets.pop();
  return { k: "show", id, when: binding(truthy(cond)), anchor: null, focusables, children };
}

function lowerShow(opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement, children: readonly ts.JsxChild[], scope: Scope, ctx: Ctx): ShowNode {
  const sf = scope.mod.sf;
  let when: Expr | undefined;
  for (const a of opening.attributes.properties) {
    if (!ts.isJsxAttribute(a) || !ts.isIdentifier(a.name)) throw new MicroCompileError(sf, a, "spread props are outside Micro TS");
    if (a.name.text === "when") {
      if (!a.initializer || !ts.isJsxExpression(a.initializer) || !a.initializer.expression) {
        throw new MicroCompileError(sf, a, "<Show when={...}> takes an expression");
      }
      when = lowerExpr(a.initializer.expression, scope, null, ctx);
    } else if (a.name.text === "keyed") {
      continue;
    } else {
      throw new MicroCompileError(sf, a, `<Show ${a.name.text}> is outside Micro TS (when only)`);
    }
  }
  if (!when) throw new MicroCompileError(sf, opening, "<Show> needs `when`");
  return makeShow(when, () => lowerChildren(children, scope, ctx, "view"), ctx);
}

function lowerElement(
  tag: "view" | "text" | "image",
  jsxName: string,
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  children: readonly ts.JsxChild[],
  scope: Scope,
  ctx: Ctx,
): ElementNode {
  const sf = scope.mod.sf;
  const id = ctx.nextElement++;
  const order = ctx.nextOrder++;
  const node: ElementNode = { k: "element", id, tag, order, origin: `${scope.componentName}:<${jsxName}>`, children: [] };
  let ownHandler: number | undefined;
  for (const a of opening.attributes.properties) {
    if (!ts.isJsxAttribute(a) || !ts.isIdentifier(a.name)) throw new MicroCompileError(sf, a, "spread props are outside Micro TS");
    const name = a.name.text;
    const init = a.initializer;
    const exprOf = (): ts.Expression => {
      if (!init) throw new MicroCompileError(sf, a, `${name} needs a value`);
      if (ts.isStringLiteral(init)) return init;
      if (ts.isJsxExpression(init) && init.expression) return init.expression;
      throw new MicroCompileError(sf, a, `${name} needs a string or {expression}`);
    };
    switch (name) {
      case "class":
      case "className": {
        const e = lowerExpr(exprOf(), scope, null, ctx);
        const leaves: string[] = [];
        if (tyOf(e) !== "str" || !strLeaves(e, leaves)) {
          throw new MicroCompileError(sf, a, "class is a string literal or a ternary of full class literals");
        }
        for (const lit of leaves) if (!ctx.classes.includes(lit)) ctx.classes.push(lit);
        node.class = binding(e);
        break;
      }
      case "style": {
        const obj = unwrap(exprOf());
        if (!ts.isObjectLiteralExpression(obj)) throw new MicroCompileError(sf, a, "style is an object literal of spec props");
        node.style = [];
        for (const prop of obj.properties) {
          if (!ts.isPropertyAssignment(prop) || !(ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
            throw new MicroCompileError(sf, prop, "style entries are `prop: expression`");
          }
          const key = prop.name.text as PropName;
          const propId = (PROP as Record<string, number>)[key];
          if (propId === undefined) throw new MicroCompileError(sf, prop, `unknown style prop '${key}' (see spec PROP)`);
          let value = lowerExpr(prop.initializer, scope, null, ctx);
          if (tyOf(value) === "str") {
            if (value.k !== "str") throw new MicroCompileError(sf, prop, "a string style value must be a literal color");
            const literal = value.v;
            value = { k: "int", v: PROP_VALUE_KIND[key] === VALUE_KIND.color ? parseHexColor(literal, sf, prop) : Number(literal) };
          }
          if (!isNumeric(tyOf(value))) throw new MicroCompileError(sf, prop, `style prop '${key}' needs a number`);
          node.style.push({ prop: key, propId, value: binding(value) });
        }
        break;
      }
      case "focusable": {
        if (!init) {
          node.focusable = true;
          break;
        }
        const e = lowerExpr(exprOf(), scope, null, ctx);
        if (e.k !== "bool") throw new MicroCompileError(sf, a, "focusable is static in Micro TS");
        node.focusable = e.v;
        break;
      }
      case "onPress":
      case "on:press": {
        const e = unwrap(exprOf());
        const handler = resolveHandler(e, scope, ctx);
        if (!handler) throw new MicroCompileError(sf, a, "onPress takes an inline arrow, a setup function or a callback prop");
        const hid = ctx.nextHandler++;
        ownHandler = hid;
        node.ownHandler = hid;
        ctx.program.handlers.push({ id: hid, element: id, body: [] });
        const record = ctx.program.handlers[ctx.program.handlers.length - 1];
        ctx.deferred.push(() => {
          record.body = lowerFnBody(handler.fn, handler.scope, newBody(), ctx);
        });
        break;
      }
      case "ref":
      case "nodeRef": {
        const e = unwrap(exprOf());
        let refName: string | undefined;
        let refScope = scope;
        if (ts.isIdentifier(e)) refName = e.text;
        else if (ts.isArrowFunction(e) && ts.isIdentifier(e.parameters[0]?.name ?? ts.factory.createIdentifier(""))) {
          const param = (e.parameters[0].name as ts.Identifier).text;
          const body = ts.isBlock(e.body) ? e.body.statements : [e.body];
          for (const st of body) {
            const ex = ts.isExpressionStatement(st) ? st.expression : ts.isBlock(st) ? undefined : (st as ts.Expression);
            if (ex && ts.isBinaryExpression(ex) && ex.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(ex.left)) {
              const right = unwrap(ex.right);
              const assignsParam =
                (ts.isIdentifier(right) && right.text === param) ||
                (ts.isBinaryExpression(right) && ts.isIdentifier(right.left) && right.left.text === param);
              if (assignsParam) refName = ex.left.text;
            }
          }
        } else if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === scope.propsName) {
          const pv = scope.props.get(e.name.text);
          if (pv === undefined) break;
          throw new MicroCompileError(sf, a, "forwarded refs are outside Micro TS v1");
        }
        if (!refName) throw new MicroCompileError(sf, a, "ref is a setup-level `let x: NodeMirror | undefined` variable or `(n) => { x = n }`");
        const slot = refScope.refs.get(refName);
        if (!slot) throw new MicroCompileError(sf, a, `ref target \`${refName}\` is not a setup-level let`);
        if (slot.element !== null) throw new MicroCompileError(sf, a, `ref \`${refName}\` is bound twice`);
        slot.element = id;
        ctx.program.refs.push({ name: refName, element: id });
        (node.refs ??= []).push(refName);
        break;
      }
      case "debugName": {
        const e = lowerExpr(exprOf(), scope, null, ctx);
        if (e.k === "str") node.debugName = e.v;
        break;
      }
      case "src": {
        const e = lowerExpr(exprOf(), scope, null, ctx);
        if (e.k !== "str") throw new MicroCompileError(sf, a, "src is a static asset name in Micro TS");
        node.src = e.v;
        ctx.images.add(e.v);
        break;
      }
      case "sprite": {
        const e = lowerExpr(exprOf(), scope, null, ctx);
        if (e.k !== "str") throw new MicroCompileError(sf, a, "sprite is a static atlas name in Micro TS");
        node.sprite = { ...(node.sprite ?? {}), key: e.v };
        ctx.sprites.add(e.v);
        break;
      }
      case "frameStep": {
        const e = lowerExpr(exprOf(), scope, null, ctx);
        if (e.k === "undef") break;
        if (e.k !== "int") throw new MicroCompileError(sf, a, "frameStep is a static integer in Micro TS");
        node.sprite = { key: node.sprite?.key ?? "", frameStep: Math.min(0xffff, Math.max(1, e.v)) };
        break;
      }
      case "key":
        break;
      default:
        throw new MicroCompileError(sf, a, `unknown attribute '${name}' on <${jsxName}>`);
    }
  }
  if (node.sprite && node.sprite.key === "") throw new MicroCompileError(sf, opening, "frameStep needs a sprite");
  const inherited = ctx.handlerStack[ctx.handlerStack.length - 1];
  const handler = ownHandler ?? inherited;
  if (handler !== undefined) node.handler = handler;
  if (node.focusable) {
    const target = ctx.focusTargets[ctx.focusTargets.length - 1] ?? ctx.program.focusables;
    target.push({ element: id, order, ...(handler !== undefined ? { handler } : {}) });
  }
  ctx.handlerStack.push(handler);
  if (tag === "text") {
    node.text = lowerTextRun(children, scope, ctx);
  } else if (children.length > 0) {
    if (tag === "image") {
      const meaningful = children.filter((c) => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces));
      if (meaningful.length > 0) throw new MicroCompileError(sf, opening, `<${jsxName}> takes no children`);
    } else {
      node.children = lowerChildren(children, scope, ctx, "view");
    }
  }
  ctx.handlerStack.pop();
  return node;
}

function resolveHandler(e: ts.Expression, scope: Scope, ctx: Ctx): { fn: FnLike; scope: Scope } | null {
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return { fn: e, scope };
  if (ts.isIdentifier(e)) {
    const derived = scope.derived.get(e.text);
    if (derived) return { fn: derived, scope };
    return null;
  }
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === scope.propsName) {
    const pv = scope.props.get(e.name.text);
    if (pv && pv.k === "fn") return { fn: pv.node, scope: pv.scope };
    return null;
  }
  return null;
}

/** The concatenated run of a <Text>: static strings and interpolations. */
function lowerTextRun(children: readonly ts.JsxChild[], scope: Scope, ctx: Ctx): Binding {
  const sf = scope.mod.sf;
  const parts: Expr[] = [];
  const push = (e: Expr) => {
    if (e.k === "undef") return;
    if (e.k === "concat") {
      parts.push(...e.parts);
      return;
    }
    const ty = tyOf(e);
    if (ty === "str") parts.push(e);
    else if (isNumeric(ty) || ty === "bool") parts.push({ k: "tostr", e });
    else throw new Error("Micro TS: text interpolation must be a string, number or boolean");
  };
  for (const child of children) {
    if (ts.isJsxText(child)) {
      const text = cleanJsxText(child.text);
      if (text) {
        ctx.strings.add(text);
        parts.push({ k: "str", v: text });
      }
      continue;
    }
    if (ts.isJsxExpression(child)) {
      if (!child.expression) continue;
      const e = unwrap(child.expression);
      if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e)) throw new MicroCompileError(sf, e, "<Text> holds text, not elements");
      if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === scope.propsName) {
        const pv = scope.props.get(e.name.text);
        if (pv && pv.k === "jsx") {
          const inner = lowerTextRun(pv.nodes, pv.scope, ctx);
          push(inner.expr);
          continue;
        }
      }
      try {
        push(lowerExpr(e, scope, null, ctx));
      } catch (err) {
        if (err instanceof MicroCompileError) throw err;
        throw new MicroCompileError(sf, e, (err as Error).message);
      }
      continue;
    }
    throw new MicroCompileError(sf, child, "<Text> holds text, not elements");
  }
  const merged: Expr[] = [];
  for (const p of parts) {
    const last = merged[merged.length - 1];
    if (p.k === "str" && last && last.k === "str") merged[merged.length - 1] = { k: "str", v: last.v + p.v };
    else merged.push(p);
  }
  const expr: Expr = merged.length === 0 ? { k: "str", v: "" } : merged.length === 1 ? merged[0] : { k: "concat", parts: merged };
  return binding(expr);
}

/** JSX text whitespace rules (babel `cleanJSXElementLiteralChild`). */
export function cleanJsxText(raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/);
  let lastNonEmpty = 0;
  for (let i = 0; i < lines.length; i++) if (/[^ \t]/.test(lines[i])) lastNonEmpty = i;
  let out = "";
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(/\t/g, " ");
    if (i !== 0) line = line.replace(/^ +/, "");
    if (i !== lines.length - 1) line = line.replace(/ +$/, "");
    if (line) {
      if (i !== lastNonEmpty) line += " ";
      out += line;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

function truthy(e: Expr): Expr {
  const ty = tyOf(e);
  if (ty === "bool") return e;
  if (e.k === "int" || e.k === "num") return { k: "bool", v: e.v !== 0 && !Number.isNaN(e.v) };
  if (e.k === "str") return { k: "bool", v: e.v.length > 0 };
  if (e.k === "undef") return { k: "bool", v: false };
  if (e.k === "noderef") return { k: "bool", v: true };
  return { k: "truthy", e };
}

function parseHexColor(s: string, sf: ts.SourceFile, at: ts.Node): number {
  let hex = s.startsWith("#") ? s.slice(1) : "";
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  if ((hex.length !== 6 && hex.length !== 8) || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new MicroCompileError(sf, at, `bad color '${s}' (expected #rgb/#rrggbb/#rrggbbaa)`);
  }
  const n = parseInt(hex, 16);
  if (hex.length === 6) return abgr((n >>> 16) & 255, (n >>> 8) & 255, n & 255, 255);
  return abgr((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
}

function numLiteral(text: string, value: number): Expr {
  if (/^[0-9]+$/.test(text) && value <= 0x7fffffff) return { k: "int", v: value };
  return { k: "num", v: value };
}

function lowerExpr(node: ts.Expression, scope: Scope, body: Body | null, ctx: Ctx): Expr {
  const sf = scope.mod.sf;
  const e = unwrap(node);
  const fail: (msg: string) => never = (msg) => {
    throw new MicroCompileError(sf, e, msg);
  };

  if (ts.isNumericLiteral(e)) return numLiteral(e.text, Number(e.text));
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
    ctx.strings.add(e.text);
    return { k: "str", v: e.text };
  }
  if (e.kind === ts.SyntaxKind.TrueKeyword) return { k: "bool", v: true };
  if (e.kind === ts.SyntaxKind.FalseKeyword) return { k: "bool", v: false };
  if (e.kind === ts.SyntaxKind.NullKeyword) return { k: "undef" };
  if (ts.isTemplateExpression(e)) {
    const parts: Expr[] = [];
    if (e.head.text) {
      ctx.strings.add(e.head.text);
      parts.push({ k: "str", v: e.head.text });
    }
    for (const span of e.templateSpans) {
      parts.push(toStrPart(lowerExpr(span.expression, scope, body, ctx), sf, span.expression));
      if (span.literal.text) {
        ctx.strings.add(span.literal.text);
        parts.push({ k: "str", v: span.literal.text });
      }
    }
    return foldConcat(parts);
  }
  if (ts.isIdentifier(e)) {
    const name = e.text;
    if (name === "undefined") return { k: "undef" };
    if (body) {
      const param = body.params.get(name);
      if (param) return param;
      const local = body.locals.get(name);
      if (local) return { k: "local", name, ty: local };
    }
    const c = scope.consts.get(name);
    if (c) return c;
    if (scope.signals.has(name)) fail(`\`${name}\` is a signal accessor; call it (\`${name}()\`)`);
    if (scope.setters.has(name)) fail(`\`${name}\` is a signal setter; call it`);
    const ref = scope.refs.get(name);
    if (ref) {
      if (ref.element === null) fail(`ref \`${name}\` is never bound to an element in the template`);
      return { k: "noderef", element: ref.element!, name };
    }
    const imp = scope.mod.imports.get(name);
    if (imp) {
      if (CLOCK_MODULES.has(imp.module) && imp.name === "TICKS_PER_SECOND") return { k: "int", v: 60 };
      fail(`import \`${name}\` from ${imp.module} has no compile-time value in Micro TS`);
    }
    const modConst = scope.mod.consts.get(name);
    if (modConst) return lowerExpr(modConst, emptyScope(scope.mod, scope.componentName), null, ctx);
    fail(`unknown identifier \`${name}\``);
  }
  if (ts.isPropertyAccessExpression(e)) {
    if (ts.isIdentifier(e.expression) && e.expression.text === scope.propsName) {
      const pv = scope.props.get(e.name.text);
      if (pv === undefined) return { k: "undef" };
      if (pv.k === "expr") return pv.e;
      fail(`props.${e.name.text} is a ${pv.k === "fn" ? "callback" : "JSX"} prop; it has no value in an expression`);
    }
    if (ts.isIdentifier(e.expression)) {
      const target = scope.mod.consts.get(e.expression.text);
      if (target) {
        const obj = unwrap(target);
        if (ts.isObjectLiteralExpression(obj)) {
          const prop = obj.properties.find((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === e.name.text);
          if (prop && ts.isPropertyAssignment(prop)) return lowerExpr(prop.initializer, emptyScope(scope.mod, scope.componentName), null, ctx);
          fail(`${e.expression.text}.${e.name.text} is not a member of the module constant`);
        }
      }
      if (e.expression.text === "Math" && e.name.text === "PI") return { k: "num", v: Math.PI };
    }
    fail("property access is limited to props.<name> and module constants in Micro TS");
  }
  if (ts.isCallExpression(e)) return lowerCall(e, scope, body, ctx);
  if (ts.isPrefixUnaryExpression(e)) {
    const inner = lowerExpr(e.operand, scope, body, ctx);
    if (e.operator === ts.SyntaxKind.ExclamationToken) {
      const t = truthy(inner);
      if (t.k === "bool") return { k: "bool", v: !t.v };
      return { k: "unary", op: "!", e: t, ty: "bool" };
    }
    if (e.operator === ts.SyntaxKind.MinusToken) {
      if (inner.k === "int") return { k: "int", v: -inner.v };
      if (inner.k === "num") return { k: "num", v: -inner.v };
      if (!isNumeric(tyOf(inner))) fail("unary minus needs a number");
      return { k: "unary", op: "-", e: inner, ty: tyOf(inner) };
    }
    if (e.operator === ts.SyntaxKind.PlusToken) return inner;
    fail("unsupported unary operator");
  }
  if (ts.isConditionalExpression(e)) {
    const c = truthy(lowerExpr(e.condition, scope, body, ctx));
    if (c.k === "bool") return lowerExpr(c.v ? e.whenTrue : e.whenFalse, scope, body, ctx);
    const t = lowerExpr(e.whenTrue, scope, body, ctx);
    const f = lowerExpr(e.whenFalse, scope, body, ctx);
    const ty = joinTy(tyOf(t), tyOf(f));
    if (!ty || ty === "undef") fail(`ternary arms have incompatible types (${tyOf(t)} and ${tyOf(f)})`);
    return { k: "cond", c, t: widen(t, ty), f: widen(f, ty), ty };
  }
  if (ts.isBinaryExpression(e)) return lowerBinary(e, scope, body, ctx);
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) fail("a function is not a value in Micro TS; pass it as a prop or handler");
  if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e)) fail("JSX is not a value in Micro TS expressions");
  if (ts.isElementAccessExpression(e)) fail("indexing is outside Micro TS v1");
  if (ts.isObjectLiteralExpression(e)) fail("object literals are limited to style={{...}} and animate options");
  fail(`expression kind ${ts.SyntaxKind[e.kind]} is outside Micro TS`);
}

function widen(e: Expr, ty: Ty): Expr {
  if (ty === "num" && e.k === "int") return { k: "num", v: e.v };
  return e;
}

function toStrPart(e: Expr, sf: ts.SourceFile, at: ts.Node): Expr {
  const ty = tyOf(e);
  if (ty === "str") return e;
  if (e.k === "int" || e.k === "num") return { k: "str", v: jsNumberToString(e.v) };
  if (e.k === "bool") return { k: "str", v: String(e.v) };
  if (isNumeric(ty) || ty === "bool") return { k: "tostr", e };
  if (e.k === "undef") return { k: "str", v: "undefined" };
  throw new MicroCompileError(sf, at, `cannot interpolate a value of type ${ty}`);
}

export function jsNumberToString(v: number): string {
  return String(v);
}

function foldConcat(parts: Expr[]): Expr {
  const flat: Expr[] = [];
  for (const p of parts) {
    if (p.k === "concat") flat.push(...p.parts);
    else flat.push(p);
  }
  const merged: Expr[] = [];
  for (const p of flat) {
    const last = merged[merged.length - 1];
    if (p.k === "str" && last && last.k === "str") merged[merged.length - 1] = { k: "str", v: last.v + p.v };
    else if (p.k === "str" && p.v === "") continue;
    else merged.push(p);
  }
  if (merged.length === 0) return { k: "str", v: "" };
  if (merged.length === 1 && merged[0].k === "str") return merged[0];
  return { k: "concat", parts: merged };
}

function lowerBinary(e: ts.BinaryExpression, scope: Scope, body: Body | null, ctx: Ctx): Expr {
  const sf = scope.mod.sf;
  const op = e.operatorToken.kind;
  const fail: (msg: string) => never = (msg) => {
    throw new MicroCompileError(sf, e, msg);
  };
  if (op === ts.SyntaxKind.QuestionQuestionToken) {
    const l = lowerExpr(e.left, scope, body, ctx);
    if (l.k === "undef") return lowerExpr(e.right, scope, body, ctx);
    return l;
  }
  if (op === ts.SyntaxKind.EqualsToken || (op >= ts.SyntaxKind.FirstCompoundAssignment && op <= ts.SyntaxKind.LastCompoundAssignment)) {
    fail("assignment is a statement in Micro TS");
  }
  const l = lowerExpr(e.left, scope, body, ctx);
  const r = lowerExpr(e.right, scope, body, ctx);
  const lt = tyOf(l);
  const rt = tyOf(r);
  const bothNum = isNumeric(lt) && isNumeric(rt);
  const arith = (sym: "+" | "-" | "*" | "/" | "%"): Expr => {
    if (!bothNum) fail(`'${sym}' needs numbers (got ${lt} and ${rt})`);
    const ty: Ty = sym === "/" ? "num" : lt === "int" && rt === "int" ? "int" : "num";
    if ((l.k === "int" || l.k === "num") && (r.k === "int" || r.k === "num")) {
      const v = sym === "+" ? l.v + r.v : sym === "-" ? l.v - r.v : sym === "*" ? l.v * r.v : sym === "/" ? l.v / r.v : l.v % r.v;
      if (ty === "int" && Number.isInteger(v) && Math.abs(v) <= 0x7fffffff) return { k: "int", v };
      return { k: "num", v };
    }
    return { k: "binary", op: sym, l: widen(l, ty), r: widen(r, ty), ty };
  };
  const compare = (sym: "<" | "<=" | ">" | ">=" | "==" | "!="): Expr => {
    if (bothNum) {
      const ty: Ty = lt === "int" && rt === "int" ? "int" : "num";
      if ((l.k === "int" || l.k === "num") && (r.k === "int" || r.k === "num")) {
        const v = sym === "<" ? l.v < r.v : sym === "<=" ? l.v <= r.v : sym === ">" ? l.v > r.v : sym === ">=" ? l.v >= r.v : sym === "==" ? l.v === r.v : l.v !== r.v;
        return { k: "bool", v };
      }
      return { k: "binary", op: sym, l: widen(l, ty), r: widen(r, ty), ty: "bool" };
    }
    if ((sym === "==" || sym === "!=") && lt === rt && (lt === "str" || lt === "bool")) {
      if (l.k === "str" && r.k === "str") return { k: "bool", v: sym === "==" ? l.v === r.v : l.v !== r.v };
      if (l.k === "bool" && r.k === "bool") return { k: "bool", v: sym === "==" ? l.v === r.v : l.v !== r.v };
      return { k: "binary", op: sym, l, r, ty: "bool" };
    }
    if ((sym === "==" || sym === "!=") && (lt === "undef" || rt === "undef")) {
      return { k: "bool", v: sym === "==" ? lt === rt : lt !== rt };
    }
    fail(`'${sym}' compares two numbers, two strings or two booleans (got ${lt} and ${rt})`);
  };
  switch (op) {
    case ts.SyntaxKind.PlusToken:
      if (lt === "str" || rt === "str") return foldConcat([toStrPart(l, sf, e.left), toStrPart(r, sf, e.right)]);
      return arith("+");
    case ts.SyntaxKind.MinusToken: return arith("-");
    case ts.SyntaxKind.AsteriskToken: return arith("*");
    case ts.SyntaxKind.SlashToken: return arith("/");
    case ts.SyntaxKind.PercentToken: return arith("%");
    case ts.SyntaxKind.LessThanToken: return compare("<");
    case ts.SyntaxKind.LessThanEqualsToken: return compare("<=");
    case ts.SyntaxKind.GreaterThanToken: return compare(">");
    case ts.SyntaxKind.GreaterThanEqualsToken: return compare(">=");
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken: return compare("==");
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken: return compare("!=");
    case ts.SyntaxKind.AmpersandAmpersandToken:
    case ts.SyntaxKind.BarBarToken: {
      const isAnd = op === ts.SyntaxKind.AmpersandAmpersandToken;
      if (lt === "bool" && rt === "bool") {
        if (l.k === "bool" && r.k === "bool") return { k: "bool", v: isAnd ? l.v && r.v : l.v || r.v };
        if (l.k === "bool") return isAnd ? (l.v ? r : l) : l.v ? l : r;
        return { k: "binary", op: isAnd ? "&&" : "||", l, r, ty: "bool" };
      }
      const ty = joinTy(lt, rt);
      if (!ty) fail(`'${isAnd ? "&&" : "||"}' operands have incompatible types (${lt} and ${rt})`);
      const c = truthy(l);
      // JS returns an operand: a && b -> truthy(a) ? b : a; a || b -> truthy(a) ? a : b.
      return { k: "cond", c, t: widen(isAnd ? r : l, ty!), f: widen(isAnd ? l : r, ty!), ty: ty! };
    }
    default:
      fail(`operator ${ts.tokenToString(op)} is outside Micro TS`);
  }
}

function lowerCall(e: ts.CallExpression, scope: Scope, body: Body | null, ctx: Ctx): Expr {
  const sf = scope.mod.sf;
  const callee = unwrap(e.expression);
  const fail: (msg: string) => never = (msg) => {
    throw new MicroCompileError(sf, e, msg);
  };
  if (ts.isIdentifier(callee)) {
    const name = callee.text;
    const sig = scope.signals.get(name);
    if (sig !== undefined) {
      if (e.arguments.length !== 0) fail("a signal accessor takes no arguments");
      const ty = ctx.signalTy.get(sig) ?? ctx.program.signals[sig].ty;
      return { k: "signal", id: sig, ty };
    }
    if (scope.setters.has(name)) fail("a signal setter is a statement, not a value");
    if (name === "String") {
      if (e.arguments.length !== 1) fail("String() takes one argument");
      return toStrPart(lowerExpr(e.arguments[0], scope, body, ctx), sf, e.arguments[0]);
    }
    if (name === "Number" || name === "Boolean" || name === "parseInt" || name === "parseFloat") fail(`${name}() is outside Micro TS v1`);
    const derived = scope.derived.get(name);
    if (derived) {
      const inner = fnBody(derived);
      const nb = bindParams(derived, e.arguments, scope, body, ctx);
      if (Array.isArray(inner)) {
        const stmts = inner as readonly ts.Statement[];
        if (stmts.length === 1 && ts.isReturnStatement(stmts[0]) && stmts[0].expression) {
          return lowerExpr(stmts[0].expression, scope, nb, ctx);
        }
        fail(`\`${name}\` has a statement body; call it as a statement or return one expression`);
      }
      return lowerExpr(inner as ts.Expression, scope, nb, ctx);
    }
    const imp = scope.mod.imports.get(name);
    if (imp) {
      if (RUNTIME_MODULES.has(imp.module) && imp.name === "frameworkName") return { k: "str", v: "Solid" };
      fail(`\`${name}\` from ${imp.module} has no value lowering in Micro TS`);
    }
    fail(`unknown function \`${name}\``);
  }
  if (ts.isPropertyAccessExpression(callee)) {
    if (ts.isIdentifier(callee.expression) && callee.expression.text === "Math") {
      const fn = callee.name.text;
      if (!BUILTINS.has(fn)) fail(`Math.${fn} is outside Micro TS`);
      const args = e.arguments.map((a) => lowerExpr(a, scope, body, ctx));
      for (const a of args) if (!isNumeric(tyOf(a))) fail(`Math.${fn} takes numbers`);
      const builtin = fn as Builtin;
      if (builtin === "min" || builtin === "max") {
        if (args.length !== 2) fail(`Math.${fn} takes two arguments in Micro TS`);
        const ty: Ty = args.every((a) => tyOf(a) === "int") ? "int" : "num";
        if (args.every((a) => a.k === "int" || a.k === "num")) {
          const v = builtin === "min" ? Math.min(...args.map((a) => (a as { v: number }).v)) : Math.max(...args.map((a) => (a as { v: number }).v));
          return ty === "int" ? { k: "int", v } : { k: "num", v };
        }
        return { k: "call", fn: builtin, args: args.map((a) => widen(a, ty)), ty };
      }
      if (args.length !== 1) fail(`Math.${fn} takes one argument`);
      const a = args[0];
      if (builtin === "abs") {
        if (a.k === "int" || a.k === "num") return { k: a.k, v: Math.abs(a.v) };
        return { k: "call", fn: builtin, args: [a], ty: tyOf(a) };
      }
      if (a.k === "int") return a;
      if (a.k === "num") return { k: "int", v: Math[builtin](a.v) };
      if (tyOf(a) === "int") return a;
      return { k: "call", fn: builtin, args: [a], ty: "int" };
    }
    if (ts.isIdentifier(callee.expression) && callee.expression.text === scope.propsName) {
      const pv = scope.props.get(callee.name.text);
      if (pv === undefined) {
        if (e.questionDotToken) return { k: "undef" };
        fail(`props.${callee.name.text} is not bound at this use site`);
      }
      if (pv.k !== "fn") fail(`props.${callee.name.text} is not a callback`);
      const inner = fnBody(pv.node);
      const nb = bindParams(pv.node, e.arguments, scope, body, ctx);
      if (Array.isArray(inner)) fail("a callback used as a value must have an expression body");
      return lowerExpr(inner as ts.Expression, pv.scope, nb, ctx);
    }
  }
  fail("unsupported call in Micro TS");
}

/** Bind an inlined function's parameters to the caller's expressions. */
function bindParams(fn: FnLike, args: readonly ts.Expression[], scope: Scope, body: Body | null, ctx: Ctx): Body {
  const nb = newBody();
  if (body) {
    for (const [k, v] of body.locals) nb.locals.set(k, v);
    for (const [k, v] of body.params) nb.params.set(k, v);
  }
  fn.parameters.forEach((p, i) => {
    if (!ts.isIdentifier(p.name)) throw new MicroCompileError(scope.mod.sf, p, "parameters are plain identifiers");
    const arg = args[i];
    const value: Expr = arg ? lowerExpr(arg, scope, body, ctx) : p.initializer ? lowerExpr(p.initializer, scope, body, ctx) : { k: "undef" };
    nb.params.set(p.name.text, value);
  });
  return nb;
}

// ---------------------------------------------------------------------------
// Statements (handler, effect and mount bodies)
// ---------------------------------------------------------------------------

function lowerFnBody(fn: FnLike, scope: Scope, body: Body, ctx: Ctx): Stmt[] {
  const inner = fnBody(fn);
  if (Array.isArray(inner)) return lowerStmts(inner as readonly ts.Statement[], scope, body, ctx);
  return lowerExprStatement(inner as ts.Expression, scope, body, ctx);
}

function lowerStmts(stmts: readonly ts.Statement[], scope: Scope, body: Body, ctx: Ctx): Stmt[] {
  const out: Stmt[] = [];
  for (const st of stmts) out.push(...lowerStmt(st, scope, body, ctx));
  return out;
}

function lowerStmt(st: ts.Statement, scope: Scope, body: Body, ctx: Ctx): Stmt[] {
  const sf = scope.mod.sf;
  if (ts.isEmptyStatement(st)) return [];
  if (ts.isBlock(st)) return lowerStmts(st.statements, scope, body, ctx);
  if (ts.isVariableStatement(st)) {
    const out: Stmt[] = [];
    for (const decl of st.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) throw new MicroCompileError(sf, decl, "destructuring is outside Micro TS");
      if (!decl.initializer) throw new MicroCompileError(sf, decl, "locals need an initializer");
      const init = lowerExpr(decl.initializer, scope, body, ctx);
      const ty = tyOf(init);
      if (!isNumeric(ty) && ty !== "bool" && ty !== "str") throw new MicroCompileError(sf, decl, `a local holds a number, boolean or string (got ${ty})`);
      body.locals.set(decl.name.text, ty);
      body.params.delete(decl.name.text);
      out.push({ k: "let", name: decl.name.text, ty, init });
    }
    return out;
  }
  if (ts.isIfStatement(st)) {
    const c = truthy(lowerExpr(st.expression, scope, body, ctx));
    if (c.k === "bool") {
      if (c.v) return lowerStmt(st.thenStatement, scope, body, ctx);
      return st.elseStatement ? lowerStmt(st.elseStatement, scope, body, ctx) : [];
    }
    const then = lowerStmt(st.thenStatement, scope, body, ctx);
    const els = st.elseStatement ? lowerStmt(st.elseStatement, scope, body, ctx) : undefined;
    return [{ k: "if", c, then, ...(els && els.length > 0 ? { else: els } : {}) }];
  }
  if (ts.isReturnStatement(st)) {
    if (st.expression) throw new MicroCompileError(sf, st, "handlers, effects and hooks return nothing");
    return [{ k: "return" }];
  }
  if (ts.isExpressionStatement(st)) return lowerExprStatement(st.expression, scope, body, ctx);
  throw new MicroCompileError(sf, st, `statement kind ${ts.SyntaxKind[st.kind]} is outside Micro TS`);
}

function lowerExprStatement(expr: ts.Expression, scope: Scope, body: Body, ctx: Ctx): Stmt[] {
  const sf = scope.mod.sf;
  const e = unwrap(expr);
  const fail: (msg: string) => never = (msg) => {
    throw new MicroCompileError(sf, e, msg);
  };
  // Assignments to locals.
  if (ts.isBinaryExpression(e) && ts.isIdentifier(e.left)) {
    const name = e.left.text;
    const ty = body.locals.get(name);
    if (ty === undefined) fail(`\`${name}\` is not an assignable local (signals are written through their setter)`);
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.EqualsToken) return [{ k: "assign", name, e: coerceLocal(lowerExpr(e.right, scope, body, ctx), ty!, sf, e) }];
    const sym: "+" | "-" | "*" | "/" | undefined =
      op === ts.SyntaxKind.PlusEqualsToken ? "+"
      : op === ts.SyntaxKind.MinusEqualsToken ? "-"
      : op === ts.SyntaxKind.AsteriskEqualsToken ? "*"
      : op === ts.SyntaxKind.SlashEqualsToken ? "/"
      : undefined;
    if (!sym) fail("unsupported compound assignment");
    return [{ k: "assign", name, e: coerceLocal(lowerCompound(sym, e, scope, body, ctx), ty, sf, e) }];
  }
  if ((ts.isPostfixUnaryExpression(e) || ts.isPrefixUnaryExpression(e)) && ts.isIdentifier(e.operand)) {
    const name = e.operand.text;
    const ty = body.locals.get(name);
    if (ty === undefined || !isNumeric(ty)) fail(`\`${name}\` is not a numeric local`);
    const delta: Expr = e.operator === ts.SyntaxKind.PlusPlusToken ? { k: "int", v: 1 } : { k: "int", v: -1 };
    return [{ k: "assign", name, e: { k: "binary", op: "+", l: { k: "local", name, ty: ty! }, r: widen(delta, ty!), ty: ty! } }];
  }
  if (ts.isCallExpression(e)) {
    const callee = unwrap(e.expression);
    if (ts.isIdentifier(callee)) {
      const name = callee.text;
      const sig = scope.setters.get(name);
      if (sig !== undefined) {
        if (e.arguments.length !== 1) fail("a setter takes one argument");
        const arg = unwrap(e.arguments[0]);
        const signal = ctx.program.signals[sig];
        const current: Expr = { k: "signal", id: sig, ty: ctx.signalTy.get(sig) ?? signal.ty };
        let value: Expr;
        if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
          const nb = newBody();
          for (const [k, v] of body.locals) nb.locals.set(k, v);
          for (const [k, v] of body.params) nb.params.set(k, v);
          const p = arg.parameters[0];
          if (p) {
            if (!ts.isIdentifier(p.name)) fail("setter callback parameter is an identifier");
            nb.params.set(p.name.text, current);
          }
          const inner = fnBody(arg);
          if (Array.isArray(inner)) fail("setter callbacks return one expression");
          value = lowerExpr(inner as ts.Expression, scope, nb, ctx);
        } else {
          value = lowerExpr(arg, scope, body, ctx);
        }
        const vt = tyOf(value);
        const st = tyOf(current);
        if (!joinTy(st, vt) || vt === "undef") fail(`setter value type ${vt} does not match signal type ${st}`);
        return [{ k: "set", signal: sig, e: st === "num" ? widen(value, "num") : value }];
      }
      if (scope.signals.has(name)) fail("reading a signal has no effect as a statement");
      const derived = scope.derived.get(name);
      if (derived) {
        const nb = bindParams(derived, e.arguments, scope, body, ctx);
        return lowerFnBody(derived, scope, nb, ctx);
      }
      const imp = scope.mod.imports.get(name);
      if (imp && ANIMATION_MODULES.has(imp.module)) return [lowerAnimationCall(imp.name, e, scope, body, ctx)];
      if (imp && imp.module === "solid-js" && (imp.name === "batch" || imp.name === "untrack")) {
        const arg = e.arguments[0] ? unwrap(e.arguments[0]) : undefined;
        if (arg && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) return lowerFnBody(arg, scope, body, ctx);
      }
      fail(`unknown statement call \`${name}()\``);
    }
    if (ts.isPropertyAccessExpression(callee)) {
      if (ts.isIdentifier(callee.expression) && callee.expression.text === scope.propsName) {
        const propName = callee.name.text;
        const pv = scope.props.get(propName);
        if (pv === undefined) {
          if (e.questionDotToken) return [{ k: "nop", note: `props.${propName} is not bound at this use site` }];
          fail(`props.${propName} is not bound at this use site (call it with ?.() if optional)`);
        }
        if (pv.k !== "fn") fail(`props.${propName} is not a callback`);
        const nb = bindParams(pv.node, e.arguments, scope, body, ctx);
        return lowerFnBody(pv.node, pv.scope, nb, ctx);
      }
      if (ts.isIdentifier(callee.expression) && callee.expression.text === "console") return [{ k: "nop", note: `console.${callee.name.text} dropped` }];
    }
    fail("unsupported call statement in Micro TS");
  }
  // A pure expression in statement position (an inlined callback with an
  // expression body that computes nothing observable).
  lowerExpr(e, scope, body, ctx);
  return [];
}

function coerceLocal(e: Expr, ty: Ty, sf: ts.SourceFile, at: ts.Node): Expr {
  const j = joinTy(ty, tyOf(e));
  if (!j || j !== ty) {
    if (ty === "num" && tyOf(e) === "int") return widen(e, "num");
    throw new MicroCompileError(sf, at, `cannot assign ${tyOf(e)} to a ${ty} local`);
  }
  return e;
}

function lowerCompound(op: "+" | "-" | "*" | "/", original: ts.BinaryExpression, scope: Scope, body: Body, ctx: Ctx): Expr {
  // Compound assignment `x op= e` lowers as `x op e` over the original operands.
  const l = lowerExpr(original.left, scope, body, ctx);
  const r = lowerExpr(original.right, scope, body, ctx);
  const lt = tyOf(l);
  const rt = tyOf(r);
  if (op === "+" && (lt === "str" || rt === "str")) {
    return foldConcat([toStrPart(l, scope.mod.sf, original.left), toStrPart(r, scope.mod.sf, original.right)]);
  }
  if (!isNumeric(lt) || !isNumeric(rt)) throw new MicroCompileError(scope.mod.sf, original, "compound assignment needs numbers");
  const ty: Ty = op === "/" ? "num" : lt === "int" && rt === "int" ? "int" : "num";
  return { k: "binary", op, l: widen(l, ty), r: widen(r, ty), ty };
}

function lowerAnimationCall(fnName: string, e: ts.CallExpression, scope: Scope, body: Body, ctx: Ctx): Stmt {
  const sf = scope.mod.sf;
  const fail: (msg: string) => never = (msg) => {
    throw new MicroCompileError(sf, e, msg);
  };
  if (fnName !== "animate" && fnName !== "spring" && fnName !== "jump") fail(`${fnName}() is outside Micro TS v1 (animate, spring and jump are in)`);
  const args = e.arguments;
  if (args.length < 3) fail(`${fnName}(node, prop, value, ...) needs three arguments`);
  const target = lowerExpr(args[0], scope, body, ctx);
  if (target.k !== "noderef") fail("the animation target must be a ref-bound element");
  const propExpr = lowerExpr(args[1], scope, body, ctx);
  if (propExpr.k !== "str") fail("the animated prop is a string literal");
  const prop = propExpr.v as PropName;
  const propId = (PROP as Record<string, number>)[prop];
  if (propId === undefined) fail(`unknown prop '${prop}'`);
  if (animBit(prop) < 0) fail(`prop '${prop}' is not animatable (see spec ANIMATABLE)`);
  let value = lowerExpr(args[2], scope, body, ctx);
  if (value.k === "str") {
    const literal = value.v;
    value = { k: "int", v: PROP_VALUE_KIND[prop] === VALUE_KIND.color ? parseHexColor(literal, sf, args[2]) : Number(literal) };
  }
  if (!isNumeric(tyOf(value))) fail("the animation value is a number");
  if (fnName === "jump") return { k: "jump", target: target.element, prop, propId, value };
  if (fnName === "spring") {
    let easing: number = ENUMS.Easing.Spring;
    if (args[3]) {
      const preset = lowerExpr(args[3], scope, body, ctx);
      if (preset.k !== "str") fail("spring preset is a string literal");
      easing = preset.v === "bouncy" ? ENUMS.Easing.SpringBouncy : ENUMS.Easing.Spring;
    }
    return { k: "animate", target: target.element, prop, propId, to: value, durMs: { k: "int", v: 0 }, easing, delayMs: { k: "int", v: 0 } };
  }
  let durMs: Expr = { k: "int", v: 200 };
  let delayMs: Expr = { k: "int", v: 0 };
  let easing: number = ENUMS.Easing.EaseOut;
  if (args[3]) {
    const opts = unwrap(args[3]);
    if (!ts.isObjectLiteralExpression(opts)) fail("animate options are an object literal");
    for (const p of opts.properties) {
      if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) fail("animate options are `dur`, `easing`, `delay`");
      const v = lowerExpr(p.initializer, scope, body, ctx);
      switch (p.name.text) {
        case "dur":
          if (!isNumeric(tyOf(v))) fail("dur is a number of milliseconds");
          durMs = v;
          break;
        case "delay":
          if (!isNumeric(tyOf(v))) fail("delay is a number of milliseconds");
          delayMs = v;
          break;
        case "easing":
          if (v.k === "int") easing = v.v;
          else if (v.k === "str") {
            if (!(v.v in EASING_BY_NAME)) fail(`unknown easing '${v.v}'`);
            easing = EASING_BY_NAME[v.v];
          } else fail("easing is a name or an ENUMS.Easing ordinal");
          break;
        default:
          fail(`unknown animate option '${p.name.text}'`);
      }
    }
  }
  return { k: "animate", target: target.element, prop, propId, to: value, durMs, easing, delayMs };
}
