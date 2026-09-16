/** Contract mapping shared by the Vue and Solid front ends. */
import ts from "typescript";
import type { AotComponent, SourceLocation, LiteralValue } from "./aot-ir.ts";
import type { ExpressionContext } from "./aot-expressions.ts";
import { fail, typeName, constantNumericSpelling, constantArraySpellings, solidTypeAlias } from "./aot-types.ts";
export { solidTypeAlias } from "./aot-types.ts";
export function addAotContractBinding(component: AotComponent, ctx: ExpressionContext, name: string, sourceName: string, raw: ts.Type, at: SourceLocation, sourceNode?: ts.Node): void {
  const { mapper, environment } = ctx;
  const type = mapper.unwrap(raw);
  const optional = type.isUnion() && type.types.some(t => !!(t.flags & ts.TypeFlags.Undefined));
  const callable = optional ? environment.checker.getNonNullableType(type) : type;
  const signatures = callable.getCallSignatures();
  if (signatures.length) {
    if (signatures.length !== 1 || signatures[0]!.typeParameters?.length) fail(at, "View-model functions cannot have overloads or generic parameters");
    const signature = signatures[0]!;
    const parameters = signature.getParameters().map(parameter => {
      const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0];
      if (!declaration || ts.isParameter(declaration) && (declaration.dotDotDotToken || declaration.questionToken || declaration.initializer)) fail(at, "Function parameters must be required and cannot be rest parameters");
      return { name: parameter.name, type: mapper.map(environment.checker.getTypeOfSymbolAtLocation(parameter, declaration), environment.locationOf(declaration), `${typeName(name)}${typeName(parameter.name)}`) };
    });
    const returns = mapper.map(signature.getReturnType(), at, `${typeName(name)}Result`, true);
    if (optional && returns.kind !== "void") fail(at, "Optional view-model methods must return void so the default implementation has an empty body");
    const fn = { name, sourceName, parameters, returns, binding: false, handler: false, ...(optional ? { optional: true } : {}) };
    component.functions.push(fn); ctx.functions.set(name, fn);
  } else {
    const elements = type === raw && environment.checker.isTupleType(type) ? environment.checker.getTypeArguments(type as ts.TypeReference) : undefined;
    const literals = elements?.map(element => mapper.literal(element));
    const array = literals?.length && literals.every(value => value !== undefined) ? literals as LiteralValue[] : undefined;
    if (array && array.some(value => typeof value !== typeof array[0])) fail(at, "Literal array constants must contain one scalar type");
    const typeIR = array ? { kind: "array" as const, element: mapper.map(elements![0]!, at, typeName(name)), length: array.length } : mapper.map(type, at, typeName(name));
    const constant = type === raw ? array ?? mapper.literal(type) : undefined;
    const rawNumber = typeof constant === "number" ? constantNumericSpelling(environment.checker, sourceNode) : undefined;
    const rawNumbers = array && typeof array[0] === "number" ? constantArraySpellings(environment.checker, sourceNode) : undefined;
    const constantDefinition = constant !== undefined ? { name, sourceName, type: typeIR, value: constant, ...(rawNumber !== undefined ? { rawNumber } : {}), ...(rawNumbers ? { rawNumbers } : {}) } : undefined;
    if (constantDefinition) component.constants.push(constantDefinition);
    else component.values.push({ name, sourceName, type: typeIR, writable: false });
    ctx.bindings.set(name, { type: typeIR, scope: "vm", ...(constantDefinition ? { constantDefinition } : {}), ...(rawNumbers ? { rawNumbers } : {}), ...(solidTypeAlias(raw, "Accessor", environment.checker) ? { accessor: true } : {}), ...(constant !== undefined ? { constant } : {}), ...(rawNumber !== undefined ? { rawNumber } : {}) });
  }
}
