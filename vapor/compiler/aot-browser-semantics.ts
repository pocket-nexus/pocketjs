/** Normalize the template semantics that TypeScript annotations cannot express. */
import { parse } from "@vue/compiler-sfc";
import { parse as parseTemplate, NodeTypes, type TemplateChildNode, type SimpleExpressionNode } from "@vue/compiler-dom";
import ts from "typescript";
import type { AotComponent, AotExpr, AotProgram, AotType } from "./aot-ir.ts";
import { fail, location } from "./aot-types.ts";
import { createAotNumericNormalizer } from "./aot-numeric-semantics.ts";

export function normalizeVueAotSemantics(source: string, filename: string, program: AotProgram): string {
  const components = program.components.filter(item => item.file === filename);
  if (!components.length) return source;
  const normalized = components.map(component => normalizeComponentSemantics(source, filename, program, component));
  if (normalized.some(value => value !== normalized[0])) {
    const template = parse(source, { filename }).descriptor.template;
    fail(location(filename, source, template?.loc.start.offset), "Generic specializations must use the same typed display and arithmetic semantics in a shared template; use separate components when those operations differ");
  }
  return normalized[0]!;
}

/** Native, browser, and guest builds admit the same source-level normalization. */
export function validateVueAotSemantics(program: AotProgram, sources: ReadonlyMap<string, string>): void {
  const counts = new Map<string, number>();
  for (const component of program.components) counts.set(component.file, (counts.get(component.file) ?? 0) + 1);
  for (const [file, count] of counts) if (count > 1) normalizeVueAotSemantics(sources.get(file)!, file, program);
}

function normalizeComponentSemantics(source: string, filename: string, program: AotProgram, component: AotComponent): string {
  const descriptor = parse(source, { filename }).descriptor;
  if (!descriptor.template || !descriptor.scriptSetup) return source;
  const units = new Map(program.types.filter(type => type.kind === "newtype").map(type => [type.name, type.unit]));
  const color = (type?: AotType): boolean => !!type && (type.kind === "option" ? color(type.value) : type.kind === "named" && units.get(type.name) === "Color");
  const expressions = new Map<number, AotExpr[]>();
  function collect(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(collect); return; }
    const candidate = value as Partial<AotExpr>;
    if (candidate.type && typeof candidate.type === "object" && candidate.loc?.file === filename) {
      const values = expressions.get(candidate.loc.offset) ?? [];
      values.push(candidate as AotExpr);
      expressions.set(candidate.loc.offset, values);
    }
    for (const [name, child] of Object.entries(value)) if (name !== "loc" && name !== "type") collect(child);
  }
  collect(component.nodes);
  const numeric = createAotNumericNormalizer(program, source);
  const optional = new Set(component.functions.filter(fn => fn.optional).map(fn => fn.name));
  if (!optional.size && ![...expressions.values()].some(values => values.some(value => color(value.type)) || numeric.eligible(values))) return source;
  function unique(base: string): string {
    let name = base, suffix = 2;
    while (source.includes(name)) name = `${base}${suffix++}`;
    return name;
  }
  const colorBits = unique("__pocketAotColorBits"), colorText = unique("__pocketAotColorText");
  let usedBits = false, usedText = false;
  const printer = ts.createPrinter({ removeComments: true });
  const edits: { start: number; end: number; text: string }[] = [];
  const templateOffset = descriptor.template.loc.start.offset;
  const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  function rewrite(expression: SimpleExpressionNode, textContext = false, loop = false): string | undefined {
    let input = expression.content;
    let prefix = "";
    if (loop) {
      const match = input.match(/^([\s\S]*?\s+(?:in|of)\s+)([\s\S]+)$/);
      if (!match) return;
      prefix = match[1]!; input = match[2]!;
    }
    const offset = templateOffset + expression.loc.start.offset + prefix.length;
    const file = ts.createSourceFile("template-expression.ts", `(${input})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const first = file.statements[0];
    if (!first || !ts.isExpressionStatement(first) || !ts.isParenthesizedExpression(first.expression)) return;
    let changed = false;
    function matches(node: ts.Node, value: AotExpr): boolean {
      if (value.kind === "cast" || value.kind === "narrow") return matches(node, value.value);
      switch (value.kind) {
        case "binding": return ts.isIdentifier(node) || value.scope === "prop" && ts.isPropertyAccessExpression(node);
        case "constant": return ts.isIdentifier(node);
        case "literal": return ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
        case "field": return ts.isPropertyAccessExpression(node);
        case "index": return ts.isElementAccessExpression(node);
        case "call": return ts.isCallExpression(node);
        case "conditional": return ts.isConditionalExpression(node);
        case "template": return ts.isTemplateExpression(node);
        case "binary": return ts.isBinaryExpression(node) && ts.tokenToString(node.operatorToken.kind) === value.operator;
        case "unary": return ts.isPrefixUnaryExpression(node);
        case "undefined": return node.kind === ts.SyntaxKind.Identifier && node.getText(file) === "undefined";
      }
    }
    const isColor = (raw: ts.Node) => {
      let node = raw;
      while (ts.isParenthesizedExpression(node)) node = node.expression;
      const candidates = expressions.get(offset + node.getStart(file) - 1) ?? [];
      return candidates.some(value => matches(node, value) && color(value.type));
    };
    const call = (name: string, expression: ts.Expression) => ts.factory.createCallExpression(ts.factory.createIdentifier(name), undefined, [expression]);
    const result = ts.transform(first.expression.expression, [context => {
      const visit: ts.Visitor = node => {
        const transformed = ts.visitEachChild(node, visit, context);
        if (ts.isCallExpression(node) && ts.isCallExpression(transformed) && ts.isIdentifier(node.expression) && optional.has(node.expression.text) && !node.questionDotToken) {
          changed = true;
          return ts.factory.createCallChain(transformed.expression, ts.factory.createToken(ts.SyntaxKind.QuestionDotToken), transformed.typeArguments, transformed.arguments);
        }
        if (ts.isBinaryExpression(node) && ts.isBinaryExpression(transformed) &&
          [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind) && isColor(node.left) && isColor(node.right)) {
          changed = usedBits = true;
          return ts.factory.updateBinaryExpression(transformed, call(colorBits, transformed.left), transformed.operatorToken, call(colorBits, transformed.right));
        }
        if (ts.isTemplateSpan(node) && ts.isTemplateSpan(transformed) && isColor(node.expression)) {
          changed = usedText = true;
          return ts.factory.updateTemplateSpan(transformed,
            ts.factory.createCallExpression(ts.factory.createIdentifier(colorText), undefined, [transformed.expression, ts.factory.createStringLiteral("undefined")]), transformed.literal);
        }
        const normalized = numeric.rewrite(node, transformed, expressions.get(offset + node.getStart(file) - 1) ?? []);
        if (normalized) { changed = true; return normalized; }
        return transformed;
      };
      return root => ts.visitNode(root, visit) as ts.Expression;
    }]);
    let value = result.transformed[0]!;
    if (textContext && isColor(first.expression.expression)) { value = call(colorText, value); changed = usedText = true; }
    const output = changed ? prefix + printer.printNode(ts.EmitHint.Expression, value, file) : undefined;
    result.dispose();
    return output;
  }
  function visit(node: TemplateChildNode): void {
    if (node.type === NodeTypes.INTERPOLATION && node.content.type === NodeTypes.SIMPLE_EXPRESSION) {
      const output = rewrite(node.content, true);
      if (output !== undefined) edits.push({ start: templateOffset + node.content.loc.start.offset, end: templateOffset + node.content.loc.end.offset, text: output });
    } else if (node.type === NodeTypes.ELEMENT) {
      for (const prop of node.props) {
        if (prop.type !== NodeTypes.DIRECTIVE || prop.exp?.type !== NodeTypes.SIMPLE_EXPRESSION || prop.name === "slot") continue;
        const output = rewrite(prop.exp, prop.name === "text", prop.name === "for");
        if (output === undefined) continue;
        const head = prop.loc.source.slice(0, prop.loc.source.indexOf("="));
        edits.push({ start: templateOffset + prop.loc.start.offset, end: templateOffset + prop.loc.end.offset, text: `${head}="${escape(output)}"` });
      }
      node.children.forEach(visit);
    }
  }
  parseTemplate(descriptor.template.content).children.forEach(visit);
  const imports = [usedBits ? `__colorBits as ${colorBits}` : "", usedText ? `__colorText as ${colorText}` : "", ...numeric.imports()].filter(Boolean);
  if (imports.length) {
    edits.push({ start: descriptor.scriptSetup.loc.start.offset, end: descriptor.scriptSetup.loc.start.offset,
      text: `\nimport { ${imports.join(", ")} } from "@pocketjs/framework/vue-vapor/std";\n` });
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return source;
}
