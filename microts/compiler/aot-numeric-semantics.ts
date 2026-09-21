/** Shared typed-operation lowering for compiled Solid and Vue views. */
import ts from "typescript";
import type { AotExpr, AotProgram, AotType, NumericName } from "./aot-ir.ts";

export function createAotNumericNormalizer(program: AotProgram, source: string) {
  const declarations = new Map(program.types.map(type => [type.name, type]));
  function numeric(type: AotType): NumericName | undefined {
    if (type.kind === "number") return type.name;
    const declaration = type.kind === "named" ? declarations.get(type.name) : undefined;
    return declaration?.kind === "newtype" && declaration.unit !== "Color" ? numeric(declaration.base) : undefined;
  }
  const unique = (base: string) => { let name = base, index = 0; while (source.includes(name)) name = `${base}${++index}`; return name; };
  const number = unique("__pocketAotNumber"), multiply = unique("__pocketAotMultiply");
  const used = new Set<"number" | "multiply">();
  const call = (name: string, args: ts.Expression[]) => ts.factory.createCallExpression(ts.factory.createIdentifier(name), undefined, args);
  function matches(node: ts.Node, value: AotExpr): boolean {
    switch (value.kind) {
      case "binary": return ts.isBinaryExpression(node) && ts.tokenToString(node.operatorToken.kind) === value.operator;
      case "unary": return ts.isPrefixUnaryExpression(node) && ts.tokenToString(node.operator) === value.operator;
      case "literal": return typeof value.value === "number" && (ts.isNumericLiteral(node) || ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand));
      case "cast": return ts.isAsExpression(node) || ts.isTypeAssertionExpression(node);
      case "call": return value.target === "builtin" && ts.isCallExpression(node);
      default: return false;
    }
  }
  return {
    eligible(values: AotExpr[]): boolean { return !!program.modelProtocol && values.some(value => numeric(value.type) !== undefined); },
    rewrite(node: ts.Node, transformed: ts.Node, values: AotExpr[]): ts.Node | undefined {
      if (!program.modelProtocol) return;
      const expression = values.find(value => matches(node, value));
      if (!expression) return;
      const type = numeric(expression.type);
      if (!type || type === "f64" || type === "i64" || type === "u64") return;
      // Operands with f32 type round before the enclosing operation as in Rust.
      if (expression.kind === "literal" && type !== "f32") return;
      let value = transformed as ts.Expression;
      if (ts.isBinaryExpression(transformed) && expression.kind === "binary" && expression.operator === "*" && type !== "f32") {
        used.add("multiply"); value = call(multiply, [transformed.left, transformed.right]);
      }
      if (ts.isAsExpression(transformed) || ts.isTypeAssertionExpression(transformed)) value = transformed.expression;
      used.add("number");
      return call(number, [value, ts.factory.createStringLiteral(type)]);
    },
    imports(): string[] { return [...used].map(helper => helper === "number" ? `__modelNumber as ${number}` : `__modelMultiply as ${multiply}`); },
  };
}
