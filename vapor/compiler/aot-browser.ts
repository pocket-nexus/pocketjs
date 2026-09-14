/** Admission and declaration-only view models shared by browser and guest builds. */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parse } from "@vue/compiler-sfc";
import { parse as parseTemplate, NodeTypes, type ElementNode } from "@vue/compiler-dom";
import ts from "typescript";
import { analyzeVueAot } from "./aot-frontend.ts";
import type { AotComponent, AotProgram, AotType } from "./aot-ir.ts";

/** Legacy Vapor SFCs keep their existing pipeline while the C family migrates. */
export function hasVueAotContract(source: string, filename: string): boolean {
  const script = parse(source, { filename }).descriptor.scriptSetup;
  if (!script) return false;
  const moduleName = `./${basename(filename, ".vue")}`;
  const file = ts.createSourceFile(filename + ".ts", script.content, ts.ScriptTarget.Latest, true);
  return file.statements.some(statement => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text.toLowerCase() !== moduleName.toLowerCase()) return false;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) return false;
    return !!clause.name || !!clause.namedBindings && (ts.isNamespaceImport(clause.namedBindings) ||
      clause.namedBindings.elements.some(element => !element.isTypeOnly));
  });
}

export function checkVueAotSource(source: string, filename: string, strict = false): AotProgram {
  const program = analyzeVueAot(resolve(filename), { source, strict });
  for (const diagnostic of program.diagnostics) {
    if (diagnostic.severity === "warning") {
      console.warn(`${diagnostic.file}:${diagnostic.line}:${diagnostic.column}: warning: ${diagnostic.message}`);
    }
  }
  return program;
}

/** Materialize merged class leaves before the browser build collects style literals. */
export function normalizeVueAotClasses(source: string, filename: string): string {
  const descriptor = parse(source, { filename }).descriptor;
  if (!descriptor.template || !descriptor.scriptSetup) return source;
  const script = ts.createSourceFile(filename + ".ts", descriptor.scriptSetup.content, ts.ScriptTarget.Latest, true);
  const hosts = new Set<string>();
  for (const statement of script.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "@pocketjs/framework/vue-vapor/components") continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
      if (["View", "Text", "Image"].includes(binding.propertyName?.text ?? binding.name.text)) hosts.add(binding.name.text);
    }
  }
  const root = parseTemplate(descriptor.template.content);
  const edits: { start: number; end: number; text: string }[] = [];
  const offset = descriptor.template.loc.start.offset;
  const printer = ts.createPrinter({ removeComments: true });
  const escapeAttribute = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  function visit(node: ElementNode) {
    if (hosts.has(node.tag)) {
      const fixed = node.props.find(p => p.type === NodeTypes.ATTRIBUTE && p.name === "class");
      const dynamic = node.props.find(p => p.type === NodeTypes.DIRECTIVE && p.name === "bind" &&
        p.arg?.type === NodeTypes.SIMPLE_EXPRESSION && p.arg.content === "class");
      if (fixed?.type === NodeTypes.ATTRIBUTE && fixed.value && dynamic?.type === NodeTypes.DIRECTIVE && dynamic.exp?.type === NodeTypes.SIMPLE_EXPRESSION) {
        const prefix = fixed.value.content;
        const file = ts.createSourceFile("class.ts", `(${dynamic.exp.content})`, ts.ScriptTarget.Latest, true);
        const statement = file.statements[0];
        function merge(expression: ts.Expression): ts.Expression | undefined {
          if (ts.isParenthesizedExpression(expression)) return merge(expression.expression);
          if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
            return ts.factory.createStringLiteral(`${prefix} ${expression.text}`.trim());
          }
          if (ts.isConditionalExpression(expression)) {
            const yes = merge(expression.whenTrue), no = merge(expression.whenFalse);
            if (yes && no) return ts.factory.updateConditionalExpression(expression, expression.condition, expression.questionToken, yes, expression.colonToken, no);
          }
        }
        if (statement && ts.isExpressionStatement(statement) && ts.isParenthesizedExpression(statement.expression) && ts.isConditionalExpression(statement.expression.expression)) {
          const merged = merge(statement.expression.expression);
          if (merged) {
            edits.push({ start: offset + fixed.loc.start.offset, end: offset + fixed.loc.end.offset, text: "" });
            edits.push({ start: offset + dynamic.loc.start.offset, end: offset + dynamic.loc.end.offset,
              text: `:class="${escapeAttribute(printer.printNode(ts.EmitHint.Expression, merged, file))}"` });
          }
        }
      }
    }
    for (const child of node.children) if (child.type === NodeTypes.ELEMENT) visit(child);
  }
  for (const child of root.children) if (child.type === NodeTypes.ELEMENT) visit(child);
  for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return source;
}

function defaultValue(type: AotType, program: AotProgram, seen = new Set<string>()): string {
  switch (type.kind) {
    case "number": return "0";
    case "string": return '""';
    case "boolean": return "false";
    case "void": case "undefined": case "option": return "undefined";
    case "array": return "[]";
    case "tuple": return `[${type.elements.map(t => defaultValue(t, program, seen)).join(", ")}]`;
    case "named": {
      if (seen.has(type.name)) throw new Error(`Vue AOT: recursive default for ${type.name}`);
      const next = new Set(seen).add(type.name);
      const declaration = program.types.find(d => d.name === type.name);
      if (!declaration) throw new Error(`Vue AOT: missing declaration ${type.name}`);
      switch (declaration.kind) {
        case "enum": return JSON.stringify(declaration.variants[0]);
        case "newtype": return defaultValue(declaration.base, program, next);
        case "struct": return `{ ${declaration.fields.map(f => `${JSON.stringify(f.name)}: ${defaultValue(f.type, program, next)}`).join(", ")} }`;
        case "union": {
          const variant = declaration.variants[0]!;
          return `{ ${JSON.stringify(declaration.discriminant)}: ${JSON.stringify(variant.name)}, ${variant.fields.map(f => `${JSON.stringify(f.name)}: ${defaultValue(f.type, program, next)}`).join(", ")} }`;
        }
      }
    }
  }
}

/** A declaration-only app receives Vue refs with contract-shaped defaults. */
export function generateVueAotMock(program: AotProgram, component: AotComponent): string {
  const lines = ['import { ref } from "vue";'];
  const exported = new Set<string>();
  for (const value of component.values) {
    if (exported.has(value.sourceName)) continue;
    exported.add(value.sourceName);
    lines.push(`export const ${value.sourceName} = ref(${defaultValue(value.type, program)});`);
  }
  for (const fn of component.functions) {
    if (exported.has(fn.sourceName)) continue;
    exported.add(fn.sourceName);
    lines.push(`export function ${fn.sourceName}() { return ${defaultValue(fn.returns, program)}; }`);
  }
  for (const constant of component.constants) {
    const name = constant.sourceName ?? constant.name;
    if (exported.has(name)) continue;
    exported.add(name);
    lines.push(`export const ${name} = ${JSON.stringify(constant.value)};`);
  }
  return lines.join("\n") + "\n";
}

/** Resolve only the extensionless basename contract imported by its root SFC. */
export function resolveVueAotMock(importer: string, specifier: string): string | undefined {
  if (!importer.endsWith(".vue") || specifier.toLowerCase() !== `./${basename(importer, ".vue")}`.toLowerCase()) return;
  const module = resolve(dirname(importer), specifier);
  if (!existsSync(module + ".d.ts") || existsSync(module + ".ts")) return;
  const source = readFileSync(importer, "utf8");
  const program = checkVueAotSource(source, importer);
  const root = program.components.find(c => c.name === program.root)!;
  return generateVueAotMock(program, root);
}
