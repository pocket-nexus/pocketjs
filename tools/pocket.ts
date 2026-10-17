// Manifest-driven PocketJS orchestration.
//
//   bun pocket check --target psp
//   bun pocket compile --target psp
//   bun pocket build --target psp -- --release
//   bun pocket catalog [--json]      the targets --target accepts
//   bun pocket project [--manifest pocket.json]
//                                    the project configuration as JSON
//   bun pocket target add [<id> …] | list [--check] [--json] | remove <id> …
//                                    install target toolchains (tools/targets/commands.ts)
//   bun pocket status --json         install state of every target, for `pocket show`
//
// `build` for a target with a toolchain manifest stops before anything else
// unless the toolchain the framework pins is installed, and holds the target's
// install record shared until the backend finishes, so `pocket target remove`
// waits for it.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { checkAppTypes } from "../framework/compiler/app-check.ts";
import { depfile } from "../framework/compiler/build-inputs.ts";
import { runtimeVersionMismatch } from "../framework/compiler/runtime-packages.ts";
import type { PlatformContractRegistry } from "../contracts/spec/platforms.ts";
import { CATALOG, catalogEntry, catalogEntryForContract } from "./targets/index.ts";
import { statusRows, targetCommand } from "./targets/commands.ts";
import { withSharedLock } from "./targets/lock.ts";
import { loadProject } from "./targets/project.ts";
import { stateMessage, storeLayout, targetLock, targetState } from "./targets/store.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
import { canonicalJson, type ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import {
  hashPocketIdfHostProfile,
  pocketIdfHostExtension,
  pocketIdfHostRegistry,
  validatePocketIdfHostProfile,
} from "../framework/src/manifest/idf-host.ts";
import { encodePocketPackage } from "../contracts/spec/pocket-package.ts";
import { makeVariant } from "./pocket-pack.ts";

import { fileURLToPath } from "node:url";

const frameworkRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const argv = Bun.argv.slice(2);
const command = argv.shift();

function usage(message?: string): never {
  if (message) console.error(`PocketJS: ${message}`);
  console.error(
    "usage: bun pocket <check|compile|build> (--target <target> | --host-profile <pocket.host.json>) " +
      "[--manifest pocket.json] [--project-root .] [--outdir dist] [--plan-dir .pocket] " +
      "[--output app.pocket] [-- backend args]",
  );
  process.exit(1);
}

function takeOption(name: string): string | undefined {
  const inline = argv.findIndex((value) => value.startsWith(`--${name}=`));
  if (inline >= 0) return argv.splice(inline, 1)[0]!.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) usage(`--${name} requires a value`);
  argv.splice(index, 2);
  return value;
}

// The CLI states the protocol it speaks; a framework that speaks another one
// stops before reading anything else.
const cliProtocol = takeOption("cli-protocol");
if (cliProtocol !== undefined) {
  const frameworkProtocol = JSON.parse(readFileSync(resolve(frameworkRoot, "package.json"), "utf8")).pocketjs?.protocol;
  if (String(frameworkProtocol) !== cliProtocol) {
    usage(`the CLI speaks protocol ${cliProtocol} and the framework at ${frameworkRoot} speaks protocol ${frameworkProtocol}`);
  }
}

if (command === "catalog") {
  const json = argv.includes("--json");
  const rows = CATALOG.map((descriptor) => ({
    id: descriptor.id,
    title: descriptor.title,
    contract: { kind: descriptor.contract.kind, target: descriptor.contract.target },
    hosts: descriptor.hosts,
  }));
  if (json) console.log(JSON.stringify(rows, null, 2));
  else for (const row of rows) console.log(`${row.id.padEnd(20)} ${row.title}`);
  process.exit(0);
}
if (command === "project") {
  const manifestOption = takeOption("manifest");
  const manifestDirectory = dirname(resolve(manifestOption ?? "pocket.json"));
  const result = await loadProject(manifestDirectory);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
if (command === "target") {
  process.exit(await targetCommand(argv));
}
if (command === "status") {
  const project = await loadProject(process.cwd());
  console.log(JSON.stringify(statusRows(project.ok ? project.project : null), null, 2));
  process.exit(0);
}
if (command !== "check" && command !== "compile" && command !== "build") {
  usage(`unknown command ${command ?? "<missing>"}`);
}
const targetOption = takeOption("target");
const hostProfileOption = takeOption("host-profile");
if (Boolean(targetOption) === Boolean(hostProfileOption)) {
  usage("give exactly one of --target or --host-profile");
}
const manifestPath = resolve(takeOption("manifest") ?? "pocket.json");
const projectRoot = resolve(takeOption("project-root") ?? dirname(manifestPath));
const outdir = resolve(projectRoot, takeOption("outdir") ?? "dist");
const planRoot = resolve(projectRoot, takeOption("plan-dir") ?? ".pocket");
const outputOption = takeOption("output");
const depfileOption = takeOption("depfile");
const compilerReceipt = takeOption("compiler-receipt");
if (depfileOption && (!hostProfileOption || command !== "build")) usage("--depfile requires build --host-profile");
if (compilerReceipt && !existsSync(resolve(compilerReceipt))) usage("compiler receipt does not exist");
if (outputOption && (!hostProfileOption || command !== "build")) {
  usage("--output is only valid with build --host-profile");
}
// Backend args live strictly AFTER `--`; anything else left over is a typo.
// (Without the separator check-first split, `argv.splice(0)` would swallow
// unknown options into backendArgs and the guard below could never fire.)
const separator = argv.indexOf("--");
const backendArgs = separator >= 0 ? argv.splice(separator + 1) : [];
if (separator >= 0) argv.splice(separator, 1);
if (argv.length > 0) usage(`unknown option ${argv[0]}`);

if (!existsSync(manifestPath)) usage(`manifest not found: ${manifestPath}`);
const manifestInput: unknown = await Bun.file(manifestPath).json();
// `--target` names a catalog entry; plans and native hosts carry its contract
// target id, which differs for device profiles (`3ds` → `3ds-dev`).
let catalogId: string | undefined;
let target = "";
let tickHz = 60;
let profileHash: string | undefined;
let registry: PlatformContractRegistry | undefined;
if (targetOption) {
  const descriptor = catalogEntry(targetOption);
  if (!descriptor) {
    const named = catalogEntryForContract(targetOption);
    usage(
      named
        ? `unknown target ${targetOption}; the catalog names this target ${named.id}`
        : `unknown target ${targetOption}; targets: ${CATALOG.map((entry) => entry.id).join(", ")}`,
    );
  }
  catalogId = descriptor.id;
  target = descriptor.contract.target;
  registry = descriptor.contract.registry();
  if (command === "build") {
    const notReady = stateMessage(descriptor, targetState(descriptor));
    if (notReady) {
      console.error(`pocket: ${notReady}`);
      process.exit(1);
    }
  }
}
if (hostProfileOption) {
  const hostProfilePath = resolve(hostProfileOption);
  if (!existsSync(hostProfilePath)) usage(`host profile not found: ${hostProfilePath}`);
  const validated = validatePocketIdfHostProfile(await Bun.file(hostProfilePath).json());
  if (!validated.ok) {
    for (const diagnostic of validated.diagnostics) {
      console.error(`${diagnostic.code} ${diagnostic.path || "/"}: ${diagnostic.message}`);
    }
    process.exit(1);
  }
  target = validated.value.id;
  tickHz = validated.value.tickHz;
  profileHash = hashPocketIdfHostProfile(validated.value);
  registry = pocketIdfHostRegistry(validated.value);
}
const resolution = validateAndResolveBuildPlan(
  manifestInput,
  {
    target,
    ...(profileHash ? { hostExtension: pocketIdfHostExtension(profileHash, tickHz) } : {}),
  },
  registry,
);
if (!resolution.ok) {
  for (const diagnostic of resolution.diagnostics) {
    console.error(`${diagnostic.code} ${diagnostic.path || "/"}: ${diagnostic.message}`);
  }
  process.exit(1);
}
const plan = resolution.plan;
const entry = resolve(projectRoot, plan.app.entry);
if (!existsSync(entry)) usage(`app entry not found: ${entry}`);

// The application type-checks against the runtime its own resolution finds;
// the bundle carries the compiler's copy. Check against the one that runs.
const runtimeMismatch = runtimeVersionMismatch(plan.app.framework, projectRoot);
if (runtimeMismatch) {
  const { name, application, bundled } = runtimeMismatch;
  console.error(
    `PocketJS: the application resolves ${name} ${application.version} (${application.directory}) and the ` +
      `compiler bundles ${name} ${bundled.version} (${bundled.directory}); declare "${name}": "${bundled.version}" ` +
      `in the application's package.json`,
  );
  process.exit(1);
}

const typeResult = checkAppTypes({
  entry,
  tsconfigPath: existsSync(resolve(projectRoot, "tsconfig.json"))
    ? resolve(projectRoot, "tsconfig.json")
    : undefined,
  declarationFiles: [
    resolve(frameworkRoot, "framework/src/jsx.d.ts"),
    resolve(frameworkRoot, "framework/src/vue-sfc.d.ts"),
  ],
});
if (!typeResult.ok) {
  for (const diagnostic of typeResult.diagnostics.filter((item) => item.category === "error")) {
    const location = diagnostic.file
      ? `${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}:${diagnostic.column}` : ""}`
      : "TypeScript";
    console.error(`${location} TS${diagnostic.code}: ${diagnostic.message}`);
  }
  process.exit(1);
}

console.log(`✓ pocket.json v2`);
console.log(`✓ ${target} satisfies pocket.json capabilities`);
console.log(`✓ TypeScript (${typeResult.checkedFiles.length} app module(s))`);
console.log(`✓ ResolvedBuildPlan ${plan.planHash}`);

// `check` is read-only — the plan file is only materialized for the
// compile/build pipelines that consume it.
if (command === "check") process.exit(0);

const planDirectory = resolve(planRoot, target);
const planPath = resolve(planDirectory, "plan.json");
mkdirSync(planDirectory, { recursive: true });
await Bun.write(planPath, JSON.stringify(plan, null, 2) + "\n");

async function run(args: string[], label: string): Promise<void> {
  const child = Bun.spawn(args, { cwd: projectRoot, stdout: "inherit", stderr: "inherit" });
  const status = await child.exited;
  if (status !== 0) throw new Error(`${label} failed with exit ${status}`);
}

await run(
  [
    process.execPath,
    resolve(frameworkRoot, "tools/build.ts"),
    `--plan=${planPath}`,
    `--project-root=${projectRoot}`,
    `--outdir=${outdir}`,
    `--hz=${tickHz}`,
    ...(depfileOption ? [`--inputs-file=${resolve(outdir, `${plan.app.output}.inputs.json`)}`] : []),
  ],
  "PocketJS compiler",
);

if (command === "compile") process.exit(0);

if (hostProfileOption) {
  const js = new Uint8Array(readFileSync(resolve(outdir, `${plan.app.output}.js`)));
  const pakPath = resolve(outdir, `${plan.app.output}.pak`);
  const pak = existsSync(pakPath) ? new Uint8Array(readFileSync(pakPath)) : new Uint8Array(0);
  const variant = makeVariant({
    target,
    hostAbi: plan.target.hostAbi,
    planJson: canonicalJson(plan),
    identity: { output: plan.app.output, id: plan.app.id, title: plan.app.title },
    js,
    pak,
  });
  const output = outputOption
    ? resolve(projectRoot, outputOption)
    : resolve(outdir, `${plan.app.output}.pocket`);
  if (depfileOption) {
    const inputs = await Bun.file(resolve(outdir, `${plan.app.output}.inputs.json`)).json() as string[];
    await Bun.write(resolve(projectRoot, depfileOption), depfile(output, [
      ...inputs, ...typeResult.checkedFiles.filter(file => !file.endsWith("/styles.generated.ts")),
      manifestPath, resolve(hostProfileOption), ...(compilerReceipt ? [resolve(compilerReceipt)] : []),
    ]));
  }
  await Bun.write(output, encodePocketPackage({
    manifest: new Uint8Array(readFileSync(manifestPath)),
    variants: [variant],
  }));
  console.log(`✓ ESP-IDF package ${output}`);
  process.exit(0);
}

interface TargetBackendContext {
  readonly plan: ResolvedBuildPlan;
  readonly planPath: string;
  readonly projectRoot: string;
  readonly outdir: string;
  readonly args: readonly string[];
}

type TargetBackend = (context: TargetBackendContext) => Promise<void>;

const targetBackends = {
  psp: async ({ planPath, projectRoot, outdir, args }) => {
    await run(
      [
        Bun.which("bun") ?? "bun",
        resolve(frameworkRoot, "tools/psp.ts"),
        `--plan=${planPath}`,
        `--project-root=${projectRoot}`,
        `--outdir=${outdir}`,
        "--skip-build",
        ...args,
      ],
      "PSP backend",
    );
  },
  vita: async ({ planPath, projectRoot, outdir, args }) => {
    await run(
      [
        Bun.which("bun") ?? "bun",
        resolve(frameworkRoot, "tools/vita.ts"),
        `--plan=${planPath}`,
        `--project-root=${projectRoot}`,
        `--outdir=${outdir}`,
        "--skip-build",
        ...args,
      ],
      "Vita backend",
    );
  },
  pocketbook: async ({ outdir }) => {
    // The PocketBook host loads the pak + bundle from the device filesystem
    // (hosts/pocketbook), so there is no platform binary to package here —
    // `compile` already emitted <app>.js + <app>.pak into outdir. The host ELF
    // is cross-compiled separately (cargo zigbuild; see hosts/pocketbook/
    // README.md). A dedicated tools/pocketbook.ts wrapper is future work.
    console.log(
      `✓ PocketBook bundle ready in ${outdir} — cross-compile the host ` +
        `(hosts/pocketbook, cargo zigbuild) and copy both to the device.`,
    );
  },
  "web-app": async ({ plan, outdir }) =>
    compiledBundle("web-app", plan, outdir, "the browser host (hosts/web; `bun hosts/web/serve.ts` in a checkout)"),
  "macos-app": async ({ plan, outdir }) =>
    compiledBundle("macos-app", plan, outdir, "the desktop host (hosts/desktop; `bun run macos <app>` in a checkout)"),
  "linux-app": async ({ plan, outdir }) =>
    compiledBundle("linux-app", plan, outdir, "the desktop host (hosts/desktop)"),
  "macos-widget": async ({ plan, outdir }) =>
    compiledBundle("macos-widget", plan, outdir, "the note-widget host (engine/pocket3d/examples/note-widget; `bun run note` in a checkout)"),
} satisfies Partial<Record<string, TargetBackend>>;

// Targets whose host loads <output>.js + <output>.pak from a filesystem have no
// platform binary to package: `compile` produced the deliverable, so `build`
// reports where it is and which host consumes it.
function compiledBundle(target: string, plan: ResolvedBuildPlan, outdir: string, host: string): void {
  console.log(`✓ ${target} bundle ready: ${resolve(outdir, `${plan.app.output}.js`)} + .pak — loaded by ${host}.`);
}

const backend = (targetBackends as Partial<Record<string, TargetBackend>>)[catalogId ?? ""];
if (!backend) {
  usage(
    `target ${catalogId} has no build backend in tools/pocket.ts yet; ` +
      `\`pocket compile\` wrote ${resolve(outdir, `${plan.app.output}.js`)} and .pak`,
  );
}
await withSharedLock(targetLock(storeLayout(), catalogId!), () =>
  backend({
    plan,
    planPath,
    projectRoot,
    outdir,
    args: backendArgs,
  }));
