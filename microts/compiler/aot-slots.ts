import ts from "typescript";
import type { AotSlot, AotSlotBinding, SourceLocation } from "./aot-ir.ts";
import { fail, TypeMapper, typeName } from "./aot-types.ts";
import type { ExpressionContext } from "./aot-expressions.ts";

/** defineSlots uses Vue's method contract; only its argument object enters View IR. */
export function readSlotContract(type: ts.Type, mapper: TypeMapper, at: SourceLocation, component: string): AotSlot[] {
  if (!(type.flags & ts.TypeFlags.Object) || type.getCallSignatures().length || mapper.checker.getIndexInfosOfType(type).length) fail(at, "defineSlots requires an object of named slot methods");
  return type.getProperties().map(property => {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    if (!declaration) fail(at, `Slot ${property.name} has no declaration`);
    const callable = mapper.checker.getNonNullableType(mapper.checker.getTypeOfSymbolAtLocation(property, declaration));
    const signatures = callable.getCallSignatures();
    if (signatures.length !== 1 || signatures[0]!.typeParameters?.length || signatures[0]!.getParameters().length > 1) fail(at, `Slot ${property.name} accepts at most one non-generic props argument`);
    if (!signatures[0]!.getParameters().length) return { name: property.name, parameters: [] };
    const parameter = signatures[0]!.getParameters()[0]!, parameterNode = parameter.valueDeclaration ?? parameter.declarations?.[0];
    if (!parameterNode || ts.isParameter(parameterNode) && (parameterNode.dotDotDotToken || parameterNode.questionToken || parameterNode.initializer)) fail(at, "Slot props must be one required object argument");
    const props = mapper.checker.getTypeOfSymbolAtLocation(parameter, parameterNode);
    if (!(props.flags & ts.TypeFlags.Object) || props.getCallSignatures().length || mapper.checker.isArrayType(props) || mapper.checker.isTupleType(props)) fail(at, "Slot props must be a named object shape");
    return { name: property.name, parameters: mapper.fields(props, at, `${component}${typeName(property.name)}Slot`) };
  });
}

export function readSlotBindings(source: string, slot: AotSlot | undefined, context: ExpressionContext, at: SourceLocation, prefix: string): { bindings: AotSlotBinding[]; context: ExpressionContext } {
  const parsed = ts.createSourceFile("slot-binding.ts", `const ${source} = value`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statement = parsed.statements[0], declaration = statement && ts.isVariableStatement(statement) ? statement.declarationList.declarations[0] : undefined;
  if ((parsed as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length || parsed.statements.length !== 1 || !declaration || !ts.isObjectBindingPattern(declaration.name) || declaration.name.getText(parsed) !== source.trim()) fail(at, "Scoped slots use object destructuring, such as #row=\"{ item }\"");
  const scoped = { ...context, bindings: new Map(context.bindings), narrowings: new Map(context.narrowings) }, bindings: AotSlotBinding[] = [], names = new Set<string>();
  for (const binding of declaration.name.elements) {
    if (!ts.isIdentifier(binding.name) || binding.dotDotDotToken || binding.initializer || binding.propertyName && !ts.isIdentifier(binding.propertyName) && !ts.isStringLiteral(binding.propertyName)) fail(at, "Slot destructuring accepts named bindings and aliases without defaults or rest bindings");
    const prop = binding.propertyName ? (binding.propertyName as ts.Identifier | ts.StringLiteral).text : binding.name.text;
    const field = slot?.parameters.find(parameter => parameter.name === prop);
    if (!field) fail(at, `Slot ${slot?.name ?? "default"} has no ${prop} prop`);
    if (names.has(binding.name.text)) fail(at, `Duplicate slot binding ${binding.name.text}`);
    names.add(binding.name.text);
    const name = `${prefix}${bindings.length}`;
    bindings.push({ name, prop, type: field.type });
    scoped.bindings.set(binding.name.text, { type: field.type, scope: "local", resolvedName: name });
  }
  return { bindings, context: scoped };
}
