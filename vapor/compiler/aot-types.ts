import ts from "typescript";
import { VAPOR_NUMERIC_TYPES, VAPOR_UNIT_TYPES } from "../../contracts/spec/vapor.ts";
import { createVueLanguagePlugin, getDefaultCompilerOptions, type Language } from "@vue/language-core";
import { proxyCreateProgram } from "@volar/typescript/lib/node/proxyCreateProgram";
import { dirname, resolve } from "node:path";
import { AotCompileError, type AotDiagnostic, type AotType, type AotTypeDeclaration, type SourceLocation, type NumericName } from "./aot-ir.ts";

const NUMERIC = new Set<string>(VAPOR_NUMERIC_TYPES);
export function location(file: string, source: string, offset = 0): SourceLocation {
  const before = source.slice(0, offset), lines = before.split("\n");
  return { file, line: lines.length, column: lines.at(-1)!.length + 1, offset };
}
export function fail(loc: SourceLocation, message: string): never { throw new AotCompileError([{ ...loc, severity: "error", message }]); }
export function typeName(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^a-zA-Z0-9]+/).filter(Boolean);
  return words.map(w => w[0]!.toUpperCase() + w.slice(1)).join("") || "Anonymous";
}
/** Exact decimal spelling for mathematically integral numeric tokens, before JS Number rounds them. */
export function exactIntegerLiteral(text: string): string | undefined {
  text = text.replaceAll("_", "");
  const sign = text.startsWith("-") ? -1n : 1n;
  if (/^[+-]/.test(text)) text = text.slice(1);
  if (/^0[xob][0-9a-f]+$/i.test(text)) { try { return (sign * BigInt(text)).toString(); } catch { return undefined; } }
  const match = /^(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match || !match[1] && !match[2]) return undefined;
  let digits = (match[1] ?? "") + (match[2] ?? "");
  const exponent = Number(match[3] ?? 0) - (match[2]?.length ?? 0);
  if (Math.abs(exponent) > 256) return undefined;
  if (exponent >= 0) digits += "0".repeat(exponent);
  else {
    const count = -exponent;
    if (count > digits.length || !/^0*$/.test(digits.slice(-count))) return undefined;
    digits = digits.slice(0, -count) || "0";
  }
  return (sign * BigInt(digits)).toString();
}
export function constantNumericSpelling(checker: ts.TypeChecker, node: ts.Node | undefined, seen = new Set<ts.Node>()): string | undefined {
  if (!node || seen.has(node)) return undefined;
  seen.add(node);
  if (ts.isNumericLiteral(node)) return exactIntegerLiteral(node.getText());
  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) {
    const value = exactIntegerLiteral(node.operand.getText());
    if (value !== undefined && [ts.SyntaxKind.MinusToken, ts.SyntaxKind.PlusToken].includes(node.operator)) return (node.operator === ts.SyntaxKind.MinusToken ? -BigInt(value) : BigInt(value)).toString();
  }
  if (ts.isLiteralTypeNode(node)) return constantNumericSpelling(checker, node.literal, seen);
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isTypeAssertionExpression(node)) return constantNumericSpelling(checker, node.expression, seen);
  if (ts.isVariableDeclaration(node)) return constantNumericSpelling(checker, node.type, seen) ?? constantNumericSpelling(checker, node.initializer, seen);
  if (ts.isTypeAliasDeclaration(node)) return constantNumericSpelling(checker, node.type, seen);
  if (ts.isTypeReferenceNode(node)) return constantNumericSpelling(checker, node.typeName, seen);
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  for (const declaration of symbol?.declarations ?? []) {
    const raw = constantNumericSpelling(checker, declaration, seen); if (raw !== undefined) return raw;
  }
  return undefined;
}
export interface TypeEnvironment {
  program: ts.Program; checker: ts.TypeChecker;
  nodeAt(file: string, offset: number, width?: number): ts.Node | undefined;
  typeAt(file: string, offset: number): ts.Type | undefined;
  locationOf(node: ts.Node): SourceLocation;
}
/** Use the same Vue virtual code and mapping table as vue-tsc, including its control-flow branches. */
export function createTypeEnvironment(files: Map<string, string>, entry = files.keys().next().value as string): TypeEnvironment {
  const base = resolve(import.meta.dir, "../..");
  const configPath = ts.findConfigFile(dirname(entry), ts.sys.fileExists, "tsconfig.json");
  let configured: ts.CompilerOptions = {};
  if (configPath) {
    const readConfig = ts.readConfigFile(configPath, ts.sys.readFile);
    if (readConfig.error) fail(location(configPath, ts.sys.readFile(configPath) ?? ""), ts.flattenDiagnosticMessageText(readConfig.error.messageText, " "));
    const config = ts.parseJsonConfigFileContent(readConfig.config, ts.sys, dirname(configPath), undefined, configPath);
    const error = config.errors.find(d => d.category === ts.DiagnosticCategory.Error && d.code !== 18003);
    if (error) fail(location(configPath, ts.sys.readFile(configPath) ?? ""), ts.flattenDiagnosticMessageText(error.messageText, " "));
    configured = config.options;
  }
  const options: ts.CompilerOptions = {
    ...configured,
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve, strict: true, skipLibCheck: true, allowNonTsExtensions: true, allowImportingTsExtensions: true, noEmit: true,
    baseUrl: configured.baseUrl, paths: {
      ...configured.paths,
      "@pocketjs/framework/solid/components": [resolve(base, "framework/src/components.ts")],
      "@pocketjs/framework/solid/std": [resolve(base, "framework/src/std-vue-vapor.ts")],
      "@pocketjs/framework/solid/lifecycle": [resolve(base, "framework/src/lifecycle.ts")],
      "@pocketjs/framework/input": [resolve(base, "framework/src/input-api.ts")],
      "@pocketjs/framework/vue-vapor/components": [resolve(base, "framework/src/components-vue-vapor.ts")],
      "@pocketjs/framework/vue-vapor/std": [resolve(base, "framework/src/std-vue-vapor.ts")],
    },
  };
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host);
  const exists = host.fileExists.bind(host);
  host.fileExists = path => files.has(resolve(path)) || exists(path);
  const directoryExists = host.directoryExists?.bind(host);
  host.directoryExists = path => [...files.keys()].some(file => file.startsWith(resolve(path) + "/")) || !!directoryExists?.(path);
  host.readFile = path => files.get(resolve(path)) ?? read(path);
  host.getSourceFile = (path, languageVersion) => {
    const text = host.readFile(path);
    return text === undefined ? undefined : ts.createSourceFile(path, text, languageVersion, true);
  };
  host.resolveModuleNames = (names, containingFile) => names.map(name => {
    // Explicit .tsx imports name views; extensionless imports name their contracts.
    // TypeScript otherwise prefers App.tsx over the sibling App.d.ts.
    if (name.startsWith(".") && !/\.[^/]+$/.test(name)) {
      const base = resolve(dirname(containingFile), name);
      for (const [suffix, extension] of [[".ts", ts.Extension.Ts], [".d.ts", ts.Extension.Dts]] as const) {
        if (host.fileExists(base + suffix)) return { resolvedFileName: base + suffix, extension };
      }
    }
    return ts.resolveModuleName(name, containingFile, options, host).resolvedModule;
  });
  let language!: Language<string>;
  const createProgram = proxyCreateProgram(ts, ts.createProgram, () => ({
    languagePlugins: [createVueLanguagePlugin(ts, options, getDefaultCompilerOptions(3.6, "vue", true), id => id)],
    setup(value) { language = value; },
  }));
  const program = [...files.keys()].some(file => file.endsWith(".vue"))
    ? createProgram({ rootNames: [...files.keys()], options, host })
    : ts.createProgram({ rootNames: [...files.keys()], options, host });
  const checker = program.getTypeChecker();
  function nodeAt(file: string, offset: number, width = 1): ts.Node | undefined {
    const script = language?.scripts.get(file);
    const service = (script?.generated?.languagePlugin as { typescript?: { getServiceScript(root: unknown): { code: { mappings: { sourceOffsets: number[]; generatedOffsets: number[]; lengths: number[]; generatedLengths?: number[] }[] }; preventLeadingOffset?: boolean } | undefined } } | undefined)?.typescript?.getServiceScript(script!.generated!.root);
    const sourceFile = program.getSourceFile(file);
    if (!sourceFile) return undefined;
    if (!file.endsWith(".vue")) {
      let best: ts.Node | undefined;
      function visit(node: ts.Node) {
        if (node.getStart(sourceFile) <= offset && node.end >= offset + width) {
          best = node;
          ts.forEachChild(node, visit);
        }
      }
      visit(sourceFile);
      return best;
    }
    if (!service) return undefined;
    // A service script starts after an equal-length blank copy of the original SFC.
    const leading = service.preventLeadingOffset ? 0 : files.get(file)?.length ?? 0;
    let best: ts.Node | undefined;
    for (const mapping of service.code.mappings) {
      for (let i = 0; i < mapping.sourceOffsets.length; i++) {
        const start = mapping.sourceOffsets[i]!, length = mapping.lengths[i]!;
        if (offset < start || offset > start + length) continue;
        const generated = leading + mapping.generatedOffsets[i]! + Math.min(offset - start, mapping.generatedLengths?.[i] ?? length);
        function visit(node: ts.Node) {
          if (node.getStart(sourceFile) <= generated && node.end >= generated + width) {
            if (!best || node.getWidth(sourceFile) <= best.getWidth(sourceFile)) best = node;
            ts.forEachChild(node, visit);
          }
        }
        visit(sourceFile);
      }
    }
    return best;
  }
  function locationOf(node: ts.Node): SourceLocation {
    const sf = node.getSourceFile(), original = files.get(sf.fileName);
    if (original === undefined) return location(sf.fileName, sf.text, node.getStart(sf));
    if (!sf.fileName.endsWith(".vue")) return location(sf.fileName, original, node.getStart(sf));
    const script = language?.scripts.get(sf.fileName);
    const service = (script?.generated?.languagePlugin as { typescript?: { getServiceScript(root: unknown): { code: { mappings: { sourceOffsets: number[]; generatedOffsets: number[]; lengths: number[]; generatedLengths?: number[] }[] }; preventLeadingOffset?: boolean } | undefined } } | undefined)?.typescript?.getServiceScript(script!.generated!.root);
    if (service) {
      const offset = node.getStart(sf) - (service.preventLeadingOffset ? 0 : original.length);
      for (const m of service.code.mappings) for (let i = 0; i < m.generatedOffsets.length; i++) {
        const start = m.generatedOffsets[i]!, length = m.generatedLengths?.[i] ?? m.lengths[i]!;
        if (offset >= start && offset <= start + length) return location(sf.fileName, original, m.sourceOffsets[i]! + Math.min(offset - start, m.lengths[i]!));
      }
    }
    return location(sf.fileName, original);
  }
  return { program, checker, nodeAt, locationOf, typeAt(file, offset) { const node = nodeAt(file, offset); return node ? checker.getTypeAtLocation(node) : undefined; } };
}

export class TypeMapper {
  readonly declarations: AotTypeDeclaration[] = [];
  readonly diagnostics: AotDiagnostic[] = [];
  private readonly names = new Map<ts.Type, string>();
  private typeArguments = new Map<string, AotType>();
  private readonly specializedNames = new Map<string, Map<ts.Type, string>>();
  private readonly parameterized = new Map<ts.Type, boolean>();
  private readonly units = new Map<keyof typeof VAPOR_UNIT_TYPES, AotType>();
  private readonly usedNames = new Map<string, ts.Type>();
  private readonly warned = new Set<string>();
  private readonly reserved = new Set(["Ui", "NodeId", "StyleId", "Input", "String", "Vec", "Option", "Block", "KeyedList", "SlotHandle", "Self"]);
  constructor(readonly checker: ts.TypeChecker, readonly strict = false, componentNames: string[] = [], readonly sourceLocation?: (node: ts.Node) => SourceLocation) {
    for (const name of componentNames) for (const suffix of ["Props", "Event", "View", "ViewModel", "App"]) this.reserved.add(name + suffix);
  }
  unwrap(type: ts.Type): ts.Type {
    const accessor = solidTypeAlias(type, "Accessor", this.checker);
    if (accessor) return accessor;
    const refNames = new Set(["Ref", "ShallowRef", "ComputedRef", "WritableComputedRef", "ModelRef"]);
    const vueRef = [type.aliasSymbol, type.symbol].some(symbol => symbol && refNames.has(symbol.name) && symbol.declarations?.some(declaration => /\/node_modules\/(?:@vue\/(?:reactivity|runtime-core)|vue)\//.test(declaration.getSourceFile().fileName.replaceAll("\\", "/"))));
    if (vueRef) {
      const args = (type.flags & ts.TypeFlags.Object) ? this.checker.getTypeArguments(type as ts.TypeReference) : [];
      // Vue Ref's setter type retains the author's T before UnwrapRef creates a mapped getter shape.
      // Recover it only when getter and candidate are assignable in both directions.
      if (args.length > 1) {
        const candidates = args[1]!.isUnion() ? args[1]!.types : [args[1]!];
        const original = candidates.find(candidate => {
          const element = this.checker.isArrayType(candidate) ? this.checker.getTypeArguments(candidate as ts.TypeReference)[0]! : candidate;
          return element.symbol?.name !== "__type" && !!element.symbol && this.checker.isTypeAssignableTo(args[0]!, candidate) && this.checker.isTypeAssignableTo(candidate, args[0]!);
        });
        if (original) return original;
      }
      const value = type.getProperty("value");
      if (value) return this.checker.getTypeOfSymbolAtLocation(value, value.valueDeclaration ?? value.declarations![0]!);
    }
    return type;
  }
  literal(type: ts.Type): string | number | boolean | undefined {
    if (type.isStringLiteral() || type.isNumberLiteral()) return type.value;
    if (type.flags & ts.TypeFlags.BooleanLiteral) return (type as ts.Type & { intrinsicName: string }).intrinsicName === "true";
    return undefined;
  }
  declaration(type: AotType): AotTypeDeclaration | undefined { return type.kind === "named" ? this.declarations.find(d => d.name === type.name) : undefined; }
  /** Each concrete component instantiation has a type-parameter environment. */
  withTypeArguments<T>(arguments_: Map<string, AotType>, action: () => T): T {
    const previous = this.typeArguments;
    this.typeArguments = arguments_;
    try { return action(); } finally { this.typeArguments = previous; }
  }
  private dependsOnParameter(type: ts.Type, seen = new Set<ts.Type>()): boolean {
    if (type.flags & ts.TypeFlags.TypeParameter) return true;
    const cached = this.parameterized.get(type); if (cached !== undefined) return cached;
    if (seen.has(type)) return false;
    seen.add(type);
    let result = false;
    if (type.isUnionOrIntersection()) result = type.types.some(t => this.dependsOnParameter(t, seen));
    else if (this.checker.isArrayType(type) || this.checker.isTupleType(type)) result = this.checker.getTypeArguments(type as ts.TypeReference).some(t => this.dependsOnParameter(t, seen));
    else if (type.flags & ts.TypeFlags.Object) result = type.getProperties().some(p => {
      const node = p.valueDeclaration ?? p.declarations?.[0];
      return !!node && this.dependsOnParameter(this.checker.getTypeOfSymbolAtLocation(p, node), seen);
    });
    this.parameterized.set(type, result); return result;
  }
  private namesFor(type: ts.Type): Map<ts.Type, string> {
    if (!this.dependsOnParameter(type)) return this.names;
    const key = JSON.stringify([...this.typeArguments]);
    let names = this.specializedNames.get(key);
    if (!names) this.specializedNames.set(key, names = new Map());
    return names;
  }
  private reuseSpecializedShape(type: ts.Type, declaration: AotTypeDeclaration): AotType | undefined {
    const symbol = type.aliasSymbol ?? type.symbol;
    if (!symbol) return;
    const shape = ({ name: _name, ...rest }: AotTypeDeclaration) => JSON.stringify(rest);
    const existing = this.declarations.find(candidate => {
      const original = this.usedNames.get(candidate.name);
      return original && (original.aliasSymbol ?? original.symbol) === symbol && shape(candidate) === shape(declaration);
    });
    if (!existing) return;
    this.namesFor(type).set(type, existing.name);
    this.usedNames.delete(declaration.name);
    return { kind: "named", name: existing.name };
  }
  map(raw: ts.Type, loc: SourceLocation, hint: string, allowVoid = false): AotType {
    const type = this.unwrap(raw);
    if (type.isIntersection() && type.getProperty("__style") && type.types.some(t => !!(t.flags & ts.TypeFlags.String))) return { kind: "style" };
    if (type.flags & ts.TypeFlags.TypeParameter) {
      const argument = this.typeArguments.get(type.symbol?.name ?? "");
      if (argument) return argument;
    }
    if (type.isStringLiteral() && !type.value.isWellFormed() || type.isUnion() && type.types.some(member => member.isStringLiteral() && !member.value.isWellFormed())) fail(loc, "String literals cannot contain unpaired UTF-16 surrogates");
    if (type.isNumberLiteral() && !Number.isFinite(type.value)) fail(loc, "Numeric literal is outside the finite f64 range");
    if (type.flags & ts.TypeFlags.Void) { if (allowVoid) return { kind: "void" }; fail(loc, "void is only supported as a function return type"); }
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never | ts.TypeFlags.Null | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.TypeParameter | ts.TypeFlags.Conditional | ts.TypeFlags.TemplateLiteral | ts.TypeFlags.NonPrimitive)) fail(loc, `Unsupported contract type ${this.checker.typeToString(type)}`);
    if (type.flags & ts.TypeFlags.Undefined) fail(loc, "undefined is only supported as part of an optional contract type");
    if (type.flags & ts.TypeFlags.BooleanLike || type.isUnion() && type.types.every(t => !!(t.flags & ts.TypeFlags.BooleanLiteral))) return { kind: "boolean" };
    if (type.flags & ts.TypeFlags.StringLike) return { kind: "string" };
    if (type.flags & ts.TypeFlags.NumberLike) {
      if (!(type.flags & ts.TypeFlags.NumberLiteral)) {
        const key = `${loc.file}:${loc.offset}:${hint}`;
        if (!this.warned.has(key)) {
          this.warned.add(key);
          const message = `${hint}: unannotated number maps to f64; use an explicit numeric type`;
          if (this.strict) fail(loc, message);
          this.diagnostics.push({ ...loc, severity: "warning", message });
        }
      }
      return { kind: "number", name: "f64" };
    }
    const known = this.namesFor(type).get(type);
    if (known) return { kind: "named", name: known };
    if (type.isUnion()) {
      if (type.types.some(member => !!(member.flags & ts.TypeFlags.Null))) fail(loc, "null is not supported in contract positions; use undefined");
      const members = type.types.filter(t => !(t.flags & ts.TypeFlags.Undefined));
      if (members.length !== type.types.length) {
        const value = members.length === 1 ? members[0]! : this.checker.getNonNullableType(type);
        return { kind: "option", value: this.map(value, loc, hint) };
      }
      if (members.every(t => t.isStringLiteral())) {
        const name = this.reserve(type, hint);
        this.declarations.push({ kind: "enum", name, variants: members.map(t => (t as ts.StringLiteralType).value) });
        return { kind: "named", name };
      }
      if (!type.aliasSymbol || !members.every(t => !!(t.flags & ts.TypeFlags.Object))) fail(loc, "Unions must be string literals, named discriminated unions, or T | undefined");
      const discriminant = members[0]!.getProperties().find(property => {
        const values = members.map(member => {
          const field = member.getProperty(property.name);
          return field ? this.literal(this.checker.getTypeOfSymbolAtLocation(field, field.valueDeclaration ?? field.declarations![0]!)) : undefined;
        });
        return values.every(v => typeof v === "string") && new Set(values).size === members.length;
      });
      if (!discriminant) fail(loc, "A discriminated union needs a shared property with distinct string literals");
      const name = this.reserve(type, hint);
      const variants = members.map(member => ({
        name: this.literal(this.checker.getTypeOfSymbolAtLocation(member.getProperty(discriminant.name)!, member.getProperty(discriminant.name)!.declarations![0]!)) as string,
        fields: this.fields(member, loc, name, new Set([discriminant.name])),
      }));
      const declaration: AotTypeDeclaration = { kind: "union", name, discriminant: discriminant.name, variants };
      const existing = this.reuseSpecializedShape(type, declaration); if (existing) return existing;
      this.declarations.push(declaration);
      return { kind: "named", name };
    }
    if (type.isIntersection()) {
      const tag = type.getProperty("__type"), newtype = type.getProperty("__newtype");
      const tagValue = (symbol: ts.Symbol) => {
        const t = this.checker.getNonNullableType(this.checker.getTypeOfSymbolAtLocation(symbol, symbol.declarations![0]!));
        return this.literal(t);
      };
      const numeric = tag && tagValue(tag), label = newtype && tagValue(newtype);
      if (newtype && typeof label !== "string") fail(loc, "__newtype must have one string literal type");
      let base: AotType;
      if (typeof numeric === "string" && NUMERIC.has(numeric)) base = { kind: "number", name: numeric as NumericName };
      else {
        const primitive = type.types.filter(t => !(t.flags & ts.TypeFlags.Object));
        if (primitive.length !== 1 || tag) fail(loc, "Intersections support only numeric and __newtype tags");
        if (label === "Color" && primitive[0]!.flags & ts.TypeFlags.TemplateLiteral) {
          const template = primitive[0] as ts.TemplateLiteralType;
          if (template.texts.length !== 2 || template.texts[0] !== "#" || template.texts[1] !== "" || template.types.length !== 1 || !(template.types[0]!.flags & ts.TypeFlags.String)) fail(loc, "Color must use the #${string} template literal type");
          base = { kind: "number", name: "u32" };
        } else base = this.map(primitive[0]!, loc, hint);
      }
      const allowed = new Set(["__type", "__newtype"]);
      for (const member of type.types) if (member.flags & ts.TypeFlags.Object && member.getProperties().some(p => !allowed.has(p.name))) fail(loc, "Intersections support only numeric and __newtype tags");
      if (!newtype) return base;
      if (typeof label === "string" && label in VAPOR_UNIT_TYPES) {
        const unit = label as keyof typeof VAPOR_UNIT_TYPES;
        if (base.kind !== "number" || base.name !== VAPOR_UNIT_TYPES[unit].base) fail(loc, `${unit} requires the ${VAPOR_UNIT_TYPES[unit].base} representation`);
        const mapped = this.unit(unit); this.names.set(type, (mapped as { name: string }).name); return mapped;
      }
      const name = this.reserve(type, label as string, true);
      this.declarations.push({ kind: "newtype", name, base });
      return { kind: "named", name };
    }
    if (this.checker.isTupleType(type)) {
      const tuple = type as ts.TupleTypeReference;
      if (tuple.target.elementFlags.some(flag => flag & (ts.ElementFlags.Optional | ts.ElementFlags.Rest | ts.ElementFlags.Variadic))) fail(loc, "Tuples require a fixed set of required elements");
      const elements = this.checker.getTypeArguments(tuple).map((t, i) => this.map(t, loc, `${hint}${i}`));
      if (elements.length > 0 && elements.every(t => JSON.stringify(t) === JSON.stringify(elements[0]))) return { kind: "array", element: elements[0]!, length: elements.length };
      return { kind: "tuple", elements };
    }
    if (this.checker.isArrayType(type)) return { kind: "array", element: this.map(this.checker.getTypeArguments(type as ts.TypeReference)[0]!, loc, `${hint}Item`) };
    if (type.getCallSignatures().length) fail(loc, "Function types are methods, not stored values");
    if (type.flags & ts.TypeFlags.Object) {
      const object = type as ts.ObjectType;
      if ((object.objectFlags & (ts.ObjectFlags.Class | ts.ObjectFlags.Mapped) || type.symbol?.declarations?.some(d => ts.isClassDeclaration(d) || ts.isClassExpression(d))) || this.checker.getIndexInfosOfType(type).length) fail(loc, `Unsupported object contract ${this.checker.typeToString(type)}`);
      const name = this.reserve(type, hint);
      const declaration: AotTypeDeclaration = { kind: "struct", name, fields: this.fields(type, loc, name) };
      const existing = this.reuseSpecializedShape(type, declaration); if (existing) return existing;
      this.declarations.push(declaration);
      return { kind: "named", name };
    }
    fail(loc, `Unsupported contract type ${this.checker.typeToString(type)}`);
  }
  fields(type: ts.Type, loc: SourceLocation, hint: string, skip = new Set<string>()) {
    if (type.flags & ts.TypeFlags.Object) {
      const object = type as ts.ObjectType;
      if (object.objectFlags & (ts.ObjectFlags.Class | ts.ObjectFlags.Mapped) || type.symbol?.declarations?.some(d => ts.isClassDeclaration(d) || ts.isClassExpression(d)) || this.checker.getIndexInfosOfType(type).length) fail(loc, `Unsupported object contract ${this.checker.typeToString(type)}`);
    }
    return type.getProperties().filter(p => !skip.has(p.name)).map(p => {
      const declaration = p.valueDeclaration ?? p.declarations?.[0];
      if (!declaration) fail(loc, `Cannot resolve field ${p.name}`);
      const source = declaration.getSourceFile();
      const fieldLoc = this.sourceLocation?.(declaration) ?? location(source.fileName, source.text, declaration.getStart(source));
      return { name: p.name, type: this.map(this.checker.getTypeOfSymbolAtLocation(p, declaration), fieldLoc, `${hint}${typeName(p.name)}`) };
    });
  }
  unit(unit: keyof typeof VAPOR_UNIT_TYPES): AotType {
    const existing = this.units.get(unit); if (existing) return existing;
    let name: string = unit, suffix = 2;
    while (this.reserved.has(name) || this.usedNames.has(name) || this.declarations.some(d => d.name === name)) name = `${unit}_${suffix++}`;
    const value: AotType = { kind: "named", name };
    this.units.set(unit, value);
    this.declarations.push({ kind: "newtype", name, base: { kind: "number", name: VAPOR_UNIT_TYPES[unit].base }, unit });
    return value;
  }
  private reserve(type: ts.Type, hint: string, exact = false): string {
    const proposed = typeName(exact ? hint : type.aliasSymbol?.name ?? (type.symbol?.name !== "__type" ? type.symbol?.name : undefined) ?? hint);
    let name = proposed, suffix = 2;
    while (this.reserved.has(name) || this.declarations.some(d => d.name === name) || /^(Node|Block|If|For)\d+$/.test(name) || this.usedNames.has(name)) name = `${proposed}_${suffix++}`;
    this.namesFor(type).set(type, name); this.usedNames.set(name, type); return name;
  }
}

/** Resolve a Solid alias by its declaration origin, including user alias chains. */
export function solidTypeAlias(type: ts.Type, kind: "Accessor" | "Setter" | "Context", checker: ts.TypeChecker): ts.Type | undefined {
  const origin = (symbol: ts.Symbol | undefined): boolean => !!symbol && symbol.name === kind && !!symbol.declarations?.some(d => /\/node_modules\/solid-js\//.test(d.getSourceFile().fileName.replaceAll("\\", "/")));
  const seen = new Set<ts.Symbol>();
  function follows(symbol: ts.Symbol | undefined): boolean {
    if (!symbol || seen.has(symbol)) return false;
    seen.add(symbol);
    if (symbol.flags & ts.SymbolFlags.Alias) return follows(checker.getAliasedSymbol(symbol));
    if (origin(symbol)) return true;
    return !!symbol.declarations?.some(d => {
      if (!ts.isTypeAliasDeclaration(d)) return false;
      let node = d.type;
      while (ts.isParenthesizedTypeNode(node)) node = node.type;
      return ts.isTypeReferenceNode(node) && follows(checker.getSymbolAtLocation(node.typeName));
    });
  }
  if (!follows(type.aliasSymbol) && !follows(type.symbol)) return;
  if (kind === "Accessor") return type.getCallSignatures()[0]?.getReturnType();
  // Read the concrete T through Solid's declaration; aliases can substitute or fix T.
  if (kind === "Context") {
    const property = type.getProperty("defaultValue"), declaration = property?.valueDeclaration ?? property?.declarations?.[0];
    if (property && declaration) return checker.getTypeOfSymbolAtLocation(property, declaration);
  }
  if (kind === "Setter") {
    for (const signature of type.getCallSignatures()) {
      const parameter = signature.typeParameters?.[0];
      const constraint = parameter && checker.getBaseConstraintOfType(parameter);
      if (constraint) return constraint;
    }
  }
  return type.aliasTypeArguments?.[0] ?? ((type.flags & ts.TypeFlags.Object) ? checker.getTypeArguments(type as ts.TypeReference)[0] : undefined);
}

/** Literal tuple spellings survive JS Number rounding for i64/u64 tables. */
export function constantArraySpellings(checker: ts.TypeChecker, node: ts.Node | undefined, seen = new Set<ts.Node>()): (string | undefined)[] | undefined {
  if (!node || seen.has(node)) return;
  seen.add(node);
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(element => constantNumericSpelling(checker, element));
  if (ts.isTupleTypeNode(node)) return node.elements.map(element => constantNumericSpelling(checker, element));
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isTypeAssertionExpression(node)) return constantArraySpellings(checker, node.expression, seen);
  if (ts.isTypeOperatorNode(node) || ts.isParenthesizedTypeNode(node)) return constantArraySpellings(checker, node.type, seen);
  if (ts.isVariableDeclaration(node)) return constantArraySpellings(checker, node.type, seen) ?? constantArraySpellings(checker, node.initializer, seen);
  if (ts.isTypeAliasDeclaration(node)) return constantArraySpellings(checker, node.type, seen);
  if (ts.isTypeReferenceNode(node)) return constantArraySpellings(checker, node.typeName, seen);
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  for (const declaration of symbol?.declarations ?? []) {
    const value = constantArraySpellings(checker, declaration, seen); if (value) return value;
  }
}
