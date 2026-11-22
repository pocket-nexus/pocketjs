/** Explicit graph admission and contract-shaped previews for Solid AOT apps. */
import ts from "typescript";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { analyzeSolidAot, getSolidAotDependencyVersions } from "./aot-solid-frontend.ts";
import { checkAotVersion, type AotProgram, type AotComponent } from "./aot-ir.ts";
import { defaultValue } from "./aot-browser.ts";
import { modelConfiguration } from "./aot-model-config.ts";

const graphs = new Map<string, { animation: string; versions: [string, number, number][]; programs: AotProgram[] }>();
const read = (file: string, sources?: ReadonlyMap<string, string>) => sources?.get(file) ?? readFileSync(file, "utf8");

/** The application entry may be a mount module; every imported TSX component is checked.
 *  Class literals bake with the theme and tick rate registered for the entry's
 *  application (aot-model-config.ts), the values `pocket compile --aot` uses. */
export function checkSolidAotGraph(entry: string, options: { sources?: ReadonlyMap<string, string>; strict?: boolean } = {}): AotProgram[] {
  entry = resolve(entry);
  const { theme, tickHz } = modelConfiguration(entry), animation = JSON.stringify({ theme, tickHz });
  const prior = graphs.get(entry);
  if (!options.sources && !options.strict && prior?.animation === animation && prior.versions.every(([file, mtime, size]) => {
    try { const current = statSync(file); return current.mtimeMs === mtime && current.size === size; } catch { return mtime === -1; }
  })) return prior.programs;
  const visited = new Set<string>(), roots: string[] = [];
  function visit(file: string): void {
    if (visited.has(file)) return;
    visited.add(file);
    const source = read(file, options.sources), ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const forwardsImport = (statement: ts.Statement): boolean => ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression) && ast.statements.some(imported => ts.isImportDeclaration(imported) && imported.importClause?.name?.text === (statement.expression as ts.Identifier).text);
    if (file.endsWith(".tsx") && (file !== entry || ast.statements.some(statement => ts.isExportAssignment(statement) && !forwardsImport(statement) || ts.isFunctionDeclaration(statement) && statement.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)))) { roots.push(file); return; }
    for (const statement of ast.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.isTypeOnly) continue;
      const specifier = statement.moduleSpecifier.text;
      if (!specifier.startsWith(".")) continue;
      const path = resolve(dirname(file), specifier);
      const child = [path, path + ".tsx", path + ".ts"].find(candidate => /\.tsx?$/.test(candidate) && (options.sources?.has(candidate) || existsSync(candidate)));
      if (child) visit(child);
    }
  }
  visit(entry);
  if (!roots.length) throw new Error(`Solid AOT: no default-exported TSX component is reachable from ${entry}`);
  const programs: AotProgram[] = [];
  for (const file of roots) if (!programs.some(program => program.components.some(component => component.file === file))) programs.push(analyzeSolidAot(file, { ...options, theme, tickHz }));
  const dependencies = new Set(visited);
  for (const program of programs) for (const component of program.components) {
    dependencies.add(component.file);
    const base = component.file.slice(0, -4);
    for (const extension of [".ts", ".d.ts"]) if (existsSync(base + extension)) dependencies.add(base + extension);
    // Imported contract types can alter admission without changing the TSX.
    function collect(file: string): void {
      const ast = ts.createSourceFile(file, read(file, options.sources), ts.ScriptTarget.Latest, true);
      for (const statement of ast.statements) {
        if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
        const module = statement.moduleSpecifier;
        if (!module || !ts.isStringLiteral(module) || !module.text.startsWith(".")) continue;
        const base = resolve(dirname(file), module.text);
        const child = [base, base + ".ts", base + ".d.ts", base + "/index.ts"].find(p => existsSync(p) && statSync(p).isFile());
        if (child && !dependencies.has(child)) { dependencies.add(child); collect(child); }
      }
    }
    for (const extension of [".ts", ".d.ts"]) if (existsSync(base + extension)) collect(base + extension);
  }
  for (const program of programs) for (const version of getSolidAotDependencyVersions(program)) dependencies.add(version.file);
  const config = ts.findConfigFile(dirname(entry), ts.sys.fileExists, "tsconfig.json");
  if (config) dependencies.add(config);
  const versions: [string, number, number][] = [];
  for (const program of programs) for (const component of program.components) {
    for (const extension of [".ts", ".d.ts"]) {
      const file = component.file.slice(0, -4) + extension;
      if (!existsSync(file)) versions.push([file, -1, -1]);
    }
  }
  for (const file of dependencies) if (existsSync(file)) { const s = statSync(file); versions.push([file, s.mtimeMs, s.size]); }
  if (!options.sources) graphs.set(entry, { animation, versions, programs });
  return programs;
}

/** Basename imports alone never opt ordinary Solid applications into AOT: the
 *  application a file belongs to (aot-model-config.ts) selects it. */
export function getSolidAotProgram(filename: string, source?: string, buildEntry?: string): AotProgram | undefined {
  filename = resolve(filename);
  const app = modelConfiguration(filename);
  if (!app.directory || app.framework !== "solid" || app.aot !== true) return;
  if (!app.entry) throw new Error(`Solid AOT: the application at ${app.directory} registers no entry`);
  const entry = buildEntry && modelConfiguration(buildEntry).aot ? resolve(buildEntry) : app.entry;
  if (!existsSync(entry)) throw new Error(`Solid AOT: cannot resolve the application entry ${entry}`);
  const override = source !== undefined && source !== readFileSync(filename, "utf8") ? new Map([[filename, source]]) : undefined;
  const programs = checkSolidAotGraph(entry, { sources: override });
  return programs.find(program => program.components.some(component => component.file === filename));
}

/** Signals are preview defaults, never replacements for the application's business logic. */
export function generateSolidAotMock(program: AotProgram, component: AotComponent): string {
  checkAotVersion(program);
  const lines = ['import { createSignal, createContext } from "solid-js";'];
  const exports = new Map<string, string>();
  for (const value of component.values) {
    const local = `__value${exports.size}`, setter = `set${value.sourceName[0]!.toUpperCase()}${value.sourceName.slice(1)}`;
    lines.push(`const [${local}, ${local}Set] = createSignal(${defaultValue(value.type, program)});`);
    exports.set(value.sourceName, local); exports.set(setter, `${local}Set`);
  }
  for (const fn of component.functions) exports.set(fn.sourceName, fn.optional ? "undefined" : `() => (${defaultValue(fn.returns, program)})`);
  for (const constant of component.constants) exports.set(constant.sourceName ?? constant.name, JSON.stringify(constant.value));
  const contexts = (component.provides ?? []).map(provided => `export const ${provided.key} = createContext();`);
  if (component.factory) {
    return [lines[0], ...contexts].join("\n") + `\nexport function ${component.factory.sourceName}() {\n${lines.slice(1).join("\n")}\nreturn { ${[...exports].map(([name, value]) => `${JSON.stringify(name)}: ${value}`).join(", ")} };\n}\n`;
  }
  lines.splice(1, 0, ...contexts);
  for (const [name, value] of exports) lines.push(`export const ${name} = ${value};`);
  return lines.join("\n") + "\n";
}

export function resolveSolidAotMock(importer: string, specifier: string, entry?: string): string | undefined {
  if (!importer.endsWith(".tsx")) return;
  const program = getSolidAotProgram(importer, undefined, entry);
  if (!program) return;
  const module = resolve(dirname(importer), specifier);
  if (!existsSync(module + ".d.ts") || existsSync(module + ".ts")) return;
  const component = program.components.find(c => resolve(dirname(c.file), basename(c.file, ".tsx")).toLowerCase() === module.toLowerCase());
  if (component) return generateSolidAotMock(program, component);
}

/** Prefer the model module over the homonymous TSX view in both build passes. */
export function resolveSolidAotModel(importer: string, specifier: string, entry?: string): string | undefined {
  if (!importer.endsWith(".tsx") || !specifier.startsWith(".") || /\.[^/]+$/.test(specifier)) return;
  const program = getSolidAotProgram(importer, undefined, entry);
  if (!program) return;
  const base = resolve(dirname(importer), specifier);
  if (!program.components.some(component => component.file.slice(0, -4).toLowerCase() === base.toLowerCase())) return;
  return existsSync(base + ".ts") ? realpathSync(base + ".ts") : existsSync(base + ".d.ts") ? realpathSync(base + ".d.ts") : undefined;
}
