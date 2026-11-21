// `pocket check` and `pocket compile`: resolve the `app` section of a host
// config for one of its hosts, type-check the application, write the build
// plan and run the compiler on it (tools/build.ts --plan), then write the
// outputs as one bundle (`.pkb`) — or, with `aot`, generate the native guest
// sources.
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "../contracts/spec/app-config.ts";
import { BUNDLE_EXTENSION, encodeBundle } from "../contracts/spec/bundle.ts";
import { checkAppTypes } from "../framework/compiler/app-check.ts";
import { resolveAppPlan } from "../framework/compiler/app-plan.ts";
import { BuildInputs, depfile } from "../framework/compiler/build-inputs.ts";
import type { ResolvedBuildPlan } from "../framework/compiler/plan.ts";
import { runtimeVersionMismatch } from "../framework/compiler/runtime-packages.ts";
import { makeBundle } from "./bundle.ts";
import { loadHostConfig, profileRegistry, selectConfigHost } from "./profile-resolver.ts";

const frameworkRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export interface CompileApplicationOptions {
  /** The pocket.host.config.ts whose `app` section is compiled. */
  readonly configPath: string;
  /** A host id the config lists, or a pocket.host.json whose id it lists;
   *  absent, the config's one host. */
  readonly target?: string;
  /** The directory the plan's entries are relative to and the compiler runs
   *  in. Default: the config's directory. */
  readonly projectRoot?: string;
  /** Compiler intermediates. Default: <projectRoot>/dist. */
  readonly outdir?: string;
  /** Default: <projectRoot>/.pocket. */
  readonly planRoot?: string;
  /** The bundle file. Default: <outdir>/<output>.pkb. */
  readonly output?: string;
  /** Stop after the type check (`pocket check`). */
  readonly check?: boolean;
  /** Generate AOT guest sources into this directory instead of a bundle. */
  readonly aotOut?: string;
  readonly depfile?: string;
  readonly compilerReceipt?: string;
  /** Another form of the config's application for repository tools (a demo
   *  under another framework, an end-to-end identity). Paths in the result
   *  stay relative to the config file. */
  readonly app?: (app: AppConfig) => AppConfig;
}

export interface CompiledApplication {
  readonly plan: ResolvedBuildPlan;
  readonly planPath?: string;
  /** The bundle file, unless `check` or `aotOut`. */
  readonly bundle?: string;
  readonly aotOut?: string;
}

export async function compileApplication(options: CompileApplicationOptions): Promise<CompiledApplication> {
  const configPath = resolve(options.configPath);
  if (!existsSync(configPath)) throw new Error(`host config not found: ${configPath}`);
  const configDirectory = dirname(configPath);
  const projectRoot = resolve(options.projectRoot ?? configDirectory);
  const outdir = resolve(projectRoot, options.outdir ?? "dist");
  const planRoot = resolve(projectRoot, options.planRoot ?? ".pocket");
  const config = await loadHostConfig(configPath);
  const declared = config.value.app;
  if (!declared) throw new Error(`${configPath} has no app section; an application config names its entry, framework and viewport under app`);
  const app = options.app ? options.app(declared) : declared;
  const selected = selectConfigHost(config, options.target);
  const aot = options.aotOut !== undefined;
  const resolution = resolveAppPlan(app, { target: selected.profile.id, executionClass: aot ? "aot" : "guest", configDirectory, projectRoot }, profileRegistry(selected.profile));
  if (!resolution.ok) throw new Error(resolution.diagnostics.map(item => `${item.code} ${item.path || "/"}: ${item.message}`).join("\n"));
  const plan = resolution.plan;
  const iconPath = app.icon === undefined ? undefined : resolve(configDirectory, app.icon);
  const icon = iconPath === undefined ? undefined : readAppIcon(iconPath);
  const entry = resolve(projectRoot, plan.app.entry);
  if (!existsSync(entry)) throw new Error(`app entry not found: ${entry}`);
  const mismatch = runtimeVersionMismatch(plan.app.framework, projectRoot);
  if (mismatch) throw new Error(`the application resolves ${mismatch.name} ${mismatch.application.version} (${mismatch.application.directory}) and the compiler bundles ${mismatch.name} ${mismatch.bundled.version} (${mismatch.bundled.directory}); declare "${mismatch.name}": "${mismatch.bundled.version}" in the application's package.json`);
  const entries: [string, "ui" | "worker"][] = [[entry, "ui"], ...(plan.domains?.worker ? [[resolve(projectRoot, plan.domains.worker.entry), "worker"] as [string, "worker"]] : [])];
  for (const [source] of entries) if (!existsSync(source)) throw new Error(`app entry not found: ${source}`);
  const typeResults = entries.map(([entry, domain]) => checkAppTypes({
    entry,
    domain,
    frameworkRoot,
    tsconfigPath: existsSync(resolve(projectRoot, "tsconfig.json")) ? resolve(projectRoot, "tsconfig.json") : undefined,
    declarationFiles: [resolve(frameworkRoot, "framework/src/jsx.d.ts"), resolve(frameworkRoot, "framework/src/vue-sfc.d.ts")],
  }));
  const typeResult = {
    ok: typeResults.every(result => result.ok),
    diagnostics: typeResults.flatMap(result => result.diagnostics),
    checkedFiles: [...new Set(typeResults.flatMap(result => result.checkedFiles))],
  };
  if (!typeResult.ok) throw new Error(typeResult.diagnostics.filter(item => item.category === "error").map(item => `${item.file ?? "TypeScript"}${item.line ? `:${item.line}:${item.column}` : ""} TS${item.code}: ${item.message}`).join("\n"));
  console.log(`✓ ${relative(process.cwd(), configPath) || configPath} app\n✓ ${plan.target.id} hosts the application\n✓ TypeScript (${typeResult.checkedFiles.length} app module(s))\n✓ ResolvedBuildPlan ${plan.planHash}`);
  if (options.check) return { plan };
  // IDs are UTF-8 protocol strings, not filesystem paths.
  const directoryName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(plan.target.id) ? plan.target.id : selected.profileHash.slice(7, 23);
  const planDirectory = resolve(planRoot, directoryName);
  const planPath = resolve(planDirectory, "plan.json");
  mkdirSync(planDirectory, { recursive: true });
  mkdirSync(outdir, { recursive: true });
  await Bun.write(planPath, JSON.stringify(plan, null, 2) + "\n");
  const compilerReceipt = options.compilerReceipt && resolve(options.compilerReceipt);
  const extraDependencies = [...selected.dependencies, ...(iconPath ? [iconPath] : []), ...typeResult.checkedFiles.filter(file => !file.endsWith("/styles.generated.ts")), ...(compilerReceipt ? [compilerReceipt] : [])];
  if (options.depfile) {
    const tools = new BuildInputs();
    await tools.compiler([resolve(frameworkRoot, "tools/pocket.ts")], frameworkRoot);
    extraDependencies.push(...tools.paths());
  }
  if (aot) {
    const { compileAot } = await import("./aot-compile.ts");
    const result = await compileAot({ plan, configPath, projectRoot, outdir: resolve(projectRoot, options.aotOut!), dependencyFiles: extraDependencies });
    if (options.depfile) await Bun.write(resolve(projectRoot, options.depfile), depfile(result.includeFile, result.dependencies));
    console.log(`✓ AOT sources: ${result.outdir}`);
    return { plan, planPath, aotOut: result.outdir };
  }
  const inputsFile = resolve(outdir, `${plan.app.output}.inputs.json`);
  const child = Bun.spawn([process.execPath, resolve(frameworkRoot, "tools/build.ts"), `--plan=${planPath}`, `--project-root=${projectRoot}`, `--outdir=${outdir}`, `--config=${configPath}`, ...(options.depfile ? [`--inputs-file=${inputsFile}`] : [])], { cwd: projectRoot, stdout: "inherit", stderr: "inherit" });
  const status = await child.exited;
  if (status !== 0 || child.signalCode) throw new Error(`PocketJS compiler failed: ${child.signalCode ?? status}`);
  const pakPath = resolve(outdir, `${plan.app.output}.pak`);
  let bundle = makeBundle({
    plan,
    js: new Uint8Array(readFileSync(resolve(outdir, `${plan.app.output}.js`))),
    ...(plan.domains?.worker ? { workerJs: new Uint8Array(readFileSync(resolve(outdir, `${plan.app.output}.worker.js`))) } : {}),
    pak: existsSync(pakPath) ? new Uint8Array(readFileSync(pakPath)) : new Uint8Array(0),
    // The application's icon travels as the icon section.
    ...(icon ? { icon } : {}),
  });
  const output = bundlePath(options.output ? resolve(projectRoot, options.output) : resolve(outdir, `${plan.app.output}${BUNDLE_EXTENSION}`));
  if (options.depfile) {
    const inputs = await Bun.file(inputsFile).json() as string[];
    await Bun.write(resolve(projectRoot, options.depfile), depfile(output, [...inputs, ...extraDependencies]));
  }
  if (selected.profile.bytecode) {
    // The host names the QuickJS build it embeds: its bundles ship as bytecode for it.
    const { withBytecode } = await import("./quickjs-bytecode.ts");
    const bytecode = selected.profile.bytecode;
    bundle = withBytecode(bundle, { ...bytecode, buildDirectory: resolve(outdir, "quickjs-bytecode") });
    console.log(`✓ QuickJS bytecode for ${bytecode.engine}${bytecode.source === "drop" ? " (source dropped)" : ""}`);
  }
  mkdirSync(dirname(output), { recursive: true });
  await Bun.write(output, encodeBundle(bundle));
  console.log(`✓ Bundle: ${output}`);
  return { plan, planPath, bundle: output };
}

/** A bundle path: any name but one in the `.pocket` container format of
 *  other products. */
export function bundlePath(path: string): string {
  if (path.endsWith(".pocket")) throw new Error(`${path}: pocket compile writes a bundle; name it ${path.slice(0, -".pocket".length)}${BUNDLE_EXTENSION}`);
  return path;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** The square PNG `app.icon` names. */
export function readAppIcon(path: string): Uint8Array {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`app.icon names ${path}, which is not a file`);
  const icon = new Uint8Array(readFileSync(path));
  const view = new DataView(icon.buffer, icon.byteOffset, icon.byteLength);
  const png = icon.length >= 24 && PNG_SIGNATURE.every((byte, index) => icon[index] === byte);
  if (!png || view.getUint32(16) !== view.getUint32(20) || view.getUint32(16) === 0) throw new Error(`${path}: app.icon must be a square PNG`);
  return icon;
}
