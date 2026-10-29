import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BunPlugin } from "bun";
import ts from "typescript";
import { BuildInputs } from "../framework/compiler/build-inputs.ts";
import { defineHostConfig, type PocketHostConfig } from "../framework/src/host-config.ts";
import { canonicalProfileJson, hashPocketProfile, readPocketProfile, type PocketProfile } from "../framework/src/profile.ts";
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { POCKET_CAPABILITIES, definePlatformContractRegistry, defineTargetRegistry, type PocketCapabilityId } from "../contracts/spec/platform-types.ts";
import { POCKET_PROFILES, builtinProfileFile, type BuiltinProfileId } from "../hosts/index.ts";
import { targetProfile } from "../hosts/contract.ts";
import { validateToolchain } from "./targets/toolchain.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const builtinProfile = (id: string): PocketProfile | undefined => Object.hasOwn(POCKET_PROFILES, id)
  ? POCKET_PROFILES[id as BuiltinProfileId] : undefined;
const builtinProfilePath = (id: string) => resolve(ROOT, "hosts", builtinProfileFile(id as BuiltinProfileId));
export const HOST_CONFIG_FILE = "pocket.host.config.ts";
export interface ResolutionInputs {
  /** Directories are depfile watches; native output is not a module input. */
  readonly resolutionDirectories?: readonly string[];
  /** Exact package/lock paths, including absent candidates. */
  readonly resolutionFiles?: readonly string[];
  readonly moduleResolutions?: readonly { specifier: string; from: string; resolved: string | null }[];
}
export interface LoadedHostConfig extends ResolutionInputs {
  readonly path: string;
  readonly value: PocketHostConfig;
  readonly profiles: readonly PocketProfile[];
  /** The host contract of each entry of `profiles`. */
  readonly profilePaths: readonly string[];
  readonly dependencies: readonly string[];
}
export interface ResolvedProfile extends ResolutionInputs {
  readonly profile: PocketProfile;
  readonly profileHash: string;
  readonly hostAbi: number;
  readonly dependencies: readonly string[];
  /** The document the profile was read from. */
  readonly path?: string;
  readonly config?: LoadedHostConfig;
}

export function findHostConfig(from: string): string | null {
  for (let directory = resolve(from); ; directory = dirname(directory)) {
    const file = join(directory, HOST_CONFIG_FILE);
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

const PACKAGE_INPUTS = ["package.json", "bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"];

type ResolutionTracking = { directories: Set<string>; files: Set<string>; modules: { specifier: string; from: string; resolved: string | null }[]; packageDirectories: Set<string> };
function packageResolutionInputs(inputs: BuildInputs, from: string, tracking: ResolutionTracking): void {
  for (let directory = from; ; directory = dirname(directory)) {
    for (const name of PACKAGE_INPUTS) {
      const path = join(directory, name);
      inputs.add(path); tracking.files.add(path);
    }
    // Depfiles watch the importer directory. Exact ancestor candidates are
    // recorded separately without adding filesystem roots as dependencies.
    if (directory === from) { inputs.add(directory); tracking.directories.add(directory); }
    if (dirname(directory) === directory) break;
  }
}

/** External packages keep their own CJS/native loader. Their installed files
 * include data and native bindings that cannot be inferred from JS imports. */
function externalPackageInputs(inputs: BuildInputs, entry: string, packages: Set<string>, tracking: ResolutionTracking): void {
  entry = realpathSync(entry);
  inputs.add(entry);
  packageResolutionInputs(inputs, dirname(entry), tracking);
  let directory = dirname(entry);
  while (!existsSync(join(directory, "package.json"))) {
    if (dirname(directory) === directory) return;
    directory = dirname(directory);
  }
  if (packages.has(directory)) return;
  packages.add(directory);
  const visited = new Set<string>();
  const visit = (path: string) => {
    const actual = realpathSync(path);
    if (visited.has(actual)) return;
    visited.add(actual);
    const stat = statSync(actual);
    inputs.add(actual);
    if (stat.isDirectory()) {
      tracking.packageDirectories.add(actual);
      for (const name of readdirSync(actual)) {
        if (name !== "node_modules" && name !== ".git" && name !== ".pocket-build") visit(join(actual, name));
      }
    }
  };
  visit(directory);
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  for (const name of new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})])) {
    let dependency: string;
    try { dependency = Bun.resolveSync(name, directory); }
    catch { tracking.modules.push({ specifier: name, from: directory, resolved: null }); continue; }
    tracking.modules.push({ specifier: name, from: directory, resolved: dependency });
    if (existsSync(dependency)) externalPackageInputs(inputs, dependency, packages, tracking);
  }
}

async function evaluateModule(path: string): Promise<{ value: unknown; dependencies: string[] } & ResolutionInputs> {
  const inputs = new BuildInputs();
  const tracking: ResolutionTracking = { directories: new Set(), files: new Set(), modules: [], packageDirectories: new Set() };
  const externalPackages = new Set<string>();
  const plugin: BunPlugin = {
    name: "pocket-config-modules",
    setup(build) {
      build.onResolve({ filter: /^(?:\.|\/)/ }, args => {
        if (!args.importer) return;
        const from = dirname(args.importer), resolved = Bun.resolveSync(args.path, from);
        inputs.add(from); tracking.directories.add(from);
        packageResolutionInputs(inputs, from, tracking);
        tracking.modules.push({ specifier: args.path, from, resolved });
        return { path: resolved };
      });
      build.onResolve({ filter: /^@pocketjs\/framework(?:\/.*)?$/ }, args => {
        inputs.add(join(ROOT, "package.json"));
        return { path: frameworkModulePath(args.path)! };
      });
      build.onResolve({ filter: /^[^./#]/ }, args => {
        if (isBuiltin(args.path) || args.path === "bun" || args.path.startsWith("bun:") || args.path.includes(":")) return;
        const importer = args.importer ? dirname(args.importer) : dirname(path);
        const entry = Bun.resolveSync(args.path, importer);
        packageResolutionInputs(inputs, importer, tracking);
        tracking.modules.push({ specifier: args.path, from: importer, resolved: entry });
        externalPackageInputs(inputs, entry, externalPackages, tracking);
        return { path: entry, external: true };
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
  packageResolutionInputs(inputs, dirname(path), tracking);
  const code = await bundle.outputs[0]!.text();
  const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  if (!("default" in module)) throw new TypeError(`${path} must export a default value`);
  return { value: module.default, dependencies: inputs.paths(),
    resolutionDirectories: [...tracking.directories].filter(path => !tracking.packageDirectories.has(path)).sort(),
    resolutionFiles: [...tracking.files].sort(), moduleResolutions: tracking.modules };
}

/** Read a host contract. A document may carry a built-in id only with
 * the built-in profile's facts. */
export function loadProfileDocument(path: string): PocketProfile {
  const profile = readPocketProfile(path, { builtin: true });
  const builtin = builtinProfile(profile.id);
  if (builtin && canonicalProfileJson(builtin) !== canonicalProfileJson(profile)) {
    throw new TypeError(`${path}: profile id ${profile.id} belongs to a built-in profile; use a different id`);
  }
  return profile;
}

/** A `--target` that names a file rather than a built-in host id. */
export const isProfilePath = (target: string) => target.endsWith(".json") || target.includes("/") || target.includes("\\");

export async function loadHostConfig(path: string): Promise<LoadedHostConfig> {
  path = resolve(path);
  if (!existsSync(path)) throw new Error(`host config not found: ${path}`);
  const module = await evaluateModule(path);
  const value = defineHostConfig(module.value as PocketHostConfig);
  if (value.build?.toolchain) {
    const problems = validateToolchain(value.build.toolchain, value.build.toolchain.target);
    if (problems.length) throw new TypeError(`invalid runtime toolchain: ${problems.join("; ")}`);
  }
  // Host contracts are JSON files named relative to the config.
  const paths = (value.hosts ?? [value.host]).map(file => resolve(dirname(path), file));
  const profiles = paths.map(loadProfileDocument);
  if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) throw new TypeError(`${path}: profile ids must be unique`);
  return { path, value, profiles, profilePaths: paths, dependencies: [...module.dependencies, ...paths],
    resolutionDirectories: module.resolutionDirectories, resolutionFiles: module.resolutionFiles, moduleResolutions: module.moduleResolutions };
}

/** One profile as the resolver's registry. The document must validate. */
export function profileRegistry(profile: PocketProfile) {
  const checked = profile as PocketProfile<PocketCapabilityId>;
  return definePlatformContractRegistry(POCKET_CAPABILITIES, defineTargetRegistry({
    [checked.id]: targetProfile(checked),
  }));
}

export async function resolveProfile(options: {
  readonly target?: string;
  readonly from: string;
  readonly hostConfig?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Runtime builds select only profiles implemented by their config. */
  readonly requireConfig?: boolean;
}): Promise<ResolvedProfile> {
  const from = resolve(options.from);
  const target = options.target ?? options.env?.POCKET_TARGET?.trim();
  const configPath = options.hostConfig ? resolve(options.hostConfig) : findHostConfig(from);
  const config = configPath && (options.requireConfig || options.hostConfig || !target)
    ? await loadHostConfig(configPath) : undefined;
  if (options.requireConfig && !config) throw new Error(`no ${HOST_CONFIG_FILE} found above ${from}`);
  let profile: PocketProfile;
  let dependencies: readonly string[] = config?.dependencies ?? [];
  let resolution: ResolutionInputs = config ?? {};
  let path: string | undefined;
  if (config) {
    let index = 0;
    if (target) {
      index = config.profiles.findIndex(profile => profile.id === target);
      if (index < 0) throw new Error(`${config.path} does not implement host ${target}; choose ${config.profiles.map(p => p.id).join(", ")}`);
    } else if (config.profiles.length !== 1) {
      throw new Error(`${config.path} implements multiple hosts; select one with --target: ${config.profiles.map(p => p.id).join(", ")}`);
    }
    profile = config.profiles[index]!;
    path = config.profilePaths[index];
  } else if (target) {
    const builtin = isProfilePath(target) ? undefined : builtinProfile(target);
    if (builtin) {
      profile = builtin;
      path = builtinProfilePath(target);
      dependencies = [path, resolve(ROOT, "contracts/spec/binding-generation.ts")];
    } else if (isProfilePath(target)) {
      path = resolve(process.cwd(), target);
      if (!existsSync(path)) throw new Error(`host contract not found: ${path}`);
      profile = loadProfileDocument(path);
      dependencies = [path];
    } else {
      throw new Error(`unknown host ${target}; name a built-in host id or a pocket.host.json file`);
    }
  } else {
    throw new Error(`no host selected; use --target, POCKET_TARGET, or ${HOST_CONFIG_FILE} above ${from}`);
  }
  return { profile, profileHash: hashPocketProfile(profile), hostAbi: POCKET_BINDING_GENERATION, dependencies, ...(path ? { path } : {}),
    resolutionDirectories: resolution.resolutionDirectories, resolutionFiles: resolution.resolutionFiles,
    moduleResolutions: resolution.moduleResolutions, ...(config ? { config } : {}) };
}
