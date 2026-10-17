// Manifest-driven PocketJS orchestration.
//
//   bun pocket check --target psp
//   bun pocket compile --target psp
//   bun pocket build --target psp -- --release

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { checkAppTypes } from "../framework/compiler/app-check.ts";
import { depfile } from "../framework/compiler/build-inputs.ts";
import type { PocketTargetId } from "../contracts/spec/platforms.ts";
import { quickJsEngineAbiForTarget } from "../contracts/spec/quickjs-bytecode.ts";
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
import { compileQuickJsBytecode } from "./quickjs-bytecode.ts";

import { fileURLToPath } from "node:url";

const frameworkRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const argv = Bun.argv.slice(2);
const command = argv.shift();

function usage(message?: string): never {
  if (message) console.error(`PocketJS: ${message}`);
  console.error(
    "usage: bun pocket <check|compile|build> (--target <target> | --host-profile <pocket.host.json>) " +
      "[--manifest pocket.json] [--project-root .] [--outdir dist] [--plan-dir .pocket] " +
      "[--output app.pocket] [--bytecode] [-- backend args]",
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

function takeFlag(name: string): boolean {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return false;
  argv.splice(index, 1);
  return true;
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
const bytecodeOption = takeFlag("bytecode");
if (depfileOption && (!hostProfileOption || command !== "build")) usage("--depfile requires build --host-profile");
if (compilerReceipt && !existsSync(resolve(compilerReceipt))) usage("compiler receipt does not exist");
if (outputOption && (!hostProfileOption || command !== "build")) {
  usage("--output is only valid with build --host-profile");
}
if (bytecodeOption && (!hostProfileOption || command !== "build")) {
  usage("--bytecode is only valid with build --host-profile; use pocket pack for target packages");
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
let target = targetOption ?? "";
let tickHz = 60;
let profileHash: string | undefined;
let registry = undefined;
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
  let bytecode: Uint8Array | undefined;
  if (bytecodeOption) {
    if (!quickJsEngineAbiForTarget(target)) {
      console.warn(`PocketJS: ${target} has no QuickJS bytecode ABI; source retained`);
    } else {
      bytecode = compileQuickJsBytecode(target, js, {
        buildDirectory: resolve(projectRoot, ".pocket-build/quickjs-bytecode"),
      }).section;
    }
  }
  const variant = makeVariant({
    target,
    hostAbi: plan.target.hostAbi,
    planJson: canonicalJson(plan),
    identity: { output: plan.app.output, id: plan.app.id, title: plan.app.title },
    js,
    pak,
    bytecode,
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
} satisfies Record<PocketTargetId, TargetBackend>;

await targetBackends[target as PocketTargetId]({
  plan,
  planPath,
  projectRoot,
  outdir,
  args: backendArgs,
});
