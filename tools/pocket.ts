// Application compilation and program-owned runtime builds.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BuildInputs } from "../framework/compiler/build-inputs.ts";
import { POCKET_PROFILES } from "../hosts/index.ts";
import { CATALOG } from "./targets/index.ts";
import { statusRows, targetCommand } from "./targets/commands.ts";
import { loadProject } from "./targets/project.ts";
import { findHostConfig, HOST_CONFIG_FILE, resolveProfile } from "./profile-resolver.ts";
import { exportProfile } from "./profile-export.ts";
import { buildRuntime } from "./build/executor.ts";
import { resolveRuntimeProgram } from "./build/programs.ts";
import { compileApplication } from "./compile-app.ts";
import { sdkCommand } from "./sdk.ts";

const frameworkRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const argv = Bun.argv.slice(2);
const command = argv.shift();
function usage(message?: string): never {
  if (message) console.error(`PocketJS: ${message}`);
  console.error("usage: pocket check|compile [--config pocket.host.config.ts] [--target <id|pocket.host.json>] [--project-root DIR]\n" +
    "       pocket compile [--output app.pocket] [--depfile FILE] [--aot --out DIR]\n" +
    "       pocket build [--config pocket.host.config.ts] [--target ID] [--out DIR] [--pocket FILE | --aot-dir DIR] [--generic] [--deploy]\n" +
    "       pocket pack [--config FILE] [--target ID] --pocket FILE [--runtime DIR] [--out FILE]\n" +
    "       pocket host export [--config FILE] [--target ID] --out DIR [--depfile FILE]\n" +
    "       pocket host fetch --target ID --out FILE [--release-version V] [--manifest-url URL]\n" +
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
    const options = { target: takeOption("target"), config: takeOption("config") ?? takeOption("host-config"),
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
    const config = takeOption("host-config") ?? takeOption("config");
    flag("json"); noArguments();
    const result = await loadProject(process.cwd(), config);
    if (command === "project") console.log(JSON.stringify(result, null, 2));
    else {
      if (!result.ok) throw new Error(result.diagnostics.join("\n"));
      console.log(JSON.stringify(statusRows(result.project), null, 2));
    }
    if (!result.ok) process.exit(1);
    return;
  }
  if (command === "host") {
    const subcommand = argv.shift();
    if (subcommand === "fetch") {
      // The document a firmware release publishes; compile with --target FILE.
      const target = takeOption("target"), out = takeOption("out");
      const releaseVersion = takeOption("release-version"), manifestUrl = takeOption("manifest-url");
      noArguments();
      if (!target || !out) usage("host fetch requires --target and --out");
      const { releasedProfile } = await import("./release/fetch.ts");
      const profile = await releasedProfile(target, { version: releaseVersion, manifestUrl });
      mkdirSync(dirname(resolve(out)), { recursive: true });
      writeFileSync(resolve(out), JSON.stringify(profile, null, 2) + "\n");
      console.log(`✓ ${resolve(out)} (${profile.id}, binding generation ${profile.hostAbi})`);
      return;
    }
    if (subcommand !== "export") usage("expected host export or host fetch");
    const config = takeOption("config");
    const target = takeOption("target");
    const out = takeOption("out") ?? takeOption("outdir");
    const dependencies = takeOption("depfile");
    noArguments();
    if (!out) usage("host export requires --out");
    const selected = await resolveProfile({ from: process.cwd(), target, hostConfig: config, env: process.env });
    const inputs = new BuildInputs();
    await inputs.compiler([resolve(frameworkRoot, "tools/profile-export.ts"), resolve(frameworkRoot, "tools/profile-resolver.ts")], frameworkRoot);
    const result = exportProfile({ ...selected, dependencies: [...selected.dependencies, ...inputs.paths()] }, resolve(out), dependencies && resolve(dependencies));
    console.log(`✓ ${result.header}\n✓ ${result.module}\n✓ ${result.sidecar}`);
    return;
  }
  if (command === "pack") {
    const config = takeOption("config") ?? takeOption("host-config");
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
    const config = takeOption("config") ?? takeOption("host-config");
    const target = takeOption("target");
    const out = takeOption("out") ?? takeOption("outdir");
    const pocket = takeOption("pocket");
    const aotDirectory = takeOption("aot-dir");
    const deploy = flag("deploy");
    const generic = flag("generic");
    noArguments();
    const selected = await resolveRuntimeProgram({ from: process.cwd(), target, hostConfig: config, generic, env: process.env });
    const recipe = selected.config!.value.build;
    // From an application's directory the build compiles the application
    // the recipe takes, unless --pocket or --aot-dir supplies it.
    const application = selected.application;
    const base = dirname((application ?? selected.config!).path);
    const outdir = out ? resolve(out) : resolve(base, recipe ? "dist/runtime" : "dist/profile");
    let pocketInput = pocket && resolve(pocket), aotInput = aotDirectory && resolve(aotDirectory);
    if (application && !generic && recipe?.input && !pocketInput && !aotInput) {
      const compiled = resolve(outdir, ".application");
      const result = await compileApplication({ configPath: application.path, target: selected.profile.id,
        outdir: resolve(compiled, "compiler"), planRoot: resolve(compiled, "plans"),
        ...(recipe.input === "aot" ? { aotOut: resolve(compiled, "aot") } : { output: resolve(compiled, "application.pocket") }) });
      aotInput = result.aotOut;
      pocketInput = result.package;
    }
    await buildRuntime(selected, outdir, {
      pocket: pocketInput, aotDirectory: aotInput, deploy, args, app: application?.value.app,
    });
    return;
  }
  if (command !== "check" && command !== "compile") usage(`unknown command ${command ?? "<missing>"}`);
  if (argv.some(value => value === "--manifest" || value.startsWith("--manifest="))) {
    console.error("PocketJS: --manifest was removed; the application is the app section of pocket.host.config.ts, selected with --config FILE");
    process.exit(1);
  }
  const target = takeOption("target");
  const configOption = takeOption("config") ?? takeOption("host-config");
  const configPath = configOption ? resolve(configOption) : findHostConfig(process.cwd());
  if (!configPath) usage(`no ${HOST_CONFIG_FILE} above ${process.cwd()}; name one with --config`);
  if (!existsSync(configPath)) usage(`host config not found: ${configPath}`);
  const projectRoot = takeOption("project-root");
  const aot = flag("aot");
  const outOption = takeOption("out");
  const outdir = outOption ? undefined : takeOption("outdir");
  const planRoot = takeOption("plan-dir");
  const output = takeOption("output");
  const dependencies = takeOption("depfile");
  const compilerReceipt = takeOption("compiler-receipt");
  noArguments();
  if (outOption && !aot) usage("--out names an AOT directory; use --output for a .pocket file or --outdir for compiler intermediates");
  if (aot && command !== "compile") usage("--aot requires compile");
  if (aot && output) usage("--aot uses --out, not --output");
  if (compilerReceipt && !existsSync(resolve(compilerReceipt))) usage("compiler receipt does not exist");
  await compileApplication({
    configPath, target: target ?? (process.env.POCKET_TARGET?.trim() || undefined),
    ...(projectRoot ? { projectRoot: resolve(projectRoot) } : {}), outdir, planRoot, output,
    check: command === "check", ...(aot ? { aotOut: outOption ?? outdir ?? "dist" } : {}),
    depfile: dependencies, compilerReceipt,
  });
}

try { await main(); }
catch (error) { console.error(`PocketJS: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); }
