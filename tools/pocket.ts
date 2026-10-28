// Application compilation and program-owned runtime builds.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAppTypes } from "../framework/compiler/app-check.ts";
import { BuildInputs, depfile } from "../framework/compiler/build-inputs.ts";
import { runtimeVersionMismatch } from "../framework/compiler/runtime-packages.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
import { readPocketManifest } from "../framework/src/manifest/load.ts";
import { canonicalJson } from "../framework/src/manifest/plan.ts";
import { encodePocketPackage } from "../contracts/spec/pocket-package.ts";
import { POCKET_PROFILES } from "../profiles/index.ts";
import { CATALOG } from "./targets/index.ts";
import { statusRows, targetCommand } from "./targets/commands.ts";
import { loadProject } from "./targets/project.ts";
import { profileRegistry, resolveProfile } from "./profile-resolver.ts";
import { exportProfile } from "./profile-export.ts";
import { buildRuntime } from "./build/executor.ts";
import { resolveRuntimeProgram } from "./build/programs.ts";
import { makeVariant } from "./pocket-pack.ts";
import { sdkCommand } from "./sdk.ts";

const frameworkRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const argv = Bun.argv.slice(2);
const command = argv.shift();
function usage(message?: string): never {
  if (message) console.error(`PocketJS: ${message}`);
  console.error("usage: pocket check|compile [--manifest pocket.json] [--target <id|module>] [--runtime-config FILE]\n" +
    "       pocket compile [--output app.pocket] [--depfile FILE] [--aot --out DIR]\n" +
    "       pocket build [--config pocket.runtime-config.ts] [--target ID] [--out DIR] [--pocket FILE | --aot-dir DIR] [--generic] [--deploy]\n" +
    "       pocket pack [--config FILE] [--target ID] --pocket FILE [--runtime DIR] [--out FILE]\n" +
    "       pocket profile export [--config FILE] [--target ID] --out DIR [--depfile FILE]\n" +
    "       pocket doctor --target ID [--config FILE] [--generic] [--build-receipt FILE] [--runtime DIR] [--evidence FILE --identity FILE] [--device KEY] [--json]");
  process.exit(1);
}
function takeOption(name: string): string | undefined {
  const inline = argv.findIndex(value => value.startsWith(`--${name}=`));
  if (inline >= 0) {
    const value = argv.splice(inline, 1)[0]!.slice(name.length + 3);
    if (!value) usage(`--${name} requires a value`);
    return value;
  }
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) usage(`--${name} requires a value`);
  argv.splice(index, 2);
  return value;
}
function flag(name: string): boolean {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return false;
  argv.splice(index, 1);
  return true;
}
function noArguments() { if (argv.length) usage(`unknown option ${argv[0]}`); }
const cliProtocol = takeOption("cli-protocol");
if (cliProtocol !== undefined) {
  const protocol = JSON.parse(readFileSync(resolve(frameworkRoot, "package.json"), "utf8")).pocketjs?.protocol;
  if (String(protocol) !== cliProtocol) usage(`the CLI speaks protocol ${cliProtocol} and the framework at ${frameworkRoot} speaks ${protocol}`);
}

async function main() {
  if (command === "sdk") process.exit(await sdkCommand(argv));
  if (command === "target") process.exit(await targetCommand(argv));
  if (command === "doctor") {
    const options = { target: takeOption("target"), config: takeOption("config") ?? takeOption("runtime-config"),
      generic: flag("generic"), buildReceipt: takeOption("build-receipt"), runtime: takeOption("runtime"),
      evidence: takeOption("evidence"), identity: takeOption("identity"), device: takeOption("device") };
    const json = flag("json"); noArguments();
    const { inspectProgram } = await import("./doctor.ts");
    const report = await inspectProgram(options);
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`${report.target} · ${report.profileHash} · binding generation ${report.hostAbi}`);
      for (const check of report.checks) console.log(`${check.status}: ${check.name}: ${check.detail}`);
    }
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (command === "catalog") {
    const json = flag("json"); noArguments();
    const rows = Object.values(POCKET_PROFILES).map(profile => ({
      id: profile.id, title: CATALOG.find(entry => entry.contract.target === profile.id)?.title ?? profile.id,
      platform: profile.platform,
    }));
    if (json) console.log(JSON.stringify(rows, null, 2));
    else for (const row of rows) console.log(`${row.id.padEnd(20)} ${row.title}`);
    return;
  }
  if (command === "project" || command === "status") {
    const manifest = takeOption("manifest");
    const config = takeOption("runtime-config") ?? takeOption("config");
    flag("json"); noArguments();
    const result = await loadProject(manifest ? dirname(resolve(manifest)) : process.cwd(), config);
    if (command === "project") console.log(JSON.stringify(result, null, 2));
    else {
      if (!result.ok) throw new Error(result.diagnostics.join("\n"));
      console.log(JSON.stringify(statusRows(result.project), null, 2));
    }
    if (!result.ok) process.exit(1);
    return;
  }
  if (command === "profile") {
    if (argv.shift() !== "export") usage("expected profile export");
    const config = takeOption("config");
    const target = takeOption("target");
    const out = takeOption("out") ?? takeOption("outdir");
    const dependencies = takeOption("depfile");
    noArguments();
    if (!out) usage("profile export requires --out");
    const selected = await resolveProfile({ from: process.cwd(), target, runtimeConfig: config, env: process.env });
    const inputs = new BuildInputs();
    await inputs.compiler([resolve(frameworkRoot, "tools/profile-export.ts"), resolve(frameworkRoot, "tools/profile-resolver.ts")], frameworkRoot);
    const result = exportProfile({ ...selected, dependencies: [...selected.dependencies, ...inputs.paths()] }, resolve(out), dependencies && resolve(dependencies));
    console.log(`✓ ${result.header}\n✓ ${result.module}\n✓ ${result.sidecar}`);
    return;
  }
  if (command === "pack") {
    const config = takeOption("config") ?? takeOption("runtime-config");
    const target = takeOption("target");
    const runtime = takeOption("runtime");
    const releaseVersion = takeOption("release-version"), manifestUrl = takeOption("manifest-url");
    const output = takeOption("output") ?? takeOption("out");
    const id = takeOption("id"), title = takeOption("title"), author = takeOption("author"), version = takeOption("version"), icon = takeOption("icon");
    const pocket = takeOption("pocket") ?? argv.shift();
    noArguments();
    if (!pocket) usage("pack requires an application.pocket file");
    const { packRuntime } = await import("./build/pack.ts");
    await packRuntime({ config, target, runtime, releaseVersion, manifestUrl, output, id, title, author, version, icon, pocket });
    return;
  }
  if (command === "build") {
    const separator = argv.indexOf("--");
    const args = separator < 0 ? [] : argv.splice(separator).slice(1);
    const config = takeOption("config") ?? takeOption("runtime-config");
    const target = takeOption("target");
    const out = takeOption("out") ?? takeOption("outdir");
    const pocket = takeOption("pocket");
    const aotDirectory = takeOption("aot-dir");
    const deploy = flag("deploy");
    const generic = flag("generic");
    noArguments();
    const selected = await resolveRuntimeProgram({ from: process.cwd(), target, runtimeConfig: config, generic, env: process.env });
    await buildRuntime(selected, out ? resolve(out) : resolve(dirname(selected.config!.path), selected.config!.value.build ? "dist/runtime" : "dist/profile"), {
      pocket: pocket && resolve(pocket), aotDirectory: aotDirectory && resolve(aotDirectory), deploy, args,
    });
    return;
  }
  if (command !== "check" && command !== "compile") usage(`unknown command ${command ?? "<missing>"}`);
  const target = takeOption("target");
  const runtimeConfig = takeOption("runtime-config");
  const manifestPath = resolve(takeOption("manifest") ?? "pocket.json");
  const projectRoot = resolve(takeOption("project-root") ?? dirname(manifestPath));
  const aot = flag("aot");
  const outOption = takeOption("out");
  const outdir = resolve(projectRoot, outOption ?? takeOption("outdir") ?? "dist");
  const planRoot = resolve(projectRoot, takeOption("plan-dir") ?? ".pocket");
  const outputOption = takeOption("output");
  const dependencies = takeOption("depfile");
  const compilerReceipt = takeOption("compiler-receipt");
  noArguments();
  if (outOption && !aot) usage("--out names an AOT directory; use --output for a .pocket file or --outdir for compiler intermediates");
  if (aot && command !== "compile") usage("--aot requires compile");
  if (aot && outputOption) usage("--aot uses --out, not --output");
  if (compilerReceipt && !existsSync(resolve(compilerReceipt))) usage("compiler receipt does not exist");
  if (!existsSync(manifestPath)) usage(`manifest not found: ${manifestPath}`);
  const selected = await resolveProfile({ from: dirname(manifestPath), target, runtimeConfig, env: process.env });
  const loaded = readPocketManifest(manifestPath);
  const manifestInput: unknown = loaded.manifest;
  const resolution = validateAndResolveBuildPlan(manifestInput, { target: selected.profile.id, executionClass: aot ? "aot" : "guest" }, profileRegistry(selected.profile));
  if (!resolution.ok) throw new Error(resolution.diagnostics.map(item => `${item.code} ${item.path || "/"}: ${item.message}`).join("\n"));
  const plan = resolution.plan;
  const entry = resolve(projectRoot, plan.app.entry);
  if (!existsSync(entry)) usage(`app entry not found: ${entry}`);
  const mismatch = runtimeVersionMismatch(plan.app.framework, projectRoot);
  if (mismatch) throw new Error(`the application resolves ${mismatch.name} ${mismatch.application.version} (${mismatch.application.directory}) and the compiler bundles ${mismatch.name} ${mismatch.bundled.version} (${mismatch.bundled.directory}); declare "${mismatch.name}": "${mismatch.bundled.version}" in the application's package.json`);
  const entries: [string, "ui" | "worker"][] = [[entry, "ui"], ...(plan.app.worker ? [[resolve(projectRoot, plan.app.worker.entry), "worker"] as [string, "worker"]] : [])];
  for (const [source] of entries) if (!existsSync(source)) usage(`app entry not found: ${source}`);
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
  console.log(`✓ pocket.json v2\n✓ ${plan.target.id} satisfies pocket.json capabilities\n✓ TypeScript (${typeResult.checkedFiles.length} app module(s))\n✓ ResolvedBuildPlan ${plan.planHash}`);
  if (command === "check") return;
  // IDs are UTF-8 protocol strings, not filesystem paths.
  const directoryName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(plan.target.id) ? plan.target.id : selected.profileHash.slice(7, 23);
  const planDirectory = resolve(planRoot, directoryName);
  const planPath = resolve(planDirectory, "plan.json");
  mkdirSync(planDirectory, { recursive: true });
  mkdirSync(outdir, { recursive: true });
  await Bun.write(planPath, JSON.stringify(plan, null, 2) + "\n");
  const extraDependencies = [...loaded.inputs, ...selected.dependencies, ...typeResult.checkedFiles.filter(file => !file.endsWith("/styles.generated.ts")), ...(compilerReceipt ? [resolve(compilerReceipt)] : [])];
  if (dependencies) {
    const tools = new BuildInputs();
    await tools.compiler([resolve(frameworkRoot, "tools/pocket.ts")], frameworkRoot);
    extraDependencies.push(...tools.paths());
  }
  if (aot) {
    const { compileAot } = await import("./aot-compile.ts");
    const result = await compileAot({ plan, manifestPath, projectRoot, outdir, dependencyFiles: extraDependencies });
    if (dependencies) await Bun.write(resolve(projectRoot, dependencies), depfile(result.includeFile, result.dependencies));
    console.log(`✓ AOT sources: ${result.outdir}`);
    return;
  }
  const inputsFile = resolve(outdir, `${plan.app.output}.inputs.json`);
  const child = Bun.spawn([process.execPath, resolve(frameworkRoot, "tools/build.ts"), `--plan=${planPath}`, `--project-root=${projectRoot}`, `--outdir=${outdir}`, ...(dependencies ? [`--inputs-file=${inputsFile}`] : [])], { cwd: projectRoot, stdout: "inherit", stderr: "inherit" });
  const status = await child.exited;
  if (status !== 0 || child.signalCode) throw new Error(`PocketJS compiler failed: ${child.signalCode ?? status}`);
  const pakPath = resolve(outdir, `${plan.app.output}.pak`);
  const variant = makeVariant({
    target: plan.target.id, hostAbi: plan.target.hostAbi, planJson: canonicalJson(plan),
    identity: { output: plan.app.output, id: plan.app.id, title: plan.app.title },
    js: new Uint8Array(readFileSync(resolve(outdir, `${plan.app.output}.js`))),
    ...(plan.app.worker ? { workerJs: new Uint8Array(readFileSync(resolve(outdir, `${plan.app.output}.worker.js`))) } : {}),
    pak: existsSync(pakPath) ? new Uint8Array(readFileSync(pakPath)) : new Uint8Array(0),
  });
  const output = outputOption ? resolve(projectRoot, outputOption) : resolve(outdir, `${plan.app.output}.pocket`);
  if (dependencies) {
    const inputs = await Bun.file(inputsFile).json() as string[];
    await Bun.write(resolve(projectRoot, dependencies), depfile(output, [...inputs, ...extraDependencies]));
  }
  await Bun.write(output, encodePocketPackage({ manifest: loaded.embedded, variants: [variant] }));
  console.log(`✓ Package: ${output}`);
}
try { await main(); }
catch (error) { console.error(`PocketJS: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); }
