/** Manifest selection is explicit: compiled admission never falls back to a Rust model. */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import ts from "typescript";
import { attachAotModel, type AotProgram } from "./aot-ir.ts";
import { analyzeModel } from "./aot-model-frontend.ts";
import { generateModelJavaScript } from "./aot-model-js.ts";
import { analyzeVueAot } from "./aot-frontend.ts";
import { checkSolidAotGraph } from "./aot-solid-browser.ts";
import { validateViewModelBindings } from "./aot-model-view.ts";

import { modelConfiguration } from "./aot-model-config.ts";
export { modelConfiguration } from "./aot-model-config.ts";

/** Find SFC roots imported by the selected Vue mount module. */
function vueEntries(entry: string, sources: ReadonlyMap<string, string>): string[] {
  const visited = new Set<string>(), roots: string[] = [];
  function visit(file: string): void {
    if (visited.has(file)) return;
    visited.add(file);
    if (file.endsWith(".vue")) { roots.push(file); return; }
    const source = sources.get(file) ?? readFileSync(file, "utf8");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    for (const statement of ast.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      if (ts.isImportDeclaration(statement) ? statement.importClause?.isTypeOnly : statement.isTypeOnly) continue;
      const module = statement.moduleSpecifier;
      if (!module || !ts.isStringLiteral(module) || !module.text.startsWith(".")) continue;
      const path = resolve(dirname(file), module.text);
      const child = [path, path + ".ts", path + ".tsx", path + ".vue", resolve(path, "index.ts")]
        .find(candidate => /\.(?:tsx?|vue)$/.test(candidate) && (sources.has(candidate) || existsSync(candidate)));
      if (child) visit(existsSync(child) ? realpathSync(child) : child);
    }
  }
  visit(entry);
  if (!roots.length) throw new Error(`Model AOT: no SFC is reachable from ${entry}`);
  return roots;
}

export function attachCompiledModel(program: AotProgram, entry: string, strict = false, sources?: ReadonlyMap<string, string>): AotProgram {
  const config = modelConfiguration(entry);
  if (config.mode !== "compiled") return program;
  const rootPath = entry.replace(/\.(tsx|vue)$/, ".ts");
  const root = existsSync(rootPath) ? realpathSync(rootPath) : rootPath;
  const model = program.model ?? analyzeModel(root, { strict, sources, name: program.root, recursionLimit: config.recursionLimit,
    componentNames: program.components.map(component => component.name),
    factories: program.components.filter(c => c.factory).map(c => {
      const path = resolve(dirname(c.file), c.factory!.module);
      return path.endsWith(".ts") ? path : path + ".ts";
    }),
    framework: entry.endsWith(".vue") ? "vue" : "solid",
  });
  attachAotModel(program, model);
  const existing = new Set(program.diagnostics.map(diagnostic => JSON.stringify(diagnostic)));
  for (const diagnostic of model.diagnostics) if (!existing.has(JSON.stringify(diagnostic))) program.diagnostics.push(diagnostic);
  for (const component of program.components) {
    let factoryFile = component.factory && resolve(dirname(component.file), component.factory.module);
    if (factoryFile && !factoryFile.endsWith(".ts")) factoryFile += ".ts";
    if (factoryFile && existsSync(factoryFile)) factoryFile = realpathSync(factoryFile);
    const region = model.modules.find(module => module.kind !== "pure" && (component.root ? module.kind === "root" : module.file === factoryFile));
    if (!region) continue;
    region.name = component.name;
    for (const value of component.values) if (region.memos.some(memo => memo.name === value.sourceName)) value.memo = true;
  }
  validateViewModelBindings(program);
  return program;
}

/** Called before the JSX/cache pass for every TS model in a compiled application. */
export function transformCompiledModel(source: string, filename: string, buildEntry?: string): string | undefined {
  if (!filename.endsWith(".ts") || filename.endsWith(".d.ts") || filename.includes("/node_modules/")) return;
  if (existsSync(filename)) filename = realpathSync(filename);
  const config = modelConfiguration(filename);
  if (config.mode !== "compiled") return;
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const sources = new Map([[resolve(filename), source]]);
  const extension = config.framework === "vue-vapor" ? ".vue" : ".tsx";
  const conventional = ["app", "App", basename(config.directory!)].map(name => resolve(config.directory!, name + extension)).find(existsSync);
  const configured = config.entry && [resolve(config.directory!, config.entry), resolve(import.meta.dir, "../..", config.entry)].find(existsSync);
  // An AOT presentation selects the mount graph. An ordinary guest can import
  // a compiled component without admitting its own host callbacks as AOT.
  const selected = buildEntry && modelConfiguration(buildEntry).aot ? resolve(buildEntry) : conventional ?? configured;
  const entry = selected && realpathSync(selected);
  if (!entry) throw new Error(`Model AOT: cannot find a view entry under ${config.directory}`);
  const views = extension === ".vue"
    ? vueEntries(entry, sources).map(root => analyzeVueAot(root, { sources }))
    : checkSolidAotGraph(entry, { sources });
  const programs = views.map(view => attachCompiledModel(view, view.components.find(component => component.root)!.file, false, sources).model!);
  const program = programs.find(program => program.modules.some(module => module.file === resolve(filename)));
  const module = program?.modules.find(module => module.file === resolve(filename));
  if (!program || !module || module.kind === "pure") return;
  const reservedNames: string[] = [];
  const names = (node: ts.Node): void => { if (ts.isIdentifier(node)) reservedNames.push(node.text); ts.forEachChild(node, names); };
  names(ast);
  let output = generateModelJavaScript(program, module, { vue: config.framework === "vue-vapor", development: process.env.NODE_ENV !== "production", reservedNames });
  output = ast.statements.filter(ts.isEnumDeclaration).map(statement => statement.getText(ast)).join("\n") + "\n" + output;
  // Context keys belong to the view contract and preserve their source module identity.
  const contextImports = new Set<string>();
  for (const statement of ast.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === "solid-js" && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
    for (const binding of statement.importClause.namedBindings.elements) if ((binding.propertyName ?? binding.name).text === "createContext") contextImports.add(binding.name.text);
  }
  const contexts = ast.statements.flatMap(statement => ts.isVariableStatement(statement) ? statement.declarationList.declarations.flatMap(declaration => declaration.initializer && ts.isCallExpression(declaration.initializer) && ts.isIdentifier(declaration.initializer.expression) && contextImports.has(declaration.initializer.expression.text)
    ? [`${statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ? "export " : ""}const ${declaration.getText(ast)};`] : []) : []);
  if (contexts.length) output = `import {${[...contextImports].map(name => `createContext as ${name}`).join(",")}} from "solid-js";\n` + contexts.join("\n") + "\n" + output;
  if (program.modules.some(m => m.functions.some(f => JSON.stringify(f.body).includes('@pocketjs/framework/net/model')))) output = 'import "@pocketjs/framework/net/model";\n' + output;
  return output;
}
