import ts from "typescript";
import { VAPOR_BUILTINS, parseVaporColor } from "../../contracts/spec/vapor.ts";
import { BOOL, STRING, I32, F64, sameType, type AotExpr, type AotType, type AotFunction, type BindingScope, type SourceLocation, type AotTypeDeclaration } from "./aot-ir.ts";
import { fail, exactIntegerLiteral, type TypeMapper, type TypeEnvironment } from "./aot-types.ts";

export interface ExpressionBinding { type: AotType; scope: BindingScope; resolvedName?: string; constant?: string | number | boolean; rawNumber?: string; model?: string }
export interface Narrowing { type: AotType; variant?: string }
export interface ExpressionContext {
  file: string; mapper: TypeMapper; environment: TypeEnvironment;
  bindings: Map<string, ExpressionBinding>; functions: Map<string, AotFunction>; builtins: Map<string, string>;
  propsName?: string; narrowings: Map<string, Narrowing>; handler: boolean;
}
export function numeric(type: AotType, mapper: TypeMapper): Extract<AotType, { kind: "number" }> | undefined {
  if (type.kind === "number") return type;
  const d = mapper.declaration(type);
  return d?.kind === "newtype" && d.unit !== "Color" ? numeric(d.base, mapper) : undefined;
}
export function displayable(type: AotType, mapper: TypeMapper): boolean {
  if (["number", "string", "boolean", "undefined"].includes(type.kind)) return true;
  if (type.kind === "option") return displayable(type.value, mapper);
  const d = mapper.declaration(type);
  return d?.kind === "enum" || d?.kind === "newtype" && displayable(d.base, mapper);
}
export function pathOf(expr: AotExpr): string | undefined {
  if (expr.kind === "binding") return `${expr.scope}:${expr.name}`;
  if (expr.kind === "field") { const parent = pathOf(expr.object); return parent ? `${parent}.${expr.name}` : undefined; }
  if (expr.kind === "narrow") return pathOf(expr.value);
}
export function narrowed(context: ExpressionContext, condition: AotExpr, truth: boolean): ExpressionContext {
  const next = { ...context, narrowings: new Map(context.narrowings) };
  if (condition.kind === "unary" && condition.operator === "!") return narrowed(context, condition.operand, !truth);
  if (condition.kind === "binary" && condition.operator === "&&" && truth) return narrowed(narrowed(context, condition.left, true), condition.right, true);
  if (condition.kind !== "binary" || !["===", "!=="].includes(condition.operator)) return next;
  const positive = truth === (condition.operator === "===");
  const { left, right } = condition;
  if (right.kind === "undefined" && left.type.kind === "option" && !positive) {
    const path = pathOf(left); if (path) next.narrowings.set(path, { type: left.type.value });
  }
  if (left.kind === "field" && right.kind === "literal" && typeof right.value === "string") {
    const d = context.mapper.declaration(left.object.type);
    if (d?.kind === "union" && d.discriminant === left.name) {
      const path = pathOf(left.object);
      const prior = path ? next.narrowings.get(path) : undefined;
      if (path && positive) next.narrowings.set(path, { type: left.object.type, variant: right.value });
      else if (path && !prior && d.variants.length === 2) next.narrowings.set(path, { type: left.object.type, variant: d.variants.find(v => v.name !== right.value)!.name });
    }
  }
  return next;
}
export function expression(source: string, loc: SourceLocation, context: ExpressionContext, expected?: AotType): AotExpr {
  const file = ts.createSourceFile("expression.ts", `(${source})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const errors = (file as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics;
  if (errors.length) fail(loc, `Invalid expression: ${ts.flattenDiagnosticMessageText(errors[0]!.messageText, " ")}`);
  const statement = file.statements[0];
  if (file.statements.length !== 1 || !statement || !ts.isExpressionStatement(statement) || !ts.isParenthesizedExpression(statement.expression)) fail(loc, "Expected one expression");
  const at = (node: ts.Node): SourceLocation => {
    const offset = node.getStart(file) - 1, lines = source.slice(0, offset).split("\n");
    return { ...loc, offset: loc.offset + offset, line: loc.line + lines.length - 1, column: lines.length > 1 ? lines.at(-1)!.length + 1 : loc.column + offset };
  };
  function build(node: ts.Expression, wanted?: AotType, ctx = context): AotExpr {
    const here = at(node);
    const result = (body: Omit<AotExpr, "type" | "loc"> | object, type: AotType): AotExpr => ({ ...body, type, loc: here } as AotExpr);
    if (ts.isParenthesizedExpression(node)) return build(node.expression, wanted, ctx);
    function checkerNarrow(value: AotExpr, sourceNode: ts.Node, scope: ExpressionContext): AotExpr {
      if (ts.isPropertyAccessExpression(sourceNode.parent) && sourceNode.parent.questionDotToken && sourceNode.parent.expression === sourceNode) return value;
      const mappedSource = ts.isPropertyAccessExpression(sourceNode) ? sourceNode.name : sourceNode;
      const mappedNode = scope.environment.nodeAt(scope.file, at(mappedSource).offset);
      if (!mappedNode) return value;
      const checked = scope.mapper.unwrap(scope.environment.checker.getTypeAtLocation(mappedNode));
      if (checked.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return value;
      if (checked.flags & ts.TypeFlags.Never) fail(here, "This expression is unreachable after TypeScript narrowing");
      const hasUndefined = (t: ts.Type): boolean => !!(t.flags & ts.TypeFlags.Undefined) || t.isUnion() && t.types.some(hasUndefined);
      if (value.type.kind === "option" && !(value.kind === "field" && value.optional) && !hasUndefined(checked)) value = result({ kind: "narrow", value }, value.type.value);
      const declaration = scope.mapper.declaration(value.type);
      if (declaration?.kind === "union") {
        const field = checked.getProperty(declaration.discriminant);
        const fieldNode = field?.valueDeclaration ?? field?.declarations?.[0];
        if (field && fieldNode) {
          const variant = scope.mapper.literal(scope.environment.checker.getTypeOfSymbolAtLocation(field, fieldNode));
          if (typeof variant === "string" && declaration.variants.some(v => v.name === variant)) value = result({ kind: "narrow", value, variant }, value.type);
        }
      }
      return value;
    }
    if (ts.isNumericLiteral(node) || ts.isStringLiteral(node) || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
      const value = ts.isNumericLiteral(node) ? Number(node.text) : ts.isStringLiteral(node) ? node.text : node.kind === ts.SyntaxKind.TrueKeyword;
      return literal(value, wanted, here, ctx, ts.isNumericLiteral(node) ? exactIntegerLiteral(node.getText(file)) ?? node.getText(file).replaceAll("_", "").replace(/^\./, "0.").replace(/\.$/, ".0") : undefined);
    }
    if (ts.isIdentifier(node)) {
      if (node.text === "undefined") {
        let parent = node.parent;
        while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
        if (!ts.isBinaryExpression(parent) || ![ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.QuestionQuestionToken].includes(parent.operatorToken.kind)) fail(here, "undefined is supported in comparisons and ?? only");
        return result({ kind: "undefined" }, { kind: "undefined" });
      }
      const binding = ctx.bindings.get(node.text);
      if (!binding) fail(here, `Unknown template binding ${node.text}`);
      if (binding.constant !== undefined) return literal(binding.constant, wanted, here, ctx, binding.rawNumber);
      let value = result({ kind: "binding", name: binding.resolvedName ?? binding.model ?? node.text, scope: binding.scope }, binding.type);
      const n = ctx.narrowings.get(pathOf(value)!);
      if (n) value = result({ kind: "narrow", value, variant: n.variant }, n.type);
      return checkerNarrow(value, node, ctx);
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === ctx.propsName && ctx.bindings.get(node.expression.text)?.scope !== "local") {
        const binding = ctx.bindings.get(`props.${node.name.text}`);
        if (!binding) fail(here, `Unknown prop ${node.name.text}`);
        let value = result({ kind: "binding", name: node.name.text, scope: "prop" }, binding.type);
        const n = ctx.narrowings.get(pathOf(value)!);
        if (n) value = result({ kind: "narrow", value, variant: n.variant }, n.type);
        return checkerNarrow(value, node, ctx);
      }
      const object = build(node.expression, undefined, ctx);
      const optional = !!node.questionDotToken;
      let type = object.type;
      if (type.kind === "option") {
        if (!optional) fail(here, "An optional value must be narrowed by v-if or accessed with ?.");
        type = type.value;
      } else if (optional) fail(here, "Optional property access requires an Option object");
      const d = ctx.mapper.declaration(type);
      if (node.name.text === "length" && ["array", "string"].includes(type.kind)) fail(here, "Use the imported len() built-in instead of .length");
      let fieldType: AotType | undefined, variant: string | undefined;
      if (d?.kind === "struct") fieldType = d.fields.find(f => f.name === node.name.text)?.type;
      if (d?.kind === "union") {
        if (node.name.text === d.discriminant) fieldType = STRING;
        else {
          variant = ctx.narrowings.get(pathOf(object)!)?.variant;
          if (!variant && object.kind === "narrow") variant = object.variant;
          if (variant) fieldType = d.variants.find(v => v.name === variant)?.fields.find(f => f.name === node.name.text)?.type;
          if (!fieldType) fail(here, `Narrow ${d.name}.${d.discriminant} with v-if before accessing ${node.name.text}`);
        }
      }
      if (!fieldType) fail(here, `Property ${node.name.text} is not a declared object field`);
      // Mapped checker types validate that access exists in Vue's narrowed TypeScript branch.
      const mapped = ctx.environment.typeAt(ctx.file, at(node.name).offset);
      if (mapped && mapped.flags & ts.TypeFlags.Never) fail(here, "This property access is unreachable after TypeScript narrowing");
      if (optional && fieldType.kind !== "option") fieldType = { kind: "option", value: fieldType };
      let value = result({ kind: "field", object, name: node.name.text, optional, ...(variant ? { variant } : {}) }, fieldType);
      const n = ctx.narrowings.get(pathOf(value)!);
      if (n) value = result({ kind: "narrow", value, variant: n.variant }, n.type);
      return checkerNarrow(value, node, ctx);
    }
    if (ts.isElementAccessExpression(node)) {
      if (node.questionDotToken || !node.argumentExpression) fail(here, "Only arr[i] indexing is supported");
      const object = build(node.expression, undefined, ctx);
      if (object.type.kind !== "array") fail(here, "Only arrays can be indexed; computed property names are unsupported");
      const index = build(node.argumentExpression, I32, ctx); requireType(index, I32, ctx);
      return result({ kind: "index", object, index }, { kind: "option", value: object.type.element });
    }
    if (ts.isPrefixUnaryExpression(node)) {
      const operator = ts.tokenToString(node.operator);
      if (!["!", "-", "+"].includes(operator ?? "")) fail(here, "Unsupported unary operator");
      const constantOperand = operator !== "!" && literalNode(node.operand, ctx) ? build(node.operand, undefined, ctx) : undefined;
      if (constantOperand?.kind === "literal" && typeof constantOperand.value === "number") {
        const raw = constantOperand.rawNumber !== undefined ? (operator === "-" ? constantOperand.rawNumber.startsWith("-") ? constantOperand.rawNumber.slice(1) : "-" + constantOperand.rawNumber : constantOperand.rawNumber) : undefined;
        return literal(operator === "-" ? -constantOperand.value : constantOperand.value, wanted, here, ctx, raw);
      }
      const operand = build(node.operand, operator === "!" ? BOOL : wanted, ctx);
      if (operator === "!") requireType(operand, BOOL, ctx); else if (!numeric(operand.type, ctx.mapper)) fail(here, "Unary arithmetic requires a number");
      return result({ kind: "unary", operator, operand }, operator === "!" ? BOOL : operand.type);
    }
    if (ts.isConditionalExpression(node)) {
      const condition = build(node.condition, BOOL, ctx); requireType(condition, BOOL, ctx);
      let consequent = build(node.whenTrue, wanted, narrowed(ctx, condition, true));
      let alternate = build(node.whenFalse, wanted ?? consequent.type, narrowed(ctx, condition, false));
      if (consequent.kind === "literal" && (numeric(alternate.type, ctx.mapper) || (ctx.mapper.declaration(alternate.type)?.kind === "enum" || ctx.mapper.declaration(alternate.type)?.kind === "newtype" && (ctx.mapper.declaration(alternate.type) as Extract<AotTypeDeclaration,{kind:"newtype"}>).unit === "Color"))) consequent = build(node.whenTrue, alternate.type, narrowed(ctx, condition, true));
      if (wanted?.kind === "option") { consequent = promote(consequent, wanted); alternate = promote(alternate, wanted); }
      requireType(alternate, consequent.type, ctx);
      alternate = promote(alternate, consequent.type);
      return result({ kind: "conditional", condition, consequent, alternate }, consequent.type);
    }
    if (ts.isBinaryExpression(node)) {
      const operator = ts.tokenToString(node.operatorToken.kind)!;
      if (!["+", "-", "*", "/", "%", "===", "!==", "<", "<=", ">", ">=", "&&", "||", "??"].includes(operator)) fail(here, `Operator ${operator} is outside the template subset`);
      if (operator === "&&" || operator === "||") {
        const left = build(node.left, BOOL, ctx); requireType(left, BOOL, ctx);
        const right = build(node.right, BOOL, narrowed(ctx, left, operator === "&&")); requireType(right, BOOL, ctx);
        return result({ kind: "binary", operator, left, right }, BOOL);
      }
      if (operator === "??") {
        const left = build(node.left, undefined, ctx);
        if (left.type.kind !== "option") fail(here, "The left operand of ?? must be optional");
        const right = build(node.right, left.type.value, ctx); requireType(right, left.type.value, ctx);
        return result({ kind: "binary", operator, left, right }, left.type.value);
      }
      const comparison = ["===", "!==", "<", "<=", ">", ">="].includes(operator);
      let left = build(node.left, comparison ? undefined : wanted, ctx);
      let right = build(node.right, left.type, ctx);
      if ((literalNode(node.left, ctx) || ts.isStringLiteral(node.left)) && (numeric(right.type, ctx.mapper) || (ctx.mapper.declaration(right.type)?.kind === "enum" || ctx.mapper.declaration(right.type)?.kind === "newtype" && (ctx.mapper.declaration(right.type) as Extract<AotTypeDeclaration,{kind:"newtype"}>).unit === "Color"))) left = build(node.left, right.type, ctx);
      if ((operator === "===" || operator === "!==") && (left.type.kind === "undefined" || right.type.kind === "undefined")) {
        if (left.type.kind === "undefined") [left, right] = [right, left];
        if (left.type.kind !== "option") fail(here, "undefined comparisons require an optional value");
        return result({ kind: "binary", operator, left, right }, BOOL);
      }
      requireType(right, left.type, ctx);
      if (comparison) {
        if (!displayable(left.type, ctx.mapper) || left.type.kind === "option" || left.type.kind === "undefined") fail(here, "Comparisons require numbers, strings, booleans, or enums");
        if (!["===", "!=="].includes(operator) && !numeric(left.type, ctx.mapper) && left.type.kind !== "string") fail(here, "Ordered comparisons require numbers or strings");
      } else {
        const number = numeric(left.type, ctx.mapper);
        if (!number) fail(here, "Arithmetic requires numeric operands; use a template string for string concatenation");
        if ((operator === "/" || operator === "%") && !number.name.startsWith("f")) fail(here, `Integer ${operator} is unsupported; import ${operator === "/" ? "idiv" : "imod"}()`);
      }
      return result({ kind: "binary", operator, left, right }, comparison ? BOOL : left.type);
    }
    if (ts.isCallExpression(node)) {
      if (!ts.isIdentifier(node.expression) || node.typeArguments?.length || node.arguments.some(ts.isSpreadElement)) fail(here, "Calls must name an imported view-model function or built-in");
      const name = node.expression.text;
      if (ctx.bindings.get(name)?.scope === "local") fail(here, `Loop binding ${name} is not callable`);
      const fn = ctx.functions.get(name);
      if (fn) {
        if (node.arguments.length !== fn.parameters.length) fail(here, `${name} expects ${fn.parameters.length} arguments`);
        const args = node.arguments.map((a, i) => { const e = build(a, fn.parameters[i]!.type, ctx); requireType(e, fn.parameters[i]!.type, ctx); return promote(e, fn.parameters[i]!.type); });
        if (ctx.handler) fn.handler = true; else fn.binding = true;
        return result({ kind: "call", target: "vm", name, arguments: args }, fn.returns);
      }
      const builtin = ctx.builtins.get(name);
      if (!builtin) fail(here, `Function ${name} is not imported from the view-model or std module`);
      const count = VAPOR_BUILTINS[builtin as keyof typeof VAPOR_BUILTINS].parameters.length;
      if (node.arguments.length !== count) fail(here, `${builtin} expects ${count} arguments`);
      let args: AotExpr[], returns: AotType;
      if (builtin === "len") {
        args = [build(node.arguments[0]!, undefined, ctx)];
        if (!["string", "array"].includes(args[0]!.type.kind)) fail(here, "len() accepts a string or array");
        returns = I32;
      } else if (["trunc", "floor", "ceil", "round", "fixed"].includes(builtin)) {
        args = [build(node.arguments[0]!, undefined, ctx)];
        if (!numeric(args[0]!.type, ctx.mapper)?.name.startsWith("f")) fail(here, `${builtin}() expects a float`);
        returns = builtin === "fixed" ? STRING : I32;
        if (builtin === "fixed") { const digits = build(node.arguments[1]!, I32, ctx); requireType(digits, I32, ctx); args.push(digits); }
      } else {
        const nonLiteral = node.arguments.find(a => !literalNode(a, ctx));
        const base = nonLiteral ? build(nonLiteral, wanted, ctx).type : wanted;
        args = node.arguments.map(a => build(a, base, ctx)); returns = args[0]!.type;
        const number = numeric(returns, ctx.mapper);
        if (!number || ["idiv", "imod"].includes(builtin) && number.name.startsWith("f")) fail(here, `${builtin}() requires ${["idiv", "imod"].includes(builtin) ? "integer" : "numeric"} operands`);
        args.forEach(a => requireType(a, returns, ctx));
      }
      return result({ kind: "call", target: "builtin", name: builtin, arguments: args }, returns);
    }
    if (ts.isNoSubstitutionTemplateLiteral(node)) return literal(node.text, wanted, here, ctx);
    if (ts.isTemplateExpression(node)) {
      if (!node.head.text.isWellFormed() || node.templateSpans.some(span => !span.literal.text.isWellFormed())) fail(here, "String literals cannot contain unpaired UTF-16 surrogates");
      const parts: (string | AotExpr)[] = [node.head.text];
      for (const span of node.templateSpans) {
        const value = build(span.expression, undefined, ctx);
        if (!displayable(value.type, ctx.mapper)) fail(at(span.expression), "Template strings can only display scalar values");
        parts.push(value, span.literal.text);
      }
      return result({ kind: "template", parts }, STRING);
    }
    fail(here, `Unsupported template expression ${ts.SyntaxKind[node.kind]}`);
  }
  const value = build(statement.expression.expression, expected);
  return expected ? promote(value, expected) : value;
}
function literalNode(node: ts.Expression, ctx: ExpressionContext): boolean {
  return ts.isParenthesizedExpression(node) && literalNode(node.expression, ctx) || ts.isNumericLiteral(node) || ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand) || ts.isIdentifier(node) && ctx.bindings.get(node.text)?.constant !== undefined;
}
function literal(value: string | number | boolean, expected: AotType | undefined, loc: SourceLocation, ctx: ExpressionContext, rawNumber?: string): AotExpr {
  if (typeof value === "string" && !value.isWellFormed()) fail(loc, "String literals cannot contain unpaired UTF-16 surrogates");
  const actual = expected?.kind === "option" ? expected.value : expected;
  let type: AotType = typeof value === "number" ? F64 : typeof value === "string" ? STRING : BOOL;
  if (actual) {
    const number = numeric(actual, ctx.mapper), d = ctx.mapper.declaration(actual);
    if (typeof value === "string" && d?.kind === "newtype" && d.unit === "Color") {
      try { parseVaporColor(value); } catch { fail(loc, "Color literals use #rgb, #rgba, #rrggbb, or #rrggbbaa"); }
      type = actual;
    } else if (typeof value === "number" && number) {
      if ((!Number.isInteger(value) || rawNumber !== undefined && exactIntegerLiteral(rawNumber) === undefined) && !number.name.startsWith("f")) fail(loc, `Fractional literals cannot adopt ${number.name}`);
      if (!number.name.startsWith("f")) {
        if (!Number.isFinite(value)) fail(loc, `Literal is outside ${number.name} range`);
        const integer = rawNumber !== undefined ? BigInt(exactIntegerLiteral(rawNumber)!) : BigInt(value);
        const unsigned = number.name.startsWith("u"), bits = BigInt(number.name === "usize" ? 64 : Number(number.name.slice(1)));
        const minimum = unsigned ? 0n : -(1n << (bits - 1n)), maximum = (1n << (unsigned ? bits : bits - 1n)) - 1n;
        if (integer < minimum || integer > maximum) fail(loc, `Literal ${rawNumber ?? value} is outside ${number.name} range`);
      } else if (number.name === "f32" && Math.abs(value) > 3.4028234663852886e38) fail(loc, `Literal ${rawNumber ?? value} is outside f32 range`);
      type = actual;
    } else if (typeof value === "string" && d?.kind === "enum") {
      if (!d.variants.includes(value)) fail(loc, `${JSON.stringify(value)} is not a ${d.name} literal`);
      type = actual;
    } else if (d?.kind === "newtype" && sameType(type, d.base)) type = actual;
  }
  if (typeof value === "number" && !Number.isFinite(value)) fail(loc, "Numeric literal is outside the finite f64 range");
  return { kind: "literal", value, type, loc, ...(rawNumber !== undefined ? { rawNumber } : {}) };
}
export function requireType(expr: AotExpr, expected: AotType, ctx: ExpressionContext): void {
  if (sameType(expr.type, expected)) return;
  if (expected.kind === "option" && (expr.type.kind === "undefined" || sameType(expr.type, expected.value))) return;
  fail(expr.loc, `Type mismatch: expected ${describe(expected)}, received ${describe(expr.type)}`);
}
export function describe(type: AotType): string {
  if (type.kind === "number" || type.kind === "named") return type.name;
  if (type.kind === "option") return `${describe(type.value)} | undefined`;
  if (type.kind === "array") return `${describe(type.element)}[]`;
  if (type.kind === "tuple") return `[${type.elements.map(describe).join(", ")}]`;
  return type.kind;
}

/** Optional contract positions own the conversion, so downstream lowering never infers it. */
function promote(value: AotExpr, expected: AotType): AotExpr {
  if (expected.kind === "option" && sameType(value.type, expected.value)) return { kind: "cast", value, type: expected, loc: value.loc };
  return value;
}
