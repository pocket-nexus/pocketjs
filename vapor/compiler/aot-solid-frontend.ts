/** Solid TSX admission. Component bodies are a view DSL; model implementations stay in TypeScript or Rust. */
import ts from "typescript";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { BTN } from "../../contracts/spec/spec.ts";
import { VAPOR_BUILTINS, VAPOR_RELATIVE_AXES, VAPOR_STYLE_PROPS } from "../../contracts/spec/vapor.ts";
import { BOOL, I32, STRING, sameType, type AotComponent, type AotEvent, type AotExpr, type AotHandler, type AotNode, type AotProgram, type AotType, type SourceLocation } from "./aot-ir.ts";
import { createTypeEnvironment, fail, location, typeName, TypeMapper } from "./aot-types.ts";
import { displayable, expression, narrowed, numeric, requireType, type ExpressionContext } from "./aot-expressions.ts";
import { addAotContractBinding, solidTypeAlias } from "./aot-contract.ts";
import { finalizeAotProgram } from "./aot-program.ts";
import { inferGenericArgument, inferGenericSource, preservesGenericStorage, satisfiesGenericConstraint, satisfiesGenericSourceConstraint, constraintNeedsSource, type GenericSourceArguments } from "./aot-generics.ts";
import { hasJsxEntity, JSX_ENTITY_DIAGNOSTIC, normalizeJsxText } from "./aot-jsx-text.ts";

const COMPONENTS = "@pocketjs/framework/solid/components", STD = "@pocketjs/framework/solid/std", INPUT = "@pocketjs/framework/input", LIFECYCLE = "@pocketjs/framework/solid/lifecycle";
const SOLID = new Set(["Show", "Switch", "Match", "useContext", "mergeProps", "createMemo"]);
const HOSTS = new Set(["View", "Text", "Image", "ActionHandler", "AxisHandler", "For"]);
const outside = "Only the factory call, context reads, derived expressions and the JSX return are allowed";
type Jsx = ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment;
interface Import { name: string; sourceName: string; module: string; node: ts.ImportSpecifier }
interface Parsed { file: string; source: string; script: ts.SourceFile; declaration: ts.FunctionDeclaration; name: string; imports: Map<string, Import>; children: Map<string, string> }
export interface AnalyzeSolidAotOptions { strict?: boolean; source?: string; sources?: ReadonlyMap<string, string>; root?: boolean }
export interface SolidAotDependencyVersion { file: string; mtimeMs: number; size: number }
const dependencies = new WeakMap<AotProgram, readonly SolidAotDependencyVersion[]>();
export function getSolidAotDependencyVersions(program: AotProgram): readonly SolidAotDependencyVersion[] { return dependencies.get(program) ?? []; }
const unwrap = (node: ts.Expression): ts.Expression => ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
const jsx = (node: ts.Node): node is Jsx => ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node);
const eventName = (name: string) => name[2]!.toLowerCase() + name.slice(3);
const slotName = (name: string) => name === "children" ? "default" : name;

export function analyzeSolidAot(entry: string, options: AnalyzeSolidAotOptions = {}): AotProgram {
  entry = resolve(entry);
  const files = new Map([...options.sources ?? []].map(([file, source]) => [resolve(file), source]));
  if (options.source !== undefined) files.set(entry, options.source);
  const exists = (file: string) => files.has(file) || existsSync(file);
  const parsed = new Map<string, Parsed>(), visiting = new Set<string>(), classLiterals = new Set<string>();
  function collect(file: string): Parsed {
    if (visiting.has(file)) fail(location(file, ""), "Recursive component imports are outside the view subset");
    const existing = parsed.get(file); if (existing) return existing;
    if (!exists(file)) fail(location(file, ""), `Cannot find child component ${file}`);
    visiting.add(file);
    const source = files.get(file) ?? readFileSync(file, "utf8"); files.set(file, source);
    const script = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const at = (node: ts.Node) => location(file, source, node.getStart(script));
    const errors = (script as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics;
    if (errors.length) fail(location(file, source, errors[0]!.start ?? 0), ts.flattenDiagnosticMessageText(errors[0]!.messageText, " "));
    const imports = new Map<string, Import>(), children = new Map<string, string>();
    let declaration: ts.FunctionDeclaration | undefined;
    for (const statement of script.statements) {
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        if (!clause || !ts.isStringLiteral(statement.moduleSpecifier)) fail(at(statement), "Side-effect imports are runtime statements");
        if (clause.isTypeOnly) continue;
        const module = statement.moduleSpecifier.text;
        if (clause.name) {
          if (!module.endsWith(".tsx")) fail(at(statement), "Child component imports require the .tsx extension");
          if (!module.startsWith(".") || clause.namedBindings) fail(at(statement), "Child components require a relative default .tsx import");
          const child = resolve(dirname(file), module); children.set(clause.name.text, child); collect(child); continue;
        }
        if (!clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) fail(at(statement), "Use named imports for host primitives, built-ins, and view-model bindings");
        for (const node of clause.namedBindings.elements) {
          if (node.isTypeOnly) continue;
          const name = node.name.text, sourceName = node.propertyName?.text ?? name;
          if (module === COMPONENTS && !HOSTS.has(sourceName)) fail(at(node), `${sourceName} has no native runtime`);
          if (module === "solid-js" && !SOLID.has(sourceName)) fail(at(node), sourceName === "For" ? `Use <For each by> from ${COMPONENTS} instead of solid-js For` : "Component state and lifecycle belong to the basename module and the Rust model");
          if (module === STD && !(sourceName in VAPOR_BUILTINS)) fail(at(node), `Unknown std built-in ${sourceName}`);
          if (module === INPUT && sourceName !== "BTN") fail(at(node), "AOT input imports accept BTN");
          if (module === LIFECYCLE && !["onMount", "onCleanup"].includes(sourceName)) fail(at(node), "AOT lifecycle imports accept onMount and onCleanup");
          imports.set(name, { name, sourceName, module, node });
        }
      } else if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
        if (statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) fail(at(statement), "The only component export is one default function declaration");
      } else if (ts.isFunctionDeclaration(statement) && statement.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword) && statement.modifiers.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
        if (declaration || !statement.body || statement.asteriskToken || statement.modifiers.some(m => m.kind !== ts.SyntaxKind.ExportKeyword && m.kind !== ts.SyntaxKind.DefaultKeyword)) fail(at(statement), "A component default-exports one synchronous function declaration");
        declaration = statement;
      } else fail(at(statement), "A component contains imports, type declarations and one default-exported function declaration");
    }
    if (!declaration) fail(location(file, source), "A component default-exports one function declaration");
    if (declaration.parameters.length > 1 || declaration.parameters.some(p => !ts.isIdentifier(p.name) || !p.type || p.initializer || p.dotDotDotToken || p.questionToken || p.modifiers?.length)) fail(at(declaration), "A component accepts one props parameter with an object type annotation, without a default");
    const item = { file, source, script, declaration, name: typeName(basename(file, ".tsx")), imports, children };
    parsed.set(file, item); visiting.delete(file); return item;
  }
  const root = collect(entry), usedNames = new Set<string>();
  for (const item of parsed.values()) { const base = item.name; let suffix = 2; while (usedNames.has(item.name)) item.name = base + suffix++; usedNames.add(item.name); }
  const environment = createTypeEnvironment(files, entry), checker = environment.checker;
  const mapper = new TypeMapper(checker, options.strict, [...parsed.values()].map(i => i.name), environment.locationOf);
  const components: AotComponent[] = [], byFile = new Map<string, AotComponent>(), specializations = new Map<string, AotComponent>(), requiredSlots = new Map<string, Set<string>>();
  const checked = (item: Parsed, node: ts.Node) => {
    const mapped = environment.nodeAt(item.file, node.getStart(item.script), node.getWidth(item.script));
    if (!mapped) fail(location(item.file, item.source, node.getStart(item.script)), "Cannot resolve the TypeScript contract declaration");
    return checker.getTypeAtLocation(mapped);
  };
  const rootModule = resolve(dirname(entry), basename(entry, ".tsx")).toLowerCase();
  function moduleSource(item: Parsed, imported: Import): string {
    const path = resolve(dirname(item.file), imported.module);
    if (!imported.module.startsWith(".") || /\.(?:ts|tsx)$/.test(imported.module)) fail(location(item.file, item.source, imported.node.getStart()), "The view-model import must use the component basename without an extension");
    if (exists(path + ".ts") && exists(path + ".d.ts")) fail(location(item.file, item.source, imported.node.getStart()), "A view-model cannot have both .ts and .d.ts forms");
    if (!exists(path + ".ts") && !exists(path + ".d.ts")) fail(location(item.file, item.source, imported.node.getStart()), `Cannot find ${imported.module}.ts or ${imported.module}.d.ts`);
    return path;
  }
  function analyze(item: Parsed, args = new Map<string, AotType>(), instanceName = item.name, sourceArguments: GenericSourceArguments = new Map()): AotComponent {
    if (!item.declaration.typeParameters?.length && byFile.has(item.file)) return byFile.get(item.file)!;
    return mapper.withTypeArguments(args, () => {
      const loc = (node: ts.Node): SourceLocation => location(item.file, item.source, node.getStart(item.script));
      const component: AotComponent = { name: instanceName, file: item.file, root: item.file === entry && options.root !== false, props: [], events: [], slots: [], values: [], functions: [], constants: [], children: [], nodes: [], nodeCount: 0, memoCount: 0, handlerCount: 0 };
      requiredSlots.set(instanceName, new Set());
      const context: ExpressionContext = { file: item.file, mapper, environment, bindings: new Map(), functions: new Map(), builtins: new Map(), narrowings: new Map(), handler: false };
      const setters = new Map<string, string>(), contexts = new Map<string, { key: string; type: ts.Type }>(), derived = new Map<string, ts.Expression>(), models = new Map<string, Import>();
      const sameReference = (node: ts.Identifier, declaration: ts.Identifier): boolean => {
        const use = environment.nodeAt(item.file, node.getStart(item.script), node.getWidth(item.script));
        const imported = environment.nodeAt(item.file, declaration.getStart(item.script), declaration.getWidth(item.script));
        return !!use && !!imported && !!checker.getSymbolAtLocation(use) && checker.getSymbolAtLocation(use) === checker.getSymbolAtLocation(imported);
      };
      const imported = (node: ts.Expression, module: string, name?: string): boolean => {
        if (!ts.isIdentifier(node)) return false;
        const binding = item.imports.get(node.text);
        return !!binding && binding.module === module && (!name || binding.sourceName === name) && sameReference(node, binding.node.name);
      };
      const rawProps = item.declaration.parameters[0];
      if (rawProps) context.propsName = (rawProps.name as ts.Identifier).text;
      function isJsxType(node: ts.Node | undefined, seen = new Set<ts.Node>()): boolean {
        if (!node || seen.has(node)) return false; seen.add(node);
        if (ts.isUnionTypeNode(node)) return node.types.some(t => isJsxType(t, seen));
        if (ts.isParenthesizedTypeNode(node)) return isJsxType(node.type, seen);
        if (!ts.isTypeReferenceNode(node)) return false;
        let symbol = checker.getSymbolAtLocation(node.typeName);
        if (symbol?.flags && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        if (symbol?.name === "Element" && symbol.declarations?.some(d => /solid-js\//.test(d.getSourceFile().fileName))) return true;
        return !!symbol?.declarations?.some(d => ts.isTypeAliasDeclaration(d) && isJsxType(d.type, seen));
      }
      if (rawProps) {
        const type = checked(item, rawProps.type!);
        if (!(type.flags & ts.TypeFlags.Object) || type.getCallSignatures().length || checker.getIndexInfosOfType(type).length) fail(loc(rawProps), "The props parameter requires an object type");
        for (const property of type.getProperties()) {
          const declaration = property.valueDeclaration ?? property.declarations?.[0];
          if (!declaration || !ts.isPropertySignature(declaration) || !declaration.type) fail(loc(rawProps), "Props use named property signatures");
          const name = property.name, raw = checker.getTypeOfSymbolAtLocation(property, declaration), nonnullable = checker.getNonNullableType(raw);
          const signatures = nonnullable.getCallSignatures();
          if (isJsxType(declaration.type)) { component.slots.push(slotName(name)); (component.slotProps ??= []).push({ name: slotName(name), parameters: [] }); }
          else if (signatures.length && isJsxType(signatures[0]!.declaration?.type)) {
            const signature = signatures[0];
            if (signatures.length !== 1 || !signature || signature.typeParameters?.length || signature.parameters.length !== 1) fail(loc(rawProps), "A scoped slot takes one props object and returns JSX.Element");
            const parameter = signature.parameters[0]!, at = parameter.valueDeclaration ?? parameter.declarations![0]!;
            const fields = checker.getTypeOfSymbolAtLocation(parameter, at).getProperties().map(field => {
              const declaration = field.valueDeclaration ?? field.declarations![0]!, raw = checker.getTypeOfSymbolAtLocation(field, declaration), access = solidTypeAlias(raw, "Accessor", checker);
              if (!access) fail(environment.locationOf(declaration), "Scoped-slot values cross the boundary as Accessor<T>");
              return { name: field.name, type: mapper.map(access, environment.locationOf(declaration), `${component.name}${typeName(name)}${typeName(field.name)}`) };
            });
            component.slots.push(slotName(name)); (component.slotProps ??= []).push({ name: slotName(name), parameters: fields });
          } else if (/^on[A-Z]/.test(name)) {
            if (signatures.length !== 1 || signatures[0]!.typeParameters?.length || !(signatures[0]!.getReturnType().flags & ts.TypeFlags.Void)) fail(environment.locationOf(declaration), "Callback props have one non-generic signature returning void");
            component.events.push({ name: eventName(name), ...(property.flags & ts.SymbolFlags.Optional ? { optional: true } : {}), parameters: signatures[0]!.parameters.map(parameter => {
              const declaration = parameter.valueDeclaration ?? parameter.declarations![0]!;
              if (!ts.isParameter(declaration) || declaration.questionToken || declaration.initializer || declaration.dotDotDotToken) fail(environment.locationOf(declaration), "Callback payloads are required parameters");
              return { name: parameter.name, type: mapper.map(checker.getTypeOfSymbolAtLocation(parameter, declaration), environment.locationOf(declaration), `${component.name}${typeName(name)}${typeName(parameter.name)}`) };
            }) });
          } else component.props.push({ name, type: mapper.map(raw, environment.locationOf(declaration), `${component.name}${typeName(name)}`) });
          if (component.slots.includes(slotName(name)) && !(property.flags & ts.SymbolFlags.Optional)) requiredSlots.get(instanceName)!.add(slotName(name));
        }
      }
      const statements = item.declaration.body!.statements;
      const factoryNames = new Set(statements.flatMap(s => ts.isVariableStatement(s) ? s.declarationList.declarations.flatMap(d => ts.isObjectBindingPattern(d.name) && d.initializer && ts.isCallExpression(d.initializer) && ts.isIdentifier(d.initializer.expression) ? [d.initializer.expression.text] : []) : []));
      type ContractBinding = { name: string; sourceName: string; type: ts.Type; node: ts.Node };
      function register(bindings: ContractBinding[], pool: ContractBinding[] = bindings): void {
        for (const binding of [...bindings]) if (solidTypeAlias(binding.type, "Setter", checker)) {
          const sourceName = binding.sourceName.startsWith("set") && binding.sourceName.length > 3 ? binding.sourceName[3]!.toLowerCase() + binding.sourceName.slice(4) : "";
          if (!bindings.some(value => value.sourceName === sourceName)) {
            const accessor = pool.find(value => value.sourceName === sourceName);
            if (accessor) bindings.push({ ...accessor, name: sourceName });
          }
        }
        for (const binding of bindings) {
          const setter = solidTypeAlias(binding.type, "Setter", checker);
          if (setter) {
            const targetSource = binding.sourceName.startsWith("set") && binding.sourceName.length > 3 ? binding.sourceName[3]!.toLowerCase() + binding.sourceName.slice(4) : "";
            const target = bindings.find(b => b.sourceName === targetSource), accessor = target && solidTypeAlias(target.type, "Accessor", checker);
            if (!target || !accessor || !checker.isTypeAssignableTo(setter, accessor) || !checker.isTypeAssignableTo(accessor, setter)) fail(environment.locationOf(binding.node), `Setter ${binding.sourceName} must pair with an Accessor of the same type named ${targetSource || "after set"}`);
            setters.set(binding.name, target.name); continue;
          }
          addAotContractBinding(component, context, binding.name, binding.sourceName, binding.type, environment.locationOf(binding.node), binding.node);
          if (solidTypeAlias(binding.type, "Accessor", checker)) context.bindings.get(binding.name)!.accessor = true;
          else if (component.values.some(value => value.name === binding.name)) fail(environment.locationOf(binding.node), "Solid view-model values cross the boundary as Accessor<T>");
        }
      }
      const rootBindings: ContractBinding[] = [], rootPool: ContractBinding[] = [];
      for (const imp of item.imports.values()) {
        if ([COMPONENTS, INPUT, "solid-js", LIFECYCLE].includes(imp.module)) continue;
        if (imp.module === STD) { context.builtins.set(imp.name, imp.sourceName); continue; }
        const path = moduleSource(item, imp), raw = checked(item, imp.node.name), contextType = solidTypeAlias(raw, "Context", checker);
        if (contextType) {
          if (path.toLowerCase() !== rootModule) fail(loc(imp.node), "Context objects must be exported by the root's basename module");
          const access = solidTypeAlias(checker.getNonNullableType(contextType), "Accessor", checker);
          if (!access) fail(loc(imp.node), "Context objects require Context<Accessor<T>>");
          contexts.set(imp.name, { key: imp.sourceName, type: access }); continue;
        }
        if (path.toLowerCase() !== resolve(dirname(item.file), basename(item.file, ".tsx")).toLowerCase()) fail(loc(imp.node), "The view-model import must use the component basename without an extension");
        if (!component.root || factoryNames.size) models.set(imp.name, imp);
        else {
          rootBindings.push({ name: imp.name, sourceName: imp.sourceName, type: raw, node: environment.nodeAt(item.file, imp.node.name.getStart(), imp.node.name.getWidth())! });
          const sourceFile = environment.program.getSourceFile(exists(path + ".ts") ? path + ".ts" : path + ".d.ts"), symbol = sourceFile && checker.getSymbolAtLocation(sourceFile);
          if (symbol && !rootPool.length) for (const exported of checker.getExportsOfModule(symbol)) {
            const node = exported.valueDeclaration ?? exported.declarations?.[0];
            if (node) rootPool.push({ name: exported.name, sourceName: exported.name, type: checker.getTypeOfSymbolAtLocation(exported, node), node });
          }
        }
      }
      register(rootBindings, rootPool);
      for (const prop of component.props) context.bindings.set(`props.${prop.name}`, { scope: "prop", type: prop.type });
      function expand(node: ts.Expression, stack: string[] = []): string {
        node = unwrap(node);
        const replacements: { start: number; end: number; text: string }[] = [];
        function visit(child: ts.Node): void {
          if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && derived.has(child.expression.text)) {
            const name = child.expression.text;
            if (child.arguments.length || child.typeArguments?.length) fail(loc(child), "Derived expressions take no arguments");
            if (stack.includes(name)) fail(loc(child), `Cyclic derived expression ${[...stack, name].join(" -> ")}`);
            replacements.push({ start: child.getStart(item.script) - node.getStart(item.script), end: child.end - node.getStart(item.script), text: `(${expand(derived.get(name)!, [...stack, name])})` }); return;
          }
          if (ts.isAsExpression(child) || ts.isTypeAssertionExpression(child) || ts.isNonNullExpression(child) || ts.isSatisfiesExpression(child)) fail(loc(child), "TypeScript assertions are outside the view expression subset");
          if (ts.isCallExpression(child) && child.typeArguments?.length) fail(loc(child), "Type arguments are outside the view expression subset");
          ts.forEachChild(child, visit);
        }
        visit(node); let text = node.getText(item.script);
        for (const replacement of replacements.sort((a, b) => b.start - a.start)) text = text.slice(0, replacement.start) + replacement.text + text.slice(replacement.end);
        return text;
      }
      function expr(node: ts.Expression, ctx = context, expected?: AotType): AotExpr {
        function admit(child: ts.Node): void {
          if (ts.isAsExpression(child) || ts.isTypeAssertionExpression(child) || ts.isNonNullExpression(child) || ts.isSatisfiesExpression(child)) fail(loc(child), "TypeScript assertions are outside the view expression subset");
          if (ts.isCallExpression(child) && child.typeArguments?.length) fail(loc(child), "Type arguments are outside the view expression subset");
          ts.forEachChild(child, admit);
        }
        admit(node);
        return expression(node.getText(item.script), loc(node), ctx, expected);
      }
      function assertPure(value: AotExpr, reason: string, onlyLocal?: string): void {
        if (value.kind === "call" && value.target === "vm") fail(value.loc, reason);
        if (onlyLocal && value.kind === "binding" && (value.scope !== "local" || value.name !== onlyLocal)) fail(value.loc, reason);
        for (const [key, field] of Object.entries(value)) if (!["loc", "type"].includes(key)) {
          if (Array.isArray(field)) { for (const child of field) { if (child && typeof child === "object" && "kind" in child) assertPure(child as AotExpr, reason, onlyLocal); } }
          else if (field && typeof field === "object" && "kind" in field) assertPure(field as AotExpr, reason, onlyLocal);
        }
      }
      let returned: ts.Expression | undefined;
      for (const statement of statements) {
        if (returned) fail(loc(statement), "The JSX return must be the final component statement");
        if (ts.isReturnStatement(statement)) { if (!statement.expression) fail(loc(statement), "Return a JSX element or fragment"); returned = unwrap(statement.expression); continue; }
        if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) && imported(statement.expression.expression, LIFECYCLE)) {
          const call = statement.expression, name = item.imports.get((call.expression as ts.Identifier).text)!.sourceName, hook = name === "onMount" ? "mount" : "unmount";
          if (call.typeArguments?.length || call.arguments.length !== 1) fail(loc(call), "Lifecycle hooks take one zero-argument view-model call");
          const action = handler(call.arguments[0]!, context);
          if (action.kind !== "call" || action.expression.kind !== "call" || action.expression.arguments.length) fail(loc(call), "Lifecycle hooks take one zero-argument view-model call");
          if (component.hooks?.[hook]) fail(loc(call), `Duplicate ${name} hook`);
          (component.hooks ??= {})[hook] = action; continue;
        }
        if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const) || statement.declarationList.declarations.length !== 1) fail(loc(statement), outside);
        const declaration = statement.declarationList.declarations[0]!, init = declaration.initializer;
        if (!init) fail(loc(declaration), outside);
        if (ts.isArrayBindingPattern(declaration.name)) fail(loc(declaration), "Component state and lifecycle belong to the basename module and the Rust model");
        if (ts.isObjectBindingPattern(declaration.name)) {
          if (ts.isIdentifier(init) && init.text === context.propsName) fail(loc(declaration), "Read props as props.x; destructuring is outside the view subset");
          if (component.factory || !ts.isCallExpression(init) || !ts.isIdentifier(init.expression) || !models.has(init.expression.text) || init.arguments.length || init.typeArguments?.length) fail(loc(declaration), "A stateful component has one destructured call to its imported zero-argument factory");
          const factory = models.get(init.expression.text)!, signatures = checked(item, factory.node.name).getCallSignatures();
          if (signatures.length !== 1 || signatures[0]!.parameters.length || signatures[0]!.typeParameters?.length) fail(loc(init), "A child factory must have one non-generic zero-argument signature");
          const result = signatures[0]!.getReturnType();
          if (!(result.flags & ts.TypeFlags.Object) || result.getCallSignatures().length || checker.getIndexInfosOfType(result).length || result.isClass()) fail(loc(init), "A child factory returns an object of view-model values and methods");
          component.factory = { name: factory.name, sourceName: factory.sourceName, module: factory.module };
          register(declaration.name.elements.map(binding => {
            if (!ts.isIdentifier(binding.name) || binding.initializer || binding.dotDotDotToken || binding.propertyName && !ts.isIdentifier(binding.propertyName)) fail(loc(binding), "Factory destructuring accepts named bindings and aliases, without defaults or rest bindings");
            const sourceName = (binding.propertyName as ts.Identifier | undefined)?.text ?? binding.name.text, property = result.getProperty(sourceName), node = property?.valueDeclaration ?? property?.declarations?.[0];
            if (!property || !node) fail(loc(binding), `The factory does not return ${sourceName}`);
            return { name: binding.name.text, sourceName, type: checker.getTypeOfSymbolAtLocation(property, node), node };
          }), result.getProperties().flatMap(property => {
            const node = property.valueDeclaration ?? property.declarations?.[0];
            return node ? [{ name: property.name, sourceName: property.name, type: checker.getTypeOfSymbolAtLocation(property, node), node }] : [];
          })); continue;
        }
        if (!ts.isIdentifier(declaration.name)) fail(loc(declaration), outside);
        const name = declaration.name.text, value = ts.isNonNullExpression(init) ? init.expression : init;
        if (ts.isCallExpression(value) && imported(value.expression, "solid-js", "useContext")) {
          if (component.root || !ts.isNonNullExpression(init) || value.arguments.length !== 1 || value.typeArguments?.length || !ts.isIdentifier(value.arguments[0]!)) fail(loc(value), "Use const theme = useContext(ThemeContext)! in a child with a root provider");
          const provided = contexts.get((value.arguments[0] as ts.Identifier).text); if (!provided) fail(loc(value), "useContext requires a context from the root's basename module");
          const type = mapper.map(provided.type, loc(value), typeName(name));
          (component.injections ??= []).push({ key: provided.key, name, type, loc: loc(value) });
          context.bindings.set(name, { scope: "inject", resolvedName: provided.key, type, accessor: true }); continue;
        }
        if (ts.isCallExpression(value) && imported(value.expression, "solid-js", "mergeProps")) {
          if (!rawProps || context.propsName !== (rawProps.name as ts.Identifier).text || value.arguments.length !== 2 || value.typeArguments?.length || !ts.isObjectLiteralExpression(value.arguments[0]!) || !ts.isIdentifier(value.arguments[1]!) || (value.arguments[1] as ts.Identifier).text !== context.propsName) fail(loc(value), "mergeProps takes literal defaults followed by the raw props parameter");
          for (const property of (value.arguments[0] as ts.ObjectLiteralExpression).properties) {
            if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) fail(loc(property), "Prop defaults must use named literal properties");
            const prop = component.props.find(p => p.name === (property.name as ts.Identifier).text); if (!prop) fail(loc(property), "Default names an undeclared prop");
            const expected = prop.type.kind === "option" ? prop.type.value : prop.type, literal = expr(property.initializer, context, expected); requireType(literal, expected, context);
            if (literal.kind === "literal" && Array.isArray(literal.value) || literal.kind !== "literal" && !(literal.kind === "unary" && literal.operator === "-" && literal.operand.kind === "literal" && typeof literal.operand.value === "number")) fail(loc(property), "Defaults must be literal strings, numbers, booleans, or enum literals");
            prop.default = literal.kind === "literal" ? literal.value as string | number | boolean : -(literal.operand as Extract<AotExpr, {kind:"literal"}>).value as number;
            if (literal.kind === "literal" && literal.rawNumber !== undefined) prop.defaultRawNumber = literal.rawNumber;
            if (expected.kind === "style" && typeof prop.default === "string" && prop.default.trim()) classLiterals.add(prop.default.trim());
            prop.type = expected; context.bindings.set(`props.${prop.name}`, { scope: "prop", type: expected });
          }
          context.propsName = name; continue;
        }
        let arrow: ts.ArrowFunction | undefined = ts.isArrowFunction(value) ? value : undefined;
        if (ts.isCallExpression(value) && imported(value.expression, "solid-js", "createMemo") && value.arguments.length === 1 && !value.typeArguments?.length && ts.isArrowFunction(value.arguments[0]!)) arrow = value.arguments[0];
        if (!arrow || arrow.parameters.length || arrow.typeParameters?.length || ts.isBlock(arrow.body) || arrow.modifiers?.length) fail(loc(declaration), outside);
        derived.set(name, arrow.body);
      }
      if (!returned) fail(loc(item.declaration), "A component requires one JSX return");
      if (models.size && (!component.factory || models.size !== 1)) fail(loc(item.declaration), "A child may import only the factory used by its destructured setup declaration");
      if (component.hooks && !component.root && !component.factory) fail(loc(item.declaration), "Lifecycle hooks require the root or a factory child");
      context.derived = new Map([...derived].map(([name, body]) => [name, { source: body.getText(item.script), loc: loc(body), context }]));
      for (const [name, body] of derived) expand(body, [name]);
      for (const body of derived.values()) assertPure(expr(body), "Derived expressions cannot call view-model functions");
      function handler(source: ts.Expression, ctx: ExpressionContext, event?: AotEvent): AotHandler {
        const hctx = { ...ctx, bindings: new Map(ctx.bindings), handler: true };
        source = unwrap(source);
        if (ts.isArrowFunction(source)) {
          if (source.modifiers?.length || source.typeParameters?.length || source.parameters.length > (event?.parameters.length ?? 0)) fail(loc(source), "Handlers accept only the declared event payload parameters");
          source.parameters.forEach((parameter, index) => {
            if (!ts.isIdentifier(parameter.name) || parameter.initializer || parameter.questionToken || parameter.dotDotDotToken) fail(loc(parameter), "Handler parameters are plain identifiers");
            hctx.bindings.set(parameter.name.text, { type: event!.parameters[index]!.type, scope: "event", resolvedName: index === 0 ? "$event" : `$event${index}` });
          });
          return ts.isBlock(source.body) ? statementsHandler(source.body.statements, hctx, true, loc(source)) : action(unwrap(source.body), hctx);
        }
        if (!ts.isIdentifier(source)) fail(loc(source), "A handler is an arrow function or a bare view-model reference");
        if (setters.has(source.text)) {
          const target = setters.get(source.text)!, binding = hctx.bindings.get(target)!;
          if (event?.parameters.length !== 1 || !sameType(event.parameters[0]!.type, binding.type)) fail(loc(source), "A bare setter requires one payload of the signal type");
          component.values.find(v => v.name === target)!.writable = true;
          return { kind: "assign", id: component.handlerCount++, name: target, value: { kind: "binding", name: "$event", scope: "event", type: binding.type, loc: loc(source) }, loc: loc(source) };
        }
        const fn = hctx.functions.get(source.text);
        if (!fn || fn.parameters.length && (fn.parameters.length !== event?.parameters.length || fn.parameters.some((p, i) => !sameType(p.type, event.parameters[i]!.type)))) fail(loc(source), "A bare handler names a view-model function matching its event payload");
        fn.handler = true;
        return { kind: "call", id: component.handlerCount++, expression: { kind: "call", name: source.text, target: "vm", type: fn.returns, arguments: fn.parameters.map((p, i) => ({ kind: "binding", name: i === 0 ? "$event" : `$event${i}`, scope: "event", type: p.type, loc: loc(source) })), loc: loc(source) }, loc: loc(source) };
      }
      function statementsHandler(statements: readonly ts.Statement[], ctx: ExpressionContext, terminal: boolean, at: SourceLocation): AotHandler {
        const id = component.handlerCount++;
        const steps = statements.map((statement, index) => {
          const last = terminal && index === statements.length - 1;
          if (ts.isExpressionStatement(statement)) {
            const step = action(unwrap(statement.expression), ctx);
            if (step.kind === "emit" && !last) fail(loc(statement), "An emit must be the final statement of a handler or its final branch");
            return step;
          }
          if (ts.isIfStatement(statement)) {
            const condition = expr(statement.expression, ctx, BOOL); requireType(condition, BOOL, ctx);
            const branch = (node: ts.Statement, scope: ExpressionContext) => {
              const value = statementsHandler(ts.isBlock(node) ? node.statements : [node], scope, last, loc(node));
              return value.kind === "sequence" ? value.steps : [value];
            };
            return { kind: "if" as const, id: component.handlerCount++, condition, then: branch(statement.thenStatement, narrowed(ctx, condition, true)), ...(statement.elseStatement ? { else: branch(statement.elseStatement, narrowed(ctx, condition, false)) } : {}), loc: loc(statement) };
          }
          fail(loc(statement), "Handler blocks accept expression statements and if statements only");
        });
        return { kind: "sequence", id, steps, loc: at };
      }
      function action(node: ts.Expression, ctx: ExpressionContext): AotHandler {
        const at = loc(node), id = component.handlerCount++;
        if (!ts.isCallExpression(node) || node.typeArguments?.length || node.arguments.some(ts.isSpreadElement)) fail(at, "A handler statement calls a view-model function, setter, or callback prop");
        if (ts.isIdentifier(node.expression) && setters.has(node.expression.text)) {
          if (node.arguments.length !== 1 || node.questionDotToken) fail(at, "A signal setter takes one value or updater");
          const name = setters.get(node.expression.text)!, binding = ctx.bindings.get(name)!, argument = node.arguments[0]!;
          let value: AotExpr;
          if (ts.isArrowFunction(argument)) {
            if (argument.parameters.length !== 1 || argument.typeParameters?.length || argument.modifiers?.length || !ts.isIdentifier(argument.parameters[0]!.name) || argument.parameters[0]!.initializer || argument.parameters[0]!.dotDotDotToken || argument.parameters[0]!.questionToken || ts.isBlock(argument.body)) fail(loc(argument), "A setter updater is one parameter and one expression");
            const updater = { ...ctx, bindings: new Map(ctx.bindings) };
            updater.bindings.set((argument.parameters[0]!.name as ts.Identifier).text, { type: binding.type, scope: "vm", resolvedName: name });
            value = expr(argument.body, updater, binding.type);
          } else value = expr(argument, ctx, binding.type);
          requireType(value, binding.type, ctx); component.values.find(v => v.name === name)!.writable = true;
          return { kind: "assign", id, name, value, loc: at };
        }
        if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === ctx.propsName) {
          if (!/^on[A-Z]/.test(node.expression.name.text)) fail(at, "A handler callback must be declared in the component props");
          const declared = component.events.find(e => e.name === eventName((node.expression as ts.PropertyAccessExpression).name.text));
          if (!declared || !/^on[A-Z]/.test(node.expression.name.text)) fail(at, "A handler callback must be declared in the component props");
          if (!!declared.optional !== !!node.questionDotToken) fail(at, declared.optional ? "Optional callbacks must use props.onName?.(...)" : "Required callbacks use props.onName(...)");
          if (node.expression.questionDotToken || node.arguments.length !== declared.parameters.length) fail(at, `Event ${declared.name} expects ${declared.parameters.length} payload values`);
          return { kind: "emit", id, name: declared.name, ...(declared.optional ? { optional: true } : {}), arguments: node.arguments.map((argument, index) => { const type = declared.parameters[index]!.type, value = expr(argument, ctx, type); requireType(value, type, ctx); return value; }), loc: at };
        }
        const value = expr(node, ctx);
        if (value.kind !== "call" || value.target !== "vm") fail(at, "A handler call must name a view-model function");
        return { kind: "call", id, expression: value, loc: at };
      }
      function attrs(node: ts.JsxOpeningLikeElement): Map<string, ts.JsxAttribute> {
        if (node.typeArguments?.length) fail(loc(node), "Component generics are inferred from props; JSX type arguments are unsupported");
        const result = new Map<string, ts.JsxAttribute>();
        for (const attribute of node.attributes.properties) {
          if (ts.isJsxSpreadAttribute(attribute)) fail(loc(attribute), "Spread attributes are outside the view subset");
          if (!ts.isIdentifier(attribute.name) || !/^[A-Za-z_$][\w$]*$/.test(attribute.name.text)) fail(loc(attribute), "Attribute names are camelCase identifiers; use debugName");
          const name = attribute.name.text;
          if (result.has(name)) fail(loc(attribute), `Duplicate attribute ${name}`);
          if (name === "ref" || name === "nodeRef") fail(loc(attribute), "Node references are outside the view subset");
          if (attribute.initializer && !ts.isStringLiteral(attribute.initializer) && !ts.isJsxExpression(attribute.initializer)) fail(loc(attribute), "Element attribute values must be written inside braces");
          if (attribute.initializer && ts.isStringLiteral(attribute.initializer) && hasJsxEntity(attribute.initializer.getText(item.script))) fail(loc(attribute), JSX_ENTITY_DIAGNOSTIC);
          result.set(name, attribute);
        }
        return result;
      }
      const attrExpr = (attribute: ts.JsxAttribute): ts.Expression => {
        if (!attribute.initializer || !ts.isJsxExpression(attribute.initializer) || !attribute.initializer.expression || attribute.initializer.dotDotDotToken) fail(loc(attribute), `${attribute.name.getText(item.script)} requires an expression`);
        return unwrap(attribute.initializer.expression);
      };
      function attrValue(attribute: ts.JsxAttribute, ctx: ExpressionContext, expected?: AotType): AotExpr {
        if (!attribute.initializer) return { kind: "literal", value: true, type: BOOL, loc: loc(attribute) };
        if (ts.isStringLiteral(attribute.initializer)) return expression(JSON.stringify(attribute.initializer.text), loc(attribute.initializer), ctx, expected);
        return expr(attrExpr(attribute), ctx, expected);
      }
      function only(attributes: Map<string, ts.JsxAttribute>, names: string[], name: string): void { for (const [key, value] of attributes) if (!names.includes(key)) fail(loc(value), `${name} does not accept ${key}`); }
      function children(nodes: readonly ts.JsxChild[], ctx: ExpressionContext): AotNode[] {
        return nodes.flatMap(node => {
          if (ts.isJsxText(node)) { if (hasJsxEntity(node.getText(item.script))) fail(loc(node), JSX_ENTITY_DIAGNOSTIC); if (normalizeJsxText(node.text).trim()) fail(loc(node), "Text and interpolation must appear inside Text"); return []; }
          if (ts.isJsxExpression(node)) { if (node.dotDotDotToken) fail(loc(node), "Spread children are outside the view subset"); return node.expression ? content(unwrap(node.expression), ctx) : []; }
          return content(node, ctx);
        });
      }
      function slotOutlet(node: ts.Expression, ctx: ExpressionContext): AotNode[] | undefined {
        const call = ts.isCallExpression(node) ? node : undefined, access = call?.expression ?? node;
        if (!ts.isPropertyAccessExpression(access) || !ts.isIdentifier(access.expression) || access.expression.text !== ctx.propsName) return;
        const name = slotName(access.name.text), slot = component.slotProps?.find(s => s.name === name);
        if (!slot) return;
        const values: { name: string; value: AotExpr }[] = [];
        if (call) {
          if (!slot.parameters.length || call.typeArguments?.length || call.questionDotToken || call.arguments.length !== 1 || !ts.isObjectLiteralExpression(call.arguments[0]!)) fail(loc(call), "A scoped slot is called with one object of Accessor bindings");
          const seen = new Set<string>();
          for (const property of (call.arguments[0] as ts.ObjectLiteralExpression).properties) {
            if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property) || !ts.isIdentifier(property.name)) fail(loc(property), "Slot arguments use named Accessor bindings");
            const argument = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer, parameter = slot.parameters.find(p => p.name === (property.name as ts.Identifier).text);
            if (!parameter || seen.has(property.name.text)) fail(loc(property), "Unknown or duplicate slot argument"); seen.add(property.name.text);
            if (!ts.isIdentifier(argument) || !ctx.bindings.get(argument.text)?.accessor) fail(loc(argument), "Scoped-slot values must be passed as Accessors without calling them");
            const access = ctx.bindings.get(argument.text)!; const value: AotExpr = { kind: "binding", name: access.resolvedName ?? argument.text, scope: access.scope, type: access.type, loc: loc(argument) }; requireType(value, parameter.type, ctx); values.push({ name: parameter.name, value });
          }
          if (values.length !== slot.parameters.length) fail(loc(call), "Missing scoped-slot arguments");
        } else if (slot.parameters.length) fail(loc(access), "A scoped slot requires its Accessor arguments");
        return [{ kind: "slot", id: component.nodeCount++, name, ...(values.length ? { props: values } : {}), fallback: [], loc: loc(node) }];
      }
      function content(node: ts.Expression | Jsx, ctx: ExpressionContext, providerAllowed = false): AotNode[] {
        node = unwrap(node);
        if (ts.isJsxFragment(node)) return children(node.children, ctx);
        if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) {
          const slot = slotOutlet(node, ctx); if (slot) return slot;
          if (ts.isConditionalExpression(node) || ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) fail(loc(node), "Conditional children use <Show> or <Switch>");
          if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "map") fail(loc(node), `Use <For each by> from ${COMPONENTS} instead of .map`);
          fail(loc(node), "Container children are JSX nodes or declared slot outlets");
        }
        const opening = ts.isJsxElement(node) ? node.openingElement : node, nodes = ts.isJsxElement(node) ? node.children : [], attributes = attrs(opening), tag = opening.tagName;
        if (ts.isPropertyAccessExpression(tag)) {
          if (!ts.isIdentifier(tag.expression) || tag.name.text !== "Provider" || !contexts.has(tag.expression.text) || !sameReference(tag.expression, item.imports.get(tag.expression.text)!.node.name)) fail(loc(tag), "Member tags accept only a root context Provider");
          if (!component.root || !providerAllowed) fail(loc(tag), "Context providers must wrap the whole root JSX without conditional or nested overrides");
          only(attributes, ["value"], "Provider"); const attribute = attributes.get("value");
          if (!attribute) fail(loc(tag), "Provider requires an Accessor value"); const value = attrExpr(attribute);
          if (!ts.isIdentifier(value) || !ctx.bindings.get(value.text)?.accessor || ctx.bindings.get(value.text)?.scope !== "vm") fail(loc(value), "Provider value must be a root Accessor binding, without calling it");
          const source = contexts.get(tag.expression.text)!, expected = mapper.map(source.type, loc(tag), typeName(source.key)), access = ctx.bindings.get(value.text)!, binding: AotExpr = { kind: "binding", name: access.resolvedName ?? value.text, scope: access.scope, type: access.type, loc: loc(value) }; requireType(binding, expected, ctx);
          if (component.provides?.some(p => p.key === source.key)) fail(loc(tag), `Duplicate root provider ${source.key}`);
          (component.provides ??= []).push({ key: source.key, value: binding, loc: loc(tag) });
          const visible = nodes.filter(n => !(ts.isJsxText(n) && !normalizeJsxText(n.text).trim()) && !(ts.isJsxExpression(n) && !n.expression));
          if (visible.length === 1 && jsx(visible[0]!)) return content(visible[0]!, ctx, true);
          return children(nodes, ctx);
        }
        if (!ts.isIdentifier(tag)) fail(loc(tag), "Namespaced JSX elements are outside the view subset");
        const imp = item.imports.get(tag.text), kind = imp?.sourceName, known = imp?.module === COMPONENTS || imp?.module === "solid-js";
        if (imp && !sameReference(tag, imp.node.name)) fail(loc(tag), `Element ${tag.text} is shadowed by a local binding`);
        if (known && kind === "Show") {
          only(attributes, ["when", "fallback"], "Show"); const when = attributes.get("when"); if (!when) fail(loc(tag), "Show requires a boolean condition; compare explicitly");
          const condition = attrValue(when, ctx, BOOL); if (condition.type.kind !== "boolean") fail(loc(when), "Show requires a boolean condition; compare explicitly");
          const id = component.nodeCount++, branches: Extract<AotNode,{kind:"if"}>["branches"] = [{ condition, children: children(nodes, narrowed(ctx, condition, true)) }];
          const fallback = attributes.get("fallback"); if (fallback) { const value = attrExpr(fallback); if (!jsx(value)) fail(loc(value), "fallback requires a JSX element or fragment"); branches.push({ children: content(value, narrowed(ctx, condition, false)) }); }
          return [{ kind: "if", id, branches, loc: loc(node) }];
        }
        if (known && kind === "Switch") {
          only(attributes, ["fallback"], "Switch"); const id = component.nodeCount++, branches: Extract<AotNode,{kind:"if"}>["branches"] = []; let scope = ctx;
          for (const child of nodes) {
            if (ts.isJsxText(child) && !child.text.trim() || ts.isJsxExpression(child) && !child.expression) continue;
            if (!ts.isJsxElement(child) && !ts.isJsxSelfClosingElement(child)) fail(loc(child), "Switch children must be Match elements");
            const opening = ts.isJsxElement(child) ? child.openingElement : child, tag = opening.tagName;
            if (!ts.isIdentifier(tag) || !imported(tag, "solid-js", "Match")) fail(loc(child), "Switch children must be Match elements");
            const props = attrs(opening); only(props, ["when"], "Match"); const when = props.get("when"); if (!when) fail(loc(child), "Match requires a boolean condition");
            const condition = attrValue(when, scope, BOOL); requireType(condition, BOOL, scope); branches.push({ condition, children: children(ts.isJsxElement(child) ? child.children : [], narrowed(scope, condition, true)) }); scope = narrowed(scope, condition, false);
          }
          if (!branches.length) fail(loc(node), "Switch requires at least one Match");
          const fallback = attributes.get("fallback"); if (fallback) { const value = attrExpr(fallback); if (!jsx(value)) fail(loc(value), "fallback requires a JSX element or fragment"); branches.push({ children: content(value, scope) }); }
          return [{ kind: "if", id, branches, loc: loc(node) }];
        }
        if (known && kind === "Match") fail(loc(tag), "Match must be a direct child of Switch");
        if (known && kind === "For") {
          only(attributes, ["each", "by"], "For"); const each = attributes.get("each"), by = attributes.get("by"); if (!each || !by) fail(loc(node), "For requires each and by");
          const source = attrValue(each, ctx); if (source.type.kind !== "array") fail(loc(each), "For each requires an array");
          const id = component.nodeCount++, itemName = `${component.name}Loop${id}Item`, indexName = `${component.name}Loop${id}Index`, keyFunction = attrExpr(by);
          if (!ts.isArrowFunction(keyFunction) || keyFunction.parameters.length !== 1 || !ts.isIdentifier(keyFunction.parameters[0]!.name) || keyFunction.parameters[0]!.initializer || keyFunction.parameters[0]!.dotDotDotToken || keyFunction.parameters[0]!.questionToken || keyFunction.modifiers?.length || keyFunction.typeParameters?.length || ts.isBlock(keyFunction.body)) fail(loc(by), "For by requires a one-parameter key expression");
          const keyContext = { ...ctx, bindings: new Map(ctx.bindings) }; keyContext.bindings.set((keyFunction.parameters[0]!.name as ts.Identifier).text, { type: source.type.element, scope: "local", resolvedName: itemName });
          const key = expr(keyFunction.body, keyContext), declaration = mapper.declaration(key.type);
          assertPure(key, "For by reads only its parameter, compile-time constants and built-ins", itemName);
          if (!(key.type.kind === "string" || key.type.kind === "number" && ["i32", "i64"].includes(key.type.name) || declaration?.kind === "enum")) fail(loc(by), "For keys must be i32, i64, string, or a string-literal enum");
          const visible = nodes.filter(n => !(ts.isJsxText(n) && !n.text.trim()) && !(ts.isJsxExpression(n) && !n.expression));
          if (visible.length !== 1 || !ts.isJsxExpression(visible[0]!) || !visible[0].expression || !ts.isArrowFunction(visible[0].expression)) fail(loc(node), "For takes one child function (item, index) => JSX");
          const render = visible[0].expression;
          if (render.parameters.length < 1 || render.parameters.length > 2 || render.typeParameters?.length || render.modifiers?.length || render.parameters.some(p => !ts.isIdentifier(p.name) || p.initializer || p.dotDotDotToken || p.questionToken) || ts.isBlock(render.body)) fail(loc(render), "For child parameters are item and optional index Accessors");
          const itemType = source.type.element, row = { ...ctx, bindings: new Map(ctx.bindings) };
          render.parameters.forEach((parameter, index) => row.bindings.set((parameter.name as ts.Identifier).text, { scope: "local", resolvedName: index ? indexName : itemName, type: index ? I32 : itemType, accessor: true }));
          if (render.parameters.length === 2 && (render.parameters[0]!.name as ts.Identifier).text === (render.parameters[1]!.name as ts.Identifier).text) fail(loc(render), "For item and index names must differ");
          return [{ kind: "for", id, source, item: itemName, ...(render.parameters.length === 2 ? { index: indexName } : {}), itemType: source.type.element, key, children: content(unwrap(render.body), row), loc: loc(node) }];
        }
        if (imp?.module === COMPONENTS && (kind === "ActionHandler" || kind === "AxisHandler")) {
          only(attributes, kind === "ActionHandler" ? ["button", "active", "latched", "onPress"] : ["axis", "active", "onDelta"], kind);
          const id = component.nodeCount++, activeAttribute = attributes.get("active"), active = activeAttribute ? attrValue(activeAttribute, ctx, BOOL) : { kind: "literal" as const, value: true, type: BOOL, loc: loc(node) }; requireType(active, BOOL, ctx);
          const event = attributes.get(kind === "ActionHandler" ? "onPress" : "onDelta"); if (!event) fail(loc(node), `${kind} requires its event handler`);
          const action = handler(attrExpr(event), ctx, kind === "AxisHandler" ? { name: "delta", parameters: [{ name: "delta", type: I32 }] } : undefined);
          let input: Extract<AotNode,{kind:"input"}>["input"];
          if (kind === "ActionHandler") {
            const attribute = attributes.get("button"); if (!attribute) fail(loc(node), "ActionHandler requires button={BTN.NAME}"); const button = attrExpr(attribute);
            if (!ts.isPropertyAccessExpression(button) || button.questionDotToken || !imported(button.expression, INPUT, "BTN")) fail(loc(button), "button must be a static member of BTN imported from @pocketjs/framework/input");
            const value = BTN[button.name.text as keyof typeof BTN]; if (value === undefined) fail(loc(button), `Unknown BTN member ${button.name.text}`);
            if (attributes.get("latched")?.initializer) fail(loc(attributes.get("latched")!), "latched accepts only the bare attribute");
            input = { kind: "button", name: button.name.text, button: value, latched: attributes.has("latched") };
          } else {
            const attribute = attributes.get("axis"); if (!attribute) fail(loc(node), "AxisHandler requires a static axis"); const axis = attrValue(attribute, ctx, STRING);
            if (axis.kind !== "literal" || typeof axis.value !== "string" || !(axis.value in VAPOR_RELATIVE_AXES)) fail(loc(attribute), "axis must be the static literal primary or secondary");
            input = { kind: "axis", name: axis.value, axis: VAPOR_RELATIVE_AXES[axis.value as keyof typeof VAPOR_RELATIVE_AXES] };
          }
          return [{ kind: "input", id, input, active, handler: action, children: children(nodes, ctx), loc: loc(node) }];
        }
        const childFile = item.children.get(tag.text);
        if (childFile) {
          const declaration = item.script.statements.find(statement => ts.isImportDeclaration(statement) && statement.importClause?.name?.text === tag.text) as ts.ImportDeclaration;
          if (!sameReference(tag, declaration.importClause!.name!)) fail(loc(tag), `Element ${tag.text} is shadowed by a local binding`);
          const childItem = parsed.get(childFile)!; let child: AotComponent;
          if (childItem.declaration.typeParameters?.length) {
            const inferred = new Map<string, AotType>(), inferredSources: GenericSourceArguments = new Map(), parameters = childItem.declaration.typeParameters, parameterNames = new Set(parameters.map(p => p.name.text));
            const parameter = childItem.declaration.parameters[0]; if (!parameter?.type) fail(loc(node), "A generic component requires typed props");
            const raw = checked(childItem, parameter.type);
            for (const [name, attribute] of attributes) {
              const property = raw.getProperty(name), declaration = property?.valueDeclaration ?? property?.declarations?.[0];
              if (!property || !declaration || name.startsWith("on")) continue;
              const candidate = attribute.initializer && ts.isJsxExpression(attribute.initializer) ? attribute.initializer.expression : undefined;
              if (candidate && (jsx(unwrap(candidate)) || ts.isArrowFunction(unwrap(candidate)))) continue;
              const actual = attrValue(attribute, ctx), pattern = checker.getTypeOfSymbolAtLocation(property, declaration);
              inferGenericArgument(pattern, actual.type, parameterNames, inferred, mapper, loc(attribute));
              let actualType = candidate ? checked(item, candidate) : ts.isStringLiteral(attribute.initializer!) ? checker.getStringLiteralType(attribute.initializer.text) : checker.getTrueType();
              actualType = mapper.unwrap(actualType); inferGenericSource(pattern, actualType, parameterNames, inferredSources, sourceArguments, mapper);
            }
            mapper.withTypeArguments(inferred, () => {
              for (const parameter of parameters) {
                const parameterType = checked(childItem, parameter.name), fallback = checker.getDefaultFromTypeParameter(parameterType);
                if (!inferred.has(parameter.name.text) && fallback) { inferred.set(parameter.name.text, mapper.map(fallback, loc(node), `${childItem.name}${parameter.name.text}`)); inferredSources.set(parameter.name.text, [fallback]); }
                if (!inferred.has(parameter.name.text)) fail(loc(node), `Cannot infer generic parameter ${parameter.name.text} of ${childItem.name} from supplied props`);
              }
              for (const parameter of parameters) if (parameter.constraint) {
                const constraint = checked(childItem, parameter.constraint), expected = mapper.map(constraint, loc(node), `${childItem.name}${parameter.name.text}Constraint`), actual = inferred.get(parameter.name.text)!, originals = inferredSources.get(parameter.name.text);
                const fits = originals?.length ? originals.every(source => satisfiesGenericSourceConstraint(source, constraint, inferredSources, mapper)) : !constraintNeedsSource(constraint, mapper) && satisfiesGenericConstraint(actual, expected, mapper);
                if (!fits || !preservesGenericStorage(actual, expected, mapper)) fail(loc(node), `Generic argument ${parameter.name.text} does not satisfy its constraint in ${childItem.name}`);
              }
            });
            const key = JSON.stringify([childFile, [...inferred], [...inferredSources].map(([name, types]) => [name, types.map(type => checker.typeToString(type))])]);
            const existing = specializations.get(key);
            if (existing) child = existing;
            else { let suffix = 1, name = `${childItem.name}Instance${suffix}`; while (usedNames.has(name)) name = `${childItem.name}Instance${++suffix}`; usedNames.add(name); child = analyze(childItem, inferred, name, inferredSources); specializations.set(key, child); }
          } else child = analyze(childItem);
          if (!component.children.includes(child.name)) component.children.push(child.name);
          const instance: Extract<AotNode,{kind:"component"}> = { kind: "component", id: component.nodeCount++, component: child.name, props: [], events: [], slots: [], loc: loc(node) };
          for (const [name, attribute] of attributes) {
            const prop = child.props.find(p => p.name === name), event = /^on[A-Z]/.test(name) ? child.events.find(e => e.name === eventName(name)) : undefined, slot = child.slotProps?.find(s => s.name === slotName(name));
            if (prop) {
              let value = attrValue(attribute, ctx, prop.type); requireType(value, prop.type, ctx);
              if (prop.type.kind === "style") value = styles(value, true);
              instance.props.push({ name, value });
            } else if (event) instance.events.push({ name: event.name, handler: handler(attrExpr(attribute), ctx, event) });
            else if (slot) {
              const value = attrExpr(attribute);
              if (slot.parameters.length) {
                if (!ts.isArrowFunction(value) || value.parameters.length !== 1 || !ts.isObjectBindingPattern(value.parameters[0]!.name) || value.parameters[0]!.initializer || value.typeParameters?.length || value.modifiers?.length || ts.isBlock(value.body)) fail(loc(value), "A scoped slot takes destructured Accessor props and returns JSX");
                const bindings: NonNullable<Extract<AotNode,{kind:"component"}>["slots"][number]["bindings"]> = [], scope = { ...ctx, bindings: new Map(ctx.bindings) }, seen = new Set<string>();
                for (const binding of (value.parameters[0]!.name as ts.ObjectBindingPattern).elements) {
                  if (!ts.isIdentifier(binding.name) || binding.initializer || binding.dotDotDotToken || binding.propertyName && !ts.isIdentifier(binding.propertyName)) fail(loc(binding), "Scoped slots accept named destructuring and aliases");
                  const name = (binding.propertyName as ts.Identifier | undefined)?.text ?? binding.name.text, parameter = slot.parameters.find(p => p.name === name);
                  if (!parameter || seen.has(name)) fail(loc(binding), "Unknown or duplicate scoped-slot parameter"); seen.add(name);
                  const resolved = `${component.name}Slot${instance.id}_${instance.slots.length}_${binding.name.text}`;
                  bindings.push({ name: resolved, prop: name, type: parameter.type }); scope.bindings.set(binding.name.text, { scope: "local", resolvedName: resolved, type: parameter.type, accessor: true });
                }
                instance.slots.push({ name: slot.name, bindings, children: content(unwrap(value.body), scope) });
              } else { if (!jsx(value)) fail(loc(value), "Slot props require a JSX element or fragment"); instance.slots.push({ name: slot.name, children: content(value, ctx) }); }
            } else fail(loc(attribute), `${child.name} does not accept ${name}`);
          }
          for (const prop of child.props) if (!instance.props.some(p => p.name === prop.name)) {
            if (prop.default !== undefined) instance.props.push({ name: prop.name, value: expression(prop.defaultRawNumber ?? JSON.stringify(prop.default), loc(node), ctx, prop.type) });
            else if (prop.type.kind === "option") instance.props.push({ name: prop.name, value: { kind: "undefined", type: prop.type, loc: loc(node) } });
            else fail(loc(node), `Missing required ${child.name} prop ${prop.name}`);
          }
          for (const event of child.events) if (!event.optional && !instance.events.some(e => e.name === event.name)) fail(loc(node), `Missing required ${child.name} callback on${event.name[0]!.toUpperCase()}${event.name.slice(1)}`);
          const visible = nodes.some(n => !(ts.isJsxText(n) && !n.text.trim()) && !(ts.isJsxExpression(n) && !n.expression));
          if (visible) { if (!child.slots.includes("default")) fail(loc(node), `Child ${child.name} has no default slot`); if (instance.slots.some(s => s.name === "default")) fail(loc(node), "Duplicate default slot"); instance.slots.push({ name: "default", children: children(nodes, ctx) }); }
          for (const name of requiredSlots.get(child.name) ?? []) if (!instance.slots.some(slot => slot.name === name)) fail(loc(node), `Missing required ${child.name} slot ${name}`);
          return [instance];
        }
        if (imp?.module !== COMPONENTS || !["View", "Text", "Image"].includes(kind ?? "")) fail(loc(tag), `Element ${tag.text} is not an imported host primitive or child component`);
        const host: Extract<AotNode,{kind:"element"}> = { kind: "element", id: component.nodeCount++, tag: kind as "View"|"Text"|"Image", style: -1, props: [], focusable: false, events: [], children: [], loc: loc(node) };
        only(attributes, kind === "View" ? ["class", "style", "focusable", "debugName", "onPress"] : kind === "Image" ? ["class", "src"] : ["class"], kind!);
        for (const [name, attribute] of attributes) {
          if (name === "class") {
            if (!attribute.initializer) fail(loc(attribute), "class requires a full class literal or literal ternary");
            if (ts.isStringLiteral(attribute.initializer)) { const text = attribute.initializer.text.trim(); if (text) { classLiterals.add(text); (host as typeof host & { classLiteral?: string }).classLiteral = text; } }
            else {
              const value = attrValue(attribute, ctx);
              if (value.kind !== "conditional" && !(value.kind === "binding" && value.scope === "prop" && value.type.kind === "style")) fail(loc(attribute), "class requires a ternary with full class literal leaves or a StyleClass prop");
              host.dynamicStyle = { id: component.memoCount++, expression: styles(value, false) };
            }
          } else if (name === "style") {
            const object = attrExpr(attribute); if (!ts.isObjectLiteralExpression(object)) fail(loc(object), "style requires an object literal");
            for (const property of object.properties) {
              if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) fail(loc(property), "style uses named properties without spread, computed keys or shorthand");
              const name = property.name.text, spec = VAPOR_STYLE_PROPS[name as keyof typeof VAPOR_STYLE_PROPS]; if (!spec) fail(loc(property), `Unknown numeric style property ${name}`);
              const expected: AotType = spec.unit ? mapper.unit(spec.unit) : { kind: "number", name: spec.type };
              let value = expr(property.initializer, ctx);
              const literalArithmetic = (e: AotExpr): boolean => e.kind === "literal" || e.kind === "unary" && literalArithmetic(e.operand) || e.kind === "binary" && literalArithmetic(e.left) && literalArithmetic(e.right);
              if (spec.unit === "Color" || literalArithmetic(value) || numeric(value.type, mapper)?.name.startsWith("f")) value = expr(property.initializer, ctx, expected);
              const n = numeric(value.type, mapper);
              if (spec.type === "f32" && n && !n.name.startsWith("f") && value.type.kind === "number") value = { kind: "cast", value, type: expected, loc: value.loc };
              requireType(value, expected, ctx); host.props.push({ name, prop: spec.id, value, memo: component.memoCount++ });
            }
          } else if (name === "focusable") { if (attribute.initializer) fail(loc(attribute), "focusable accepts only the bare attribute"); host.focusable = true; }
          else if (name === "onPress") host.events.push({ name: "press", handler: handler(attrExpr(attribute), ctx) });
          else { if (!attribute.initializer || !ts.isStringLiteral(attribute.initializer)) fail(loc(attribute), `${name} requires a static string literal`); if (name === "src") host.src = attribute.initializer.text; else host.debugName = attribute.initializer.text; }
        }
        if (host.events.length && !host.focusable) fail(loc(node), "onPress requires a focusable View");
        if (kind === "Image") { if (!host.src || nodes.length) fail(loc(node), "Image requires a static src asset name and has no children"); }
        else if (kind === "Text") {
          const parts: (string | AotExpr)[] = [];
          const add = (value: string | AotExpr) => { if (typeof value === "string" && !value) return; if (typeof value === "string" && typeof parts.at(-1) === "string") parts[parts.length - 1] = (parts.at(-1) as string) + value; else parts.push(value); };
          for (const child of nodes) {
            if (ts.isJsxText(child)) { if (hasJsxEntity(child.getText(item.script))) fail(loc(child), JSX_ENTITY_DIAGNOSTIC); if (!child.text.isWellFormed()) fail(loc(child), "Text cannot contain unpaired UTF-16 surrogates"); add(normalizeJsxText(child.text)); }
            else if (ts.isJsxExpression(child) && !child.dotDotDotToken) {
              if (!child.expression) continue; const value = expr(child.expression, ctx), scalar = value.type.kind === "option" ? value.type.value : value.type;
              if (scalar.kind === "boolean") fail(loc(child), "Boolean text is outside the view subset; use a string ternary");
              if (!displayable(value.type, mapper)) fail(loc(child), "Text interpolation only supports scalar values and optional scalars");
              add(value.kind === "literal" && typeof value.value === "string" ? value.value : value);
            } else fail(loc(child), "Text only accepts text and scalar expressions");
          }
          host.text = { parts, memo: component.memoCount++ };
        } else host.children = children(nodes, ctx);
        return [host];
      }
      function styles(value: AotExpr, prop: boolean, leaf = false): AotExpr {
        if (value.kind === "conditional") return { ...value, consequent: styles(value.consequent, prop, true), alternate: styles(value.alternate, prop, true), type: prop ? { kind: "style" } : I32 };
        if (value.kind === "binding" && value.scope === "prop" && value.type.kind === "style" && !leaf) return value;
        if (value.kind !== "literal" || typeof value.value !== "string") fail(value.loc, "StyleClass values require full class literal leaves or a forwarded StyleClass prop");
        const classes = value.value.trim(); if (classes) classLiterals.add(classes);
        return { ...value, value: classes, type: prop ? { kind: "style" } : I32 };
      }
      if (!jsx(returned)) fail(loc(returned), "Return a JSX element or fragment");
      component.nodes = content(returned, context, true);
      components.push(component); if (!item.declaration.typeParameters?.length) byFile.set(item.file, component);
      return component;
    });
  }
  if (root.declaration.typeParameters?.length) fail(location(entry, root.source), "A generic component requires a parent that supplies concrete props");
  for (const item of parsed.values()) if (!item.declaration.typeParameters?.length) analyze(item);
  const program = finalizeAotProgram(root.name, components, mapper, classLiterals);
  const versions: SolidAotDependencyVersion[] = [];
  for (const file of [...new Set(environment.program.getSourceFiles().map(f => resolve(f.fileName)))].sort()) { try { const stat = statSync(file); if (stat.isFile()) versions.push({ file, mtimeMs: stat.mtimeMs, size: stat.size }); } catch {} }
  dependencies.set(program, versions);
  return program;
}
