import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BunPlugin } from "bun";
import ts from "typescript";
import { BuildInputs } from "../framework/compiler/build-inputs.ts";
import { defineRuntimeConfig, type PocketRuntimeConfig } from "../framework/src/runtime-config.ts";
import { canonicalProfileJson, hashPocketProfile, validatePocketProfile, type PocketProfile } from "../framework/src/profile.ts";
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { POCKET_CAPABILITIES, definePlatformContractRegistry, defineTargetRegistry, type PocketCapabilityId } from "../contracts/spec/platform-types.ts";
import { POCKET_PROFILES } from "../profiles/index.ts";
import { targetProfile } from "../profiles/contract.ts";
import { validateToolchain } from "./targets/toolchain.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const builtinProfile = (id: string): PocketProfile | undefined => Object.hasOwn(POCKET_PROFILES, id)
  ? POCKET_PROFILES[id as keyof typeof POCKET_PROFILES] : undefined;
export const RUNTIME_CONFIG_FILE = "pocket.runtime-config.ts";
export interface LoadedRuntimeConfig {
  readonly path: string;
  readonly value: PocketRuntimeConfig;
  readonly profiles: readonly PocketProfile[];
  readonly dependencies: readonly string[];
}
export interface ResolvedProfile {
  readonly profile: PocketProfile;
  readonly profileHash: string;
  readonly hostAbi: number;
  readonly dependencies: readonly string[];
  readonly config?: LoadedRuntimeConfig;
}

export function findRuntimeConfig(from: string): string | null {
  for (let directory = resolve(from); ; directory = dirname(directory)) {
    const file = join(directory, RUNTIME_CONFIG_FILE);
    if (existsSync(file)) return file;
    if (dirname(directory) === directory) return null;
  }
}

// Config modules are bundled so framework subpaths work in firmware projects
// without node_modules. Preserve each source module's file-based import.meta.
function sourceMetadata(source: string, path: string): string {
  if (!source.includes("import.meta")) return source;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const result = ts.transform(file, [context => node => {
    const visit: ts.Visitor = current => {
      if (ts.isPropertyAccessExpression(current) && ts.isMetaProperty(current.expression) && current.expression.keywordToken === ts.SyntaxKind.ImportKeyword) {
        const values: Record<string, string> = { url: pathToFileURL(path).href, dir: dirname(path), dirname: dirname(path), path, filename: path };
        if (values[current.name.text] !== undefined) return ts.factory.createStringLiteral(values[current.name.text]!);
        if (current.name.text === "main") return ts.factory.createFalse();
      }
      return ts.visitEachChild(current, visit, context);
    };
    return ts.visitNode(node, visit) as ts.SourceFile;
  }]);
  const text = ts.createPrinter().printFile(result.transformed[0]!);
  result.dispose();
  return text;
}

function frameworkModulePath(specifier: string): string | undefined {
  if (specifier !== "@pocketjs/framework" && !specifier.startsWith("@pocketjs/framework/")) return undefined;
  const exports = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).exports;
  const key = specifier === "@pocketjs/framework" ? "." : `./${specifier.slice("@pocketjs/framework/".length)}`;
  const entry = exports[key];
  const target = typeof entry === "string" ? entry : entry?.default;
  if (!target) throw new Error(`unknown framework subpath ${specifier}`);
  return resolve(ROOT, target);
}

async function evaluateModule(path: string): Promise<{ value: unknown; dependencies: string[] }> {
  const inputs = new BuildInputs();
  const plugin: BunPlugin = {
    name: "pocket-config-modules",
    setup(build) {
      build.onResolve({ filter: /^@pocketjs\/framework(?:\/.*)?$/ }, args => {
        inputs.add(join(ROOT, "package.json"));
        return { path: frameworkModulePath(args.path)! };
      });
      build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, args => ({
        contents: sourceMetadata(readFileSync(args.path, "utf8"), args.path),
        loader: args.path.endsWith(".tsx") ? "tsx" : args.path.endsWith(".jsx") ? "jsx" : "ts",
      }));
    },
  };
  const bundle = await Bun.build({ entrypoints: [path], target: "bun", format: "esm", metafile: true, plugins: [plugin] });
  if (!bundle.success) throw new AggregateError(bundle.logs, `${path} does not bundle`);
  inputs.metafile(bundle.metafile);
  inputs.add(path);
  inputs.add(process.execPath);
  // Package resolution may change without a source edit.
  inputs.add(dirname(path));
  for (let directory = dirname(path); ; directory = dirname(directory)) {
    for (const name of ["package.json", "bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]) inputs.add(join(directory, name));
    if (dirname(directory) === directory) break;
  }
  const code = await bundle.outputs[0]!.text();
  const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  if (!("default" in module)) throw new TypeError(`${path} must export a default value`);
  return { value: module.default, dependencies: inputs.paths() };
}

function checkedProfile(value: unknown): PocketProfile {
  const id = value && typeof value === "object" && "id" in value ? String(value.id) : "";
  const builtin = builtinProfile(id);
  const result = validatePocketProfile(value, { builtin: Boolean(builtin) });
  if (!result.ok) throw new TypeError(result.diagnostics.map(item => `${item.path || "/"}: ${item.message}`).join("; "));
  if (builtin && canonicalProfileJson(builtin) !== canonicalProfileJson(result.value)) {
    throw new TypeError(`profile id ${id} belongs to a built-in profile; use a different id`);
  }
  return result.value;
}

export async function loadRuntimeConfig(path: string): Promise<LoadedRuntimeConfig> {
  path = resolve(path);
  if (!existsSync(path)) throw new Error(`runtime config not found: ${path}`);
  const module = await evaluateModule(path);
  const value = defineRuntimeConfig(module.value as PocketRuntimeConfig);
  if (value.build?.toolchain) {
    const problems = validateToolchain(value.build.toolchain, value.build.toolchain.target);
    if (problems.length) throw new TypeError(`invalid runtime toolchain: ${problems.join("; ")}`);
  }
  const profiles = (value.profiles ?? [value.profile]).map(checkedProfile);
  return { path, value, profiles, dependencies: module.dependencies };
}

export function profileRegistry(profile: PocketProfile) {
  const checked = checkedProfile(profile) as PocketProfile<PocketCapabilityId>;
  return definePlatformContractRegistry(POCKET_CAPABILITIES, defineTargetRegistry({
    [checked.id]: targetProfile(checked),
  }));
}

export async function resolveProfile(options: {
  readonly target?: string;
  readonly from: string;
  readonly runtimeConfig?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Runtime builds select only profiles implemented by their config. */
  readonly requireConfig?: boolean;
}): Promise<ResolvedProfile> {
  const from = resolve(options.from);
  const target = options.target ?? options.env?.POCKET_TARGET?.trim();
  const configPath = options.runtimeConfig ? resolve(options.runtimeConfig) : findRuntimeConfig(from);
  const config = configPath && (options.requireConfig || options.runtimeConfig || !target)
    ? await loadRuntimeConfig(configPath) : undefined;
  if (options.requireConfig && !config) throw new Error(`no ${RUNTIME_CONFIG_FILE} found above ${from}`);
  let profile: PocketProfile;
  let dependencies: readonly string[] = config?.dependencies ?? [];
  if (config) {
    if (target) {
      const selected = config.profiles.find(profile => profile.id === target);
      if (!selected) throw new Error(`${config.path} does not implement profile ${target}; choose ${config.profiles.map(p => p.id).join(", ")}`);
      profile = selected;
    } else {
      if (config.profiles.length !== 1) throw new Error(`${config.path} implements multiple profiles; select one with --target: ${config.profiles.map(p => p.id).join(", ")}`);
      profile = config.profiles[0]!;
    }
  } else if (target) {
    const builtin = builtinProfile(target);
    if (builtin) {
      profile = builtin;
      dependencies = [resolve(ROOT, `profiles/${target}.ts`), resolve(ROOT, "profiles/contract.ts"), resolve(ROOT, "contracts/spec/binding-generation.ts")];
    } else {
      let path: string;
      if (target.startsWith(".") || target.startsWith("/")) path = resolve(process.cwd(), target);
      else {
        try { path = frameworkModulePath(target) ?? Bun.resolveSync(target, from); }
        catch { throw new Error(`unknown profile or module ${target}`); }
      }
      if (!existsSync(path)) throw new Error(`profile module not found: ${path}`);
      const module = await evaluateModule(path);
      profile = checkedProfile(module.value);
      dependencies = module.dependencies;
    }
  } else {
    throw new Error(`no profile selected; use --target, POCKET_TARGET, or ${RUNTIME_CONFIG_FILE} above ${from}`);
  }
  return { profile, profileHash: hashPocketProfile(profile), hostAbi: POCKET_BINDING_GENERATION, dependencies, ...(config ? { config } : {}) };
}
