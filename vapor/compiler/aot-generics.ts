/** Infer finite component specializations from the parent's typed prop expressions. */
import ts from "typescript";
import { baseParse, NodeTypes } from "@vue/compiler-dom";
import type { AotExpr, AotType, SourceLocation } from "./aot-ir.ts";
import { sameType } from "./aot-ir.ts";
import { fail, type TypeEnvironment, type TypeMapper } from "./aot-types.ts";

export interface GenericParameter { name: string; type: ts.Type; constraint?: ts.Type; default?: ts.Type }
export type GenericSourceArguments = Map<string, ts.Type[]>;

export function genericParameters(file: string, source: string, declaration: string, environment: TypeEnvironment, loc: SourceLocation): GenericParameter[] {
  const prefix = "type Component<", syntax = ts.createSourceFile("generic.ts", `${prefix}${declaration}> = never;`, ts.ScriptTarget.Latest, true);
  const statement = syntax.statements[0];
  if ((syntax as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics.length || !statement || !ts.isTypeAliasDeclaration(statement) || !statement.typeParameters?.length) fail(loc, "generic requires TypeScript type parameter declarations");
  const script = baseParse(source, { parseMode: "sfc" }).children.find(node => node.type === NodeTypes.ELEMENT && node.tag === "script" && node.props.some(prop => prop.type === NodeTypes.ATTRIBUTE && prop.name === "setup"));
  const attribute = script?.type === NodeTypes.ELEMENT ? script.props.find(prop => prop.type === NodeTypes.ATTRIBUTE && prop.name === "generic") : undefined;
  if (attribute?.type !== NodeTypes.ATTRIBUTE || !attribute.value) fail(loc, "Cannot resolve the generic attribute");
  const quoted = /^["']/.test(attribute.value.loc.source);
  const start = attribute.value.loc.start.offset + (quoted ? 1 : 0);
  return statement.typeParameters.map(parameter => {
    const mapped = environment.nodeAt(file, start + parameter.name.getStart(syntax) - prefix.length);
    if (!mapped) fail(loc, `Cannot resolve generic parameter ${parameter.name.text}`);
    const type = environment.checker.getTypeAtLocation(mapped);
    if (!(type.flags & ts.TypeFlags.TypeParameter)) fail(loc, `Cannot resolve generic parameter ${parameter.name.text}`);
    const declaration = type.symbol.declarations?.find(ts.isTypeParameterDeclaration);
    const constraint = declaration?.constraint && environment.checker.getTypeFromTypeNode(declaration.constraint);
    return { name: parameter.name.text, type, constraint, default: environment.checker.getDefaultFromTypeParameter(type) };
  });
}

/** Keep literal domains that the Rust storage type does not retain. */
export function genericSourceType(actual: AotExpr, environment: TypeEnvironment, width?: number): ts.Type | undefined {
  if (actual.kind === "literal") {
    if (typeof actual.value === "string") return environment.checker.getStringLiteralType(actual.value);
    if (typeof actual.value === "number") return environment.checker.getNumberLiteralType(actual.value);
    return actual.value ? environment.checker.getTrueType() : environment.checker.getFalseType();
  }
  const node = environment.nodeAt(actual.loc.file, actual.loc.offset, width);
  const type = node && environment.checker.getTypeAtLocation(node);
  return type && !(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) ? type : undefined;
}

export function inferGenericSource(pattern: ts.Type, actual: ts.Type, parameters: Set<string>, inferred: GenericSourceArguments, inherited: GenericSourceArguments, mapper: TypeMapper, seen = new Set<ts.Type>()): void {
  pattern = mapper.unwrap(pattern); actual = mapper.unwrap(actual);
  if (actual.flags & ts.TypeFlags.TypeParameter) {
    const values = inherited.get(actual.symbol.name);
    if (values) { for (const value of values) if (value !== actual) inferGenericSource(pattern, value, parameters, inferred, inherited, mapper, seen); return; }
  }
  if (pattern.flags & ts.TypeFlags.TypeParameter && parameters.has(pattern.symbol.name)) {
    const values = inferred.get(pattern.symbol.name) ?? [];
    if (!values.includes(actual)) values.push(actual);
    inferred.set(pattern.symbol.name, values); return;
  }
  if (seen.has(pattern)) return;
  const next = new Set(seen).add(pattern), checker = mapper.checker;
  if (pattern.isUnion()) {
    const members = pattern.types.filter(type => !(type.flags & ts.TypeFlags.Undefined));
    if (members.length === 1) inferGenericSource(members[0]!, checker.getNonNullableType(actual), parameters, inferred, inherited, mapper, next);
  } else if (checker.isArrayType(pattern)) {
    const element = checker.getIndexTypeOfType(actual, ts.IndexKind.Number);
    if (element) inferGenericSource(checker.getTypeArguments(pattern as ts.TypeReference)[0]!, element, parameters, inferred, inherited, mapper, next);
  } else if (checker.isTupleType(pattern)) {
    const expected = checker.getTypeArguments(pattern as ts.TypeReference);
    const values = checker.isTupleType(actual) ? checker.getTypeArguments(actual as ts.TypeReference) : expected.map(() => checker.getIndexTypeOfType(actual, ts.IndexKind.Number));
    expected.forEach((type, index) => { if (values[index]) inferGenericSource(type, values[index]!, parameters, inferred, inherited, mapper, next); });
  } else for (const property of pattern.getProperties()) {
    const field = actual.getProperty(property.name), node = property.valueDeclaration ?? property.declarations?.[0], fieldNode = field?.valueDeclaration ?? field?.declarations?.[0];
    if (node && field && fieldNode) inferGenericSource(checker.getTypeOfSymbolAtLocation(property, node), checker.getTypeOfSymbolAtLocation(field, fieldNode), parameters, inferred, inherited, mapper, next);
  }
}

/** TypeScript checks literal and branded types; dependent constraints use inferred parameters. */
export function satisfiesGenericSourceConstraint(actual: ts.Type, expected: ts.Type, arguments_: GenericSourceArguments, mapper: TypeMapper, seen = new Map<ts.Type, Set<ts.Type>>()): boolean {
  actual = mapper.unwrap(actual); expected = mapper.unwrap(expected);
  const checker = mapper.checker;
  if (actual.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return false;
  if (checker.isTypeAssignableTo(actual, expected)) return true;
  if (seen.get(expected)?.has(actual)) return true;
  const next = new Map(seen); next.set(expected, new Set(seen.get(expected)).add(actual));
  if (expected.flags & ts.TypeFlags.TypeParameter) {
    const values = arguments_.get(expected.symbol.name);
    return !!values?.length && (actual.isUnion() ? actual.types : [actual]).every(value => values.some(candidate => candidate !== expected && satisfiesGenericSourceConstraint(value, candidate, arguments_, mapper, next)));
  }
  if (actual.isUnion()) return actual.types.every(value => satisfiesGenericSourceConstraint(value, expected, arguments_, mapper, next));
  if (expected.isUnion()) return expected.types.some(value => satisfiesGenericSourceConstraint(actual, value, arguments_, mapper, next));
  if (checker.isTupleType(expected)) {
    if (!checker.isTupleType(actual)) return false;
    const fields = checker.getTypeArguments(expected as ts.TypeReference), values = checker.getTypeArguments(actual as ts.TypeReference);
    return fields.length === values.length && fields.every((field, index) => satisfiesGenericSourceConstraint(values[index]!, field, arguments_, mapper, next));
  }
  if (checker.isArrayType(expected)) {
    const value = checker.getIndexTypeOfType(actual, ts.IndexKind.Number);
    return !!value && satisfiesGenericSourceConstraint(value, checker.getTypeArguments(expected as ts.TypeReference)[0]!, arguments_, mapper, next);
  }
  if (!(expected.flags & ts.TypeFlags.Object) || !(actual.flags & ts.TypeFlags.Object)) return false;
  return expected.getProperties().every(property => {
    const field = actual.getProperty(property.name), node = property.valueDeclaration ?? property.declarations?.[0], fieldNode = field?.valueDeclaration ?? field?.declarations?.[0];
    if (!field) return !!(property.flags & ts.SymbolFlags.Optional);
    return !!node && !!fieldNode && satisfiesGenericSourceConstraint(checker.getTypeOfSymbolAtLocation(field, fieldNode), checker.getTypeOfSymbolAtLocation(property, node), arguments_, mapper, next);
  });
}

/** Missing source evidence cannot prove a literal constraint from an erased Rust type. */
export function constraintNeedsSource(type: ts.Type, mapper: TypeMapper, seen = new Set<ts.Type>()): boolean {
  if (type.isLiteral() || type.flags & (ts.TypeFlags.BooleanLiteral | ts.TypeFlags.TypeParameter)) return true;
  if (seen.has(type)) return false;
  const next = new Set(seen).add(type);
  if (type.isUnionOrIntersection()) return type.types.some(member => constraintNeedsSource(member, mapper, next));
  if (mapper.checker.isArrayType(type) || mapper.checker.isTupleType(type)) return mapper.checker.getTypeArguments(type as ts.TypeReference).some(member => constraintNeedsSource(member, mapper, next));
  return !!(type.flags & ts.TypeFlags.Object) && type.getProperties().some(property => {
    const node = property.valueDeclaration ?? property.declarations?.[0];
    return !!node && constraintNeedsSource(mapper.checker.getTypeOfSymbolAtLocation(property, node), mapper, next);
  });
}

/** Phantom TypeScript tags do not permit changing the concrete Rust numeric representation. */
export function preservesGenericStorage(actual: AotType, expected: AotType, mapper: TypeMapper, seen = new Set<string>()): boolean {
  if (expected.kind === "number") return sameType(actual, expected);
  if (expected.kind === "option") return preservesGenericStorage(actual.kind === "option" ? actual.value : actual, expected.value, mapper, seen);
  if (expected.kind === "array") return actual.kind === "array" && preservesGenericStorage(actual.element, expected.element, mapper, seen);
  if (expected.kind === "tuple") {
    const elements = actual.kind === "tuple" ? actual.elements : actual.kind === "array" && actual.length === expected.elements.length ? expected.elements.map(() => actual.element) : [];
    return elements.length === expected.elements.length && expected.elements.every((element, index) => preservesGenericStorage(elements[index]!, element, mapper, seen));
  }
  const a = mapper.declaration(actual), b = mapper.declaration(expected);
  if (b?.kind === "newtype") return sameType(actual, expected);
  const key = JSON.stringify([actual, expected]);
  if (seen.has(key)) return true;
  const next = new Set(seen).add(key);
  if (a?.kind === "struct" && b?.kind === "struct") return b.fields.every(field => {
    const value = a.fields.find(value => value.name === field.name);
    return !value || preservesGenericStorage(value.type, field.type, mapper, next);
  });
  if (a?.kind === "union" && b?.kind === "union") return a.variants.every(variant => {
    const required = b.variants.find(value => value.name === variant.name);
    return !required || required.fields.every(field => {
      const value = variant.fields.find(value => value.name === field.name);
      return !value || preservesGenericStorage(value.type, field.type, mapper, next);
    });
  });
  return true;
}

export function inferGenericArgument(pattern: ts.Type, actual: AotType, parameters: Set<string>, inferred: Map<string, AotType>, mapper: TypeMapper, loc: SourceLocation, seen = new Set<ts.Type>()): void {
  pattern = mapper.unwrap(pattern);
  if (pattern.flags & ts.TypeFlags.TypeParameter && parameters.has(pattern.symbol.name)) {
    const name = pattern.symbol.name, previous = inferred.get(name);
    if (previous && !sameType(previous, actual)) fail(loc, `Conflicting inferred types for generic parameter ${name}`);
    inferred.set(name, actual); return;
  }
  if (seen.has(pattern)) return;
  seen.add(pattern);
  if (pattern.isUnion()) {
    const members = pattern.types.filter(t => !(t.flags & ts.TypeFlags.Undefined));
    if (members.length === 1) inferGenericArgument(members[0]!, actual.kind === "option" ? actual.value : actual, parameters, inferred, mapper, loc, seen);
  } else if (mapper.checker.isArrayType(pattern) && actual.kind === "array") {
    inferGenericArgument(mapper.checker.getTypeArguments(pattern as ts.TypeReference)[0]!, actual.element, parameters, inferred, mapper, loc, seen);
  } else if (mapper.checker.isTupleType(pattern)) {
    const args = mapper.checker.getTypeArguments(pattern as ts.TypeReference);
    const values = actual.kind === "tuple" ? actual.elements : actual.kind === "array" && actual.length === args.length ? args.map(() => actual.element) : [];
    args.forEach((type, index) => { if (values[index]) inferGenericArgument(type, values[index]!, parameters, inferred, mapper, loc, new Set(seen)); });
  } else {
    const shape = mapper.declaration(actual);
    if (shape?.kind === "struct") for (const property of pattern.getProperties()) {
      const node = property.valueDeclaration ?? property.declarations?.[0], field = shape.fields.find(f => f.name === property.name);
      if (node && field) inferGenericArgument(mapper.checker.getTypeOfSymbolAtLocation(property, node), field.type, parameters, inferred, mapper, loc, new Set(seen));
    }
  }
}

/** Structural constraints accept extra object fields; numeric types retain their exact tags. */
export function satisfiesGenericConstraint(actual: AotType, expected: AotType, mapper: TypeMapper): boolean {
  if (sameType(actual, expected)) return true;
  if (expected.kind === "option") return satisfiesGenericConstraint(actual.kind === "option" ? actual.value : actual, expected.value, mapper);
  if (actual.kind === "array" && expected.kind === "array") return (expected.length === undefined || expected.length === actual.length) && satisfiesGenericConstraint(actual.element, expected.element, mapper);
  const a = mapper.declaration(actual), b = mapper.declaration(expected);
  if (a?.kind === "enum") {
    if (expected.kind === "string") return true;
    if (b?.kind === "enum") return a.variants.every(variant => b.variants.includes(variant));
  }
  return a?.kind === "struct" && b?.kind === "struct" && b.fields.every(field => {
    const value = a.fields.find(f => f.name === field.name);
    return value ? satisfiesGenericConstraint(value.type, field.type, mapper) : field.type.kind === "option";
  });
}
