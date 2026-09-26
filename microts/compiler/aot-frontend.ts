import ts from "typescript";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { parse as parseSfc, type SFCDescriptor } from "@vue/compiler-sfc";
import { parse as parseTemplate, NodeTypes, type ElementNode, type DirectiveNode, type TemplateChildNode, type SimpleExpressionNode } from "@vue/compiler-dom";
import * as vapor from "@vue/compiler-vapor";
import { addAotContractBinding } from "./aot-contract.ts";
import { analyzeViewModel, viewModelModule, validateViewModelBindings } from "./aot-model-view.ts";
import { attachAotModel } from "./aot-ir.ts";
import { finalizeAotProgram } from "./aot-program.ts";
import { PROP, BTN } from "../../contracts/spec/spec.ts";
import { MICROTS_BUILTINS, MICROTS_ELEMENTS, MICROTS_STYLE_PROPS, MICROTS_INPUT_ELEMENTS, MICROTS_RELATIVE_AXES } from "../../contracts/spec/microts.ts";
import { MOTION_DEFAULT_MIN_QUALITY, MOTION_MIN_QUALITIES, MOTION_VALUES, motionEvent } from "./aot-motion.ts";
import { BOOL, I32, STRING, sameType, type AotProgram, type AotComponent, type AotType, type AotNode, type AotExpr, type AotHandler, type AotProp, type AotEvent, type SourceLocation } from "./aot-ir.ts";
import { TypeMapper, createTypeEnvironment, location, fail, typeName } from "./aot-types.ts";
import { expression, requireType, numeric, displayable, narrowed, type ExpressionContext } from "./aot-expressions.ts";
import { readSlotContract, readSlotBindings } from "./aot-slots.ts";
import { constraintNeedsSource, genericParameters, genericSourceType, inferGenericArgument, inferGenericSource, preservesGenericStorage, satisfiesGenericConstraint, satisfiesGenericSourceConstraint, type GenericSourceArguments } from "./aot-generics.ts";
import { analyzeContextStatement, vueContextCall } from "./aot-provide-inject.ts";
import { validateVueAotSemantics } from "./aot-browser-semantics.ts";
import type { VaporRootIR, VaporIfIR, VaporForIR, VaporCreateIR, VaporBlockIR, VaporDynamicInfo } from "./vendor/vue-vapor-ir.ts";

const LIFECYCLE = "@pocketjs/framework/vue-vapor/lifecycle";
const camelize = (name: string) => name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
const COMPONENTS = "@pocketjs/framework/vue-vapor/components", STD = "@pocketjs/framework/vue-vapor/std", INPUT = "@pocketjs/framework/vue-vapor/input";
interface ParsedComponent { file: string; source: string; descriptor: SFCDescriptor; script: ts.SourceFile; imports: Map<string, string>; contextImports: Map<string, string>; children: Map<string, string>; hosts: Map<string, "View" | "Text" | "Image">; inputHosts: Map<string, keyof typeof MICROTS_INPUT_ELEMENTS>; buttonNames: Set<string>; name: string }
export interface AnalyzeVueAotOptions { strict?: boolean; source?: string; sources?: ReadonlyMap<string, string>; root?: boolean }
export interface AotDependencyVersion { file: string; mtimeMs: number; size: number }
const dependencyVersions = new WeakMap<AotProgram, readonly AotDependencyVersion[]>();
/** Filesystem versions for cache invalidation; compiler sources and ASTs stay outside the View IR. */
export function getAotDependencyVersions(program: AotProgram): readonly AotDependencyVersion[] {
  return dependencyVersions.get(program) ?? [];
}
/** Admission, TypeScript contract analysis, and serializable View IR for all three execution classes. */
export function analyzeVueAot(entry: string, options: AnalyzeVueAotOptions = {}): AotProgram {
  entry = resolve(entry);
  const parsed = new Map<string, ParsedComponent>(), visiting = new Set<string>(), classLiterals = new Set<string>();
  function collect(file: string, override?: string): ParsedComponent {
    if (visiting.has(file)) fail(location(file, ""), "Recursive component imports are outside the AOT subset");
    const existing = parsed.get(file); if (existing) return existing;
    visiting.add(file);
    const source = override ?? options.sources?.get(file) ?? readFileSync(file, "utf8");
    const result = parseSfc(source, { filename: file });
    if (result.errors.length) fail(location(file, source), String(result.errors[0]));
    const descriptor = result.descriptor;
    if (!descriptor.template || descriptor.template.src || descriptor.template.lang || !descriptor.scriptSetup || descriptor.script || descriptor.scriptSetup.lang !== "ts" || descriptor.scriptSetup.src || descriptor.styles.length || descriptor.customBlocks.length) fail(location(file, source), 'An AOT SFC contains one <template> and one <script setup lang="ts">; no runtime script, styles, or custom blocks');
    const script = ts.createSourceFile(file + ".ts", descriptor.scriptSetup.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const item: ParsedComponent = { file, source, descriptor, script, imports: new Map(), contextImports: new Map(), children: new Map(), hosts: new Map(), inputHosts: new Map(), buttonNames: new Set(), name: typeName(basename(file, ".vue")) };
    for (const statement of script.statements) {
      const loc = location(file, source, descriptor.scriptSetup.loc.start.offset + statement.getStart(script));
      if (ts.isImportDeclaration(statement)) {
        if (!ts.isStringLiteral(statement.moduleSpecifier) || !statement.importClause) fail(loc, "Side-effect imports are runtime statements");
        const module = statement.moduleSpecifier.text, clause = statement.importClause;
        if (clause.isTypeOnly) continue;
        if (module.endsWith(".vue")) {
          if (!clause.name || clause.namedBindings || !module.startsWith(".")) fail(loc, "Child components require a relative default .vue import");
          const child = resolve(dirname(file), module); if (!existsSync(child) && !options.sources?.has(child)) fail(loc, `Cannot find child component ${module}`); item.children.set(clause.name.text, child); collect(child); continue;
        }
        if (clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) fail(loc, "Use named imports for host primitives, built-ins, and view-model bindings");
        for (const binding of clause.namedBindings.elements) {
          if (binding.isTypeOnly) continue;
          const original = binding.propertyName?.text ?? binding.name.text;
          if (module === COMPONENTS) {
            if (original in MICROTS_INPUT_ELEMENTS) item.inputHosts.set(binding.name.text, original as keyof typeof MICROTS_INPUT_ELEMENTS);
            else if (original in MICROTS_ELEMENTS) item.hosts.set(binding.name.text, original as "View" | "Text" | "Image");
            else fail(loc, `Host component ${original} is outside the AOT subset`);
          } else if (module === "vue") {
            if (original !== "provide" && original !== "inject") fail(loc, "AOT setup imports from Vue accept provide and inject");
            item.contextImports.set(binding.name.text, original);
          } else if (module === LIFECYCLE) {
            if (!["onMounted", "onUnmounted"].includes(original)) fail(loc, "AOT lifecycle imports accept onMounted and onUnmounted");
            item.contextImports.set(binding.name.text, original);
          } else if (module === STD) {
            if (!(original in MICROTS_BUILTINS)) fail(loc, `Unknown std built-in ${original}`);
          } else if (module === INPUT) {
            if (original !== "BTN") fail(loc, "AOT input imports accept BTN; input is handled by ActionHandler, AxisHandler and MotionHandler");
            item.buttonNames.add(binding.name.text);
          } else {
            if (!module.startsWith("./") || module.slice(2).toLowerCase() !== basename(file, ".vue").toLowerCase()) fail(loc, "The view-model import must use the SFC basename without an extension");
            const modulePath = resolve(dirname(file), module);
            if ((existsSync(modulePath + ".ts") || options.sources?.has(modulePath + ".ts")) && (existsSync(modulePath + ".d.ts") || options.sources?.has(modulePath + ".d.ts"))) fail(loc, "A view-model cannot have both .ts and .d.ts forms");
            if (!(existsSync(modulePath + ".ts") || options.sources?.has(modulePath + ".ts")) && !(existsSync(modulePath + ".d.ts") || options.sources?.has(modulePath + ".d.ts"))) fail(loc, `Cannot find ${module}.ts or ${module}.d.ts`);
          }
          item.imports.set(binding.name.text, module);
        }
      } else if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
        // Generic contract declarations are resolved by the component specialization.
      } else if (!ts.isVariableStatement(statement) && !(ts.isExpressionStatement(statement) && ((ts.isCallExpression(statement.expression) && ts.isIdentifier(statement.expression.expression) && ["onMounted", "onUnmounted"].includes(item.contextImports.get(statement.expression.expression.text) ?? "")) || vueContextCall(statement.expression, item.contextImports) === "provide" || ts.isCallExpression(statement.expression) && ts.isIdentifier(statement.expression.expression) && statement.expression.expression.text === "defineSlots"))) fail(loc, "Only imports, type declarations, component macros, and root provide calls are allowed in script setup");
    }
    parsed.set(file, item); visiting.delete(file); return item;
  }
  const root = collect(entry, options.source);
  // Component names are symbols at the View IR boundary; source filenames may repeat in separate folders.
  const usedNames = new Set<string>();
  for (const item of parsed.values()) { const base = item.name; let n = 2; while (usedNames.has(item.name)) item.name = base + n++; usedNames.add(item.name); }
  const modelSources = new Map([...(options.sources ?? []), ...[...parsed].map(([file, item]) => [file, item.source] as [string, string])]);
  const environment = createTypeEnvironment(modelSources, entry);
  const mapper = new TypeMapper(environment.checker, options.strict, [...parsed.values()].map(c => c.name), environment.locationOf), components: AotComponent[] = [];
  const model = analyzeViewModel(entry, [...parsed.values()].map(item => ({ file: item.file, name: item.name, factory: item.script.statements.some(statement => ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => ts.isObjectBindingPattern(declaration.name) && !!declaration.initializer && ts.isCallExpression(declaration.initializer))) })), modelSources, environment, mapper);
  const byFile = new Map<string, AotComponent>();
  const specializations = new Map<string, AotComponent>();
  const locAt = (item: ParsedComponent, offset: number) => location(item.file, item.source, offset);
  function analyzeComponent(item: ParsedComponent, arguments_ = new Map<string, AotType>(), instanceName = item.name, sourceArguments: GenericSourceArguments = new Map()): AotComponent {
    if (!item.descriptor.scriptSetup!.attrs.generic && byFile.has(item.file)) return byFile.get(item.file)!;
    return mapper.withTypeArguments(arguments_, () => {
    const { file, source, descriptor, script } = item, scriptOffset = descriptor.scriptSetup!.loc.start.offset;
    const loc = (node: ts.Node) => locAt(item, scriptOffset + node.getStart(script));
    const checkedType = (node: ts.Node): ts.Type => {
      const mapped = environment.nodeAt(file, scriptOffset + node.getStart(script), node.getWidth(script));
      if (!mapped) fail(loc(node), "Vue virtual code did not map this contract declaration");
      return environment.checker.getTypeAtLocation(mapped);
    };
    const component: AotComponent = { name: instanceName, file, root: file === entry && options.root !== false, props: [], events: [], slots: [], values: [], functions: [], constants: [], children: [], nodes: [], nodeCount: 0, memoCount: 0, handlerCount: 0 };
    const ctx: ExpressionContext = { file, mapper, environment, modelModule: viewModelModule(model, file), bindings: new Map(), functions: new Map(), builtins: new Map(), narrowings: new Map(), handler: false };
    let emitName: string | undefined, propsSeen = false, emitsSeen = false, slotsSeen = false;
    function defineSlots(call: ts.CallExpression): void {
      if (slotsSeen || call.arguments.length || call.typeArguments?.length !== 1) fail(loc(call), "Use one typed defineSlots<T>() declaration");
      slotsSeen = true;
      component.slotProps = readSlotContract(checkedType(call.typeArguments![0]!), mapper, loc(call), component.name);
      component.slots.push(...component.slotProps.map(slot => slot.name));
    }
    const factoryCalls = new Set(script.statements.flatMap(statement => ts.isVariableStatement(statement) ? statement.declarationList.declarations.flatMap(declaration => ts.isObjectBindingPattern(declaration.name) && declaration.initializer && ts.isCallExpression(declaration.initializer) && ts.isIdentifier(declaration.initializer.expression) ? [declaration.initializer.expression.text] : []) : []));
    const factoryImports = new Map<string, { sourceName: string; module: string; type: ts.Type; node: ts.Node }>();
    const addContractBinding = (name: string, sourceName: string, raw: ts.Type, at: SourceLocation, sourceNode?: ts.Node) => addAotContractBinding(component, ctx, name, sourceName, raw, at, sourceNode);
    for (const statement of script.statements) {
      if (ts.isImportDeclaration(statement)) {
        const module = (statement.moduleSpecifier as ts.StringLiteral).text, clause = statement.importClause;
        if (!clause || clause.isTypeOnly || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;
        for (const binding of clause.namedBindings.elements) {
          if (binding.isTypeOnly || module === COMPONENTS || module === INPUT || module === "vue" || module === LIFECYCLE) continue;
          const name = binding.name.text, sourceName = binding.propertyName?.text ?? name;
          if (module === STD) { ctx.builtins.set(name, sourceName); continue; }
          if (!component.root || factoryCalls.size) factoryImports.set(name, { sourceName, module, type: checkedType(binding.name), node: binding.name });
          else addContractBinding(name, sourceName, checkedType(binding.name), loc(binding), environment.nodeAt(file, scriptOffset + binding.name.getStart(script)));
        }
      }
      if (analyzeContextStatement(statement, component, item.contextImports, ctx, checkedType, loc)) continue;
      if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) && ts.isIdentifier(statement.expression.expression) && statement.expression.expression.text === "defineSlots") { defineSlots(statement.expression); continue; }
      if (!ts.isVariableStatement(statement)) continue;
      if (!(statement.declarationList.flags & ts.NodeFlags.Const) || statement.declarationList.declarations.length !== 1) fail(loc(statement), "A component macro requires one const declaration");
      const declaration = statement.declarationList.declarations[0]!;
      if (ts.isObjectBindingPattern(declaration.name)) {
        if (component.factory || !declaration.initializer || !ts.isCallExpression(declaration.initializer) || !ts.isIdentifier(declaration.initializer.expression)) fail(loc(declaration), "A stateful child has one destructured call to its imported factory");
        const call = declaration.initializer, factoryName = (call.expression as ts.Identifier).text, factory = factoryImports.get(factoryName);
        if (!factory || call.typeArguments?.length) fail(loc(declaration), "A child factory is an imported function from the component's module");
        const signatures = factory.type.getCallSignatures();
        if (signatures.length !== 1 || signatures[0]!.typeParameters?.length) fail(loc(declaration), "A child factory must have one non-generic signature");
        const parameters = signatures[0]!.getParameters().map(parameter => {
          const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0];
          if (!declaration || ts.isParameter(declaration) && (declaration.questionToken || declaration.dotDotDotToken || declaration.initializer)) fail(loc(call), "Factory parameters require a fixed set of mount-time values");
          return { name: parameter.name, type: mapper.map(environment.checker.getTypeOfSymbolAtLocation(parameter, declaration), loc(call), typeName(parameter.name)) };
        });
        if (call.arguments.length !== parameters.length) fail(loc(call), `Factory ${factory.sourceName} expects ${parameters.length} mount-time arguments`);
        const arguments_ = call.arguments.map((argument, index) => {
          const value = expression(argument.getText(script), loc(argument), ctx, parameters[index]!.type); requireType(value, parameters[index]!.type, ctx);
          const inspect = (node: AotExpr): void => {
            if (node.kind === "call" && node.target === "vm") fail(node.loc, "Factory arguments must be mount-time values without view-model method calls");
            for (const [key, child] of Object.entries(node)) if (!["type", "loc"].includes(key)) {
              if (Array.isArray(child)) for (const item of child) { if (item && typeof item === "object" && "kind" in item) inspect(item as AotExpr); }
              else if (child && typeof child === "object" && "kind" in child) inspect(child as AotExpr);
            }
          }; inspect(value); return value;
        });
        const result = signatures[0]!.getReturnType();
        if (!(result.flags & ts.TypeFlags.Object) || (result as ts.ObjectType).objectFlags & (ts.ObjectFlags.Class | ts.ObjectFlags.Mapped) || result.symbol?.declarations?.some(d => ts.isClassDeclaration(d) || ts.isClassExpression(d)) || result.getCallSignatures().length || environment.checker.getIndexInfosOfType(result).length) fail(loc(declaration), "A child factory returns an object of view-model values and methods");
        component.factory = { name: factoryName, sourceName: factory.sourceName, module: factory.module, ...(parameters.length ? { params: parameters, arguments: arguments_ } : {}) };
        for (const binding of declaration.name.elements) {
          if (!ts.isIdentifier(binding.name) || binding.dotDotDotToken || binding.initializer || binding.propertyName && !ts.isIdentifier(binding.propertyName) && !ts.isStringLiteral(binding.propertyName)) fail(loc(binding), "Factory destructuring accepts named bindings and aliases, without defaults or rest bindings");
          const sourceName = binding.propertyName ? (binding.propertyName as ts.Identifier | ts.StringLiteral).text : binding.name.text;
          const property = result.getProperty(sourceName), propertyNode = property?.valueDeclaration ?? property?.declarations?.[0];
          if (!property || !propertyNode) fail(loc(binding), `The factory does not return ${sourceName}`);
          addContractBinding(binding.name.text, sourceName, environment.checker.getTypeOfSymbolAtLocation(property, propertyNode), loc(binding), propertyNode);
        }
        continue;
      }
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !ts.isCallExpression(declaration.initializer)) fail(loc(declaration), "Runtime variables outside component macros and the child factory are unsupported");
      const name = declaration.name.text; let call = declaration.initializer, defaults: ts.ObjectLiteralExpression | undefined;
      if (ts.isIdentifier(call.expression) && call.expression.text === "defineSlots") { defineSlots(call); continue; }
      if (ts.isIdentifier(call.expression) && call.expression.text === "withDefaults") {
        if (call.arguments.length !== 2 || !ts.isCallExpression(call.arguments[0]!) || !ts.isObjectLiteralExpression(call.arguments[1]!)) fail(loc(call), "withDefaults requires defineProps<T>() and an object of literal defaults");
        defaults = call.arguments[1]; call = call.arguments[0];
      }
      if (!ts.isIdentifier(call.expression) || !["defineProps", "defineEmits", "defineModel"].includes(call.expression.text) || call.typeArguments?.length !== 1) fail(loc(call), "Only typed defineProps, defineEmits, and defineModel macros are accepted");
      const macro = call.expression.text, typeNode = call.typeArguments![0]!, type = checkedType(typeNode);
      if (defaults && macro !== "defineProps") fail(loc(call), "withDefaults is only supported with defineProps");
      if (macro === "defineProps") {
        if (propsSeen || call.arguments.length) fail(loc(call), "Use one defineProps<T>() declaration"); propsSeen = true; ctx.propsName = name;
        if (type.getCallSignatures().length || !type.isClassOrInterface() && !(type.flags & ts.TypeFlags.Object)) fail(loc(call), "defineProps requires an object type");
        component.props.push(...mapper.fields(type, loc(typeNode), item.name + "Props"));
        if (defaults) for (const property of defaults.properties) {
          if (!ts.isPropertyAssignment(property) || !property.name || !ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) fail(loc(property), "Prop defaults must use named literal properties");
          const prop = component.props.find(p => p.name === property.name.getText(script).replace(/^['"]|['"]$/g, ""));
          if (!prop) fail(loc(property), "Default names an undeclared prop");
          const expected = prop.type.kind === "option" ? prop.type.value : prop.type;
          const value = expression(property.initializer.getText(script), loc(property.initializer), ctx, expected);
          if (value.kind !== "literal" && !(value.kind === "unary" && value.operator === "-" && value.operand.kind === "literal" && typeof value.operand.value === "number")) fail(loc(property), "Defaults must be literal strings, numbers, booleans, or enum literals");
          requireType(value, expected, ctx);
          prop.default = value.kind === "literal" ? value.value : -(value.operand as Extract<AotExpr, {kind: "literal"}>).value as number;
          if (value.kind === "literal" && value.rawNumber !== undefined) prop.defaultRawNumber = value.rawNumber;
          prop.type = expected;
        }
        for (const prop of component.props) ctx.bindings.set(`props.${prop.name}`, { type: prop.type, scope: "prop" });
      } else if (macro === "defineEmits") {
        if (emitsSeen || call.arguments.length || type.getCallSignatures().length) fail(loc(call), "defineEmits accepts one tuple-form declaration"); emitsSeen = true; emitName = name;
        for (const property of type.getProperties()) {
          const declaration = property.valueDeclaration ?? property.declarations![0]!;
          const tuple = environment.checker.getTypeOfSymbolAtLocation(property, declaration);
          if (!environment.checker.isTupleType(tuple)) fail(loc(call), `Event ${property.name} must use a tuple payload`);
          const elements = environment.checker.getTypeArguments(tuple as ts.TypeReference);
          const labels = (tuple as ts.TupleTypeReference).target.labeledElementDeclarations;
          component.events.push({ name: property.name, parameters: elements.map((t, i) => ({ name: labels?.[i] && ts.isNamedTupleMember(labels[i]!) ? (labels[i] as ts.NamedTupleMember).name.text : `arg${i}`, type: mapper.map(t, loc(call), `${item.name}${typeName(property.name)}${i}`) })) });
        }
      } else {
        let model = "modelValue";
        if (call.arguments.length && ts.isStringLiteral(call.arguments[0]!)) model = (call.arguments[0] as ts.StringLiteral).text;
        const config = call.arguments[typeof call.arguments[0] !== "undefined" && ts.isStringLiteral(call.arguments[0]!) ? 1 : 0];
        if (call.arguments.length > (model === "modelValue" && !ts.isStringLiteral(call.arguments[0] ?? ts.factory.createIdentifier("")) ? 1 : 2)) fail(loc(call), "defineModel accepts a literal name and optional required: true");
        if (config && (!ts.isObjectLiteralExpression(config) || config.properties.some(p => !ts.isPropertyAssignment(p) || p.name.getText(script) !== "required" || p.initializer.kind !== ts.SyntaxKind.TrueKeyword))) fail(loc(config), "defineModel options only support required: true");
        if (component.props.some(p => p.name === model)) fail(loc(call), `Duplicate model prop ${model}`);
        const typeIR = mapper.map(type, loc(call), `${item.name}${typeName(model)}`);
        component.props.push({ name: model, type: typeIR, model });
        component.events.push({ name: `update:${model}`, parameters: [{ name: "value", type: typeIR }] });
        ctx.bindings.set(name, { type: typeIR, scope: "prop", model });
      }
    }
    if (factoryImports.size && (!component.factory || factoryImports.size !== 1)) fail(loc(factoryImports.values().next().value!.node), "A child may import only the factory used by its destructured setup declaration");
    for (const statement of script.statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression) || !ts.isIdentifier(statement.expression.expression)) continue;
      const call = statement.expression, imported = item.contextImports.get((call.expression as ts.Identifier).text);
      if (imported !== "onMounted" && imported !== "onUnmounted") continue;
      if (!component.root && !component.factory) fail(loc(call), "Lifecycle hooks require a root or factory component");
      const callback = call.arguments[0];
      if (call.typeArguments?.length || call.arguments.length !== 1 || !callback || !ts.isArrowFunction(callback) || callback.parameters.length || !ts.isCallExpression(callback.body) || !ts.isIdentifier(callback.body.expression) || callback.body.arguments.length || callback.body.typeArguments?.length) fail(loc(call), "Lifecycle hooks require a zero-argument view-model call");
      const fn = ctx.functions.get(callback.body.expression.text);
      if (!fn || fn.parameters.length) fail(loc(call), "Lifecycle hooks require a zero-argument view-model method");
      const name = imported === "onMounted" ? "mount" : "unmount";
      if (component.hooks?.[name]) fail(loc(call), `Duplicate ${name} lifecycle hook`);
      fn.handler = true;
      (component.hooks ??= {})[name] = { kind: "call", id: component.handlerCount++, loc: loc(call), expression: expression(callback.body.getText(script), loc(callback.body), { ...ctx, handler: true }) };
    }
    const templateOffset = descriptor.template!.loc.start.offset;
    const tplLoc = (node: { loc: { start: { offset: number } } }) => locAt(item, templateOffset + node.loc.start.offset);
    const parseOptions = { isCustomElement: (tag: string) => item.hosts.has(tag) || item.inputHosts.has(tag), onError: (error: { message: string; loc?: { start: { offset: number } } }) => fail(locAt(item, templateOffset + (error.loc?.start.offset ?? 0)), error.message) };
    // Vapor creates the structural blocks before language-neutral analysis.
    const vaporIr = vapor.transform(parseTemplate(descriptor.template!.content, parseOptions), {
      ...parseOptions, filename: file, prefixIdentifiers: true,
      nodeTransforms: [vapor.transformVOnce, vapor.transformVIf, vapor.transformVFor, vapor.transformKey, vapor.transformSlotOutlet, vapor.transformTemplateRef, vapor.transformElement, vapor.transformText, vapor.transformVSlot, vapor.transformComment, vapor.transformChildren],
      directiveTransforms: { bind: vapor.transformVBind, on: vapor.transformVOn, text: vapor.transformVText, show: vapor.transformVShow, model: vapor.transformVModel },
    }) as unknown as VaporRootIR;
    if (vaporIr.type !== 0 || vaporIr.block.type !== 1) fail(locAt(item, templateOffset), "Unexpected Vapor IR");
    const ast = vaporIr.node;
    const vaporIf = new Map<number, VaporIfIR>(), vaporFor = new Map<number, VaporForIR>();
    const vaporElements = new Map<number, VaporCreateIR>();
    const visited = new WeakSet<object>();
    function readVapor(value: unknown): void {
      if (!value || typeof value !== "object" || visited.has(value)) return;
      visited.add(value);
      if (Array.isArray(value)) { value.forEach(readVapor); return; }
      const record = value as Record<string, unknown>;
      if (record.type === 15 && record.positive) {
        const op = value as VaporIfIR; vaporIf.set(op.positive.node.loc.start.offset, op);
      } else if (record.type === 16 && record.render) {
        const op = value as VaporForIR; vaporFor.set(op.render.node.loc.start.offset, op);
      } else if (record.type === 1 && record.dynamic && record.node) {
        const block = value as VaporBlockIR;
        function associate(node: VaporBlockIR["node"], info: VaporDynamicInfo): void {
          if (info.operation?.type === 12) vaporElements.set(node.loc.start.offset, info.operation as VaporCreateIR);
          if (node.type === NodeTypes.ROOT || node.type === NodeTypes.ELEMENT) node.children.forEach((child, i) => { if (info.children[i]) associate(child, info.children[i]!); });
        }
        associate(block.node, block.dynamic);
      }
      for (const [key, child] of Object.entries(record)) if (!["node", "ast", "loc"].includes(key)) readVapor(child);
    }
    readVapor(vaporIr.block);

    const expr = (node: SimpleExpressionNode | undefined, context = ctx, expected?: AotType) => {
      if (!node || node.type !== NodeTypes.SIMPLE_EXPRESSION || !node.content.trim()) fail(node ? tplLoc(node) : locAt(item, templateOffset), "A directive requires an expression");
      return expression(node.content, tplLoc(node), context, expected);
    };
    const directive = (node: ElementNode, name: string) => node.props.find(p => p.type === NodeTypes.DIRECTIVE && p.name === name) as DirectiveNode | undefined;
    const argument = (d: DirectiveNode) => {
      if (!d.arg || d.arg.type !== NodeTypes.SIMPLE_EXPRESSION || !d.arg.isStatic) fail(tplLoc(d), "Directive arguments must be static names");
      return d.arg.content;
    };
    function handler(content: string, at: SourceLocation, context: ExpressionContext, event?: AotEvent, attribute = true): AotHandler {
      const hctx = { ...context, bindings: new Map(context.bindings), handler: true };
      if (event?.parameters.length) hctx.bindings.set("$event", { type: event.parameters[0]!.type, scope: "event" });
      // As in Vue, an inline statement reads the first payload value as $event
      // and a method handler receives every value its parameters name. The
      // later values bind only for that generated call, never for source text.
      // Only a whole attribute is a method handler; a name inside a statement
      // block stays a reference.
      const method = attribute && event && event.parameters.length > 1 && /^[A-Za-z_$][\w$]*$/.test(content.trim()) ? context.functions.get(content.trim()) : undefined;
      if (method) {
        event!.parameters.forEach((parameter, index) => { if (index) hctx.bindings.set(`$event${index}`, { type: parameter.type, scope: "event" }); });
        content = `${content.trim()}(${method.parameters.map((_, index) => index ? `$event${index}` : "$event").join(", ")})`;
      }
      const sourceFile = ts.createSourceFile("handler.ts", content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const statement = sourceFile.statements[0];
      const parseErrors = (sourceFile as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics;
      if (parseErrors.length) fail(at, "Invalid handler statement syntax");
      if (sourceFile.statements.length !== 1 || !statement || !ts.isExpressionStatement(statement)) {
        const hasEmit = (step: AotHandler): boolean => step.kind === "emit" || step.kind === "sequence" && step.steps.some(hasEmit) || step.kind === "if" && [...step.then, ...(step.else ?? [])].some(hasEmit);
        const atNode = (node: ts.Node) => locAt(item, at.offset + node.getStart(sourceFile));
        const list = (statements: readonly ts.Statement[], scope: ExpressionContext): AotHandler[] => {
          const steps = statements.map(stmt => {
            if (ts.isExpressionStatement(stmt)) return handler(stmt.expression.getText(sourceFile), atNode(stmt.expression), scope, event, false);
            if (ts.isIfStatement(stmt)) {
              const condition = expression(stmt.expression.getText(sourceFile), atNode(stmt.expression), { ...scope, bindings: hctx.bindings, handler: true }, BOOL);
              requireType(condition, BOOL, scope);
              const branch = (body: ts.Statement, truth: boolean) => list(ts.isBlock(body) ? body.statements : [body], narrowed(scope, condition, truth));
              return { kind: "if" as const, id: component.handlerCount++, condition, then: branch(stmt.thenStatement, true), ...(stmt.elseStatement ? { else: branch(stmt.elseStatement, false) } : {}), loc: atNode(stmt) };
            }
            fail(atNode(stmt), "Handler blocks accept expression statements and if statements only");
          });
          if (steps.slice(0, -1).some(hasEmit)) fail(at, "An emit must be the last statement of its handler or final branch");
          return steps;
        };
        return { kind: "sequence", id: component.handlerCount++, steps: list(sourceFile.statements, context), loc: at };
      }
      const node = statement.expression, id = component.handlerCount++;
      const handlerLoc = (child: ts.Node) => locAt(item, at.offset + child.getStart(sourceFile));
      if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression) && node.expression.text === emitName && hctx.bindings.get(node.expression.text)?.scope !== "local") {
          const first = node.arguments[0]; if (!first || !ts.isStringLiteral(first)) fail(at, "emit requires a literal event name");
          const declared = component.events.find(e => e.name === first.text); if (!declared) fail(at, `Undeclared event ${first.text}`);
          if (node.arguments.length !== declared.parameters.length + 1) fail(at, `Event ${first.text} expects ${declared.parameters.length} payload values`);
          return { kind: "emit", id, name: first.text, arguments: node.arguments.slice(1).map((a, i) => { const value = expression(a.getText(sourceFile), handlerLoc(a), hctx, declared.parameters[i]!.type); requireType(value, declared.parameters[i]!.type, hctx); return value; }), loc: at };
        }
        const value = expression(content, at, hctx);
        if (value.kind !== "call" || value.target !== "vm") fail(at, "A handler call must name a view-model function");
        return { kind: "call", id, expression: value, loc: at };
      }
      // Vue evaluates a bare function reference in a statement without calling it.
      if (!attribute && ts.isIdentifier(node) && context.functions.has(node.text)) fail(at, `A reference to ${node.text} does nothing in a handler statement; call it`);
      let target: ts.Expression | undefined, valueSource: string | undefined, valueLoc = at;
      if (ts.isPostfixUnaryExpression(node) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) {
        target = node.operand; valueLoc = handlerLoc(target);
        valueSource = `${target.getText(sourceFile)} ${node.operator === ts.SyntaxKind.PlusPlusToken ? "+" : "-"} 1`;
      } else if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken].includes(node.operatorToken.kind)) {
        target = node.left;
        if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          valueSource = node.right.getText(sourceFile); valueLoc = handlerLoc(node.right);
        } else {
          // Reuse the '=' character's position for the opening parenthesis. Every
          // original operand keeps its source offset, including comments/newlines.
          const operator = node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken ? "+" : "-";
          valueSource = content.slice(0, node.operatorToken.getStart(sourceFile)) + operator + "(" + content.slice(node.operatorToken.end, node.end) + ")";
        }
      }
      if (!target || !ts.isIdentifier(target) || !valueSource) fail(at, "Assignments must target a view-model value or defineModel binding");
      const binding = hctx.bindings.get(target.text); if (!binding || binding.constant !== undefined || binding.scope !== "vm" && !binding.model) fail(at, "Assignments must target a view-model value or defineModel binding");
      const value = expression(valueSource, valueLoc, hctx, binding.type); requireType(value, binding.type, hctx);
      if (binding.model) return { kind: "emit", id, name: `update:${binding.model}`, arguments: [value], loc: at };
      component.values.find(v => v.name === target.text)!.writable = true;
      return { kind: "assign", id, name: target.text, value, loc: at };
    }
    function nodes(children: TemplateChildNode[], context: ExpressionContext): AotNode[] {
      const result: AotNode[] = [];
      for (let i = 0; i < children.length; i++) {
        const child = children[i]!;
        if (child.type === NodeTypes.COMMENT || child.type === NodeTypes.TEXT && !child.content.trim()) continue;
        if (child.type !== NodeTypes.ELEMENT) fail(tplLoc(child), "Text and interpolation must appear inside Text");
        const condition = directive(child, "if");
        if (condition) {
          const operation = vaporIf.get(child.loc.start.offset);
          if (!operation) fail(tplLoc(child), "Vapor did not produce the conditional block");
          const group: Extract<AotNode, {kind:"if"}> = { kind: "if", id: component.nodeCount++, branches: [], loc: tplLoc(child) };
          let branchCtx = context, branch: VaporIfIR | VaporBlockIR | undefined = operation;
          let consumedOffset = child.loc.start.offset;
          while (branch) {
            const conditional: VaporIfIR | undefined = branch.type === 15 ? branch : undefined;
            const block: VaporBlockIR = conditional ? conditional.positive : branch as VaporBlockIR;
            const test = conditional ? expr(conditional.condition, branchCtx, BOOL) : undefined;
            if (test) requireType(test, BOOL, branchCtx);
            const blockChildren = (block.node.type === NodeTypes.ROOT || block.node.type === NodeTypes.ELEMENT) ? block.node.children : [];
            group.branches.push({ ...(test ? { condition: test } : {}), children: nodes(blockChildren, test ? narrowed(branchCtx, test, true) : branchCtx) });
            consumedOffset = Math.max(consumedOffset, block.node.loc.start.offset);
            if (test) branchCtx = narrowed(branchCtx, test, false);
            branch = conditional ? conditional.negative : undefined;
          }
          while (children[i + 1] && children[i + 1]!.loc.start.offset <= consumedOffset) i++;
          result.push(group); continue;
        }
        if (directive(child, "else") || directive(child, "else-if")) fail(tplLoc(child), "v-else and v-else-if must follow v-if");
        result.push(...element(child, context));
      }
      return result;
    }
    function element(node: ElementNode, context: ExpressionContext, ignored = new Set<string>()): AotNode[] {
      const at = tplLoc(node), loop = directive(node, "for");
      if (loop && !ignored.has("for")) {
        const operation = vaporFor.get(node.loc.start.offset);
        if (!operation || !operation.value || operation.index) fail(tplLoc(loop), "v-for accepts item in list or (item, i) in list");
        if (!/^[A-Za-z_$][\w$]*$/.test(operation.value.content) || operation.key && !/^[A-Za-z_$][\w$]*$/.test(operation.key.content)) fail(tplLoc(loop), "v-for bindings must be identifiers");
        const source = expr(operation.source, context);
        if (source.type.kind !== "array") fail(tplLoc(loop), "v-for only accepts arrays");
        const id = component.nodeCount++;
        const itemName = operation.value.content, index = operation.key?.content, rowContext = { ...context, bindings: new Map(context.bindings) };
        if (itemName === index) fail(tplLoc(loop), "The v-for item and index must have distinct names");
        const resolvedItem = `${component.name}Loop${id}Item`, resolvedIndex = `${component.name}Loop${id}Index`;
        rowContext.bindings.set(itemName, { type: source.type.element, scope: "local", resolvedName: resolvedItem });
        if (index) rowContext.bindings.set(index, { type: I32, scope: "local", resolvedName: resolvedIndex });
        if (!operation.keyProp) fail(at, "v-for requires :key");
        const key = expr(operation.keyProp, rowContext), keyDecl = mapper.declaration(key.type);
        if (!(key.type.kind === "string" || key.type.kind === "number" && ["i32", "i64"].includes(key.type.name) || keyDecl?.kind === "enum")) fail(key.loc, "v-for keys must be i32, i64, string, or a string-literal enum");
        const renderChildren = (operation.render.node.type === NodeTypes.ROOT || operation.render.node.type === NodeTypes.ELEMENT) ? operation.render.node.children : [];
        return [{ kind: "for", id, source, item: resolvedItem, ...(index ? {index: resolvedIndex} : {}), itemType: source.type.element, key, children: nodes(renderChildren, rowContext), loc: at }];
      }
      const tag = item.hosts.get(node.tag), childFile = item.children.get(node.tag);
      let child: AotComponent | undefined;
      if (childFile) {
        const childItem = parsed.get(childFile)!, generic = childItem.descriptor.scriptSetup!.attrs.generic;
        if (generic !== undefined) {
          if (typeof generic !== "string") fail(at, "generic requires TypeScript type parameter declarations");
          const parameters = genericParameters(childFile, childItem.source, generic, environment, at);
          const names = new Set(parameters.map(p => p.name));
          let inferred = new Map<string, AotType>();
          const inferredSources: GenericSourceArguments = new Map();
          const missingSources = new Set<string>();
          const childOffset = childItem.descriptor.scriptSetup!.loc.start.offset;
          for (const statement of childItem.script.statements) if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
            let call = declaration.initializer;
            if (call && ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === "withDefaults") call = call.arguments[0];
            if (!call || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || !["defineProps", "defineModel"].includes(call.expression.text) || !call.typeArguments?.[0]) continue;
            const typeNode = call.typeArguments[0], mapped = environment.nodeAt(childFile, childOffset + typeNode.getStart(childItem.script), typeNode.getWidth(childItem.script));
            if (!mapped) fail(at, "Cannot resolve generic component props");
            const raw = environment.checker.getTypeAtLocation(mapped);
            for (const attribute of node.props) {
              let propName: string | undefined, actual: AotExpr | undefined;
              if (attribute.type === NodeTypes.DIRECTIVE && ["bind", "model"].includes(attribute.name) && attribute.exp?.type === NodeTypes.SIMPLE_EXPRESSION) {
                propName = attribute.name === "model" && !attribute.arg ? "modelValue" : attribute.arg?.type === NodeTypes.SIMPLE_EXPRESSION && attribute.arg.isStatic ? camelize(attribute.arg.content) : undefined;
                if (propName && (call.expression.text === "defineModel" || raw.getProperty(propName))) actual = expr(attribute.exp, context);
              } else if (attribute.type === NodeTypes.ATTRIBUTE) {
                propName = camelize(attribute.name);
                if (raw.getProperty(propName)) actual = expression(attribute.value ? JSON.stringify(attribute.value.content) : "true", tplLoc(attribute), context);
              }
              if (!actual || !propName) continue;
              const actualSource = genericSourceType(actual, environment, attribute.type === NodeTypes.DIRECTIVE && attribute.exp?.type === NodeTypes.SIMPLE_EXPRESSION ? attribute.exp.content.length : undefined);
              const infer = (pattern: ts.Type) => {
                let argument = actual!;
                const constraint = pattern.flags & ts.TypeFlags.TypeParameter ? parameters.find(parameter => parameter.name === pattern.symbol.name)?.constraint : undefined;
                const literalNumber = argument.kind === "literal" && typeof argument.value === "number" || argument.kind === "unary" && ["+", "-"].includes(argument.operator) && argument.operand.kind === "literal" && typeof argument.operand.value === "number";
                if (literalNumber && constraint && (constraint.flags & ts.TypeFlags.NumberLike || constraint.getProperty("__type")) && attribute.type === NodeTypes.DIRECTIVE && attribute.exp?.type === NodeTypes.SIMPLE_EXPRESSION) {
                  const expected = mapper.map(constraint, tplLoc(attribute), `${childItem.name}${pattern.symbol.name}Constraint`);
                  if (numeric(expected, mapper)) argument = expr(attribute.exp, context, expected);
                }
                const argumentTypes = new Map<string, AotType>();
                inferGenericArgument(pattern, argument.type, names, argumentTypes, mapper, tplLoc(attribute));
                const sourceTypes: GenericSourceArguments = new Map();
                if (actualSource) inferGenericSource(pattern, actualSource, names, sourceTypes, sourceArguments, mapper);
                for (const [name, type] of argumentTypes) {
                  const previous = inferred.get(name);
                  if (previous && !sameType(previous, type)) fail(tplLoc(attribute), `Conflicting inferred types for generic parameter ${name}`);
                  inferred.set(name, type);
                  const types = sourceTypes.get(name);
                  if (!types?.length) missingSources.add(name);
                  else inferredSources.set(name, [...new Set([...(inferredSources.get(name) ?? []), ...types])]);
                }
              };
              const modelName = call.arguments[0] && ts.isStringLiteral(call.arguments[0]) ? call.arguments[0].text : "modelValue";
              if (call.expression.text === "defineModel") {
                if (modelName === propName) infer(raw);
              } else {
                const property = raw.getProperty(propName), declaration = property?.valueDeclaration ?? property?.declarations?.[0];
                if (property && declaration) infer(environment.checker.getTypeOfSymbolAtLocation(property, declaration));
              }
            }
          }
          mapper.withTypeArguments(inferred, () => {
            for (const parameter of parameters) {
              if (!inferred.has(parameter.name) && parameter.default) {
                inferred.set(parameter.name, mapper.map(parameter.default, at, `${childItem.name}${parameter.name}`));
                inferredSources.set(parameter.name, parameter.default.flags & ts.TypeFlags.TypeParameter ? inferredSources.get(parameter.default.symbol.name) ?? [] : [parameter.default]);
              }
              const actual = inferred.get(parameter.name);
              if (!actual) fail(at, `Cannot infer generic parameter ${parameter.name} of ${childItem.name} from supplied props`);
            }
            for (const parameter of parameters) {
              const actual = inferred.get(parameter.name)!;
              if (parameter.constraint) {
                const expected = mapper.map(parameter.constraint, at, `${childItem.name}${parameter.name}Constraint`);
                const originals = inferredSources.get(parameter.name);
                const sourceRequired = constraintNeedsSource(parameter.constraint, mapper);
                const fits = missingSources.has(parameter.name) && sourceRequired ? false
                  : originals?.length ? originals.every(original => satisfiesGenericSourceConstraint(original, parameter.constraint!, inferredSources, mapper))
                  : !sourceRequired && satisfiesGenericConstraint(actual, expected, mapper);
                if (!fits || !preservesGenericStorage(actual, expected, mapper)) fail(at, `Generic argument ${parameter.name} does not satisfy its constraint in ${childItem.name}`);
              }
            }
          });
          inferred = new Map(parameters.map(parameter => [parameter.name, inferred.get(parameter.name)!]));
          const key = JSON.stringify([childFile, [...inferred], parameters.map(parameter => inferredSources.get(parameter.name)?.map(type => environment.checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation)).sort())]);
          child = specializations.get(key);
          if (!child) {
            const base = `${childItem.name}Instance`; let suffix = 1, name = `${base}${suffix}`;
            while (usedNames.has(name)) name = `${base}${++suffix}`;
            usedNames.add(name);
            child = analyzeComponent(childItem, inferred, name, inferredSources); specializations.set(key, child);
          }
        } else child = analyzeComponent(childItem);
        if (!component.children.includes(child.name)) component.children.push(child.name);
      }
      if (node.tag === "template") {
        for (const prop of node.props) if (prop.type !== NodeTypes.DIRECTIVE || !ignored.has(prop.name) && !(prop.name === "bind" && prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION && prop.arg.content === "key" && ignored.has("key"))) fail(tplLoc(prop), "A template fragment only accepts structural directives");
        return nodes(node.children, context);
      }
      if (node.tag === "slot") {
        let name = "default";
        for (const prop of node.props) if (prop.type === NodeTypes.ATTRIBUTE && prop.name === "name" && prop.value) name = prop.value.content;
        if (slotsSeen && !component.slots.includes(name)) fail(at, `Slot ${name} is not declared by defineSlots`);
        const contract = component.slotProps?.find(slot => slot.name === name), values: { name: string; value: AotExpr }[] = [];
        for (const attribute of node.props) {
          if (attribute.type === NodeTypes.ATTRIBUTE && attribute.name === "name" && attribute.value) continue;
          if (attribute.type === NodeTypes.DIRECTIVE && ignored.has(attribute.name)) continue;
          if (attribute.type === NodeTypes.DIRECTIVE && (attribute.name !== "bind" || attribute.modifiers.length)) fail(tplLoc(attribute), "Slot outlets accept named typed props and a static slot name");
          const propName = camelize(attribute.type === NodeTypes.ATTRIBUTE ? attribute.name : argument(attribute));
          if (propName === "name") fail(tplLoc(attribute), "Slot outlets require a static name");
          const parameter = contract?.parameters.find(prop => prop.name === propName);
          if (!parameter) fail(tplLoc(attribute), `Slot ${name} has no declared ${propName} prop`);
          if (values.some(value => value.name === propName)) fail(tplLoc(attribute), `Duplicate slot prop ${propName}`);
          const value = attribute.type === NodeTypes.ATTRIBUTE ? expression(attribute.value ? JSON.stringify(attribute.value.content) : "true", tplLoc(attribute), context, parameter.type) : expr(attribute.exp as SimpleExpressionNode, context, parameter.type);
          requireType(value, parameter.type, context); values.push({ name: propName, value });
        }
        for (const parameter of contract?.parameters ?? []) if (!values.some(value => value.name === parameter.name)) {
          if (parameter.type.kind !== "option") fail(at, `Missing required ${name} slot prop ${parameter.name}`);
          values.push({ name: parameter.name, value: { kind: "undefined", type: parameter.type, loc: at } });
        }
        if (!component.slots.includes(name)) component.slots.push(name);
        return [{ kind: "slot", id: component.nodeCount++, name, ...(values.length ? { props: values } : {}), fallback: nodes(node.children, context), loc: at }];
      }
      const inputTag = item.inputHosts.get(node.tag);
      if (inputTag) {
        let active: AotExpr = { kind: "literal", value: true, type: BOOL, loc: at }, latched = false;
        let button: { name: string; value: number } | undefined, axis: { name: string; value: number } | undefined, motion: keyof typeof MOTION_VALUES | undefined, minQuality: keyof typeof MOTION_MIN_QUALITIES = MOTION_DEFAULT_MIN_QUALITY;
        let action: AotHandler | undefined, pendingMotion: { content: string; at: SourceLocation } | undefined;
        const seen = new Set<string>();
        for (const attribute of node.props) {
          if (attribute.type === NodeTypes.DIRECTIVE && ignored.has(attribute.name)) continue;
          const name = attribute.type === NodeTypes.ATTRIBUTE ? attribute.name : attribute.name === "bind" || attribute.name === "on" ? argument(attribute) : "";
          if (!name || seen.has(name)) fail(tplLoc(attribute), `Unsupported or duplicate ${inputTag} attribute`);
          seen.add(name);
          if (attribute.type === NodeTypes.DIRECTIVE) {
            if (attribute.modifiers.length) fail(tplLoc(attribute), "Input directive modifiers are unsupported");
            if (attribute.name === "on") {
              const eventName = MICROTS_INPUT_ELEMENTS[inputTag].events[0];
              if (name !== eventName || !attribute.exp || attribute.exp.type !== NodeTypes.SIMPLE_EXPRESSION) fail(tplLoc(attribute), `${inputTag} requires @${eventName} with one handler`);
              // A motion payload depends on :value, which may follow the handler.
              if (inputTag === "MotionHandler") pendingMotion = { content: attribute.exp.content, at: tplLoc(attribute.exp) };
              else action = handler(attribute.exp.content, tplLoc(attribute.exp), context, inputTag === "AxisHandler" ? { name: "delta", parameters: [{ name: "delta", type: I32 }] } : undefined);
            } else if (name === "active") {
              active = expr(attribute.exp as SimpleExpressionNode, context, BOOL); requireType(active, BOOL, context);
            } else if (name === "latched" && inputTag === "ActionHandler") {
              const value = expr(attribute.exp as SimpleExpressionNode, context, BOOL); requireType(value, BOOL, context);
              if (value.kind !== "literal" || typeof value.value !== "boolean") fail(tplLoc(attribute), "latched must be a static boolean");
              latched = value.value;
            } else if (name === "button" && inputTag === "ActionHandler") {
              const value = attribute.exp as SimpleExpressionNode | undefined;
              const buttonSource = ts.createSourceFile("button.ts", `(${value?.content ?? ""})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
              const buttonStatement = buttonSource.statements[0];
              let buttonExpression = buttonStatement && ts.isExpressionStatement(buttonStatement) ? buttonStatement.expression : undefined;
              while (buttonExpression && ts.isParenthesizedExpression(buttonExpression)) buttonExpression = buttonExpression.expression;
              if (!buttonExpression || !ts.isPropertyAccessExpression(buttonExpression) || buttonExpression.questionDotToken || !ts.isIdentifier(buttonExpression.expression) || !item.buttonNames.has(buttonExpression.expression.text) || context.bindings.has(buttonExpression.expression.text)) fail(tplLoc(attribute), "button must be a static member of BTN imported from @pocketjs/framework/vue-vapor/input");
              const name = buttonExpression.name.text, valueId = BTN[name as keyof typeof BTN];
              if (valueId === undefined) fail(tplLoc(attribute), `Unknown BTN member ${name}`);
              button = { name, value: valueId };
            } else if (name === "axis" && inputTag === "AxisHandler") {
              const value = expr(attribute.exp as SimpleExpressionNode, context, STRING);
              if (value.kind !== "literal" || typeof value.value !== "string" || !(value.value in MICROTS_RELATIVE_AXES)) fail(tplLoc(attribute), "axis must be the static literal primary or secondary");
              axis = { name: value.value, value: MICROTS_RELATIVE_AXES[value.value as keyof typeof MICROTS_RELATIVE_AXES] };
            } else if ((name === "value" || name === "minQuality") && inputTag === "MotionHandler") {
              const value = expr(attribute.exp as SimpleExpressionNode, context, STRING), table = name === "value" ? MOTION_VALUES : MOTION_MIN_QUALITIES;
              if (value.kind !== "literal" || typeof value.value !== "string" || !(value.value in table)) fail(tplLoc(attribute), `${name} must be a static literal: ${Object.keys(table).join(", ")}`);
              if (name === "value") motion = value.value as keyof typeof MOTION_VALUES; else minQuality = value.value as keyof typeof MOTION_MIN_QUALITIES;
            } else fail(tplLoc(attribute), `${inputTag} does not accept :${name}`);
          } else if (name === "active" && !attribute.value) active = { kind: "literal", value: true, type: BOOL, loc: tplLoc(attribute) };
          else if (name === "latched" && inputTag === "ActionHandler" && !attribute.value) latched = true;
          else if (name === "axis" && inputTag === "AxisHandler" && attribute.value && attribute.value.content in MICROTS_RELATIVE_AXES) axis = { name: attribute.value.content, value: MICROTS_RELATIVE_AXES[attribute.value.content as keyof typeof MICROTS_RELATIVE_AXES] };
          else if (name === "value" && inputTag === "MotionHandler" && attribute.value && attribute.value.content in MOTION_VALUES) motion = attribute.value.content as keyof typeof MOTION_VALUES;
          else if (name === "minQuality" && inputTag === "MotionHandler" && attribute.value && attribute.value.content in MOTION_MIN_QUALITIES) minQuality = attribute.value.content as keyof typeof MOTION_MIN_QUALITIES;
          else fail(tplLoc(attribute), `${inputTag} requires typed bindings for ${name}`);
        }
        if (inputTag === "MotionHandler" && !motion) fail(at, "MotionHandler requires a static value");
        if (motion && pendingMotion) action = handler(pendingMotion.content, pendingMotion.at, context, motionEvent(motion));
        if (!action) fail(at, `${inputTag} requires its event handler`);
        if (inputTag === "ActionHandler" && !button) fail(at, "ActionHandler requires :button=BTN.NAME");
        if (inputTag === "AxisHandler" && !axis) fail(at, "AxisHandler requires a static axis");
        const input: Extract<AotNode, { kind: "input" }>["input"] = button ? { kind: "button", name: button.name, button: button.value, latched } : axis ? { kind: "axis", name: axis.name, axis: axis.value } : { kind: "motion", name: motion!, value: MOTION_VALUES[motion!].id, minQuality: MOTION_MIN_QUALITIES[minQuality] };
        return [{ kind: "input", id: component.nodeCount++, input, active, handler: action, children: nodes(node.children, context), loc: at }];
      }
      const creation = vaporElements.get(node.loc.start.offset);
      if (tag && (!creation || !creation.useCreateElement || creation.tag !== node.tag)) fail(at, "Vapor must lower each host primitive to an explicit create-element operation");
      if (!tag && !child) fail(at, `Element ${node.tag} is not an imported host primitive or child component`);
      const host: Extract<AotNode, {kind:"element"}> = { kind: "element", id: component.nodeCount++, tag: tag ?? "View", style: -1, props: [], focusable: false, events: [], children: [], loc: at };
      const instance: Extract<AotNode, {kind:"component"}> = { kind: "component", id: host.id, component: child?.name ?? "", props: [], events: [], slots: [], loc: at };
      let staticClass = "", classBinding: SimpleExpressionNode | undefined, textBinding: AotExpr | undefined;
      for (const attribute of node.props) {
        if (attribute.type === NodeTypes.DIRECTIVE) {
          const d = attribute;
          if (ignored.has(d.name)) continue;
          if (d.modifiers.length) fail(tplLoc(d), "Directive modifiers are outside the AOT subset");
          if (d.name === "bind" && argument(d) === "key" && ignored.has("key")) continue;
          if (d.name === "on") {
            const name = argument(d);
            if (tag && (tag !== "View" || name !== "press")) fail(tplLoc(d), `${tag} has no ${name} event`);
            const event = child?.events.find(e => camelize(e.name) === camelize(name));
            if (child && !event) fail(tplLoc(d), `Child ${child.name} does not emit ${name}`);
            if (!d.exp || d.exp.type !== NodeTypes.SIMPLE_EXPRESSION) fail(tplLoc(d), "An event requires a handler expression");
            (child ? instance : host).events.push({ name: event?.name ?? name, handler: handler(d.exp.content, tplLoc(d.exp), context, event) });
          } else if (d.name === "bind") {
            const name = argument(d);
            if (name === "ref" && tag) {
              const value = d.exp?.type === NodeTypes.SIMPLE_EXPRESSION ? d.exp.content.trim() : "";
              if (!component.refs?.some(slot => slot.name === value)) fail(tplLoc(d), ":ref requires a model createNodeRef binding");
              host.ref = value; continue;
            }
            if (name === "class" && tag) { classBinding = d.exp as SimpleExpressionNode; continue; }
            if (name === "style" && tag === "View") {
              const value = d.exp as SimpleExpressionNode | undefined; if (!value) fail(tplLoc(d), ":style requires an object literal");
              const sf = ts.createSourceFile("style.ts", `(${value.content})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), statement = sf.statements[0];
              const obj = statement && ts.isExpressionStatement(statement) && ts.isParenthesizedExpression(statement.expression) ? statement.expression.expression : undefined;
              if (!obj || !ts.isObjectLiteralExpression(obj)) fail(tplLoc(d), ":style requires an object literal");
              for (const p of obj.properties) {
                if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name) && !ts.isStringLiteral(p.name)) fail(tplLoc(d), ":style uses static named numeric properties");
                const name = p.name.text, spec = MICROTS_STYLE_PROPS[name as keyof typeof MICROTS_STYLE_PROPS]; if (!spec) fail(tplLoc(d), `Unknown numeric style property ${name}`);
                const valueLoc = tplLoc(value); valueLoc.offset += p.initializer.getStart(sf) - 1;
                const expected: AotType = spec.unit ? mapper.unit(spec.unit) : { kind: "number", name: spec.type };
                // First preserve integer arithmetic, then widen the complete host-attribute expression.
                let e = expression(p.initializer.getText(sf), valueLoc, context);
                const literalArithmetic = (value: AotExpr): boolean => value.kind === "literal" || value.kind === "unary" && literalArithmetic(value.operand) || value.kind === "binary" && literalArithmetic(value.left) && literalArithmetic(value.right);
                if (spec.unit === "Color" || literalArithmetic(e) || numeric(e.type, mapper)?.name.startsWith("f")) e = expression(p.initializer.getText(sf), valueLoc, context, expected);
                const n = numeric(e.type, mapper);
                if (spec.type === "f32" && n && !n.name.startsWith("f") && e.type.kind === "number") e = { kind: "cast", value: e, type: expected, loc: e.loc };
                requireType(e, expected, context);
                host.props.push({ name, prop: spec.id, value: e, memo: component.memoCount++ });
              }
              continue;
            }
            const prop = child?.props.find(p => p.name === camelize(name));
            if (!prop) fail(tplLoc(d), `${child?.name ?? tag} does not accept :${name}`);
            const value = expr(d.exp as SimpleExpressionNode, context, prop.type); requireType(value, prop.type, context); instance.props.push({ name: prop.name, value });
          } else if (d.name === "model") {
            if (!child) fail(tplLoc(d), "v-model is supported on child components only");
            const name = d.arg ? camelize(argument(d)) : "modelValue", prop = child.props.find(p => p.model === name);
            if (!prop) fail(tplLoc(d), `Child ${child.name} has no model ${name}`);
            const value = expr(d.exp as SimpleExpressionNode, context, prop.type); requireType(value, prop.type, context); instance.props.push({ name: prop.name, value });
            instance.events.push({ name: `update:${name}`, handler: handler(`${(d.exp as SimpleExpressionNode).content} = $event`, tplLoc(d), context, child.events.find(e => e.name === `update:${name}`)) });
          } else if (d.name === "show") {
            if (!tag) fail(tplLoc(d), "v-show requires a host primitive");
            const value = expr(d.exp as SimpleExpressionNode, context, BOOL); requireType(value, BOOL, context);
            host.props.push({ name: "display", prop: PROP.display, value: { kind: "conditional", condition: value, consequent: { kind: "literal", value: 0, type: I32, loc: value.loc }, alternate: { kind: "literal", value: 1, type: I32, loc: value.loc }, type: I32, loc: value.loc }, memo: component.memoCount++ });
          } else if (d.name === "text") {
            if (tag !== "Text" || node.children.length) fail(tplLoc(d), "v-text requires Text with no children");
            textBinding = expr(d.exp as SimpleExpressionNode, context);
          } else fail(tplLoc(d), `Directive v-${d.name} is outside the AOT subset`);
        } else {
          const name = attribute.name, value = attribute.value?.content;
          if (tag) {
            if (name === "class") staticClass = value ?? "";
            else if (name === "focusable" && tag === "View" && value === undefined) host.focusable = true;
            else if (name === "debug-name" && tag === "View" && value !== undefined) host.debugName = value;
            else if (name === "src" && tag === "Image" && value !== undefined) host.src = value;
            else fail(tplLoc(attribute), `${tag} does not accept ${name}`);
          } else {
            const prop = child!.props.find(p => p.name === camelize(name)); if (!prop) fail(tplLoc(attribute), `${child!.name} does not declare prop ${name}`);
            const e = expression(value === undefined ? "true" : JSON.stringify(value), tplLoc(attribute), context, prop.type); requireType(e, prop.type, context); instance.props.push({ name: prop.name, value: e });
          }
        }
      }
      if (child) {
        const names = new Set<string>();
        for (const prop of instance.props) { if (names.has(prop.name)) fail(at, `Duplicate prop ${prop.name}`); names.add(prop.name); }
        for (const prop of child.props) if (!names.has(prop.name)) {
          if (prop.default !== undefined) instance.props.push({ name: prop.name, value: { kind: "literal", value: prop.default, ...(prop.defaultRawNumber !== undefined ? { rawNumber: prop.defaultRawNumber } : {}), type: prop.type, loc: at } });
          else if (prop.type.kind === "option") instance.props.push({ name: prop.name, value: { kind: "undefined", type: prop.type, loc: at } });
          else fail(at, `Missing required ${child.name} prop ${prop.name}`);
        }
        const defaultChildren: TemplateChildNode[] = [];
        for (const content of node.children) {
          if (content.type === NodeTypes.ELEMENT && content.tag === "template" && directive(content, "slot")) {
            const slot = directive(content, "slot")!; if (content.props.length !== 1 || slot.modifiers.length) fail(tplLoc(slot), "Slot declarations accept a static name and optional props destructuring");
            const name = slot.arg ? argument(slot) : "default";
            if (!child.slots.includes(name)) fail(tplLoc(slot), `Child ${child.name} has no ${name} slot`);
            if (instance.slots.some(s => s.name === name)) fail(tplLoc(slot), `Duplicate slot ${name}`);
            const scoped = slot.exp && slot.exp.type === NodeTypes.SIMPLE_EXPRESSION ? readSlotBindings(slot.exp.content, child.slotProps?.find(s => s.name === name), context, tplLoc(slot.exp), `${component.name}Slot${instance.id}_${instance.slots.length}_`) : undefined;
            instance.slots.push({ name, ...(scoped ? { bindings: scoped.bindings } : {}), children: nodes(content.children, scoped?.context ?? context) });
          } else defaultChildren.push(content);
        }
        if (defaultChildren.some(n => n.type !== NodeTypes.COMMENT && !(n.type === NodeTypes.TEXT && !n.content.trim()))) {
          if (!child.slots.includes("default")) fail(at, `Child ${child.name} has no default slot`);
          if (instance.slots.some(s => s.name === "default")) fail(at, "Duplicate default slot");
          instance.slots.push({ name: "default", children: nodes(defaultChildren, context) });
        }
        return [instance];
      }
      if (host.events.length && !host.focusable) fail(at, "@press requires a focusable View");
      if (tag === "Image" && (!host.src || node.children.length)) fail(at, "Image requires a static src asset name and has no children");
      if (classBinding) {
        const value = expr(classBinding, context);
        function styles(e: AotExpr): AotExpr {
          if (e.kind === "conditional") return { ...e, consequent: styles(e.consequent), alternate: styles(e.alternate), type: I32 };
          if (e.kind !== "literal" || typeof e.value !== "string") fail(e.loc, ":class must be a ternary with full class literal leaves");
          const classes = `${staticClass} ${e.value}`.trim(); if (classes) classLiterals.add(classes);
          return { ...e, value: classes, type: I32 };
        }
        if (value.type.kind === "style") {
          if (staticClass) fail(value.loc, "A static class cannot be combined with a StyleClass prop");
          if (value.kind !== "binding" || value.scope !== "prop") fail(value.loc, "A StyleClass binding must forward an unchanged prop");
          host.dynamicStyle = { id: component.memoCount++, expression: value };
        } else {
          if (value.kind !== "conditional") fail(value.loc, ":class must be a ternary or chain of ternaries");
          host.dynamicStyle = { id: component.memoCount++, expression: styles(value) };
        }
      } else if (staticClass) { classLiterals.add(staticClass); (host as typeof host & { classLiteral?: string }).classLiteral = staticClass; }
      if (tag === "Text") {
        const parts: (string | AotExpr)[] = [];
        if (textBinding) parts.push(textBinding);
        else for (const content of node.children) {
          if (content.type === NodeTypes.TEXT) { if (!content.content.isWellFormed()) fail(tplLoc(content), "Text cannot contain unpaired UTF-16 surrogates"); parts.push(content.content); }
          else if (content.type === NodeTypes.INTERPOLATION) parts.push(expr(content.content as SimpleExpressionNode, context));
          else if (content.type !== NodeTypes.COMMENT) fail(tplLoc(content), "Text only accepts text and interpolation");
        }
        for (const part of parts) if (typeof part !== "string" && !displayable(part.type, mapper)) fail(part.loc, "Text interpolation only supports scalar values and optional scalars");
        host.text = { parts, memo: component.memoCount++ };
      } else host.children = nodes(node.children, context);
      return [host];
    }
    component.nodes = nodes(ast.children, ctx);
    components.push(component); if (!descriptor.scriptSetup!.attrs.generic) byFile.set(file, component);
    return component;
    });
  }
  if (root.descriptor.scriptSetup!.attrs.generic !== undefined) fail(location(entry, root.source), "A generic component requires a parent that supplies concrete props");
  for (const item of parsed.values()) if (item.descriptor.scriptSetup!.attrs.generic === undefined) analyzeComponent(item);
  const program = finalizeAotProgram(root.name, components, mapper, classLiterals);
  if (model) attachAotModel(program, model);
  validateViewModelBindings(program);
  validateVueAotSemantics(program, new Map([...parsed].map(([file, item]) => [file, item.source])));
  const dependencies = new Set(environment.program.getSourceFiles().map(file => resolve(file.fileName)));
  const config = ts.findConfigFile(dirname(entry), ts.sys.fileExists, "tsconfig.json");
  if (config) dependencies.add(resolve(config));
  const versions: AotDependencyVersion[] = [];
  for (const file of [...dependencies].sort()) {
    try { const stat = statSync(file); if (stat.isFile()) versions.push({ file, mtimeMs: stat.mtimeMs, size: stat.size }); }
    catch { /* Vue virtual files and source overrides have no filesystem version. */ }
  }
  dependencyVersions.set(program, versions);
  return program;
}
