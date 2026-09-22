/** Normalize typed view operations before Solid's universal JSX transform. */
import ts from "typescript";
import type { AotComponent, AotExpr, AotProgram, AotType } from "./aot-ir.ts";
import { fail, location } from "./aot-types.ts";
import { createAotNumericNormalizer } from "./aot-numeric-semantics.ts";

export function normalizeSolidAotSemantics(source: string, filename: string, program: AotProgram): string {
  const components = program.components.filter(c => c.file === filename);
  const results = components.map(component => normalize(source, filename, program, component));
  if (results.some(result => result !== results[0])) fail(location(filename, source), "Generic specializations must use the same typed display and arithmetic semantics; use separate components");
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
  const numeric = createAotNumericNormalizer(program, source);
  if (![...expressions.values()].some(list => list.some(e => color(e.type)) || numeric.eligible(list))) return source;
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  // A derived accessor's expanded IR root points at its use site. Recover the
  // declaration's root so its operation rounds before subsequent getter reads.
  const derived = new Map<string, ts.Expression>(), calls = new Map<number, ts.CallExpression[]>();
  const index = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = node.initializer;
      const arrow = ts.isArrowFunction(initializer) ? initializer : ts.isCallExpression(initializer) && initializer.arguments[0] && ts.isArrowFunction(initializer.arguments[0]) ? initializer.arguments[0] : undefined;
      if (arrow && !ts.isBlock(arrow.body)) derived.set(node.name.text, arrow.body);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const values = calls.get(node.getStart(ast)) ?? []; values.push(node); calls.set(node.getStart(ast), values);
    }
    ts.forEachChild(node, index);
  };
  index(ast);
  const pending = [...expressions].flatMap(([offset, values]) => values.map(value => ({ offset, value })));
  for (let index = 0; index < pending.length; index++) {
    const { offset, value } = pending[index]!;
    for (const call of calls.get(offset) ?? []) {
      const body = derived.get((call.expression as ts.Identifier).text); if (!body) continue;
      const target = body.getStart(ast), values = expressions.get(target) ?? [];
      if (!values.includes(value)) { values.push(value); expressions.set(target, values); pending.push({ offset: target, value }); }
    }
  }
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
      return numeric.rewrite(node, transformed, expressions.get(node.getStart(ast)) ?? []) ?? transformed;
    };
    return root => ts.visitNode(root, visit) as ts.SourceFile;
  }]);
  const output = ts.createPrinter().printFile(result.transformed[0]!); result.dispose();
  const imports = [usedBits ? `__colorBits as ${bits}` : "", usedText ? `__colorText as ${text}` : "", ...numeric.imports()].filter(Boolean);
  if (!imports.length) return source;
  return `import { ${imports.join(", ")} } from "@pocketjs/framework/solid/std";\n${output}`;
}
