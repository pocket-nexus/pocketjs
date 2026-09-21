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
import { parseMicroTsColor } from "../../contracts/spec/microts.ts";

export interface AnalyzeModelOptions { sources?: ReadonlyMap<string, string>; source?: string; strict?: boolean; recursionLimit?: number; name?: string; factories?: readonly string[]; framework?: "solid" | "vue"; componentNames?: string[]; environment?: TypeEnvironment; mapper?: TypeMapper }
type Binding = { id: number; name: string; kind: "signal" | "setter" | "memo" | "field" | "local" | "constant" | "function" | "ref"; type: AotType; node: ts.Node; module: ModelModule; binder?: ModelBinder; value?: ModelExpr; fn?: ModelFunction; declaration?: ts.VariableDeclaration; capacity?: number; arrayBound?: number };
type Imported = { name: string; source: string };
const VOID: AotType = { kind: "void" };
const numericNames = new Set(["i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "usize", "f32", "f64"]);
const stdNames = new Set(["len", "trunc", "floor", "ceil", "round", "idiv", "imod", "min", "max", "abs", "clamp", "fixed", "copy", "equals", "map", "filter", "find", "some", "frames", "after", "until", "join", "all", "any", "cancel"]);
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
  function resolveImport(name: string, file: string, node: ts.Node): string {
    const path = resolve(dirname(file), name), result = [path, `${path}.ts`, `${path}/index.ts`, `${path}.d.ts`].find(x => files.has(x) || existsSync(x));
    if (!result) fail(location(file, source(file), node.getStart()), `cannot resolve model import ${name}`);
    return result;
  }
  function collect(file: string) {
    if (visiting.has(file)) return; visiting.add(file); reachable.push(file);
    const ast = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true);
    if (file.endsWith(".d.ts")) fail(location(file, source(file)), "compiled models require a .ts module with bodies, not .d.ts");
    for (const node of ast.statements) if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith(".") && !node.importClause?.isTypeOnly && !(node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) && node.importClause.namedBindings.elements.every(item => item.isTypeOnly))) collect(resolveImport(node.moduleSpecifier.text, file, node));
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
  let nextId = 1, current!: ModelModule, currentFunction: ModelFunction | undefined, callbackReturnType: AotType | undefined, effectDepth = 0, generated = 0;
  const loc = (node: ts.Node) => env.locationOf(node);
  function error(node: ts.Node, message: string): never { return fail(loc(node), message); }
  function symbol(node: ts.Node, follow = false): ts.Symbol | undefined { let s = checker.getSymbolAtLocation(node); if (follow && s && s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s); return s; }
  function binding(node: ts.Node): Binding | undefined { const s = ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent) ? checker.getShorthandAssignmentValueSymbol(node.parent) : symbol(node); return s && (bindings.get(s) ?? bindings.get(s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s)); }
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
  function args(nodes: readonly ts.Expression[], into: ModelStmt[], parameters?: ModelBinder[]): ModelExpr[] {
    return nodes.map((n, i) => temp(expr(n, parameters?.[i]?.type, into), into));
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
  function constantExpression(e: ModelExpr): boolean { return e.kind === "literal" || e.kind === "undefined" || e.kind === "cast" && constantExpression(e.value) || e.kind === "struct" && e.fields.every(x => constantExpression(x.value)) || e.kind === "array" && e.items.every(constantExpression) || e.kind === "local" && current.params.some(p => p.id === e.id); }
  function read(b: Binding, node: ts.Node): ModelExpr {
    if (b.kind === "constant") return { ...loadConstant(b), loc: loc(node) };
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
      const operator = ts.tokenToString(node.operator); if (!["!", "-", "+"].includes(operator ?? "")) error(node, "unsupported unary operator");
      const operand = expr(node.operand, operator === "!" ? BOOL : expected, into);
      if (operator !== "!" && !numeric(operand.type)) error(node, "numeric unary operator requires a number");
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
      if (operator === "%") error(node.operatorToken, "use imod() for integer remainder");
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
        if (node.arguments.length !== b.fn!.params.length) error(node, `function ${b.name} expects ${b.fn!.params.length} arguments`);
        return check(make(node, { kind: "invoke", callee: b.id, args: args(node.arguments, into, b.fn!.params) }, b.fn!.returns), expected, node);
      }
      if (name === "copy") { if (node.arguments.length !== 1) error(node, "copy requires one argument"); const value = expr(node.arguments[0]!, expected, into); return make(node, { kind: "copy", value }, value.type); }
      if (name && stdNames.has(name) && !["frames", "after", "until", "join", "all", "any", "cancel"].includes(name)) {
        const values: ModelExpr[] = [];
        for (let i = 0; i < node.arguments.length; i++) {
          const argument = node.arguments[i]!;
          if (ts.isArrowFunction(argument)) {
            if (!["map", "filter", "find", "some"].includes(name) || i !== 1 || ts.isBlock(argument.body)) error(argument, "collection callbacks require one inline expression");
            const array = values[0]; if (array?.type.kind !== "array") error(argument, "collection built-ins require an array");
            const elementType = array.type.element;
            const params = argument.parameters.map((p, index) => { if (!ts.isIdentifier(p.name) || index > 1) error(p, "collection callback accepts element and index only"); return bindLocal(p.name, index === 0 ? elementType : I32, false); });
            const value = isolated(argument.body, name === "map" ? expected?.kind === "array" ? expected.element : undefined : BOOL);
            values.push(make(argument, { kind: "lambda", params, body: { stmts: [{ kind: "return", value }] } }, value.type));
          } else values.push(expr(argument, i > 0 && ["idiv", "imod", "min", "max", "clamp", "equals"].includes(name) ? values[0]?.type : undefined, into));
        }
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
  function assignment(left: ts.Expression, right: ts.Expression, operator: string, into: ModelStmt[], node: ts.Node): void {
    const direct = binding(left), vue = ts.isPropertyAccessExpression(left) && left.name.text === "value" ? binding(left.expression) : undefined;
    if (vue && isVueBinding(vue)) {
      if (vue.kind !== "signal") error(left, "computed values are read-only");
      if (operator === "=") return setter(vue, right, into, node);
      const lhs = temp(read(vue, left), into), rhs = expr(right, vue.type, into);
      const value = binaryAssignment(operator, lhs, rhs, node);
      into.push({ kind: "set", signal: vue.id, value, loc: loc(node) }); return;
    }
    let target: ModelTarget, expected: AotType | undefined;
    if (direct && (direct.kind === "local" || direct.kind === "field")) {
      const declaration = direct.node.parent;
      if (direct.kind === "local" && ts.isVariableDeclaration(declaration) && declaration.parent.flags & ts.NodeFlags.Const) error(left, "cannot assign to a const local");
      target = { kind: direct.kind, id: direct.id }; expected = direct.type;
    } else if (ts.isElementAccessExpression(left) || ts.isPropertyAccessExpression(left)) {
      const owner = binding(left.expression);
      if (!owner?.binder?.owned) error(left, "write through a view is outside the model subset; use copy()");
      if (ts.isElementAccessExpression(left)) {
        if (owner.type.kind !== "array") error(left, "element assignment requires an owned array");
        const object = read(owner, left.expression), index = expr(left.argumentExpression, I32, into);
        checkArrayIndex(object, index, left.argumentExpression);
        target = { kind: "element", owner: owner.id, index: temp(index, into) }; expected = owner.type.element;
      } else { target = { kind: "member", owner: owner.id, name: left.name.text }; expected = memberType(read(owner, left), left.name.text, left); }
    } else error(left, "assignment target must be a local, a private field, or an owned value");
    const previous = operator === "=" ? undefined : temp(target.kind === "element"
      ? make(left, { kind: "index", object: read(binding((left as ts.ElementAccessExpression).expression)!, (left as ts.ElementAccessExpression).expression), index: target.index }, expected!)
      : expr(left, undefined, into), into);
    let value = expr(right, operator === "/=" ? undefined : expected, into);
    if (previous) value = binaryAssignment(operator, previous, value, node);
    check(value, expected, node);
    if (!primitive(value.type)) value = make(right, { kind: "copy", value }, value.type);
    into.push({ kind: "assign", target, value, loc: loc(node) });
    if (direct?.binder) { delete direct.binder.viewOf; delete direct.arrayBound; }
  }
  function binaryAssignment(operator: string, left: ModelExpr, right: ModelExpr, node: ts.Node): ModelExpr {
    const op = operator.slice(0, -1); if (!["+", "-", "*", "/", "&", "|", "^", "<<", ">>", ">>>"].includes(op)) error(node, `compound operator ${operator} is outside the subset`);
    if(color(left.type)||color(right.type))error(node,"Color arithmetic and ordered comparisons are outside the subset");
    return check(make(node, { kind: "binary", operator: op, left, right }, op === "/" ? left.type.kind==="named"&&numeric(left.type)?.name.startsWith("f")?left.type:F64 : left.type), left.type, node);
  }
  function lowerStmt(node: ts.Statement, into: ModelStmt[]): void {
    if (ts.isEmptyStatement(node)) return;
    if (ts.isBlock(node)) { into.push({ kind: "batch", body: lowerBlock(node), loc: loc(node) }); return; }
    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
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
    if (ts.isExpressionStatement(node)) {
      const e = node.expression;
      if (ts.isAwaitExpression(e)) { const a = awaitable(e.expression, into); into.push({ kind: "await", source: a.source, loc: loc(node) }); return; }
      if (ts.isBinaryExpression(e) && ["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>=", ">>>="].includes(e.operatorToken.getText())) { assignment(e.left, e.right, e.operatorToken.getText(), into, e); return; }
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
      into.push({ kind: "forOf", binder, source, body: lowerBlock(node.statement), loc: loc(node) }); return;
    }
    if (ts.isForStatement(node)) {
      if (!node.initializer || !ts.isVariableDeclarationList(node.initializer) || node.initializer.declarations.length !== 1 || !node.condition || !ts.isBinaryExpression(node.condition) || !["<", "<="].includes(node.condition.operatorToken.getText()) || !node.incrementor) error(node, "bounded for requires let i = start; i < bound; i++");
      const declaration = node.initializer.declarations[0]!; if (!ts.isIdentifier(declaration.name) || !declaration.initializer) error(declaration, "bounded for requires an initialized local counter");
      const start = temp(expr(declaration.initializer, type(declaration.type) ?? I32, into), into), binder = bindLocal(declaration.name, start.type);
      if (binding(node.condition.left)?.id !== binder.id || !(ts.isPostfixUnaryExpression(node.incrementor) || ts.isPrefixUnaryExpression(node.incrementor)) || node.incrementor.operator !== ts.SyntaxKind.PlusPlusToken || binding(node.incrementor.operand)?.id !== binder.id) error(node, "bounded for increments its own counter by one");
      const bound = expr(node.condition.right, binder.type, into);
      into.push({ kind: "for", binder, start, bound, inclusive: node.condition.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken, body: lowerBlock(node.statement), loc: loc(node) }); return;
    }
    if (ts.isSwitchStatement(node)) {
      const value = expr(node.expression, undefined, into);
      if (!["number", "string", "named"].includes(value.type.kind)) error(node, "switch requires an enum or literal cases");
      const cases = node.caseBlock.clauses.map(c => {
        const tail = c.statements.at(-1); if (!tail || !ts.isBreakStatement(tail) && !ts.isReturnStatement(tail)) error(c, "every switch case must end in break or return");
        const statements: ModelStmt[] = []; for (const s of c.statements) if (!ts.isBreakStatement(s)) lowerStmt(s, statements);
        return { ...(ts.isCaseClause(c) ? { value: isolated(c.expression, value.type) } : {}), body: { stmts: statements } };
      });
      into.push({ kind: "switch", value, cases, loc: loc(node) }); return;
    }
    if (ts.isWhileStatement(node) || ts.isDoStatement(node)) error(node, "while and do loops are outside the model subset; use a bounded for loop");
    if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) return;
    error(node, `${ts.SyntaxKind[node.kind]} is outside the model statement subset`);
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
        if (clause.name || clause.namedBindings && !ts.isNamedImports(clause.namedBindings)) error(node, "model imports require named bindings");
        for (const specifier of (clause.namedBindings as ts.NamedImports | undefined)?.elements ?? []) {
          if (specifier.isTypeOnly) continue;
          const name = specifier.propertyName?.text ?? specifier.name.text, s = symbol(specifier.name)!;
          if (!source.startsWith(".")) {
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
  result.modules.sort((a, b) => ["root", "factory", "pure"].indexOf(a.kind) - ["root", "factory", "pure"].indexOf(b.kind));
  const memoDone = new Set<number>(), memoActive = new Set<number>();
  const pendingSignals: { b: Binding; init: ts.CallExpression; exported: boolean }[] = [], pendingMemos: { b: Binding; init: ts.CallExpression; exported: boolean }[] = [], pendingEffects: { module: ModelModule; node: ts.CallExpression; id: number }[] = [];
  const functionsByBinding = new Map<number, { b: Binding; node: ts.FunctionDeclaration; state: "new" | "active" | "done" }>();
  function registerStatements(statements: readonly ts.Statement[], model: ModelModule, outer = false) {
    current = model;
    for (const node of statements) {
      if (ts.isImportDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node) || ts.isEmptyStatement(node)) continue;
      if (ts.isExportDeclaration(node)) error(node, "re-exports are outside the model subset");
      if (ts.isReturnStatement(node) && model.kind === "factory" && !outer) continue;
      if (ts.isFunctionDeclaration(node)) {
        if (factoryDeclarations.get(model) === node) continue;
        if (!node.name || !node.body || node.asteriskToken || node.typeParameters?.length) error(node, "model functions require a named nongenerator body without type parameters");
        const fn: ModelFunction = { id: nextId++, name: node.name.text, exported: exported(node), async: asyncFn(node), params: [], returns: type(node.type, `${typeName(node.name.text)}Result`) ?? VOID, body: { stmts: [] }, ledger: emptyLedger(), loc: loc(node) };
        const b = register(node.name, { id: fn.id, name: fn.name, kind: "function", type: fn.returns, node, module: model, fn });
        fn.params = node.parameters.map(p => { if (!ts.isIdentifier(p.name) || p.dotDotDotToken || p.questionToken || p.initializer) error(p, "function parameters require simple names and fixed arity"); const t = type(p.type, p.name.text); if (!t) error(p, "function parameters require a contract type annotation"); return bindLocal(p.name, t); });
        model.functions.push(fn); functionsByBinding.set(fn.id, { b, node, state: "new" }); continue;
      }
      if (ts.isVariableStatement(node)) {
        for (const d of node.declarationList.declarations) {
          if (!d.initializer) error(d, "model declarations require an initializer");
          const init = d.initializer as ts.CallExpression, name = ts.isCallExpression(d.initializer) ? callName(d.initializer.expression) : undefined;
          if (name === "createSignal" || name === "ref") {
            if (model.kind === "pure") error(d, "pure module cannot declare state; importing another model's signal, memo or function is outside the subset");
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
            if (model.kind === "pure") error(d, "pure module cannot declare a memo");
            const b = register(d.name, { id: nextId++, name: d.name.text, kind: "memo", type: type(init.typeArguments?.[0], d.name.text) ?? VOID, node: d, module: model });
            pendingMemos.push({ b, init: init as ts.CallExpression, exported: exported(node) }); continue;
          }
          if (name === "createNodeRef") { if (model.kind === "pure") error(d, "pure module cannot declare a node reference"); const id = nextId++; model.refs.push({ id, name: d.name.text }); register(d.name, { id, name: d.name.text, kind: "ref", type: STRING, node: d, module: model }); continue; }
          if (name === "createContext") continue;
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) error(init, "closures as stored values are outside the model subset");
          const mutable = !(node.declarationList.flags & ts.NodeFlags.Const);
          if (mutable && model.kind === "pure") error(d, "pure module cannot declare private state");
          if (mutable && exported(node)) error(d, "private mutable fields cannot be exported");
          const b = register(d.name, { id: nextId++, name: d.name.text, kind: mutable ? "field" : "constant", type: type(d.type, d.name.text) ?? VOID, node: d, declaration: d, module: model, capacity: capacity(d.type) });
          if (mutable) model.fields.push({ id: b.id, name: b.name, type: b.type, capacity: b.capacity, seed: make(init, { kind: "undefined" }, VOID), loc: loc(d) });
        } continue;
      }
      if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && ["createEffect", "watch", "watchEffect"].includes(callName(node.expression.expression) ?? "")) {
        if (model.kind === "pure") error(node, "pure module cannot declare an effect");
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
    for (const node of env.program.getSourceFile(model.file)!.statements) if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith(".") && !node.importClause?.isTypeOnly) {
      const other = moduleByFile.get(resolveImport(node.moduleSpecifier.text, model.file, node));
      if (other && other.kind !== "pure") error(node, "cross-model imports of signals, memos and functions are outside the subset; use props, events or context");
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
      const collect = (block: ModelBlock): void => { for (const s of block.stmts) { if (s.kind === "return") returns.push(s.value?.type ?? VOID); else if (s.kind === "if") { collect(s.then); if (s.else) collect(s.else); } else if (["for", "forOf", "batch", "untrack"].includes(s.kind)) collect((s as { body: ModelBlock }).body); } };
      collect(currentFunction.body); currentFunction.returns = returns[0] ?? VOID;
      if (!returns.every(t => sameType(t, currentFunction!.returns))) error(item.node, "function returns require one consistent contract type");
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
  lowerModelTasks(result);
  analyzeModelLedgers(result);
  assertModelProgram(result);
  return result;
}
