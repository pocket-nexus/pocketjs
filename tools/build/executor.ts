import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { canonicalProfileJson } from "../../framework/src/profile.ts";
import type { RuntimeBuildContext, RuntimeBuildStep } from "../../framework/src/runtime-config.ts";
import { POCKET_BINDING_GENERATION } from "../../contracts/spec/binding-generation.ts";
import { exportProfile } from "../profile-export.ts";
import { profileRegistry, type ResolvedProfile } from "../profile-resolver.ts";
import { currentHost, type TargetDescriptor } from "../targets/types.ts";
import { requireToolchain, storeLayout, targetLock } from "../targets/store.ts";
import { withArtifactLock, withSharedLock } from "../targets/lock.ts";
import { toolchainDigest } from "../targets/toolchain.ts";
import { pocketjsCommit } from "../runtime/manifest.ts";
import { prepareAot, prepareApplication } from "./inputs.ts";

export interface RuntimeBuildOptions {
  readonly pocket?: string;
  readonly aotDirectory?: string;
  readonly args?: readonly string[];
  readonly deploy?: boolean;
}
export interface RuntimeBuildResult {
  readonly outdir: string;
  readonly artifact?: string;
  readonly receipt?: string;
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function expandBuildValue(value: string, context: Pick<RuntimeBuildContext, "outdir" | "output" | "configDirectory" | "application" | "aot">): string {
  const values: Record<string, string | undefined> = {
    outdir: context.outdir, output: context.output, config: context.configDirectory,
    application: context.application?.directory, aot: context.aot?.directory,
  };
  return value.replace(/\{(outdir|output|config|application|aot)\}/g, (_, key: string) => {
    if (values[key] === undefined) throw new Error(`runtime build placeholder {${key}} requires an input`);
    return values[key]!;
  });
}

/** Declarative steps and imperative hooks use the same execution environment. */
export async function executeBuildStep(step: RuntimeBuildStep, context: RuntimeBuildContext, rustToolchain?: string, rustup?: string | null): Promise<void> {
  if (step.kind === "compilerOnly") return;
  const expand = (value: string) => expandBuildValue(value, context);
  const options = { cwd: step.cwd && expand(step.cwd), env: Object.fromEntries(Object.entries(step.env ?? {}).map(([name, value]) => [name, expand(value)])) };
  const args = (step.args ?? []).map(expand);
  if (step.kind === "cargo") {
    const rust = step.toolchain ?? rustToolchain;
    const command = step.executable
      ? [expand(step.executable)]
      : rust && rustup ? [rustup, "run", rust, "cargo"] : ["cargo", ...(rust ? [`+${rust}`] : [])];
    await context.run([...command, "build", "--locked",
      ...(step.release === false ? [] : ["--release"]),
      ...(step.manifest ? ["--manifest-path", expand(step.manifest)] : []),
      ...(step.package ? ["--package", step.package] : []),
      ...(step.target ? ["--target", expand(step.target)] : []),
      ...(step.targetDirectory ? ["--target-dir", expand(step.targetDirectory)] : []),
      ...(step.noDefaultFeatures ? ["--no-default-features"] : []),
      ...(step.buildStd?.length ? [`-Zbuild-std=${step.buildStd.join(",")}`] : []),
      ...(step.features?.length ? ["--features", step.features.join(",")] : []), ...args], options);
  } else if (step.kind === "make") {
    await context.run(["make", ...(step.target ? [expand(step.target)] : []),
      ...Object.entries(step.variables ?? {}).map(([key, value]) => `${key}=${expand(value)}`), ...args], options);
  } else {
    const build = resolve(context.configDirectory, options.cwd ?? ".", expand(step.buildDirectory ?? ".pocket-build/native"));
    await context.run(["cmake", "-S", expand(step.source ?? "."), "-B", build,
      ...Object.entries(step.definitions ?? {}).map(([key, value]) => `-D${key}=${expand(value)}`), ...args], options);
    await context.run(["cmake", "--build", build, ...(step.target ? ["--target", expand(step.target)] : [])], options);
  }
}

function artifactFiles(path: string): Record<string, { bytes: number; sha256: string }> {
  const files: Record<string, { bytes: number; sha256: string }> = {};
  const base = lstatSync(path).isDirectory() ? path : dirname(path);
  const visit = (file: string) => {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error(`runtime artifact contains a symlink: ${file}`);
    if (stat.isDirectory()) { for (const name of readdirSync(file).sort()) visit(join(file, name)); return; }
    if (!stat.isFile()) throw new Error(`runtime artifact is not a regular file: ${file}`);
    const bytes = readFileSync(file);
    files[relative(base, file)] = { bytes: bytes.length, sha256: hash(bytes) };
  };
  visit(path);
  if (!Object.keys(files).length) throw new Error(`runtime artifact is empty: ${path}`);
  return files;
}

async function buildRuntimeUnlocked(selected: ResolvedProfile, outdir: string, options: RuntimeBuildOptions = {}): Promise<RuntimeBuildResult> {
  const config = selected.config;
  if (!config) throw new Error("pocket build requires pocket.runtime-config.ts");
  if (selected.hostAbi !== POCKET_BINDING_GENERATION) throw new Error("runtime build requires the current binding generation");
  if (options.pocket && options.aotDirectory) throw new Error("choose either --pocket or --aot-dir");
  outdir = resolve(outdir);
  const recipe = config.value.build;
  if (!recipe) {
    if (options.pocket || options.aotDirectory || options.deploy || options.args?.length) throw new Error("this program exports a profile; its external build system owns native compilation and deployment");
    const exported = exportProfile(selected, outdir);
    console.log(`✓ Profile exported: ${exported.header}`);
    console.log("Native compilation is owned by the external build system.");
    return { outdir };
  }
  const host = currentHost();
  if (!host || !recipe.hosts.includes(host)) throw new Error(`runtime build supports ${recipe.hosts.join(", ")}, not ${host ?? process.platform}`);
  if (recipe.input === "package" && !options.pocket) throw new Error("this native program requires --pocket <compiled application.pocket>; run pocket compile first");
  if (recipe.input === "aot" && !options.aotDirectory) throw new Error("this native program requires --aot-dir <generated sources>; run pocket compile --aot first");
  if (recipe.input === "aot" && options.pocket || recipe.input === "package" && options.aotDirectory) throw new Error(`runtime recipe requires ${recipe.input} input`);
  if (options.deploy && !recipe.deploy) throw new Error("this runtime config has no deploy hook");
  const application = options.pocket ? prepareApplication(selected, options.pocket, outdir) : undefined;
  const aot = options.aotDirectory ? prepareAot(selected, options.aotDirectory, outdir) : undefined;
  const output = application?.plan.app.output ?? aot?.output ?? (/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(selected.profile.id) ? selected.profile.id : selected.profileHash.slice(7, 23));
  const configDirectory = dirname(config.path);
  exportProfile(selected, outdir);
  const descriptor: TargetDescriptor = {
    id: recipe.toolchain?.target ?? selected.profile.id, title: selected.profile.id,
    hosts: recipe.hosts, toolchain: recipe.toolchain,
    contract: { kind: "profile", target: selected.profile.id, registry: () => profileRegistry(selected.profile) },
  };
  // Capture source identity before native tools can modify generated files.
  const source = pocketjsCommit();
  const snapshotDependencies = () => {
    const declaredSources: string[] = [];
    const collectSource = (path: string) => {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
        throw new Error(`runtime source input is not a regular file or directory: ${path}`);
      declaredSources.push(path);
      if (stat.isDirectory()) for (const name of readdirSync(path).sort()) collectSource(join(path, name));
    };
    for (const input of recipe.sourceInputs ?? []) collectSource(resolve(configDirectory, input));
    return Object.fromEntries([...new Set([...selected.dependencies, ...declaredSources])].sort().map(path => {
      const stat = statSync(path);
      return [path, stat.isFile()
        ? { kind: "file", bytes: stat.size, sha256: hash(readFileSync(path)) }
        : { kind: "directory", sha256: hash(Buffer.from(JSON.stringify(readdirSync(path).sort()))) }];
    }));
  };
  const dependencies = snapshotDependencies();
  const verifyDependencies = () => {
    let current: ReturnType<typeof snapshotDependencies>;
    try { current = snapshotDependencies(); }
    catch (error) {
      throw new Error(`runtime build inputs changed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const changed = [...new Set([...Object.keys(dependencies), ...Object.keys(current)])]
      .filter(path => JSON.stringify(dependencies[path]) !== JSON.stringify(current[path]));
    if (changed.length) throw new Error(`runtime build inputs changed: ${changed.join(", ")}`);
  };
  const perform = async (): Promise<RuntimeBuildResult> => {
    const toolchain = requireToolchain(descriptor);
    const paths = Object.fromEntries(Object.entries(toolchain?.components ?? {}).map(([name, component]) => [name, component.path ?? component.toolchain!]));
    const binaries = Object.values(toolchain?.components ?? {})
      .filter(component => component.kind === "archive" || component.kind === "cargo-install")
      .map(component => join(component.path!, "bin")).filter(existsSync);
    const env = {
      POCKETJS_TARGET: selected.profile.id, POCKETJS_HOST_ABI: String(selected.hostAbi),
      POCKETJS_TICK_HZ: String(selected.profile.tickHz),
      POCKETJS_PROFILE_JSON: canonicalProfileJson(selected.profile), POCKETJS_PROFILE_HASH: selected.profileHash,
      POCKETJS_PROFILE_EXPORT_DIR: outdir,
      ...(application ? { POCKETJS_PACKAGE: application.packagePath, POCKETJS_PLAN: application.planPath,
        POCKETJS_APP_DIR: application.directory, POCKETJS_APP: output } : {}),
      ...(aot ? { POCKETJS_AOT_DIR: aot.directory, POCKETJS_AOT_INCLUDE: aot.includeFile } : {}),
    };
    const commands: { command: string[]; cwd: string; status?: number; signal?: string | null }[] = [];
    const context: RuntimeBuildContext = {
      profile: selected.profile, profileHash: selected.profileHash, configDirectory, outdir,
      output, args: options.args ?? [], application, aot, env, toolchainPaths: paths,
      async run(command, runOptions = {}) {
        if (!command.length) throw new Error("runtime command must not be empty");
        const cwd = resolve(configDirectory, runOptions.cwd ?? ".");
        const entry: typeof commands[number] = { command: [...command], cwd };
        commands.push(entry);
        const child = Bun.spawn([...command], { cwd,
          env: { ...process.env, ...runOptions.env,
            PATH: [...binaries, runOptions.env?.PATH ?? process.env.PATH ?? ""].join(":"),
            RUSTUP_AUTO_INSTALL: "0", ...env }, stdout: "inherit", stderr: "inherit" });
        entry.status = await child.exited; entry.signal = child.signalCode;
        if (entry.status !== 0 || entry.signal) throw new Error(`${command[0]} failed: ${entry.signal ?? entry.status}`);
      },
    };
    const inputReceipt = application ? { kind: "package", sha256: hash(readFileSync(application.packagePath)), planHash: application.plan.planHash } :
      aot ? { kind: "aot", sha256: hash(readFileSync(aot.dependencyManifest)) } : null;
    const startedAt = new Date().toISOString();
    const receiptPath = join(outdir, "build-receipt.json");
    let artifact: string | undefined;
    let files: ReturnType<typeof artifactFiles> | undefined;
    let failure: string | undefined;
    try {
      const steps: readonly RuntimeBuildStep[] = Array.isArray(recipe.steps) ? recipe.steps : [recipe.steps as RuntimeBuildStep];
      const rustPins = [...new Set(Object.values(toolchain?.components ?? {}).filter(component => component.kind === "rustup").map(component => component.toolchain!))];
      for (const step of steps) {
        if (step.kind === "cargo" && rustPins.length) {
          if (step.toolchain && !rustPins.includes(step.toolchain)) throw new Error(`Cargo step requests a toolchain absent from its install record: ${step.toolchain}`);
          if (!step.toolchain && rustPins.length > 1) throw new Error("Cargo step must select a toolchain from the program's multiple Rust pins");
        }
        await executeBuildStep(step, context, rustPins[0], toolchain?.rustup);
      }
      await recipe.run?.(context);
      if (recipe.artifact) {
        artifact = resolve(configDirectory, expandBuildValue(recipe.artifact, context));
        if (!existsSync(artifact)) throw new Error(`runtime build did not produce ${artifact}`);
        files = artifactFiles(artifact);
      }
      verifyDependencies();
      if (artifact) console.log(`✓ Runtime artifact: ${artifact}`);
      if (options.deploy) await recipe.deploy!(context);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      const receipt = { schema: "pocket-runtime-build/1", success: failure === undefined, startedAt, finishedAt: new Date().toISOString(),
        source, dependencies, config: config.path, target: selected.profile.id,
        profileHash: selected.profileHash, hostAbi: selected.hostAbi, host,
        toolchainDigest: recipe.toolchain ? toolchainDigest(recipe.toolchain, host) : null,
        input: inputReceipt,
        invocation: { cwd: process.cwd(), outdir, pocket: options.pocket, aotDirectory: options.aotDirectory,
          args: [...(options.args ?? [])], deploy: Boolean(options.deploy) },
        artifact, files, commands, deployed: Boolean(options.deploy && !failure), ...(failure ? { failure } : {}) };
      const staging = `${receiptPath}.${process.pid}.tmp`;
      writeFileSync(staging, JSON.stringify(receipt, null, 2) + "\n"); renameSync(staging, receiptPath);
    }
    return { outdir, artifact, receipt: receiptPath };
  };
  mkdirSync(outdir, { recursive: true });
  if (recipe.toolchain) return withSharedLock(targetLock(storeLayout(), descriptor.id), perform);
  return perform();
}

export async function buildRuntime(selected: ResolvedProfile, outdir: string, options: RuntimeBuildOptions = {}): Promise<RuntimeBuildResult> {
  outdir = resolve(outdir);
  mkdirSync(dirname(outdir), { recursive: true });
  return withArtifactLock(join(dirname(outdir), `.${basename(outdir)}.build.lock`),
    () => buildRuntimeUnlocked(selected, outdir, options));
}
