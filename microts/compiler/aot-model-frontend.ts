/** TypeScript model admission and hygienic lowering, shared by Solid and Vue. */
import ts from "typescript";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { BOOL, F64, I32, STRING, sameType, type AotType, type SourceLocation } from "./aot-ir.ts";
import { createTypeEnvironment, fail, location, TypeMapper, typeName, type TypeEnvironment } from "./aot-types.ts";
import { emptyLedger, type ModelBinder, type ModelProgram, type ModelModule, type ModelExpr, type ModelBlock, type ModelStmt, type ModelFunction, type ModelAwaitable, type ModelTarget } from "./aot-model-ir.ts";
import { analyzeModelLedgers } from "./aot-model-ledger.ts";
import { modelNumberType } from "./aot-model-numbers.ts";
import { lowerModelTasks, assertModelProgram } from "./aot-model-tasks.ts";
import { parseMicroTsColor, MICROTS_NUMERIC_TYPES, MICROTS_EXTENDED_BUILTINS, MICROTS_MUTATION_BUILTINS, MICROTS_MATH_BUILTINS, MICROTS_MATH2_BUILTINS } from "../../contracts/spec/microts.ts";
import type { ModelPathStep, ModelTarget as ModelTargetType } from "./aot-model-ir.ts";

export interface AnalyzeModelOptions { sources?: ReadonlyMap<string, string>; source?: string; strict?: boolean; recursionLimit?: number; name?: string; factories?: readonly string[]; framework?: "solid" | "vue"; componentNames?: string[]; environment?: TypeEnvironment; mapper?: TypeMapper }
type Binding = { id: number; name: string; kind: "signal" | "setter" | "memo" | "field" | "local" | "constant" | "function" | "ref"; type: AotType; node: ts.Node; module: ModelModule; binder?: ModelBinder; value?: ModelExpr; fn?: ModelFunction; declaration?: ts.VariableDeclaration; capacity?: number; arrayBound?: number };
type Imported = { name: string; source: string };
const VOID: AotType = { kind: "void" };
const numericNames = new Set(["i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "usize", "f32", "f64"]);
const stdNames = new Set(["len", "trunc", "floor", "ceil", "round", "idiv", "imod", "min", "max", "abs", "clamp", "fixed", "copy", "equals", "map", "filter", "find", "some", "frames", "after", "until", "join", "all", "any", "cancel", ...MICROTS_NUMERIC_TYPES, ...Object.keys(MICROTS_EXTENDED_BUILTINS)]);
const mutationNames = new Set<string>(MICROTS_MUTATION_BUILTINS);
const mathNames = new Set<string>([...MICROTS_MATH_BUILTINS, ...MICROTS_MATH2_BUILTINS]);
/** Reads compiler options for tsconfig `paths` aliases next to the entry. */
function aliasCompilerOptions(entry: string): ts.CompilerOptions | undefined {
  const configPath = ts.findConfigFile(dirname(entry), ts.sys.fileExists, "tsconfig.json");
  if (!configPath) return;
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) return;
  const options = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath), undefined, configPath).options;
  if (!options.paths) return;
  return { ...options, moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true, noEmit: true };
}
const primitiveType = (t: AotType) => ["number", "boolean", "string", "undefined", "void"].includes(t.kind);
const modifiers = (node: ts.Node) => ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : [];
const exported = (node: ts.Node) => modifiers(node).some(m => m.kind === ts.SyntaxKind.ExportKeyword);
const asyncFn = (node: ts.Node) => modifiers(node).some(m => m.kind === ts.SyntaxKind.AsyncKeyword);

export function analyzeModel(entry: string, options: AnalyzeModelOptions = {}): ModelProgram {
  entry = resolve(entry);
  const files = new Map<string, string>([...(options.sources ?? [])].map(([name, text]) => [resolve(name), text]));
  if (options.source !== undefined) files.set(entry, options.source);
  const reachable: string[] = [], visiting = new Set<string>();
  function source(file: string): string { const value = files.get(file) ?? (existsSync(file) ? readFileSync(file, "utf8") : undefined); if (value === undefined) fail(location(file, ""), "model module does not exist"); files.set(file, value); return value; }
  const aliasOptions = aliasCompilerOptions(entry), aliasCache = new Map<string, string | undefined>();
  /** A non-relative specifier that tsconfig `paths` maps to a local TypeScript module. */
  function aliasModule(name: string, file: string): string | undefined {
    if (!aliasOptions || name.startsWith(".") || name.startsWith("@pocketjs/") || name === "solid-js" || name === "vue") return undefined;
    const key = `${file}\0${name}`;
    if (!aliasCache.has(key)) {
      const resolved = ts.resolveModuleName(name, file, aliasOptions, ts.sys).resolvedModule?.resolvedFileName;
      aliasCache.set(key, resolved && resolved.endsWith(".ts") && !resolved.endsWith(".d.ts") && !resolved.includes("/node_modules/") ? resolve(resolved) : undefined);
    }
    return aliasCache.get(key);
  }
  const localImport = (name: string, file: string) => name.startsWith(".") || !!aliasModule(name, file);
  function resolveImport(name: string, file: string, node: ts.Node): string {
    const alias = aliasModule(name, file); if (alias) return alias;
    const path = resolve(dirname(file), name), result = [path, `${path}.ts`, `${path}/index.ts`, `${path}.d.ts`].find(x => files.has(x) || existsSync(x));
    if (!result) fail(location(file, source(file), node.getStart()), `cannot resolve model import ${name}`);
    return result;
  }
  function collect(file: string) {
    if (visiting.has(file)) return; visiting.add(file); reachable.push(file);
    const ast = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true);
    if (file.endsWith(".d.ts")) fail(location(file, source(file)), "compiled models require a .ts module with bodies, not .d.ts");
    for (const node of ast.statements) if (valueImport(node, file)) collect(resolveImport(node.moduleSpecifier.text, file, node));
  }
  /** A namespace re-export, `export * as name from "./module"`. */
  function namespaceExport(node: ts.Node): node is ts.ExportDeclaration & { moduleSpecifier: ts.StringLiteral } {
    return ts.isExportDeclaration(node) && !node.isTypeOnly && !!node.exportClause && ts.isNamespaceExport(node.exportClause) && !!node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier);
  }
  /** An import of values from a local module, or a namespace re-export of one: the module is part of the model. */
  function valueImport(node: ts.Node, file: string): node is (ts.ImportDeclaration | ts.ExportDeclaration) & { moduleSpecifier: ts.StringLiteral } {
    if (namespaceExport(node)) return localImport(node.moduleSpecifier.text, file);
    return ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && localImport(node.moduleSpecifier.text, file) && !node.importClause?.isTypeOnly && !(node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) && node.importClause.namedBindings.elements.every(item => item.isTypeOnly));
  }
  collect(entry); for (const factory of options.factories ?? []) collect(resolve(factory));
  const componentNames = options.componentNames ?? [options.name ?? "App", ...(options.factories ?? []).map(file => typeName(basename(file, ".ts")))];
  const env = options.environment ?? createTypeEnvironment(files, entry), checker = env.checker, mapper = options.mapper ?? new TypeMapper(checker, options.strict ?? false, componentNames, env.locationOf);
  const result: ModelProgram = { version: 1, modules: [], types: mapper.declarations, diagnostics: mapper.diagnostics, recursionLimit: options.recursionLimit ?? 256 };
  const declaration = (t: AotType) => t.kind === "named" ? result.types.find(definition => definition.name === t.name) : undefined;
  const scalarBase = (t: AotType): AotType => { const definition=declaration(t);return definition?.kind==="newtype"?scalarBase(definition.base):t; };
  const color = (t: AotType): boolean => { const definition=declaration(t);return definition?.kind==="newtype"&&definition.unit==="Color"; };
  const numeric = (t: AotType): Extract<AotType,{kind:"number"}>|undefined => { const base=scalarBase(t);return !color(t)&&base.kind==="number"?base:undefined; };
  const primitive = (t: AotType): boolean => primitiveType(t) || declaration(t)?.kind === "enum" || declaration(t)?.kind === "newtype" && primitive(scalarBase(t));
  if (!Number.isInteger(result.recursionLimit) || result.recursionLimit < 1) fail(location(entry, source(entry)), "recursionLimit must be a positive integer");
  const bindings = new Map<ts.Symbol, Binding>(), imports = new Map<ts.Symbol, Imported>(), aliases = new Map<string, ts.TypeNode>();
  const declarations = new Map<ModelModule, readonly ts.Statement[]>(), moduleByFile = new Map<string, ModelModule>(), constantActive = new Set<number>();
  const joinTypes = new Map<string, string>();
  /** Host accessor names of exported state fields, with the file that declares each. */
  const hostNames = new Map<string, string>();
  let nextId = 1, current!: ModelModule, currentFunction: ModelFunction | undefined, callbackReturnType: AotType | undefined, effectDepth = 0, generated = 0;
  /** Enclosing loops and switch statements, innermost last, for break and continue. */
  const flow: { kind: "loop" | "switch"; id: number }[] = [], targeted = new Set<number>();
  let loopCounter = 0;
  const loc = (node: ts.Node) => env.locationOf(node);
  function error(node: ts.Node, message: string): never { return fail(loc(node), message); }
  function symbol(node: ts.Node, follow = false): ts.Symbol | undefined { let s = checker.getSymbolAtLocation(node); if (follow && s && s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s); return s; }
  /** Whether an expression names a module: `ns` of `import * as ns` or `export * as ns`, or a member namespace of one. */
  function isNamespace(node: ts.Node): boolean {
    const s = symbol(ts.isPropertyAccessExpression(node) ? node.name : node, true);
    return !!s && !!(s.flags & ts.SymbolFlags.ValueModule) && !!s.declarations?.some(ts.isSourceFile);
  }
  function binding(node: ts.Node): Binding | undefined { if (ts.isPropertyAccessExpression(node) && isNamespace(node.expression)) return binding(node.name); const s = ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent) ? checker.getShorthandAssignmentValueSymbol(node.parent) : symbol(node); return s && (bindings.get(s) ?? bindings.get(s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s)); }
  function imported(node: ts.Node): Imported | undefined { const s = symbol(node); return s && imports.get(s); }
  function register(node: ts.Node, value: Binding): Binding { const s = symbol(node); if (!s) error(node, `unresolved binder ${node.getText()}`); bindings.set(s, value); return value; }
  function named(node: ts.Node): string | undefined { return imported(node)?.name; }
  function callName(node: ts.Expression): string | undefined { return ts.isIdentifier(node) ? named(node) : undefined; }
  function make(node: ts.Node, kind: Record<string, unknown>, type: AotType): ModelExpr { return { ...kind, type, loc: loc(node), ledger: emptyLedger() } as ModelExpr; }
  function check(value: ModelExpr, expected: AotType | undefined, node: ts.Node): ModelExpr {
    if (!expected || expected.kind === "void" || sameType(value.type, expected)) return value;
    if (expected.kind === "string" && value.type.kind === "string") return { ...value, type: expected };
    if (expected.kind === "array" && value.type.kind === "array" && sameType(expected.element, value.type.element)) return { ...value, type: expected };
    if (value.kind === "literal" && typeof value.value === "number" && expected.kind === "number") return { ...value, type: modelNumberType(value.rawNumber ?? String(value.value), expected, loc(node)) };
    if (expected.kind === "option" && value.type.kind !== "option") return value.kind === "undefined" ? { ...value, type:expected } : make(node,{kind:"cast",value:check(value,expected.value,node)},expected);
    if (expected.kind === "named" && value.type.kind === "named" && value.kind === "struct") return { ...value, type: expected, name: expected.name };
    if (expected.kind === "named" && value.kind === "literal") {
      const definition = result.types.find(type => type.name === expected.name);
      if (definition?.kind === "enum" && definition.variants.includes(String(value.value))) return { ...value, type: expected };
      if (definition?.kind === "newtype") {
        if (definition.unit === "Color") {
          if (typeof value.value !== "string") error(node,"Color literals use #rgb, #rgba, #rrggbb, or #rrggbbaa");
          let bits:number;try { bits=parseMicroTsColor(value.value); } catch { error(node,"Color literals use #rgb, #rgba, #rrggbb, or #rrggbbaa"); }
          return { ...value, value: "#"+[bits&255,(bits>>>8)&255,(bits>>>16)&255,bits>>>24].map(byte=>byte.toString(16).padStart(2,"0")).join(""), type:expected };
        }
        const adopted=check(value,definition.base,node);return {...adopted,type:expected};
      }
    }
    const target = declaration(expected), source = declaration(value.type);
    if (target?.kind === "newtype" && target.unit !== "Color" && sameType(value.type,target.base) || source?.kind === "newtype" && source.unit !== "Color" && sameType(source.base,expected)) return make(node,{kind:"cast",value},expected);
    if (value.type.kind === "number" && expected.kind === "number") error(node, `numeric type cannot change from ${expected.name} to ${value.type.name}; annotate the local or use idiv`);
    error(node, `expected ${JSON.stringify(expected)}, received ${JSON.stringify(value.type)}`);
  }
  function type(node: ts.TypeNode | undefined, hint = "Value"): AotType | undefined {
    if (!node) return;
    if (ts.isParenthesizedTypeNode(node)) return type(node.type, hint);
    if (node.kind === ts.SyntaxKind.NumberKeyword) return F64;
    if (node.kind === ts.SyntaxKind.BooleanKeyword) return BOOL;
    if (node.kind === ts.SyntaxKind.StringKeyword) return STRING;
    if (node.kind === ts.SyntaxKind.VoidKeyword) return VOID;
    if (node.kind === ts.SyntaxKind.UndefinedKeyword) return { kind: "undefined" };
    if (ts.isArrayTypeNode(node)) return { kind: "array", element: type(node.elementType, `${hint}Item`)! };
    if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) return type(node.type, hint);
    if (ts.isTypeReferenceNode(node)) {
      const name = imported(node.typeName)?.name ?? node.typeName.getText();
      if (numericNames.has(name)) return { kind: "number", name: name as "i32" };
      if (name === "Cap") {
        const base = type(node.typeArguments?.[0], hint), bound = capacity(node);
        if (!base || (base.kind !== "string" && base.kind !== "array")) error(node, "Cap applies to strings and arrays only");
        return { ...base, capacity: bound };
      }
      if (["Promise", "PromiseLike", "Accessor", "Ref", "Readonly"].includes(name)) return type(node.typeArguments?.[0], hint);
      if (["Array", "ReadonlyArray"].includes(name)) return { kind: "array", element: type(node.typeArguments?.[0], `${hint}Item`)! };
    }
    return mapper.map(checker.getTypeFromTypeNode(node), loc(node), hint);
  }
  function capacity(node: ts.TypeNode | undefined): number | undefined {
    if (node && ts.isTypeReferenceNode(node) && (imported(node.typeName)?.name ?? node.typeName.getText()) === "Cap") {
      const argument = node.typeArguments?.[1], text = argument?.getText();
      if (!text || !/^\d+$/.test(text) || Number(text) < 1) error(node, "Cap requires a positive integer capacity");
      return Number(text);
    }
  }
  function bindLocal(node: ts.Identifier, valueType: AotType, owned = true): ModelBinder {
    const b: ModelBinder = { id: nextId++, name: node.text, type: valueType, owned, ...(storageCapacity(valueType) !== undefined ? { capacity: storageCapacity(valueType) } : {}), loc: loc(node) };
    register(node, { id: b.id, name: b.name, kind: "local", type: valueType, node, module: current, binder: b }); return b;
  }
  function storageCapacity(valueType: AotType): number | undefined { return valueType.kind === "array" || valueType.kind === "string" ? valueType.capacity : undefined; }
  function temp(value: ModelExpr, into: ModelStmt[]): ModelExpr {
    if (["literal", "undefined", "local"].includes(value.kind)) return value;
    const b: ModelBinder = { id: nextId++, name: `_arg${generated++}`, type: value.type, owned: true, loc: value.loc };
    into.push({ kind: "let", binder: b, init: !primitive(value.type) ? { ...value, kind: "copy", value } : value, loc: value.loc }); return { kind: "local", id: b.id, type: b.type, ledger: emptyLedger(), loc: value.loc };
  }
  /** Whether running a value or statements may call a function or change state. */
  function effectful(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(effectful);
    const kind = (value as { kind?: string }).kind;
    if (kind === "lambda") return false;
    if (kind && ["invoke", "call", "mutate", "sequence", "assign", "set", "start", "await", "external"].includes(kind)) return true;
    return Object.entries(value).some(([key, child]) => key !== "loc" && key !== "ledger" && key !== "type" && effectful(child));
  }
  /**
   * Lowers built-in call arguments in source order. Statements that lowering an
   * argument emits run before the call; when they, or an earlier argument, have
   * effects, the earlier arguments are bound to temporaries first.
   */
  function inOrder(count: number, lower: (index: number, into: ModelStmt[], earlier: ModelExpr[]) => ModelExpr, into: ModelStmt[]): ModelExpr[] {
    const values: ModelExpr[] = [];
    for (let index = 0; index < count; index++) {
      const statements: ModelStmt[] = [];
      const value = lower(index, statements, values);
      if (statements.length) {
        const later = effectful(statements);
        for (let j = 0; j < values.length; j++) if (later || effectful(values[j])) values[j] = temp(values[j]!, into);
      }
      into.push(...statements);
      values.push(value);
    }
    return values;
  }
  /**
   * A value stored into Cap storage of `type`, bound to a local of that type first, so
   * every backend bounds it there and reports an overflow under `name`.
   */
  function bounded(value: ModelExpr, type: AotType, name: string, into: ModelStmt[], node: ts.Node): ModelExpr {
    if (!("capacity" in type) || type.capacity === undefined) return value;
    const b: ModelBinder = { id: nextId++, name, type, owned: true, loc: value.loc };
    into.push({ kind: "let", binder: b, init: make(node, { kind: "copy", value }, type), loc: value.loc });
    return { kind: "local", id: b.id, type, ledger: emptyLedger(), loc: value.loc };
  }
  /** Constant default values of function parameters, by parameter binder id. */
  const parameterDefaults = new Map<number, ts.Expression>();
  function args(nodes: readonly ts.Expression[], into: ModelStmt[], parameters?: ModelBinder[]): ModelExpr[] {
    const values = nodes.map((n, i) => temp(expr(n, parameters?.[i]?.type, into), into));
    for (const parameter of parameters?.slice(nodes.length) ?? []) {
      const initializer = parameterDefaults.get(parameter.id)!;
      const value = isolated(initializer, parameter.type);
      if (!constantExpression(value)) error(initializer, "parameter defaults require literals or constants");
      // Call arguments are atomic; a default array or struct literal is bound first.
      values.push(temp(value, into));
    }
    return values;
  }
  function checkArity(node: ts.CallExpression, fn: ModelFunction, name: string): void {
    const required = fn.params.filter(parameter => !parameterDefaults.has(parameter.id)).length;
    if (node.arguments.length < required || node.arguments.length > fn.params.length) error(node, `function ${name} expects ${required === fn.params.length ? required : `${required} to ${fn.params.length}`} arguments`);
  }
  function isolated(node: ts.Expression, expected?: AotType): ModelExpr { const statements: ModelStmt[] = [], value = expr(node, expected, statements); return statements.length ? make(node, { kind: "sequence", body: { stmts: statements }, value }, value.type) : value; }
  function loadConstant(b: Binding): ModelExpr {
    if (b.value) return b.value;
    if (constantActive.has(b.id)) error(b.node, `constant cycle at ${b.name}`);
    constantActive.add(b.id); const before = current; current = b.module;
    b.value = isolated(b.declaration!.initializer!, type(b.declaration!.type, b.name)); b.type = b.value.type;
    if (!constantExpression(b.value)) error(b.declaration!.initializer!, "module constants and seeds require literals, constants, or object and array literals of literals");
    current = before; constantActive.delete(b.id); return b.value;
  }
  /**
   * Whether a value is built from literals and constants only. `bound` holds the
   * temporaries of an enclosing sequence, such as the operands of `fill(4 * W * H, 0)`
   * bound before the call, which count as constant when their initializers do.
   */
  function constantExpression(e: ModelExpr, bound: ReadonlySet<number> = new Set()): boolean {
    const constant = (value: ModelExpr) => constantExpression(value, bound);
    if (e.kind === "sequence") {
      const inner = new Set(bound);
      for (const stmt of e.body.stmts) {
        if (stmt.kind !== "let" || !constantExpression(stmt.init, inner)) return false;
        inner.add(stmt.binder.id);
      }
      return constantExpression(e.value, inner);
    }
    return e.kind === "literal" || e.kind === "undefined" || e.kind === "constant" || (e.kind === "cast" || e.kind === "copy") && constant(e.value) || e.kind === "unary" && constant(e.operand) || e.kind === "binary" && constant(e.left) && constant(e.right) || e.kind === "struct" && e.fields.every(x => constant(x.value)) || e.kind === "array" && e.items.every(constant) || e.kind === "builtin" && (["fill", "embedBytes"].includes(e.name) || numericNames.has(e.name)) && e.args.every(constant) || e.kind === "local" && (bound.has(e.id) || current.params.some(p => p.id === e.id));
  }
  /** Array constants of scalars are stored once as statics instead of being inlined at each use. */
  function staticConstant(value: ModelExpr): boolean {
    // A Cap array keeps its bounded storage, so it is not a static slice.
    if (value.type.kind !== "array" || value.type.capacity !== undefined || !primitive(value.type.element) || scalarBase(value.type.element).kind === "string") return false;
    return value.kind === "array" && value.items.every(item => item.kind === "literal" || item.kind === "unary" && item.operand.kind === "literal") || value.kind === "builtin" && value.name === "embedBytes";
  }
  function read(b: Binding, node: ts.Node): ModelExpr {
    if (b.kind === "constant") { const value = loadConstant(b); return staticConstant(value) ? make(node, { kind: "constant", id: b.id, value }, value.type) : { ...value, loc: loc(node) }; }
    if (b.kind === "function" || b.kind === "setter") error(node, "function values may not escape; call the function or use an admitted inline callback");
    if (b.kind === "ref") return make(node, { kind: "literal", value: b.name }, STRING);
    const value=make(node, { kind: b.kind, id: b.id }, b.type);
    if(b.type.kind==="option") {
      const narrowed=checker.getTypeAtLocation(node);
      const optional=(t:ts.Type):boolean=>!!(t.flags&ts.TypeFlags.Undefined)||t.isUnion()&&t.types.some(optional);
      if(!(narrowed.flags&(ts.TypeFlags.Any|ts.TypeFlags.Unknown))&&!optional(narrowed))return make(node,{kind:"cast",value},b.type.value);
    }
    return value;
  }
  function memberType(object: ModelExpr, name: string, node: ts.Node): AotType {
    const base = object.type.kind === "option" ? object.type.value : object.type;
    if (base.kind !== "named") error(node, "property access is limited to contract struct fields and enum members; use len() for length");
    const declaration = result.types.find(t => t.name === base.name);
    if (declaration?.kind === "struct") { const f = declaration.fields.find(f => f.name === name); if (f) return f.type; }
    if (declaration?.kind === "union") {
      if (name === declaration.discriminant) return STRING;
      const field = declaration.variants.flatMap(v => v.fields).find(f => f.name === name); if (field) return field.type;
    }
    error(node, `unknown contract field ${name}`);
  }
  function expr(node: ts.Expression, expected: AotType | undefined, into: ModelStmt[]): ModelExpr {
    if (ts.isParenthesizedExpression(node)) return expr(node.expression, expected, into);
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      if (node.type.getText() === "const") return expr(node.expression, expected, into);
      const target = type(node.type)!; const value = expr(node.expression, target, into); return check(make(node, { kind: "cast", value }, target), expected, node);
    }
    if (ts.isNumericLiteral(node) || ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.MinusToken, ts.SyntaxKind.PlusToken].includes(node.operator) && ts.isNumericLiteral(node.operand)) {
      const raw = node.getText(), numberType = modelNumberType(raw, expected ? numeric(expected) ?? expected : undefined, loc(node));
      const spelling = raw.replaceAll("_", ""), sign = spelling.startsWith("-") ? -1 : 1;
      return check(make(node, { kind: "literal", value: sign * Number(spelling.replace(/^[+-]/, "")), rawNumber: raw }, numberType), expected, node);
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return check(make(node, { kind: "literal", value: node.text }, expected?.kind === "string" ? expected : STRING), expected, node);
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return check(make(node, { kind: "literal", value: node.kind === ts.SyntaxKind.TrueKeyword }, BOOL), expected, node);
    if (ts.isIdentifier(node)) {
      if (node.text === "undefined") return check(make(node, { kind: "undefined" }, { kind: "undefined" }), expected, node);
      const b = binding(node); if (!b) error(node, `unresolved model name ${node.text}`);
      if (["signal", "memo"].includes(b.kind)) error(node, isVueBinding(b) ? "Vue refs and computed values must be read through .value" : "Solid accessors must be called to read their values");
      return check(read(b, node), expected, node);
    }
    if (ts.isPropertyAccessExpression(node) && isNamespace(node.expression)) return expr(node.name, expected, into);
    if (isNamespace(node)) error(node, "a namespace names its members; it is not a value");
    if (ts.isPropertyAccessExpression(node)) {
      const b = binding(node.expression);
      if (b?.kind === "memo") ensureMemo(b.id);
      if (b && ["signal", "memo"].includes(b.kind) && node.name.text === "value" && isVueBinding(b)) return check(read(b, node), expected, node);
      const enumSymbol = symbol(node.expression, true), enumDecl = enumSymbol?.declarations?.find(ts.isEnumDeclaration);
      if (enumDecl) { const member = enumDecl.members.find(m => m.name.getText() === node.name.text); if (!member) error(node, "unknown enum member"); const value = checker.getConstantValue(member); if (value === undefined) error(node, "enum members require constant values"); const enumType=typeof value==="string"?mapper.map(checker.getDeclaredTypeOfSymbol(enumSymbol!),loc(node),enumDecl.name.text):I32;return check(make(node, { kind: "literal", value }, enumType), expected, node); }
      if (imported(node.expression)?.name === "BTN") {
        const property = checker.getSymbolAtLocation(node.name), decl = property?.valueDeclaration;
        if (decl && ts.isPropertyAssignment(decl) && ts.isNumericLiteral(decl.initializer)) return expr(decl.initializer, I32, into);
        error(node, `unresolved button constant ${node.name.text}`);
      }
      const object = expr(node.expression, undefined, into), valueType = memberType(object, node.name.text, node);
      const objectBase = object.type.kind === "option" ? object.type.value : object.type;
      const objectName = objectBase.kind === "named" ? objectBase.name : undefined;
      const definition = result.types.find(t => t.name === objectName);
      let variant: string | undefined;
      if (definition?.kind === "union") {
        const narrowed = checker.getTypeAtLocation(node.expression), discriminant = narrowed.getProperty(definition.discriminant);
        const tag = discriminant && mapper.literal(checker.getTypeOfSymbolAtLocation(discriminant, node.expression));
        if (typeof tag === "string" && definition.variants.some(v => v.name === tag)) variant = tag;
      }
      return check(make(node, { kind: "member", object, name: node.name.text, optional: !!node.questionDotToken, ...(variant ? { variant } : {}) }, valueType), expected, node);
    }
    if (ts.isElementAccessExpression(node)) {
      const object = expr(node.expression, undefined, into); if (object.type.kind !== "array") error(node, "only arrays admit index reads");
      const index = expr(node.argumentExpression, I32, into);
      checkArrayIndex(object, index, node.argumentExpression);
      return check(make(node, { kind: "index", object, index }, object.type.element), expected, node);
    }
    if (ts.isObjectLiteralExpression(node)) {
      const target = expected ?? mapper.map(checker.getTypeAtLocation(node), loc(node), "ModelObject");
      if (target.kind !== "named") error(node, "object literals require a contract struct or union type");
      const definition = result.types.find(t => t.name === target.name), fields = node.properties.map(property => {
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) error(property, "object literal spreads, methods and accessors are outside the model subset");
        const name = property.name.getText().replace(/^['"]|['"]$/g, "");
        const annotation = definition?.kind === "struct" ? definition.fields.find(f => f.name === name)?.type : definition?.kind === "union" ? definition.variants.flatMap(v => v.fields).find(f => f.name === name)?.type : undefined;
        return { name, value: expr(ts.isPropertyAssignment(property) ? property.initializer : property.name, annotation, into) };
      });
      const tag = definition?.kind === "union" ? fields.find(f => f.name === definition.discriminant)?.value : undefined;
      const variant = tag?.kind === "literal" && typeof tag.value === "string" ? tag.value : undefined;
      return make(node, { kind: "struct", name: target.name, fields, ...(variant ? { variant } : {}) }, target);
    }
    if (ts.isArrayLiteralExpression(node)) {
      const element = expected?.kind === "array" ? expected.element : node.elements[0] ? expr(node.elements[0] as ts.Expression, undefined, []).type : undefined;
      if (!element) error(node, "empty arrays require an element type from their position");
      const items = node.elements.map(x => { if (ts.isSpreadElement(x) || ts.isOmittedExpression(x)) error(x, "array spread and holes are outside the model subset"); return expr(x, element, into); });
      return check(make(node, { kind: "array", element, items }, expected?.kind === "array" ? expected : { kind: "array", element }), expected, node);
    }
    if (ts.isPrefixUnaryExpression(node)) {
      const operator = ts.tokenToString(node.operator); if (!["!", "-", "+", "~"].includes(operator ?? "")) error(node, "unsupported unary operator");
      const operand = expr(node.operand, operator === "!" ? BOOL : expected, into);
      if (operator !== "!" && !numeric(operand.type)) error(node, "numeric unary operator requires a number");
      if (operator === "~" && numeric(operand.type)!.name.startsWith("f")) error(node, "~ requires an integer operand");
      return check(make(node, { kind: "unary", operator, operand }, operator === "!" ? BOOL : operand.type), expected, node);
    }
    if (ts.isConditionalExpression(node)) {
      const condition = expr(node.condition, BOOL, into);
      let consequent = isolated(node.whenTrue, expected), alternate = isolated(node.whenFalse, expected ?? (consequent.kind==="literal"?undefined:consequent.type));
      if(!expected&&consequent.kind==="literal"&&(numeric(alternate.type)||color(alternate.type)||declaration(alternate.type)?.kind==="enum"))consequent=check(consequent,alternate.type,node.whenTrue);
      alternate=check(alternate,consequent.type,node.whenFalse);
      return make(node, { kind: "conditional", condition, consequent, alternate }, consequent.type);
    }
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.getText();
      if (!["+", "-", "*", "/", "%", "<", "<=", ">", ">=", "===", "!==", "&&", "||", "??", "&", "|", "^", "<<", ">>", ">>>"].includes(operator)) error(node.operatorToken, `operator ${operator} is outside the model subset`);
      const comparison = ["<", "<=", ">", ">=", "===", "!=="].includes(operator), logic = ["&&", "||"].includes(operator);
      let left = expr(node.left, logic ? BOOL : !comparison && operator !== "/" && operator !== "??" && expected && numeric(expected) ? expected : undefined, into);
      left = temp(left, into);
      const literalLeft = left.kind === "literal" && (typeof left.value === "number" || typeof left.value === "string");
      const right = ["&&", "||", "??"].includes(operator) ? isolated(node.right, logic ? BOOL : left.type.kind === "option" ? left.type.value : undefined) : expr(node.right, literalLeft && !(expected&&!comparison&&numeric(expected)) || comparison && left.kind === "undefined" || operator === "+" && (left.type.kind === "string" || ts.isStringLiteral(node.right) || ts.isTemplateExpression(node.right)) ? undefined : left.type, into);
      if (literalLeft && (numeric(right.type) && typeof (left as Extract<ModelExpr,{kind:"literal"}>).value === "number" || comparison && (declaration(right.type)?.kind === "enum" || color(right.type)))) left = check(left,right.type,node.left);
      const presence = left.type.kind === "option" && right.kind === "undefined" || left.kind === "undefined" && right.type.kind === "option";
      if ((color(left.type)||color(right.type))&&!["===","!==","??"].includes(operator)) error(node,"Color arithmetic and ordered comparisons are outside the subset");
      if (["===", "!=="].includes(operator) && !presence && (!primitive(left.type) || !primitive(right.type))) error(node, "=== and !== on non-primitive values are outside the subset; use equals(a, b)");
      if (operator === "??" && left.type.kind !== "option") error(node, "?? requires an Option value");
      if (["-", "*", "/", "%", "&", "|", "^", "<<", ">>", ">>>"].includes(operator) && (!numeric(left.type) || !numeric(right.type))) error(node, "numeric operator requires numbers");
      if (["<","<=",">",">="].includes(operator)&&(!numeric(left.type)||!numeric(right.type))&&!(scalarBase(left.type).kind==="string"&&scalarBase(right.type).kind==="string")) error(node,"ordered comparisons require numbers or strings");
      if (["&", "|", "^", "<<", ">>", ">>>"].includes(operator) && numeric(left.type)!.name.startsWith("f")) error(node, `${operator} requires integer operands`);
      const outType = comparison || logic ? BOOL : operator === "/" ? numeric(left.type)?.name.startsWith("f")?left.type:F64 : operator === "+" && (scalarBase(left.type).kind === "string" || scalarBase(right.type).kind === "string") ? declaration(left.type)?.kind==="newtype"&&scalarBase(left.type).kind==="string"?left.type:STRING : operator === "??" && left.type.kind === "option" ? left.type.value : left.type;
      if (numeric(outType)?.name === "i64") {
        if (options.strict) error(node, "i64 arithmetic loses precision above 2^53 on JavaScript classes");
        if (!result.diagnostics.some(d => d.offset === node.getStart() && d.file === node.getSourceFile().fileName)) result.diagnostics.push({ ...loc(node), severity: "warning", message: "i64 arithmetic loses precision above 2^53 on JavaScript classes" });
      }
      return check(make(node, { kind: "binary", operator, left, right }, outType), expected, node);
    }
    if (ts.isTemplateExpression(node)) return check(make(node, { kind: "template", parts: [node.head.text, ...node.templateSpans.flatMap(span => [expr(span.expression, undefined, into), span.literal.text])] }, STRING), expected, node);
    if (ts.isCallExpression(node)) {
      const b = binding(node.expression), name = callName(node.expression);
      if (b?.kind === "signal" || b?.kind === "memo") { if (b.kind === "memo") ensureMemo(b.id); if (node.arguments.length) error(node, "accessor reads take no arguments"); return check(read(b, node), expected, node); }
      if (b?.kind === "function") {
        ensureFunction(b.id);
        if (b.fn!.async) error(node, "an async call must start a task as a statement or be awaited");
        checkArity(node, b.fn!, b.name);
        return check(make(node, { kind: "invoke", callee: b.id, args: args(node.arguments, into, b.fn!.params) }, b.fn!.returns), expected, node);
      }
      if (name === "copy") { if (node.arguments.length !== 1) error(node, "copy requires one argument"); const value = expr(node.arguments[0]!, expected, into); return make(node, { kind: "copy", value }, value.type); }
      if (name && numericNames.has(name)) {
        if (node.arguments.length !== 1) error(node, `${name}() converts one number`);
        const value = expr(node.arguments[0]!, undefined, into); if (!numeric(value.type)) error(node.arguments[0]!, `${name}() requires a number`);
        return check(make(node, { kind: "builtin", name, args: [value] }, { kind: "number", name: name as "i32" }), expected, node);
      }
      if (name && mathNames.has(name)) {
        const arity = (MICROTS_MATH2_BUILTINS as readonly string[]).includes(name) ? 2 : 1;
        if (node.arguments.length !== arity) error(node, `${name}() takes ${arity} argument${arity > 1 ? "s" : ""}`);
        const floatHint = expected && numeric(expected)?.name.startsWith("f") ? numeric(expected) : undefined;
        let type: ReturnType<typeof numeric>;
        const args = inOrder(arity, (index, statements) => {
          if (index > 0) return expr(node.arguments[index]!, type, statements);
          const first = expr(node.arguments[0]!, floatHint, statements); type = numeric(first.type);
          if (!type?.name.startsWith("f")) error(node.arguments[0]!, `${name}() requires f32 or f64; convert integers with f32() or f64()`);
          return first;
        }, into);
        return check(make(node, { kind: "builtin", name, args }, type!), expected, node);
      }
      if (name === "fill") {
        if (node.arguments.length !== 2) error(node, "fill(count, value) takes two arguments");
        const element = expected?.kind === "array" ? expected.element : undefined;
        const [count, value] = inOrder(2, (index, statements) => {
          if (index === 0) return expr(node.arguments[0]!, I32, statements);
          const value = expr(node.arguments[1]!, element, statements);
          return element ? bounded(check(value, element, node.arguments[1]!), element, "fill", statements, node.arguments[1]!) : value;
        }, into) as [ModelExpr, ModelExpr];
        return check(make(node, { kind: "builtin", name, args: [count, value] }, { kind: "array", element: value.type }), expected, node);
      }
      if (name === "embedBytes") {
        const argument = node.arguments[0];
        if (node.arguments.length !== 1 || !argument || !ts.isStringLiteral(argument)) error(node, "embedBytes requires one string literal path");
        const path = resolve(dirname(node.getSourceFile().fileName), argument.text);
        if (!existsSync(path)) error(argument, `embedded file ${path} does not exist`);
        return check(make(node, { kind: "builtin", name, args: [make(argument, { kind: "literal", value: path }, STRING)] }, { kind: "array", element: { kind: "number", name: "u8" } }), expected, node);
      }
      if (name === "codePoints" || name === "fromCodePoint") {
        if (node.arguments.length !== 1) error(node, `${name} takes one argument`);
        const value = expr(node.arguments[0]!, name === "codePoints" ? STRING : I32, into);
        return check(make(node, { kind: "builtin", name, args: [value] }, name === "codePoints" ? { kind: "array", element: I32 } : STRING), expected, node);
      }
      if (name && mutationNames.has(name)) return mutation(node, name as MutationName, expected, into);
      if (name && stdNames.has(name) && !["frames", "after", "until", "join", "all", "any", "cancel"].includes(name)) {
        const values = inOrder(node.arguments.length, (i, statements, values) => {
          const argument = node.arguments[i]!;
          if (ts.isArrowFunction(argument)) {
            if (!["map", "filter", "find", "some"].includes(name) || i !== 1 || ts.isBlock(argument.body)) error(argument, "collection callbacks require one inline expression");
            const array = values[0]; if (array?.type.kind !== "array") error(argument, "collection built-ins require an array");
            const elementType = array.type.element;
            const params = argument.parameters.map((p, index) => { if (!ts.isIdentifier(p.name) || index > 1) error(p, "collection callback accepts element and index only"); return bindLocal(p.name, index === 0 ? elementType : I32, false); });
            const value = isolated(argument.body, name === "map" ? expected?.kind === "array" ? expected.element : undefined : BOOL);
            return make(argument, { kind: "lambda", params, body: { stmts: [{ kind: "return", value }] } }, value.type);
          }
          return expr(argument, i > 0 && ["idiv", "imod", "min", "max", "clamp", "equals"].includes(name) ? values[0]?.type : undefined, statements);
        }, into);
        let out = expected ?? values[0]?.type ?? VOID;
        if (["len", "trunc", "floor", "ceil", "round"].includes(name)) out = I32;
        if (["equals", "some"].includes(name)) out = BOOL;
        if (name === "fixed") out = STRING;
        if (name === "map") out = { kind: "array", element: values[1]!.type };
        if (name === "filter") out = values[0]!.type;
        if (name === "find") { if (values[0]?.type.kind !== "array") error(node, "find requires an array"); out = { kind: "option", value: values[0].type.element }; }
        return check(make(node, { kind: "builtin", name, args: values }, out), expected, node);
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === "String" && !binding(node.expression)) return make(node, { kind: "builtin", name: "String", args: args(node.arguments, into) }, STRING);
      error(node, `call ${node.expression.getText()} is outside the model subset`);
    }
    if (ts.isAwaitExpression(node)) error(node, "await must occur as a task statement or local initializer");
    error(node, `${ts.SyntaxKind[node.kind]} is outside the model expression subset`);
  }
  function isVueBinding(b: Binding) { return ts.isVariableDeclaration(b.node) && !!b.node.initializer && ts.isCallExpression(b.node.initializer) && ["ref", "computed"].includes(callName(b.node.initializer.expression) ?? ""); }
  function viewOf(e: ModelExpr): number | undefined { return e.kind === "signal" ? e.id : e.kind === "local" ? [...bindings.values()].find(b => b.id === e.id)?.binder?.viewOf : undefined; }
  function arrayBound(e: ModelExpr): number | undefined {
    if (e.kind === "array") return e.items.length;
    if (e.kind === "constant") return arrayBound(e.value);
    if (e.kind === "builtin" && e.name === "fill" && e.args[0]?.kind === "literal") return Number(e.args[0].value);
    if (e.kind === "copy" || e.kind === "cast") return arrayBound(e.value);
    if (e.kind === "local") { const bound = [...bindings.values()].find(b => b.id === e.id)?.arrayBound; if (bound !== undefined) return bound; }
    if (e.type.kind === "array") return e.type.length ?? e.type.capacity;
  }
  function checkArrayIndex(object: ModelExpr, index: ModelExpr, node: ts.Node): void {
    const bound = arrayBound(object);
    if (index.kind === "literal" && typeof index.value === "number" && (index.value < 0 || bound !== undefined && index.value >= bound)) error(node, "constant array index is outside the array");
  }
  function immutableView(e: ModelExpr): boolean {
    if (e.kind === "signal" || e.kind === "memo") return true;
    if (e.kind === "local") return [...bindings.values()].find(b => b.id === e.id)?.binder?.owned === false;
    if (e.kind === "member" || e.kind === "index") return immutableView(e.object);
    if (e.kind === "cast") return immutableView(e.value);
    if (e.kind === "conditional") return immutableView(e.consequent) || immutableView(e.alternate);
    if (e.kind === "sequence") return immutableView(e.value);
    return false;
  }
  type Place = { root: { kind: "local" | "field"; id: number }; rootType: AotType; steps: ModelPathStep[]; types: AotType[]; type: AotType; binding: Binding };
  /** An assignable place: a local or field root followed by element and member steps. Index operands are evaluated once, into temporaries. */
  function place(node: ts.Expression, into: ModelStmt[]): Place {
    if (ts.isParenthesizedExpression(node)) return place(node.expression, into);
    if (ts.isPropertyAccessExpression(node) && isNamespace(node.expression)) return place(node.name, into);
    if (ts.isIdentifier(node)) {
      const b = binding(node);
      if (!b || b.kind !== "local" && b.kind !== "field") error(node, "assignment target must be a local, a private field, or an element or member of one");
      return { root: { kind: b.kind, id: b.id }, rootType: b.type, steps: [], types: [], type: b.type, binding: b };
    }
    if (ts.isElementAccessExpression(node)) {
      const base = owned(place(node.expression, into), node.expression);
      if (base.type.kind !== "array") error(node, "element assignment requires an owned array");
      const index = temp(expr(node.argumentExpression, I32, into), into);
      checkArrayIndex(placeRead(base, node.expression), index, node.argumentExpression);
      return { ...base, steps: [...base.steps, { kind: "index", index }], types: [...base.types, base.type.element], type: base.type.element };
    }
    if (ts.isPropertyAccessExpression(node)) {
      const base = owned(place(node.expression, into), node.expression);
      const declaration = base.type.kind === "named" ? result.types.find(t => t.name === (base.type as Extract<AotType, { kind: "named" }>).name) : undefined;
      if (declaration?.kind !== "struct") error(node, "member assignment requires a contract struct");
      const type = memberType(placeRead(base, node.expression), node.name.text, node);
      return { ...base, steps: [...base.steps, { kind: "member", name: node.name.text }], types: [...base.types, type], type };
    }
    error(node, "assignment target must be a local, a private field, or an element or member of one");
  }
  function owned(p: Place, node: ts.Node): Place {
    if (!p.steps.length && p.root.kind === "local" && !p.binding.binder?.owned) error(node, "write through a view is outside the model subset; use copy()");
    return p;
  }
  function placeRead(p: Place, node: ts.Node): ModelExpr {
    let value = make(node, { kind: p.root.kind, id: p.root.id }, p.rootType);
    p.steps.forEach((step, index) => { value = make(node, step.kind === "index" ? { kind: "index", object: value, index: step.index } : { kind: "member", object: value, name: step.name }, p.types[index]!); });
    return value;
  }
  function placeTarget(p: Place): ModelTargetType {
    const [step] = p.steps;
    if (!step) return { kind: p.root.kind, id: p.root.id };
    if (p.root.kind === "local" && p.steps.length === 1) return step.kind === "index" ? { kind: "element", owner: p.root.id, index: step.index } : { kind: "member", owner: p.root.id, name: step.name };
    return { kind: "path", root: p.root, steps: p.steps };
  }
  type MutationName = "push" | "pop" | "insert" | "removeAt" | "clear" | "truncate" | "fillRange" | "copyRange" | "fillRect" | "copyRect";
  /** In-place array built-ins take an assignable place as their first argument. */
  function mutation(node: ts.CallExpression, name: MutationName, expected: AotType | undefined, into: ModelStmt[]): ModelExpr {
    const arity = { push: 2, pop: 1, insert: 3, removeAt: 2, clear: 1, truncate: 2, fillRange: 4, copyRange: 5, fillRect: 6, copyRect: 8 }[name];
    // copyRange and copyRect take an optional last argument: a source value they skip.
    const copies = name === "copyRange" || name === "copyRect", source = name === "copyRect" ? 2 : 1;
    if (node.arguments.length !== arity && !(copies && node.arguments.length === arity + 1)) error(node, `${name} takes ${arity} argument${arity > 1 ? "s" : ""}`);
    const target = owned(place(node.arguments[0]!, into), node.arguments[0]!);
    if (target.type.kind !== "array") error(node.arguments[0]!, `${name} requires an array place`);
    if (target.type.capacity !== undefined && ["push", "insert", "removeAt", "truncate"].includes(name)) error(node, `${name} on a Cap array is outside the subset`);
    const element = target.type.element;
    if (copies && (!primitive(element) || scalarBase(element).kind === "string")) error(node.arguments[0]!, `${name} requires numeric, boolean or enum elements`);
    const types: Record<MutationName, (AotType | undefined)[]> = { push: [element], pop: [], insert: [I32, element], removeAt: [I32], clear: [], truncate: [I32], fillRange: [I32, I32, element], copyRange: [I32, target.type, I32, I32, element], fillRect: [I32, I32, I32, I32, element], copyRect: [I32, I32, target.type, I32, I32, I32, I32, element] };
    // The source of a copy stays a place, read in place, unless a later argument's effects force it into a temporary.
    const stored = ({ push: 0, insert: 1, fillRange: 2, fillRect: 4 } as Partial<Record<MutationName, number>>)[name];
    const args = inOrder(node.arguments.length - 1, (index, statements) => {
      const argument = node.arguments[index + 1]!, value = expr(argument, types[name][index], statements);
      if (copies && index === source) { if (value.type.kind !== "array" || !sameType(value.type.element, element)) error(argument, `${name} source must have the target's element type`); return value; }
      const checked = check(value, types[name][index], argument);
      // A value stored into Cap elements is bounded, and reported under the array's name, before the call.
      return index === stored ? temp(bounded(checked, element, target.binding.name, statements, argument), statements) : temp(checked, statements);
    }, into);
    const result = name === "pop" || name === "removeAt" ? element : VOID;
    const value = make(node, { kind: "mutate", op: name, target: placeTarget(target), args }, result);
    if (target.root.kind === "local") for (const b of bindings.values()) if (b.id === target.root.id) { if (b.binder) delete b.binder.viewOf; delete b.arrayBound; }
    return result.kind === "void" ? value : check(value, expected, node);
  }
  function setter(signal: Binding, valueNode: ts.Expression, into: ModelStmt[], node: ts.Node): void {
    let value: ModelExpr, pre: ModelBinder | undefined;
    if (ts.isArrowFunction(valueNode)) {
      if (valueNode.parameters.length !== 1 || !ts.isIdentifier(valueNode.parameters[0]!.name)) error(valueNode, "a functional setter requires one parameter");
      pre = bindLocal(valueNode.parameters[0]!.name as ts.Identifier, signal.type, false);
      if (ts.isBlock(valueNode.body)) {
        const previousReturnType = callbackReturnType; callbackReturnType = signal.type;
        const body = lowerBlock(valueNode.body), last = body.stmts.at(-1);
        callbackReturnType = previousReturnType;
        if (last?.kind !== "return" || !last.value) error(valueNode.body, "setter callback must return its value");
        body.stmts.pop(); value = make(valueNode, { kind: "sequence", body, value: check(last.value, signal.type, valueNode) }, signal.type);
      } else value = isolated(valueNode.body, signal.type);
    } else value = expr(valueNode, signal.type, into);
    const writeBack = !primitive(signal.type) && viewOf(value) === signal.id;
    into.push({ kind: "set", signal: signal.id, value, ...(pre ? { pre } : {}), ...(writeBack ? { writeBack: true as const } : {}), loc: loc(node) });
    // A stored view no longer denotes the current value after an intervening write.
    if (!writeBack) for (const b of bindings.values()) if (b.binder?.viewOf === signal.id) delete b.binder.viewOf;
  }
  function awaitable(node: ts.Expression, into: ModelStmt[]): { source: ModelAwaitable; type: AotType } {
    if (!currentFunction?.async) error(node, "await is admitted only inside an async function, never a memo or effect");
    if (!ts.isCallExpression(node)) error(node, "awaitable is outside the closed model set");
    const name = callName(node.expression), fn = binding(node.expression);
    if (name === "frames" || name === "after") {
      if (node.arguments.length !== 1) error(node, `${name} requires one argument`);
      const value = isolated(node.arguments[0]!, name === "frames" ? I32 : undefined);
      return { source: name === "frames" ? { kind: "frames", count: value } : { kind: "after", ms: value }, type: VOID };
    }
    if (name === "until") {
      const callback = node.arguments[0]; if (!callback || !ts.isArrowFunction(callback) || ts.isBlock(callback.body) || callback.parameters.length) error(node, "until requires an inline predicate expression");
      return { source: { kind: "until", predicate: isolated(callback.body, BOOL) }, type: VOID };
    }
    if (fn?.fn?.async) {
      ensureFunction(fn.id);
      if (node.arguments.length !== fn.fn.params.length) error(node, `function ${fn.name} expects ${fn.fn.params.length} arguments`);
      return { source: { kind: "join", task: fn.id, wrapped: false, args: node.arguments.map((arg, i) => isolated(arg, fn.fn!.params[i]?.type)) }, type: fn.fn.returns };
    }
    if (name === "join") {
      const call = node.arguments[0]; if (!call) error(node, "join requires one task call");
      const inner = awaitable(call, into); if (inner.source.kind !== "join") error(node, "join requires an async function call");
      const key = JSON.stringify(inner.type), base = `Join${typeName(inner.type.kind === "named" ? inner.type.name : inner.type.kind)}`;
      let joined = joinTypes.get(key);
      if (!joined) {
        joined = base; let suffix = 2; while (result.types.some(t => t.name === joined)) joined = `${base}${suffix++}`;
        joinTypes.set(key, joined);
        result.types.push({ kind: "union", name: joined, discriminant: "kind", variants: [{ name: "done", fields: inner.type.kind === "void" ? [] : [{ name: "value", type: inner.type }] }, { name: "cancelled", fields: [] }] });
      }
      return { source: { ...inner.source, wrapped: true }, type: { kind: "named", name: joined } };
    }
    if (name === "all" || name === "any") {
      const array = node.arguments[0]; if (!array || !ts.isArrayLiteralExpression(array) || !array.elements.length) error(node, `${name} requires a nonempty literal array of awaitables`);
      const members = array.elements.map(n => awaitable(n as ts.Expression, into));
      let returned: AotType = { kind: "tuple", elements: members.map(m => m.type) };
      if (name === "any") {
        const concrete = members.flatMap(m => m.type.kind === "void" || m.type.kind === "undefined" ? [] : [m.type.kind === "option" ? m.type.value : m.type]);
        const optional = members.some(m => ["void", "undefined", "option"].includes(m.type.kind));
        if (!concrete.length) returned = VOID;
        else if (concrete.every(t => sameType(t, concrete[0]!))) returned = optional ? { kind: "option", value: concrete[0]! } : concrete[0]!;
        else {
          const resultType = checker.getAwaitedType(checker.getTypeAtLocation(node));
          if (!resultType) error(node, "any result requires a closed contract union");
          returned = mapper.map(resultType, loc(node), "AnyResult");
        }
      }
      return { source: { kind: name, members: members.map(m => m.source) }, type: returned };
    }
    if (name === "animate") return { source: { kind: "animate", args: node.arguments.map(arg => isolated(arg)) }, type: STRING };
    if (ts.isPropertyAccessExpression(node.expression)) {
      const service = imported(node.expression.expression);
      if (service?.source.endsWith("/model")) {
        const valueType = checker.getAwaitedType(checker.getTypeAtLocation(node));
        if (!valueType || valueType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) error(node, "model services require a resolved typed awaitable contract");
        const returned = mapper.map(valueType, loc(node), "ServiceResult");
        return { source: { kind: "service", module: service.source, call: node.expression.name.text, args: node.arguments.map(arg => isolated(arg)), result: returned }, type: returned };
      }
    }
    error(node, "awaitable is outside the closed model set");
  }
  function lowerBlock(node: ts.Block | ts.Statement): ModelBlock {
    const out: ModelStmt[] = []; const statements = ts.isBlock(node) ? node.statements : [node];
    for (const statement of statements) lowerStmt(statement, out);
    return { stmts: out };
  }
  function assignment(left: ts.Expression, right: ts.Expression | ((expected: AotType) => ModelExpr), operator: string, into: ModelStmt[], node: ts.Node): void {
    const direct = binding(left), vue = ts.isPropertyAccessExpression(left) && left.name.text === "value" ? binding(left.expression) : undefined;
    if (vue && isVueBinding(vue)) {
      if (vue.kind !== "signal") error(left, "computed values are read-only");
      if (typeof right === "function") error(left, "increment a Vue ref with += 1");
      if (operator === "=") return setter(vue, right, into, node);
      const lhs = temp(read(vue, left), into), rhs = expr(right, vue.type, into);
      const value = binaryAssignment(operator, lhs, rhs, node);
      into.push({ kind: "set", signal: vue.id, value, loc: loc(node) }); return;
    }
    const target = place(left, into), expected = target.type;
    if (!target.steps.length && target.root.kind === "local") {
      const declaration = direct!.node.parent;
      if (ts.isVariableDeclaration(declaration) && declaration.parent.flags & ts.NodeFlags.Const) error(left, "cannot assign to a const local");
    }
    const previous = operator === "=" ? undefined : temp(placeRead(target, left), into);
    let value = typeof right === "function" ? right(expected) : expr(right, operator === "/=" ? undefined : expected, into);
    if (previous) value = binaryAssignment(operator, previous, value, node);
    check(value, expected, node);
    if (!primitive(value.type)) value = make(node, { kind: "copy", value }, value.type);
    into.push({ kind: "assign", target: placeTarget(target), value, loc: loc(node) });
    if (!target.steps.length && direct?.binder) { delete direct.binder.viewOf; delete direct.arrayBound; }
  }
  function binaryAssignment(operator: string, left: ModelExpr, right: ModelExpr, node: ts.Node): ModelExpr {
    const op = operator.slice(0, -1); if (!["+", "-", "*", "/", "%", "&", "|", "^", "<<", ">>", ">>>"].includes(op)) error(node, `compound operator ${operator} is outside the subset`);
    if(color(left.type)||color(right.type))error(node,"Color arithmetic and ordered comparisons are outside the subset");
    return check(make(node, { kind: "binary", operator: op, left, right }, op === "/" ? left.type.kind==="named"&&numeric(left.type)?.name.startsWith("f")?left.type:F64 : left.type), left.type, node);
  }
  function lowerStmt(node: ts.Statement, into: ModelStmt[]): void {
    if (ts.isEmptyStatement(node)) return;
    if (ts.isBlock(node)) { into.push({ kind: "batch", body: lowerBlock(node), loc: loc(node) }); return; }
    if (ts.isVariableStatement(node)) { lowerDeclarations(node.declarationList, into); return; }
    if (ts.isWhileStatement(node) || ts.isDoStatement(node)) {
      const id = loopStart(node), condition = isolated(node.expression, BOOL);
      const body = loopBody(id, node.statement);
      into.push({ kind: "while", loop: id, condition, body, ...(ts.isDoStatement(node) ? { post: true } : {}), loc: loc(node) }); return;
    }
    if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
      if (node.label) error(node, "labeled break and continue are outside the model subset");
      if (currentFunction?.async) error(node, "break and continue are admitted in synchronous functions only");
      const breaking = ts.isBreakStatement(node), target = [...flow].reverse().find(entry => entry.kind === "loop" || breaking);
      if (!target) error(node, `${breaking ? "break" : "continue"} requires an enclosing loop`);
      if (target.kind === "switch") error(node, "break inside a switch case exits the switch; end the case with break or restructure it");
      targeted.add(target.id);
      into.push({ kind: breaking ? "break" : "continue", loop: target.id, loc: loc(node) }); return;
    }
    if (ts.isLabeledStatement(node)) error(node, "labeled statements are outside the model subset");
    lowerStatementTail(node, into);
  }
  function loopStart(node: ts.Node): number {
    if (currentFunction?.async) error(node, "while, do and general for loops are admitted in synchronous functions only; use a bounded for loop");
    return ++loopCounter;
  }
  function loopBody(id: number, statement: ts.Statement): ModelBlock {
    flow.push({ kind: "loop", id });
    try { return lowerBlock(statement); } finally { flow.pop(); }
  }
  function lowerDeclarations(list: ts.VariableDeclarationList, into: ModelStmt[]): void {
    {
      for (const d of list.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) error(d, "locals require a simple binder and initializer");
        if (ts.isAwaitExpression(d.initializer)) {
          const awaited = awaitable(d.initializer.expression, into), expected = type(d.type, d.name.text) ?? awaited.type;
          if (!sameType(expected, awaited.type)) error(d, "await result must match the local's contract type");
          const b = bindLocal(d.name, expected); into.push({ kind: "await", source: awaited.source, binder: b, loc: loc(d) }); continue;
        }
        let init = expr(d.initializer, type(d.type, d.name.text), into);
        const view = !primitive(init.type) ? viewOf(init) : undefined;
        const owned = primitive(init.type) || !immutableView(init);
        const b = bindLocal(d.name, init.type, owned); if (view !== undefined) b.viewOf = view;
        const bound = arrayBound(init); if (bound !== undefined) binding(d.name)!.arrayBound = bound;
        if (owned && !primitive(init.type) && init.kind === "local") init = make(d.initializer, { kind: "copy", value: init }, init.type);
        into.push({ kind: "let", binder: b, init, loc: loc(d) });
      } return;
    }
  }
  function lowerStatementTail(node: ts.Statement, into: ModelStmt[]): void {
    if (ts.isExpressionStatement(node)) {
      const e = node.expression;
      if (ts.isAwaitExpression(e)) { const a = awaitable(e.expression, into); into.push({ kind: "await", source: a.source, loc: loc(node) }); return; }
      if (ts.isBinaryExpression(e) && ["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>=", ">>>="].includes(e.operatorToken.getText())) { assignment(e.left, e.right, e.operatorToken.getText(), into, e); return; }
      if ((ts.isPostfixUnaryExpression(e) || ts.isPrefixUnaryExpression(e)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(e.operator) && !ts.isIdentifier(e.operand)) {
        assignment(e.operand, expected => make(e, { kind: "literal", value: 1 }, expected), e.operator === ts.SyntaxKind.PlusPlusToken ? "+=" : "-=", into, e); return;
      }
      if ((ts.isPostfixUnaryExpression(e) || ts.isPrefixUnaryExpression(e)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(e.operator)) {
        const value = expr(e.operand, undefined, into), b = binding(e.operand);
        if (!b || !["local", "field"].includes(b.kind) || !numeric(value.type)) error(e, "increment requires a numeric local or field");
        into.push({ kind: "assign", target: { kind: b.kind as "local" | "field", id: b.id }, value: make(e, { kind: "binary", operator: e.operator === ts.SyntaxKind.PlusPlusToken ? "+" : "-", left: value, right: make(e, { kind: "literal", value: 1 }, value.type) }, value.type), loc: loc(node) }); return;
      }
      if (ts.isCallExpression(e)) {
        const b = binding(e.expression), name = callName(e.expression);
        if (b?.kind === "setter") { if (e.arguments.length !== 1) error(e, "a setter requires one argument"); setter(b, e.arguments[0]!, into, e); return; }
        if (name === "untrack" || name === "batch") {
          if (name === "untrack" && !effectDepth) error(e, "untrack is admitted inside effects only");
          const callback = e.arguments[0]; if (!callback || !ts.isArrowFunction(callback) || callback.parameters.length) error(e, `${name} requires an inline callback`);
          const body = ts.isBlock(callback.body) ? lowerBlock(callback.body) : expressionStatementBody(callback.body);
          into.push({ kind: name, body, loc: loc(node) }); return;
        }
        if (b?.kind === "function") {
          ensureFunction(b.id);
          checkArity(e, b.fn!, b.name);
          into.push({ kind: b.fn!.async ? "start" : "call", ...(b.fn!.async ? { task: b.id } : { callee: b.id }), args: args(e.arguments, into, b.fn!.params), loc: loc(node) } as ModelStmt); return;
        }
        if (name === "cancel") {
          const task = e.arguments[0] && binding(e.arguments[0]); if (!task?.fn?.async) error(e, "cancel requires an async function name");
          into.push({ kind: "external", op: "cancel", args: [make(e.arguments[0]!, { kind: "literal", value: task.id }, I32)], loc: loc(node) }); return;
        }
        if (name === "animate" || name === "jump" || ts.isPropertyAccessExpression(e.expression) && e.expression.expression.getText() === "console" && e.expression.name.text === "log" && !binding(e.expression.expression)) {
          into.push({ kind: "external", op: name === "animate" || name === "jump" ? name : "log", args: args(e.arguments, into), loc: loc(node) }); return;
        }
      }
      into.push({ kind: "expr", value: expr(e, undefined, into), loc: loc(node) }); return;
    }
    if (ts.isReturnStatement(node)) {
      if (!currentFunction && !effectDepth && !callbackReturnType) error(node, "return occurs only inside a function body");
      const expected = callbackReturnType ?? currentFunction?.returns;
      into.push({ kind: "return", ...(node.expression ? { value: expr(node.expression, expected?.kind === "void" ? undefined : expected, into) } : {}), loc: loc(node) }); return;
    }
    if (ts.isIfStatement(node)) { into.push({ kind: "if", condition: expr(node.expression, BOOL, into), then: lowerBlock(node.thenStatement), ...(node.elseStatement ? { else: lowerBlock(node.elseStatement) } : {}), loc: loc(node) }); return; }
    if (ts.isForOfStatement(node)) {
      if (node.awaitModifier || !ts.isVariableDeclarationList(node.initializer) || node.initializer.declarations.length !== 1) error(node, "for-of requires one local binder");
      const declaration = node.initializer.declarations[0]!; if (!ts.isIdentifier(declaration.name)) error(declaration, "for-of requires a simple binder");
      const source = expr(node.expression, undefined, into); if (source.type.kind !== "array") error(node.expression, "for-of requires an array");
      const binder = bindLocal(declaration.name, source.type.element, primitive(source.type.element));
      const id = ++loopCounter, body = loopBody(id, node.statement);
      into.push({ kind: "forOf", binder, source, body, ...(targeted.has(id) ? { loop: id } : {}), loc: loc(node) }); return;
    }
    if (ts.isForStatement(node)) {
      // `for (let i = start; i < bound; i++)` whose body leaves i alone evaluates bound once;
      // other for loops re-evaluate their condition and run their update after continue.
      const declaration = node.initializer && ts.isVariableDeclarationList(node.initializer) && node.initializer.declarations.length === 1 ? node.initializer.declarations[0]! : undefined;
      const counter = declaration && ts.isIdentifier(declaration.name) && declaration.initializer ? declaration.name.text : undefined;
      const increment = node.incrementor && (ts.isPostfixUnaryExpression(node.incrementor) || ts.isPrefixUnaryExpression(node.incrementor)) && node.incrementor.operator === ts.SyntaxKind.PlusPlusToken ? node.incrementor.operand : undefined;
      const bounded = counter !== undefined && !!node.condition && ts.isBinaryExpression(node.condition) && ["<", "<="].includes(node.condition.operatorToken.getText()) && ts.isIdentifier(node.condition.left) && node.condition.left.text === counter && !!increment && ts.isIdentifier(increment) && increment.text === counter;
      const counterSymbol = bounded ? checker.getSymbolAtLocation(declaration!.name) : undefined;
      const writesCounter = (n: ts.Node): boolean => {
        const counterOf = (target: ts.Node) => ts.isIdentifier(target) && checker.getSymbolAtLocation(target) === counterSymbol;
        if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment && counterOf(n.left)) return true;
        if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) && counterOf(n.operand)) return true;
        return !!ts.forEachChild(n, child => writesCounter(child) || undefined);
      };
      if (!bounded || writesCounter(node.statement)) { generalFor(node, into); return; }
      const condition = node.condition as ts.BinaryExpression;
      const start = temp(expr(declaration!.initializer!, type(declaration!.type) ?? I32, into), into), binder = bindLocal(declaration!.name as ts.Identifier, start.type);
      const bound = expr(condition.right, binder.type, into);
      const id = ++loopCounter, body = loopBody(id, node.statement);
      into.push({ kind: "for", binder, start, bound, inclusive: condition.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken, body, ...(targeted.has(id) ? { loop: id } : {}), loc: loc(node) }); return;
    }
    if (ts.isSwitchStatement(node)) {
      const value = expr(node.expression, undefined, into);
      if (!["number", "string", "named"].includes(value.type.kind)) error(node, "switch requires an enum or literal cases");
      const cases = node.caseBlock.clauses.map(c => {
        const tail = c.statements.at(-1); if (!tail || !ts.isBreakStatement(tail) && !ts.isReturnStatement(tail)) error(c, "every switch case must end in break or return");
        const statements: ModelStmt[] = [];
        flow.push({ kind: "switch", id: 0 });
        try { for (const s of c.statements) if (!ts.isBreakStatement(s) || s.label) lowerStmt(s, statements); } finally { flow.pop(); }
        return { ...(ts.isCaseClause(c) ? { value: isolated(c.expression, value.type) } : {}), body: { stmts: statements } };
      });
      into.push({ kind: "switch", value, cases, loc: loc(node) }); return;
    }
    if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) return;
    error(node, `${ts.SyntaxKind[node.kind]} is outside the model statement subset`);
  }
  function generalFor(node: ts.ForStatement, into: ModelStmt[]): void {
    const id = loopStart(node), init: ModelStmt[] = [];
    if (node.initializer) {
      if (ts.isVariableDeclarationList(node.initializer)) lowerDeclarations(node.initializer, init);
      else for (const part of commaParts(node.initializer)) init.push(...expressionStatementBody(part).stmts);
    }
    const condition = node.condition ? isolated(node.condition, BOOL) : make(node, { kind: "literal", value: true }, BOOL);
    const body = loopBody(id, node.statement);
    const update = node.incrementor ? { stmts: commaParts(node.incrementor).flatMap(part => expressionStatementBody(part).stmts) } : undefined;
    into.push({ kind: "batch", body: { stmts: [...init, { kind: "while", loop: id, condition, body, ...(update ? { update } : {}), loc: loc(node) }] }, loc: loc(node) });
  }
  function commaParts(expression: ts.Expression): ts.Expression[] {
    return ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.CommaToken ? [...commaParts(expression.left), ...commaParts(expression.right)] : [expression];
  }
  function expressionStatementBody(expression: ts.Expression): ModelBlock {
    const into: ModelStmt[] = [], statement = ts.factory.createExpressionStatement(expression);
    ts.setTextRange(statement, expression);
    (statement as { parent: ts.Node }).parent = expression.parent;
    lowerStmt(statement, into); return { stmts: into };
  }
  // Register import provenance before interpreting any declaration.
  for (const file of reachable) {
    const ast = env.program.getSourceFile(file)!;
    for (const node of ast.statements) {
      if (modifiers(node).some(m => m.kind === ts.SyntaxKind.DefaultKeyword)) error(node, "export default is outside the model subset");
      if (ts.isImportDeclaration(node)) {
        if (!ts.isStringLiteral(node.moduleSpecifier)) error(node, "module specifier must be a string literal");
        const source = node.moduleSpecifier.text, clause = node.importClause;
        if (!clause) error(node, "side-effect imports are outside the model subset");
        if (clause.isTypeOnly) continue;
        if (clause.name) error(node, "model imports require named bindings");
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          if (!localImport(source, file)) error(node, "namespace imports require a local module");
          continue;
        }
        for (const specifier of (clause.namedBindings as ts.NamedImports | undefined)?.elements ?? []) {
          if (specifier.isTypeOnly) continue;
          const name = specifier.propertyName?.text ?? specifier.name.text, s = symbol(specifier.name)!;
          if (!localImport(source, file)) {
            const allowed = source === "solid-js" ? ["createSignal", "createContext", "untrack", "batch"] : source === "vue" ? ["ref", "computed"] : source === "@pocketjs/framework/solid/reactive" ? ["createEffect", "createMemo", "on"] : source === "@pocketjs/framework/vue-vapor/reactive" ? ["watch", "watchEffect"] : /^@pocketjs\/framework\/(?:solid|vue-vapor)\/std$/.test(source) ? [...stdNames] : source === "@pocketjs/framework/input" ? ["BTN"] : /^@pocketjs\/framework\/(?:solid\/|vue-vapor\/)?animation$/.test(source) ? ["animate", "jump", "createNodeRef"] : source.endsWith("/model") && source.startsWith("@pocketjs/framework/") ? ["net", "storage", "device"] : [];
            if (!allowed.includes(name)) error(specifier, `${name} from ${source} is outside the compiled model subset${["createMemo", "createEffect", "watch", "watchEffect"].includes(name) ? "; use the framework reactive module" : ""}`);
          }
          imports.set(s, { name, source });
        }
      }
    }
  }
  const factoryDeclarations = new Map<ModelModule, ts.FunctionDeclaration>();
  for (const file of reachable) {
    const ast = env.program.getSourceFile(file)!;
    const explicitFactory = options.factories?.some(factory => resolve(factory) === file);
    const factory = ast.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && !!node.body && exported(node) && (explicitFactory && node.body.statements.some(s => ts.isReturnStatement(s) && s.expression && ts.isObjectLiteralExpression(s.expression)) || node.body.statements.some(s => ts.isVariableStatement(s) && s.declarationList.declarations.some(d => d.initializer && ts.isCallExpression(d.initializer) && ["createSignal", "ref"].includes(callName(d.initializer.expression) ?? "")))));
    const isRoot = file === entry;
    const model: ModelModule = { name: isRoot ? options.name ?? "App" : typeName(basename(file, ".ts")), file, kind: isRoot ? "root" : factory ? "factory" : "pure", params: [], signals: [], fields: [], memos: [], effects: [], functions: [], schedule: [], refs: [], tasks: [], constants: [] };
    if (factory && !isRoot) { model.factory = factory.name?.text; factoryDeclarations.set(model, factory); declarations.set(model, factory.body!.statements); }
    else declarations.set(model, ast.statements);
    moduleByFile.set(file, model); result.modules.push(model);
  }
  // A module with private `let` fields, or one importing such a module, is a state module:
  // its fields and functions belong to the root region.
  const stateCall = (node: ts.Expression) => ts.isCallExpression(node) && ["createSignal", "ref", "createMemo", "computed", "createNodeRef", "createContext"].includes(callName(node.expression) ?? "");
  const moduleImports = (model: ModelModule) => env.program.getSourceFile(model.file)!.statements.flatMap(node => valueImport(node, model.file) ? [moduleByFile.get(resolveImport(node.moduleSpecifier.text, model.file, node))] : []);
  for (const model of result.modules) if (model.kind === "pure" && env.program.getSourceFile(model.file)!.statements.some(node => ts.isVariableStatement(node) && !(node.declarationList.flags & ts.NodeFlags.Const) && node.declarationList.declarations.some(d => !d.initializer || !stateCall(d.initializer)))) model.kind = "state";
  for (let changed = true; changed;) {
    changed = false;
    for (const model of result.modules) if (model.kind === "pure" && moduleImports(model).some(other => other?.kind === "state")) { model.kind = "state"; changed = true; }
  }
  for (const model of result.modules) if (model.kind === "factory" && moduleImports(model).some(other => other?.kind === "state")) error(env.program.getSourceFile(model.file)!.statements[0]!, "a factory module cannot import a state module; state modules belong to the root region");
  result.modules.sort((a, b) => ["root", "state", "factory", "pure"].indexOf(a.kind) - ["root", "state", "factory", "pure"].indexOf(b.kind));
  const memoDone = new Set<number>(), memoActive = new Set<number>();
  const pendingSignals: { b: Binding; init: ts.CallExpression; exported: boolean }[] = [], pendingMemos: { b: Binding; init: ts.CallExpression; exported: boolean }[] = [], pendingEffects: { module: ModelModule; node: ts.CallExpression; id: number }[] = [];
  const functionsByBinding = new Map<number, { b: Binding; node: ts.FunctionDeclaration; state: "new" | "active" | "done" }>();
  function registerStatements(statements: readonly ts.Statement[], model: ModelModule, outer = false) {
    current = model;
    for (const node of statements) {
      if (ts.isImportDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node) || ts.isEmptyStatement(node)) continue;
      if (namespaceExport(node) || ts.isExportDeclaration(node) && (node.isTypeOnly || !!node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.every(item => item.isTypeOnly))) continue;
      if (ts.isExportDeclaration(node)) error(node, "re-exports other than export * as name are outside the model subset");
      if (ts.isReturnStatement(node) && model.kind === "factory" && !outer) continue;
      if (ts.isFunctionDeclaration(node)) {
        if (factoryDeclarations.get(model) === node) continue;
        if (!node.name || !node.body || node.asteriskToken || node.typeParameters?.length) error(node, "model functions require a named nongenerator body without type parameters");
        if (model.kind === "state" && asyncFn(node)) error(node, "state module functions are synchronous; declare tasks in the root model");
        const fn: ModelFunction = { id: nextId++, name: node.name.text, exported: exported(node), async: asyncFn(node), params: [], returns: type(node.type, `${typeName(node.name.text)}Result`) ?? VOID, body: { stmts: [] }, ledger: emptyLedger(), loc: loc(node) };
        const b = register(node.name, { id: fn.id, name: fn.name, kind: "function", type: fn.returns, node, module: model, fn });
        fn.params = node.parameters.map(p => {
          if (!ts.isIdentifier(p.name) || p.dotDotDotToken || p.questionToken) error(p, "function parameters require simple names; optional parameters need a constant default");
          const t = type(p.type, p.name.text); if (!t) error(p, "function parameters require a contract type annotation");
          const binder = bindLocal(p.name, t);
          if (p.initializer) parameterDefaults.set(binder.id, p.initializer);
          return binder;
        });
        const firstDefault = fn.params.findIndex(parameter => parameterDefaults.has(parameter.id));
        if (firstDefault >= 0 && fn.params.slice(firstDefault).some(parameter => !parameterDefaults.has(parameter.id))) error(node, "parameters after a defaulted parameter need defaults");
        model.functions.push(fn); functionsByBinding.set(fn.id, { b, node, state: "new" }); continue;
      }
      if (ts.isVariableStatement(node)) {
        for (const d of node.declarationList.declarations) {
          if (!d.initializer) error(d, "model declarations require an initializer");
          const init = d.initializer as ts.CallExpression, name = ts.isCallExpression(d.initializer) ? callName(d.initializer.expression) : undefined;
          if (name === "createSignal" || name === "ref") {
            if (model.kind === "pure") error(d, "pure module cannot declare state; importing another model's signal, memo or function is outside the subset");
            if (model.kind === "state") error(d, "state modules hold private let fields; declare signals in the root model");
            if (init.arguments.length !== 1) error(init, "model signals require one seed and no equality options");
            let getter: ts.Identifier, setterName: ts.Identifier | undefined;
            if (name === "createSignal") {
              if (!ts.isArrayBindingPattern(d.name) || d.name.elements.length !== 2 || !ts.isBindingElement(d.name.elements[0]!) || !ts.isBindingElement(d.name.elements[1]!)) error(d.name, "createSignal requires [getter, setter] binding");
              const [first, second] = d.name.elements as ts.NodeArray<ts.BindingElement>;
              if (!ts.isIdentifier(first!.name) || !ts.isIdentifier(second!.name)) error(d.name, "signal tuple requires simple getter and setter names"); getter = first!.name; setterName = second!.name;
            } else { if (!ts.isIdentifier(d.name)) error(d.name, "ref requires a simple binder"); getter = d.name; }
            const t = type(init.typeArguments?.[0], getter.text) ?? VOID;
            const b = register(getter, { id: nextId++, name: getter.text, kind: "signal", type: t, node: d, module: model, capacity: capacity(init.typeArguments?.[0]) });
            if (setterName) register(setterName, { ...b, kind: "setter", name: setterName.text });
            pendingSignals.push({ b, init, exported: exported(node) }); continue;
          }
          if (!ts.isIdentifier(d.name)) error(d.name, "model declarations require a simple name");
          if (name === "createMemo" || name === "computed") {
            if (model.kind === "pure" || model.kind === "state") error(d, `${model.kind} module cannot declare a memo`);
            const b = register(d.name, { id: nextId++, name: d.name.text, kind: "memo", type: type(init.typeArguments?.[0], d.name.text) ?? VOID, node: d, module: model });
            pendingMemos.push({ b, init: init as ts.CallExpression, exported: exported(node) }); continue;
          }
          if (name === "createNodeRef") { if (model.kind === "pure" || model.kind === "state") error(d, `${model.kind} module cannot declare a node reference`); const id = nextId++; model.refs.push({ id, name: d.name.text }); register(d.name, { id, name: d.name.text, kind: "ref", type: STRING, node: d, module: model }); continue; }
          if (name === "createContext") continue;
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) error(init, "closures as stored values are outside the model subset");
          const mutable = !(node.declarationList.flags & ts.NodeFlags.Const);
          if (mutable && model.kind === "pure") error(d, "pure module cannot declare private state");
          if (mutable && exported(node) && model.kind !== "state") error(d, "private mutable fields cannot be exported");
          const b = register(d.name, { id: nextId++, name: d.name.text, kind: mutable ? "field" : "constant", type: type(d.type, d.name.text) ?? VOID, node: d, declaration: d, module: model, capacity: capacity(d.type) });
          const hostName = mutable && model.kind === "state" && exported(node) ? `${basename(model.file, ".ts").replace(/[^A-Za-z0-9]+/g, "_").toLowerCase()}_${b.name}` : undefined;
          // Each field takes a getter and a _mut accessor; fields x and x_mut would both take x_mut.
          if (hostName !== undefined) for (const accessor of [hostName, `${hostName}_mut`]) {
            const other = hostNames.get(accessor);
            if (other !== undefined) error(d.name, `state fields of ${other} and ${model.file} share the host accessor ${accessor}; rename a field or a file`);
            hostNames.set(accessor, model.file);
          }
          if (mutable) model.fields.push({ id: b.id, name: b.name, type: b.type, capacity: b.capacity, seed: make(init, { kind: "undefined" }, VOID), loc: loc(d), ...(hostName !== undefined ? { hostName } : {}) });
        } continue;
      }
      if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && ["createEffect", "watch", "watchEffect"].includes(callName(node.expression.expression) ?? "")) {
        if (model.kind === "pure" || model.kind === "state") error(node, `${model.kind} module cannot declare an effect`);
        pendingEffects.push({ module: model, node: node.expression, id: nextId++ }); continue;
      }
      error(node, "top-level statements are outside the model subset; only declarations and framework effects are admitted");
    }
  }
  for (const model of result.modules) {
    current = model;
    const factory = factoryDeclarations.get(model);
    if (factory) {
      model.params = factory.parameters.map(p => { if (!ts.isIdentifier(p.name) || !p.type || p.initializer || p.dotDotDotToken) error(p, "factory parameters require fixed typed values"); return bindLocal(p.name, type(p.type, p.name.text)!); });
      registerStatements(env.program.getSourceFile(model.file)!.statements, model, true);
    }
    registerStatements(declarations.get(model)!, model);
  }
  for (const model of result.modules) {
    current = model;
    for (const node of env.program.getSourceFile(model.file)!.statements) if (valueImport(node, model.file)) {
      const other = moduleByFile.get(resolveImport(node.moduleSpecifier.text, model.file, node));
      if (other && other.kind !== "pure" && !(other.kind === "state" && (model.kind === "root" || model.kind === "state"))) error(node, "cross-model imports of signals, memos and functions are outside the subset; use props, events or context");
    }
  }
  for (const pending of pendingSignals) {
    const { b, init } = pending; current = b.module;
    const seed = isolated(init.arguments[0]!, b.type.kind === "void" ? undefined : b.type);
    if (!constantExpression(seed)) error(init.arguments[0]!, "signal seeds require literals, constants, or literal objects and arrays");
    b.type = seed.type;
    b.capacity ??= storageCapacity(seed.type);
    const setterBinding = [...bindings.values()].find(s => s.kind === "setter" && s.id === b.id); if (setterBinding) setterBinding.type = seed.type;
    b.module.signals.push({ id: b.id, name: b.name, ...(setterBinding ? { setter: setterBinding.name } : {}), exported: pending.exported, type: b.type, ...(b.capacity ? { capacity: b.capacity } : {}), seed, loc: loc(b.node) });
  }
  for (const model of result.modules) {
    current = model;
    for (const b of bindings.values()) if (b.module === model && b.kind === "constant") model.constants!.push({ id: b.id, name: b.name, value: loadConstant(b), exported: exported(b.declaration!.parent.parent) });
    for (const field of model.fields) {
      const b = [...bindings.values()].find(b => b.id === field.id)!;
      field.seed = isolated(b.declaration!.initializer!, b.type.kind === "void" ? undefined : b.type);
      if (!constantExpression(field.seed)) error(b.node, "private field seeds require constants or literal values");
      field.type = b.type = field.seed.type;
      field.capacity ??= storageCapacity(field.type);
    }
  }
  function ensureFunction(id: number) {
    const item = functionsByBinding.get(id); if (!item || item.state === "done" || item.state === "active") return;
    item.state = "active"; const beforeModule = current, beforeFunction = currentFunction, beforeReturnType = callbackReturnType;
    current = item.b.module; currentFunction = item.b.fn!; callbackReturnType = undefined;
    currentFunction.body = lowerBlock(item.node.body!);
    if (!item.node.type) {
      const returns: AotType[] = [];
      const collect = (block: ModelBlock): void => { for (const s of block.stmts) { if (s.kind === "return") returns.push(s.value?.type ?? VOID); else if (s.kind === "if") { collect(s.then); if (s.else) collect(s.else); } else if (s.kind === "switch") { for (const c of s.cases) collect(c.body); } else if (["for", "forOf", "while", "batch", "untrack"].includes(s.kind)) collect((s as { body: ModelBlock }).body); } };
      collect(currentFunction.body); currentFunction.returns = returns[0] ?? VOID;
      if (!returns.every(t => sameType(t, currentFunction!.returns))) error(item.node, "function returns require one consistent contract type");
      // TypeScript adds undefined to the inferred type when the end of the body is reachable.
      const signature = checker.getSignatureFromDeclaration(item.node), inferred = signature && checker.getReturnTypeOfSignature(signature);
      const undefinedIn = (t: ts.Type): boolean => !!(t.flags & ts.TypeFlags.Undefined) || t.isUnion() && t.types.some(undefinedIn);
      if (!["void", "undefined", "option"].includes(currentFunction.returns.kind) && inferred && undefinedIn(inferred)) error(item.node, "a function that returns a value must return one on every path; add a final return or annotate the return type");
      item.b.type = currentFunction.returns;
    }
    current = beforeModule; currentFunction = beforeFunction; callbackReturnType = beforeReturnType; item.state = "done";
  }
  for (const item of functionsByBinding.values()) ensureFunction(item.b.id);
  function ensureMemo(id: number) {
    if (memoDone.has(id)) return;
    const item = pendingMemos.find(m => m.b.id === id); if (!item) return;
    if (memoActive.has(id)) error(item.b.node, `reactive cycle: memo ${item.b.name}`);
    memoActive.add(id); const before = current, beforeReturnType = callbackReturnType; current = item.b.module; callbackReturnType = item.b.type;
    const callback = item.init.arguments[0]; if (!callback || !ts.isArrowFunction(callback) || callback.parameters.length || item.init.arguments.length !== 1) error(item.init, "memo requires one pure inline callback");
    let value: ModelExpr;
    if (ts.isBlock(callback.body)) {
      const body: ModelStmt[] = []; const statements = callback.body.statements;
      const last = statements.at(-1); if (!last || !ts.isReturnStatement(last) || !last.expression) error(callback.body, "memo block must return a value");
      for (const s of statements.slice(0, -1)) lowerStmt(s, body);
      const result = expr(last.expression, item.b.type.kind === "void" ? undefined : item.b.type, body);
      value = body.length ? make(callback, { kind: "sequence", body: { stmts: body }, value: result }, result.type) : result;
    } else value = isolated(callback.body, item.b.type.kind === "void" ? undefined : item.b.type);
    item.b.type = value.type;
    item.b.module.memos.push({ id, name: item.b.name, exported: item.exported, type: value.type, body: value, inputs: [], loc: loc(item.b.node) });
    memoActive.delete(id); memoDone.add(id); current = before; callbackReturnType = beforeReturnType;
  }
  for (const m of pendingMemos) ensureMemo(m.b.id);
  function sourcesOf(node: ts.Expression): number[] {
    const list = ts.isArrayLiteralExpression(node) ? node.elements : [node];
    return list.map(n => {
      if (ts.isArrowFunction(n)) {
        if (ts.isBlock(n.body)) error(n, "watch source getter requires one signal or memo read");
        const value = isolated(n.body); if (value.kind !== "signal" && value.kind !== "memo") error(n, "watch source getter requires one signal or memo and cannot read a private field"); return value.id;
      }
      const b = binding(n); if (!b || !["signal", "memo"].includes(b.kind)) error(n, "declared subscriptions require signal or memo accessors"); return b.id;
    });
  }
  for (const pending of pendingEffects) {
    current = pending.module; currentFunction = undefined; effectDepth++;
    const name = callName(pending.node.expression), call = pending.node;
    let callback: ts.Expression | undefined = call.arguments[0], declared = name === "watch", defer = name === "watch", subscriptions: number[] = [], watch: ModelModule["effects"][number]["watch"];
    if (name === "watch") { if (!call.arguments[0]) error(call, "watch requires a source"); subscriptions = sourcesOf(call.arguments[0]); callback = call.arguments[1]; if (call.arguments[2]) defer = !effectOptions(call.arguments[2], "immediate"); }
    if (callback && ts.isCallExpression(callback) && callName(callback.expression) === "on") {
      declared = true; if (!callback.arguments[0]) error(callback, "on requires subscriptions"); subscriptions = sourcesOf(callback.arguments[0]);
      if (callback.arguments[2]) defer = effectOptions(callback.arguments[2], "defer"); callback = callback.arguments[1];
    }
    if (!callback || !ts.isArrowFunction(callback) || asyncFn(callback)) error(call, "effects require a synchronous inline callback");
    if (name === "watch" && callback.parameters.length) {
      if (subscriptions.length !== 1 || callback.parameters.length > 2) error(callback, "watch values and previous values require one source");
      const signal = [...current.signals, ...current.memos].find(s => s.id === subscriptions[0])!;
      const params = callback.parameters.map((p,index) => { if (!ts.isIdentifier(p.name)) error(p, "watch parameter requires a simple binder"); return bindLocal(p.name, index===1&&!defer&&signal.type.kind!=="option"?{kind:"option",value:signal.type}:signal.type, false); });
      watch = { sources: subscriptions, value: params[0], previous: params[1] };
    } else if (callback.parameters.length) error(callback, "effect callbacks take no parameters");
    const body = ts.isBlock(callback.body) ? lowerBlock(callback.body) : expressionStatementBody(callback.body);
    current.effects.push({ id: pending.id, subscriptions, declared, defer, body, ledger: emptyLedger(), loc: loc(call), ...(watch ? { watch } : {}) }); effectDepth--;
  }
  function effectOptions(node: ts.Expression, name: string): boolean {
    if (!ts.isObjectLiteralExpression(node) || node.properties.length !== 1) error(node, `only the ${name} effect option is admitted`);
    const p = node.properties[0]!; if (!ts.isPropertyAssignment(p) || p.name.getText() !== name || ![ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(p.initializer.kind)) error(p, `only the boolean ${name} effect option is admitted`);
    return p.initializer.kind === ts.SyntaxKind.TrueKeyword;
  }
  for (const [model, factory] of factoryDeclarations) {
    const returned = factory.body!.statements.at(-1);
    if (!returned || !ts.isReturnStatement(returned) || !returned.expression || !ts.isObjectLiteralExpression(returned.expression)) error(factory, "factory must end with a returned object literal naming its contract");
    for (const p of returned.expression.properties) {
      if (!ts.isShorthandPropertyAssignment(p)) error(p, "factory return entries must name declared region bindings");
      const b = binding(p.name); if (!b || b.module !== model || !["signal", "memo", "function", "ref"].includes(b.kind)) error(p, "factory contract must expose its own signals, memos, node references and functions");
      const exposed = [...model.signals, ...model.memos, ...model.functions].find(v => v.id === b.id); if (exposed) exposed.exported = true;
    }
  }
  for (const file of reachable) {
    const ast = env.program.getSourceFile(file)!;
    const diagnostic = [...env.program.getSyntacticDiagnostics(ast), ...env.program.getSemanticDiagnostics(ast)].find(d => d.category === ts.DiagnosticCategory.Error);
    if (diagnostic) fail(location(file, files.get(file)!, diagnostic.start ?? 0), ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
  }
  const rootModule = result.modules.find(model => model.kind === "root");
  for (const model of result.modules.filter(model => model.kind === "state")) {
    if (!rootModule) fail(location(model.file, source(model.file)), "state modules require a root model");
    for (const f of model.functions) f.exported = false;
    rootModule.fields.push(...model.fields);
    rootModule.functions.push(...model.functions);
    rootModule.constants!.push(...(model.constants ?? []).map(constant => ({ ...constant, exported: false })));
  }
  // State accessors are inherent methods of the native model, which Rust resolves before
  // the model's handlers and getters; a public name cannot be one of them.
  if (rootModule) {
    const publics = new Set([...rootModule.signals.flatMap(s => [s.name, ...(s.setter ? [s.setter] : [])]), ...rootModule.memos.map(m => m.name), ...rootModule.functions.filter(f => f.exported).map(f => f.name), ...rootModule.refs.map(r => r.name), ...(rootModule.constants ?? []).filter(c => c.exported).map(c => c.name)]);
    for (const f of rootModule.fields) for (const name of f.hostName ? [f.hostName, `${f.hostName}_mut`] : []) {
      if (publics.has(name)) fail(f.loc!, `the state accessor ${name} of field ${f.name} has the name of an export of the root model; rename one of them`);
    }
  }
  result.modules = result.modules.filter(model => model.kind !== "state");
  lowerModelTasks(result);
  analyzeModelLedgers(result);
  assertModelProgram(result);
  return result;
}
