/** Normalize Color display/equality before Solid's universal JSX transform. */
import ts from "typescript";
import type { AotComponent, AotExpr, AotProgram, AotType } from "./aot-ir.ts";
import { fail, location } from "./aot-types.ts";

export function normalizeSolidAotSemantics(source: string, filename: string, program: AotProgram): string {
  const components = program.components.filter(c => c.file === filename);
  const results = components.map(component => normalize(source, filename, program, component));
  if (results.some(result => result !== results[0])) fail(location(filename, source), "Generic specializations must use the same Color display and equality semantics; use separate components");
  return results[0] ?? source;
}
function normalize(source: string, filename: string, program: AotProgram, component: AotComponent): string {
  const colors = new Set(program.types.filter(t => t.kind === "newtype" && t.unit === "Color").map(t => t.name));
  const color = (type: AotType): boolean => type.kind === "option" ? color(type.value) : type.kind === "named" && colors.has(type.name);
  const expressions = new Map<number, AotExpr[]>();
  function collect(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(collect); return; }
    const e = value as Partial<AotExpr>;
    if (e.type && e.loc?.file === filename) {
      const list = expressions.get(e.loc.offset) ?? []; list.push(e as AotExpr); expressions.set(e.loc.offset, list);
    }
    for (const [name, child] of Object.entries(value)) if (name !== "loc" && name !== "type") collect(child);
  }
  collect(component.nodes); collect(component.hooks);
  if (![...expressions.values()].some(list => list.some(e => color(e.type)))) return source;
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const unique = (base: string) => { let name = base, index = 0; while (source.includes(name)) name = base + ++index; return name; };
  const bits = unique("__pocketColorBits"), text = unique("__pocketColorText");
  let usedBits = false, usedText = false;
  const isColor = (node: ts.Node) => {
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    return expressions.get(node.getStart(ast))?.some(e => color(e.type)) ?? false;
  };
  const call = (name: string, args: ts.Expression[]) => ts.factory.createCallExpression(ts.factory.createIdentifier(name), undefined, args);
  const result = ts.transform(ast, [context => {
    const visit: ts.Visitor = node => {
      const transformed = ts.visitEachChild(node, visit, context);
      if (ts.isBinaryExpression(node) && ts.isBinaryExpression(transformed) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind) && isColor(node.left) && isColor(node.right)) {
        usedBits = true;
        return ts.factory.updateBinaryExpression(transformed, call(bits, [transformed.left]), transformed.operatorToken, call(bits, [transformed.right]));
      }
      if (ts.isTemplateSpan(node) && ts.isTemplateSpan(transformed) && isColor(node.expression)) {
        usedText = true;
        return ts.factory.updateTemplateSpan(transformed, call(text, [transformed.expression, ts.factory.createStringLiteral("undefined")]), transformed.literal);
      }
      if (ts.isJsxExpression(node) && ts.isJsxExpression(transformed) && node.expression && transformed.expression && ts.isJsxElement(node.parent) && isColor(node.expression)) {
        usedText = true;
        return ts.factory.updateJsxExpression(transformed, call(text, [transformed.expression]));
      }
      return transformed;
    };
    return root => ts.visitNode(root, visit) as ts.SourceFile;
  }]);
  const output = ts.createPrinter().printFile(result.transformed[0]!); result.dispose();
  if (!usedBits && !usedText) return source;
  const imports = [usedBits ? `__colorBits as ${bits}` : "", usedText ? `__colorText as ${text}` : ""].filter(Boolean);
  return `import { ${imports.join(", ")} } from "@pocketjs/framework/solid/std";\n${output}`;
}
