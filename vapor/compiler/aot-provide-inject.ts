import ts from "typescript";
import { sameType, type AotComponent, type SourceLocation } from "./aot-ir.ts";
import { expression, type ExpressionContext } from "./aot-expressions.ts";
import { fail, typeName } from "./aot-types.ts";

/** Only the stock Vue functions imported by name participate in static context. */
export function vueContextCall(node: ts.Node, imports: Map<string, string>): "provide" | "inject" | undefined {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
  const imported = imports.get(node.expression.text);
  return imported === "provide" || imported === "inject" ? imported : undefined;
}

export function analyzeContextStatement(
  statement: ts.Statement, component: AotComponent, imports: Map<string, string>,
  context: ExpressionContext, checkedType: (node: ts.Node) => ts.Type,
  loc: (node: ts.Node) => SourceLocation,
): boolean {
  if (ts.isExpressionStatement(statement) && vueContextCall(statement.expression, imports) === "provide") {
    const call = statement.expression as ts.CallExpression;
    if (!component.root) fail(loc(call), "provide is supported only in the root component");
    if (call.typeArguments?.length || call.arguments.length !== 2 || !ts.isStringLiteral(call.arguments[0]!) || !ts.isIdentifier(call.arguments[1]!)) fail(loc(call), 'provide requires a literal key and a view-model binding: provide("theme", theme)');
    const key = (call.arguments[0] as ts.StringLiteral).text;
    if (!key.isWellFormed()) fail(loc(call), "Context keys cannot contain unpaired UTF-16 surrogates");
    if (component.provides?.some(value => value.key === key)) fail(loc(call), `Duplicate provide key ${JSON.stringify(key)}`);
    const source = call.arguments[1]!, binding = context.bindings.get(source.getText());
    if (!binding || binding.scope !== "vm") fail(loc(source), "A provided value must be a root view-model binding");
    const value = expression(source.getText(), loc(source), context);
    (component.provides ??= []).push({ key, value, loc: loc(call) });
    return true;
  }
  if (!ts.isVariableStatement(statement)) return false;
  const declarations = statement.declarationList.declarations;
  const declaration = declarations[0], initializer = declaration?.initializer;
  // The root key check discharges Vue's optional return type for editor users.
  const call = initializer && ts.isNonNullExpression(initializer) ? initializer.expression : initializer;
  if (!call || vueContextCall(call, imports) !== "inject") return false;
  if (component.root) fail(loc(call), "inject requires a child component and a matching root provide");
  if (!(statement.declarationList.flags & ts.NodeFlags.Const) || declarations.length !== 1 || !ts.isIdentifier(declaration!.name)) fail(loc(statement), "inject requires one named const declaration");
  const injection = call as ts.CallExpression;
  if (injection.typeArguments?.length !== 1 || injection.arguments.length !== 1 || !ts.isStringLiteral(injection.arguments[0]!)) fail(loc(call), 'inject requires an explicit type and literal key: inject<Theme>("theme")');
  const key = (injection.arguments[0] as ts.StringLiteral).text, name = (declaration!.name as ts.Identifier).text;
  const type = context.mapper.map(checkedType(injection.typeArguments[0]!), loc(call), typeName(name));
  (component.injections ??= []).push({ key, name, type, loc: loc(call) });
  context.bindings.set(name, { scope: "inject", resolvedName: key, type });
  return true;
}

/** Keys and types disappear into statically ordered view arguments; there is no runtime registry. */
export function resolveProvidedContext(components: AotComponent[]): void {
  const root = components.find(component => component.root);
  const provided = new Map(root?.provides?.map(value => [value.key, value]) ?? []);
  for (const component of components) for (const injection of component.injections ?? []) {
    const value = provided.get(injection.key);
    if (!value) fail(injection.loc, `No root provide matches inject key ${JSON.stringify(injection.key)}`);
    if (!sameType(value.value.type, injection.type)) fail(injection.loc, `The provided type for ${JSON.stringify(injection.key)} does not match its inject type`);
  }
  const byName = new Map(components.map(component => [component.name, component]));
  const resolved = new Set<string>();
  function visit(component: AotComponent): void {
    if (resolved.has(component.name)) return;
    resolved.add(component.name);
    const keys = new Set(component.injections?.map(value => value.key) ?? []);
    for (const name of component.children) {
      const child = byName.get(name)!;
      visit(child);
      child.context?.forEach(value => keys.add(value.key));
    }
    if (keys.size) component.context = [...keys].sort().map(key => ({ key, type: provided.get(key)!.value.type }));
  }
  components.forEach(visit);
}
