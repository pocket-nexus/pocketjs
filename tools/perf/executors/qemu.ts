import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import {
  artifactBuildVariantKey,
  buildRenderConfig,
  parseReceiptV1,
  rgbaFramebufferByteLength,
  type ReceiptV1,
  type ScenarioV1,
} from "../core/index.ts";
import {
  createQemuReceipts,
  parseGuestOutput,
  sha256Json,
  type ArtifactMetrics,
  type GuestProtocolResult,
  type QemuTarget,
  type ReceiptEnvironmentV1,
} from "../receipts/index.ts";
import { NATIVE_RUN_OUTPUT_PREFIX, parseNativeResult } from "../receipts/native-protocol.ts";
import { estimatedSuiteSeconds, expandSuiteFrameworks, loadScenarioSuite } from "../runner/suite.ts";
import type { NativeOkResult, NativeRunResult } from "../runner/native.ts";
import { nativeProvenance } from "../cli/receipts.ts";
import { runCommand } from "../cli/process.ts";
import type { QemuBridgeOptions } from "../cli/types.ts";
import {
  damageFixtureArgs,
  isDamageScenario,
  materializeDamageFixture,
  parseDamageCorrectnessOutput,
  type DamageCorrectnessRecordV1,
} from "./damage.ts";
import type { VaporQemuResult } from "./vapor.ts";

const DEFAULT_IMAGE = "pocketjs-perf-qemu:11.0.3";
const QEMU_PLUGIN = "/opt/pocketjs-perf-qemu/build/pocketjs-perf-counter.so";
const CARGO_REGISTRY_VOLUME = "pocketjs-perf-cargo-registry-v1";
const QEMU_WORKER_OUTPUT_PREFIX = "POCKETJS_PERF_QEMU_WORKER ";
export const QEMU_ENTROPY_PROFILE = "seed-1+guest-shim-v1";

const ADAPTER_CAPABILITIES: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  "guest-app": new Set([
    "guest.frame",
    "core.ui",
    "renderer.framebuffer",
    "assets.pak",
    "input.buttons",
    "input.analog",
    "input.touch",
    "correctness.framebuffer",
    "correctness.draw-list",
    "correctness.effects",
    "correctness.state-final",
  ]),
  "core-lab": new Set([
    "fixture.core.damage",
    "correctness.framebuffer",
    "correctness.draw-list",
  ]),
  vapor: new Set([
    "fixture.vapor.generated-c",
    "input.buttons",
    "input.relative-axis",
    "correctness.framebuffer",
    "correctness.draw-list",
    "correctness.effects",
    "correctness.state-final",
  ]),
});

interface TargetSpec {
  readonly executor: QemuBridgeOptions["executor"];
  readonly rustTarget: string;
  readonly qemuTarget: QemuTarget;
  readonly compiler: string;
  readonly sizeTool: string;
  readonly emulator: string;
  readonly cpuArgs: readonly string[];
  readonly emulatorArgs: readonly string[];
  readonly sysroot: string;
  readonly rustFlags: readonly string[];
  readonly cFlags: readonly string[];
  readonly cargoEnvironment: Readonly<Record<string, string>>;
}

const TARGETS: Readonly<Record<QemuBridgeOptions["executor"], TargetSpec>> = {
  "qemu-armv7-thumb2": {
    executor: "qemu-armv7-thumb2",
    rustTarget: "armv7-unknown-linux-gnueabihf",
    qemuTarget: "arm",
    compiler: "arm-linux-gnueabihf-gcc",
    sizeTool: "arm-linux-gnueabihf-size",
    emulator: "/opt/qemu/bin/qemu-arm",
    cpuArgs: ["-cpu", "cortex-a9,neon=off,vfp-d32=off"],
    emulatorArgs: ["-seed", "1"],
    sysroot: "/usr/arm-linux-gnueabihf",
    rustFlags: ["-C", "target-feature=+thumb-mode"],
    cFlags: ["-mthumb", "-march=armv7-a", "-mfpu=vfpv3-d16", "-mfloat-abi=hard"],
    cargoEnvironment: {
      CARGO_TARGET_ARMV7_UNKNOWN_LINUX_GNUEABIHF_LINKER: "arm-linux-gnueabihf-gcc",
      CC_armv7_unknown_linux_gnueabihf: "arm-linux-gnueabihf-gcc",
      CFLAGS_armv7_unknown_linux_gnueabihf:
        "-mthumb -march=armv7-a -mfpu=vfpv3-d16 -mfloat-abi=hard",
      RUSTFLAGS: "-C target-feature=+thumb-mode",
    },
  },
  "qemu-aarch64": {
    executor: "qemu-aarch64",
    rustTarget: "aarch64-unknown-linux-gnu",
    qemuTarget: "aarch64",
    compiler: "aarch64-linux-gnu-gcc",
    sizeTool: "aarch64-linux-gnu-size",
    emulator: "/opt/qemu/bin/qemu-aarch64",
    cpuArgs: ["-cpu", "cortex-a53"],
    emulatorArgs: ["-seed", "1"],
    sysroot: "/usr/aarch64-linux-gnu",
    rustFlags: [],
    cFlags: ["-march=armv8-a"],
    cargoEnvironment: {
      CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER: "aarch64-linux-gnu-gcc",
      CC_aarch64_unknown_linux_gnu: "aarch64-linux-gnu-gcc",
      CFLAGS_aarch64_unknown_linux_gnu: "-march=armv8-a",
    },
  },
};

export function qemuInvocationProfile(executor: QemuBridgeOptions["executor"]): {
  readonly cpuArgs: readonly string[];
  readonly emulatorArgs: readonly string[];
  readonly entropyProfile: typeof QEMU_ENTROPY_PROFILE;
} {
  const target = TARGETS[executor];
  return {
    cpuArgs: [...target.cpuArgs],
    emulatorArgs: [...target.emulatorArgs],
    entropyProfile: QEMU_ENTROPY_PROFILE,
  };
}

interface CommandOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly combined: string;
}

interface SuiteContext {
  readonly options: QemuBridgeOptions;
  readonly sourceRoot: string;
  readonly harnessRoot: string;
  readonly outDir: string;
  readonly workDir: string;
  readonly image: string;
  readonly imageIdentity: string;
  readonly target: TargetSpec;
  readonly toolchain: ReceiptEnvironmentV1["toolchain"];
  readonly fingerprint: string;
  readonly hostPlatform: string;
  readonly hostArch: string;
}

export interface GuestArtifacts {
  readonly bundle: string;
  readonly pak: string | null;
}

interface QemuRunArtifacts {
  readonly binary: string;
  readonly correctnessOutput: string;
  readonly correctnessFramebufferHash: string;
  readonly checkpointFramebufferHashes: Readonly<Record<string, string>>;
  readonly correctnessStateHash: string;
  readonly correctnessEffectHash: string;
  readonly measurementOutput: string;
  readonly artifactMetrics: ArtifactMetrics;
}

export interface QemuSuiteResult {
  readonly receipts: readonly ReceiptV1[];
  readonly invalidReasons: readonly string[];
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function command(argv: readonly string[], cwd: string): CommandOutput {
  const result = runCommand(argv, { cwd });
  const stdout = text(result.stdout);
  const stderr = text(result.stderr);
  return {
    exitCode: result.exitCode,
    stdout,
    stderr,
    combined: `${stdout}${stdout && stderr ? "\n" : ""}${stderr}`,
  };
}

function failure(action: string, result: CommandOutput): Error {
  const detail = (result.stderr.trim() || result.stdout.trim()).slice(-4_000);
  return new Error(`${action} failed (${result.exitCode})${detail ? `: ${detail}` : ""}`);
}

function safeName(scenario: ScenarioV1): string {
  return `${scenario.id}.${scenario.subject.framework}`.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

export function qemuScenarioCapabilityReasons(scenario: ScenarioV1): readonly string[] {
  const capabilities = ADAPTER_CAPABILITIES[scenario.subject.family];
  if (!capabilities) {
    return [`${scenario.id}: no QEMU capability declaration for ${scenario.subject.family}`];
  }
  return scenario.executorRequirements
    .filter((requirement) => !capabilities.has(requirement))
    .map((requirement) => (
      `${scenario.id}: ${scenario.subject.family} QEMU adapter does not provide ` +
      `executor requirement ${JSON.stringify(requirement)}`
    ));
}

function dockerMount(path: string, target: string, readonly = false): readonly string[] {
  const mode = readonly ? ",readonly" : "";
  return ["--mount", `type=bind,source=${realpathSync(path)},target=${target}${mode}`];
}

function dockerRun(
  context: SuiteContext,
  argv: readonly string[],
  options: { readonly network?: boolean; readonly environment?: Readonly<Record<string, string>> } = {},
): CommandOutput {
  const environment = {
    LC_ALL: "C",
    TZ: "UTC",
    ...options.environment,
  };
  const dockerArgs = [
    "docker", "run", "--rm",
    ...dockerMount(context.sourceRoot, "/source", true),
    ...dockerMount(context.workDir, "/work"),
    ...dockerMount(context.outDir, "/output"),
    "--workdir", "/work",
    ...(options.network === false ? ["--network", "none"] : []),
    ...Object.entries(environment).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
    context.image,
    ...argv,
  ];
  return command(dockerArgs, context.outDir);
}

function inspectImage(image: string, cwd: string): string {
  const result = command([
    "docker", "image", "inspect", image,
    "--format", "{{.Id}} {{.Os}}/{{.Architecture}} {{json .RepoDigests}}",
  ], cwd);
  if (result.exitCode !== 0) {
    throw new Error(
      `pinned QEMU image ${image} is unavailable; run tools/perf/qemu/docker.sh build`,
    );
  }
  const identity = result.stdout.trim();
  if (!/^sha256:[a-f0-9]{64}\s+linux\/(?:amd64|arm64)\s+/.test(identity)) {
    throw new Error(`cannot identify pinned QEMU image ${image}: ${JSON.stringify(identity)}`);
  }
  return identity;
}

function containerVersion(image: string, cwd: string, executable: string, ...args: string[]): string {
  const result = command(["docker", "run", "--rm", "--entrypoint", executable, image, ...args], cwd);
  if (result.exitCode !== 0) throw failure(`reading ${executable} version`, result);
  return (result.stdout || result.stderr).split(/\r?\n/, 1)[0]!.trim();
}

export function qemuHarnessFingerprint(
  harnessRoot: string,
  imageIdentity: string,
  executor: QemuBridgeOptions["executor"],
  bunVersion: string,
  hostPlatform: string = process.platform,
  hostArch: string = process.arch,
): string {
  const target = TARGETS[executor];
  const hash = createHash("sha256");
  hash.update("pocketjs.perf.qemu-executor.v1\0").update(imageIdentity).update("\0");
  hash.update(JSON.stringify({
    executor: target.executor,
    target: target.rustTarget,
    rustFlags: target.rustFlags,
    cFlags: target.cFlags,
    qemuCpuArgs: target.cpuArgs,
    qemuEmulatorArgs: target.emulatorArgs,
    entropyProfile: QEMU_ENTROPY_PROFILE,
    markerPlugin: QEMU_PLUGIN,
    hostBun: bunVersion,
    hostPlatform,
    hostArch,
  })).update("\0");
  for (const relativePath of [
    "bun.lock",
    "tools/perf/core/render-config.ts",
    "tools/perf/executors/qemu.ts",
    "tools/perf/executors/qemu-worker.ts",
    "tools/perf/executors/damage.ts",
    "tools/perf/executors/vapor.ts",
    "tools/perf/runner/native.ts",
    "tools/perf/runner/native-cli.ts",
    "tools/perf/runner/native-world.ts",
    "tools/perf/runner/input.ts",
    "tools/perf/apps/idle-fixture-main.tsx",
    "tools/perf/apps/list-fixture-main.tsx",
    "tools/perf/apps/keyed-list-model.ts",
    "tools/perf/guest/Cargo.toml",
    "tools/perf/guest/src/main.rs",
    "tools/perf/damage-fixture/Cargo.toml",
    "tools/perf/damage-fixture/Cargo.lock",
    "tools/perf/damage-fixture/src/main.rs",
    "tools/perf/qemu/guest_marker.h",
    "tools/perf/qemu/perf_counter.c",
    "tools/perf/receipts/protocol.ts",
    "tools/perf/receipts/factory.ts",
    "tools/perf/receipts/hash.ts",
    "tools/perf/receipts/native-protocol.ts",
    "hosts/web/wasm-ops.js",
    "framework/src/touch.ts",
  ]) {
    const path = join(harnessRoot, relativePath);
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    hash.update(relativePath).update("\0").update(String(bytes.byteLength)).update("\0").update(bytes);
  }
  return hash.digest("hex");
}

function makeContext(options: QemuBridgeOptions): SuiteContext {
  const sourceRoot = realpathSync(resolve(options.sourceRoot));
  const harnessRoot = realpathSync(resolve(options.harnessRoot));
  const outDir = resolve(options.outDir);
  mkdirSync(outDir, { recursive: true });
  const workDir = mkdtempSync(join(outDir, ".qemu-work-"));
  const image = process.env.POCKETJS_QEMU_IMAGE || DEFAULT_IMAGE;
  try {
    const imageIdentity = inspectImage(image, outDir);
    const target = TARGETS[options.executor];
    const rustc = containerVersion(image, outDir, "rustc", "--version");
    const cCompiler = containerVersion(image, outDir, target.compiler, "--version");
    const qemu = containerVersion(image, outDir, target.emulator, "--version");
    if (!/\bversion 11\.0\.3\b/.test(qemu)) {
      throw new Error(`expected QEMU 11.0.3, got ${JSON.stringify(qemu)}`);
    }
    const rustSysroot = containerVersion(image, outDir, "rustc", "--print", "sysroot");
    const bunVersion = `Bun ${Bun.version}`;
    return {
      options,
      sourceRoot,
      harnessRoot,
      outDir,
      workDir,
      image,
      imageIdentity,
      target,
      toolchain: {
        rustc,
        cCompiler,
        sysroot: `rust=${rustSysroot};guest=${target.sysroot}`,
        qemu,
        bun: bunVersion,
      },
      fingerprint: qemuHarnessFingerprint(
        harnessRoot,
        imageIdentity,
        options.executor,
        bunVersion,
        process.platform,
        process.arch,
      ),
      hostPlatform: process.platform,
      hostArch: process.arch,
    };
  } catch (error) {
    cleanupWorkDirectory(outDir, workDir, image);
    throw error;
  }
}

export function qemuCleanupFallbackArgs(image: string, workDir: string): readonly string[] {
  return [
    "docker", "run", "--rm",
    "--network", "none",
    "--read-only",
    "--cap-drop", "ALL",
    "--cap-add", "DAC_OVERRIDE",
    "--security-opt", "no-new-privileges",
    ...dockerMount(workDir, "/work"),
    "--entrypoint", "find",
    image,
    "/work", "-mindepth", "1", "-delete",
  ];
}

function isPermissionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "EACCES" || error.code === "EPERM";
}

function cleanupWorkDirectory(outDir: string, workDir: string, image: string): void {
  if (!existsSync(workDir)) return;
  const resolvedWork = realpathSync(workDir);
  if (resolve(resolvedWork, "..") !== realpathSync(outDir) ||
      !basename(resolvedWork).startsWith(".qemu-work-")) {
    throw new Error(`refusing to clean unexpected QEMU work directory ${resolvedWork}`);
  }
  try {
    rmSync(resolvedWork, { recursive: true, force: true });
    return;
  } catch (error) {
    if (!isPermissionError(error) || !existsSync(resolvedWork)) throw error;
  }

  // Docker builds run as container root so Cargo target directories can be
  // unreadable to an unprivileged Linux host. Limit the privileged fallback to
  // the validated disposable bind mount. DAC_OVERRIDE is required to enter the
  // host-owned mode-0700 mkdtemp root; every other capability remains dropped.
  const result = command(qemuCleanupFallbackArgs(image, resolvedWork), outDir);
  if (result.exitCode !== 0) throw failure("cleaning the QEMU work directory", result);
  rmSync(resolvedWork, { recursive: true, force: true });
}

function quickJsLockTuples(lockPath: string): readonly string[] {
  if (!existsSync(lockPath)) throw new Error(`source root has no engine/Cargo.lock: ${lockPath}`);
  const wanted = new Set(["rquickjs", "rquickjs-core", "rquickjs-sys"]);
  const tuples: string[] = [];
  for (const block of readFileSync(lockPath, "utf8").split("[[package]]").slice(1)) {
    const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    if (!name || !wanted.has(name)) continue;
    const version = /^\s*version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const source = /^\s*source\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const checksum = /^\s*checksum\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    if (!version || !source || !checksum) throw new Error(`${lockPath}: incomplete ${name} lock entry`);
    tuples.push(`${name}@${version}\0${source}\0${checksum}`);
  }
  tuples.sort();
  if (tuples.length !== wanted.size || new Set(tuples.map((tuple) => tuple.split("@", 1)[0])).size !== wanted.size) {
    throw new Error(`${lockPath}: expected one locked rquickjs, rquickjs-core, and rquickjs-sys tuple`);
  }
  return tuples;
}

function cargoDockerArgs(
  context: SuiteContext,
  manifest: string,
  targetDir: string,
): readonly string[] {
  const manifestInWork = `/work/${relative(context.workDir, manifest)}`;
  const targetInWork = `/work/${relative(context.workDir, targetDir)}`;
  return [
    "docker", "run", "--rm",
    ...dockerMount(context.sourceRoot, "/source", true),
    ...dockerMount(context.workDir, "/work"),
    "--mount", `type=volume,source=${CARGO_REGISTRY_VOLUME},target=/opt/rust/cargo/registry`,
    "--workdir", "/work",
    "--env", "LC_ALL=C",
    "--env", "TZ=UTC",
    ...Object.entries(context.target.cargoEnvironment)
      .flatMap(([name, value]) => ["--env", `${name}=${value}`]),
    context.image,
    "cargo", "build", "--release", "--locked",
    "--manifest-path", manifestInWork,
    "--target-dir", targetInWork,
    "--target", context.target.rustTarget,
  ];
}

function buildCargoFixture(
  context: SuiteContext,
  manifest: string,
  targetDir: string,
  binaryName: string,
): string {
  mkdirSync(targetDir, { recursive: true });
  const result = command(cargoDockerArgs(context, manifest, targetDir), context.outDir);
  if (result.exitCode !== 0) throw failure(`cross-building ${binaryName}`, result);
  const binary = join(targetDir, context.target.rustTarget, "release", binaryName);
  if (!existsSync(binary) || !statSync(binary).isFile()) {
    throw new Error(`cross build did not produce ${binary}`);
  }
  return binary;
}

function materializeGuestHarness(context: SuiteContext): { manifest: string; targetDir: string } {
  const source = join(context.harnessRoot, "tools/perf/guest");
  const destination = join(context.workDir, "guest");
  mkdirSync(join(destination, "src"), { recursive: true });
  cpSync(join(source, "src"), join(destination, "src"), { recursive: true });
  const sourceLock = readFileSync(join(context.sourceRoot, "engine/Cargo.lock"), "utf8");
  const guestPackage = [
    "",
    "[[package]]",
    'name = "pocketjs-perf-guest"',
    'version = "0.1.0"',
    "dependencies = [",
    ' "anyhow",',
    ' "libc",',
    ' "pocket-mod",',
    ' "pocket-ui-surface",',
    ' "pocketjs-core",',
    ' "rquickjs",',
    ' "serde",',
    ' "serde_json",',
    "]",
    "",
  ].join("\n");
  if (sourceLock.includes('name = "pocketjs-perf-guest"')) {
    throw new Error("source engine lock unexpectedly already contains pocketjs-perf-guest");
  }
  writeFileSync(join(destination, "Cargo.lock"), `${sourceLock.trimEnd()}${guestPackage}`);
  let manifest = readFileSync(join(source, "Cargo.toml"), "utf8");
  const quickJsVersion = lockedPackageVersion(sourceLock, "rquickjs");
  const versionedQuickJs = manifest.replace(
    /rquickjs = \{ version = "[^"]+", features = \["rust-alloc"\] \}/,
    `rquickjs = { version = "=${quickJsVersion}", features = ["rust-alloc"] }`,
  );
  if (versionedQuickJs === manifest) {
    throw new Error("guest manifest no longer has the expected rquickjs allocator dependency");
  }
  manifest = versionedQuickJs;
  const replacements: Readonly<Record<string, string>> = {
    "../../../engine/crates/pocket-mod": "/source/engine/crates/pocket-mod",
    "../../../engine/crates/pocket-ui-surface": "/source/engine/crates/pocket-ui-surface",
    "../../../engine/core": "/source/engine/core",
  };
  for (const [from, to] of Object.entries(replacements)) manifest = manifest.replaceAll(from, to);
  if (/path\s*=\s*"\.\./.test(manifest)) {
    throw new Error("guest manifest contains an unstaged relative dependency");
  }
  const manifestPath = join(destination, "Cargo.toml");
  writeFileSync(manifestPath, manifest);
  resolveGuestLock(context, manifestPath);
  return { manifest: manifestPath, targetDir: join(destination, "target") };
}

function lockedPackageVersion(lock: string, packageName: string): string {
  const versions: string[] = [];
  for (const block of lock.split("[[package]]").slice(1)) {
    const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    if (name !== packageName) continue;
    const version = /^\s*version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    if (!version) throw new Error(`source lock has an incomplete ${packageName} entry`);
    versions.push(version);
  }
  if (versions.length !== 1) {
    throw new Error(`source lock must contain exactly one ${packageName} version; got ${versions.length}`);
  }
  return versions[0]!;
}

function resolveGuestLock(context: SuiteContext, manifestPath: string): void {
  const result = command([
    "docker", "run", "--rm",
    ...dockerMount(context.sourceRoot, "/source", true),
    ...dockerMount(context.workDir, "/work"),
    "--mount", `type=volume,source=${CARGO_REGISTRY_VOLUME},target=/opt/rust/cargo/registry`,
    "--workdir", "/work",
    "--env", "LC_ALL=C",
    "--env", "TZ=UTC",
    context.image,
    "cargo", "metadata",
    "--manifest-path", `/work/${relative(context.workDir, manifestPath)}`,
    "--format-version", "1",
  ], context.outDir);
  if (result.exitCode !== 0) throw failure("resolving the source-seeded guest lock", result);
  const expected = quickJsLockTuples(join(context.sourceRoot, "engine/Cargo.lock"));
  const actual = quickJsLockTuples(join(context.workDir, "guest/Cargo.lock"));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `staged guest QuickJS lock differs from measured source: ` +
        `expected ${expected.join(", ")}; got ${actual.join(", ")}`,
    );
  }
}

function buildWasm(sourceRoot: string): void {
  const result = command([process.execPath, join(sourceRoot, "tools/wasm.ts")], sourceRoot);
  if (result.exitCode !== 0) throw failure("building Native correctness WASM", result);
}

export function snapshotGuestArtifacts(
  sourceBundle: string,
  sourcePak: string | null,
  workDir: string,
  cacheKey: string,
): GuestArtifacts {
  const artifactDirectory = join(
    workDir,
    "artifacts",
    createHash("sha256").update(cacheKey).digest("hex"),
  );
  mkdirSync(artifactDirectory, { recursive: true });
  const frozenBundle = join(artifactDirectory, "bundle.js");
  copyFileSync(sourceBundle, frozenBundle);
  let frozenPak: string | null = null;
  if (sourcePak) {
    frozenPak = join(artifactDirectory, "bundle.pak");
    copyFileSync(sourcePak, frozenPak);
  }
  return { bundle: frozenBundle, pak: frozenPak };
}

function buildGuestArtifacts(context: SuiteContext, scenario: ScenarioV1): GuestArtifacts {
  const sourceRoot = context.sourceRoot;
  const renderContract = qemuScenarioRenderContract(scenario);
  const result = command([
    process.execPath,
    join(sourceRoot, "tools/build.ts"),
    scenario.subject.id,
    `--framework=${scenario.subject.framework}`,
    renderContract.densityArgument,
    `--outdir=${join(sourceRoot, "dist")}`,
  ], sourceRoot);
  if (result.exitCode !== 0) throw failure(`building ${scenario.subject.id}`, result);
  const bundle = join(sourceRoot, "dist", `${scenario.subject.entry}.js`);
  const pakPath = join(sourceRoot, "dist", `${scenario.subject.entry}.pak`);
  if (!existsSync(bundle)) throw new Error(`${scenario.id}: build did not produce ${bundle}`);
  const pak = existsSync(pakPath) ? pakPath : null;
  if (scenario.executorRequirements.includes("assets.pak") && !pak) {
    throw new Error(`${scenario.id}: build did not produce required ${pakPath}`);
  }
  return snapshotGuestArtifacts(
    bundle,
    pak,
    context.workDir,
    renderContract.artifactCacheKey,
  );
}

function runIsolatedNative(
  context: SuiteContext,
  scenario: ScenarioV1,
  artifacts: GuestArtifacts,
  directory: string,
): NativeRunResult {
  mkdirSync(directory, { recursive: true });
  const scenarioPath = join(directory, "scenario.json");
  const sourceRoot = join(directory, "source");
  mkdirSync(join(sourceRoot, "hosts/web"), { recursive: true });
  mkdirSync(join(sourceRoot, "dist"), { recursive: true });
  copyFileSync(
    join(context.sourceRoot, "hosts/web/pocketjs.wasm"),
    join(sourceRoot, "hosts/web/pocketjs.wasm"),
  );
  copyFileSync(artifacts.bundle, join(sourceRoot, "dist", `${scenario.subject.entry}.js`));
  if (artifacts.pak) {
    copyFileSync(artifacts.pak, join(sourceRoot, "dist", `${scenario.subject.entry}.pak`));
  }
  writeFileSync(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`);
  const result = command([
    process.execPath,
    join(context.harnessRoot, "tools/perf/runner/native-cli.ts"),
    scenarioPath,
    "--source-root", sourceRoot,
    "--harness-root", context.harnessRoot,
    "--out-dir", directory,
  ], context.harnessRoot);
  const records = result.stdout.split(/\r?\n/)
    .filter((line) => line.startsWith(NATIVE_RUN_OUTPUT_PREFIX));
  if (records.length !== 1) throw failure(`${scenario.id}: isolated Native correctness replay`, result);
  const parsed = parseNativeResult(JSON.parse(records[0]!.slice(NATIVE_RUN_OUTPUT_PREFIX.length)));
  if (parsed.success === false) {
    throw new Error(`${scenario.id}: invalid Native replay: ${parsed.reasons.join("; ")}`);
  }
  if (result.exitCode !== 0 && !(result.exitCode === 2 && parsed.data.status === "unsupported")) {
    throw failure(`${scenario.id}: isolated Native correctness replay`, result);
  }
  return parsed.data;
}

function containerWorkPath(context: SuiteContext, hostPath: string): string {
  const workPath = relative(context.workDir, hostPath);
  if (!workPath.startsWith("..")) return `/work/${workPath}`;
  const outputPath = relative(context.outDir, hostPath);
  if (!outputPath.startsWith("..")) return `/output/${outputPath}`;
  throw new Error(`${hostPath} is outside QEMU work and output directories`);
}

function guestArguments(
  context: SuiteContext,
  binary: string,
  scenarioPath: string,
  artifacts: GuestArtifacts,
  mode: "correctness" | "measurement",
  framebufferPath?: string,
  framebufferDir?: string,
): readonly string[] {
  const args = [
    context.target.emulator,
    ...context.target.cpuArgs,
    ...context.target.emulatorArgs,
    "-L", context.target.sysroot,
    ...(mode === "measurement"
      ? ["-d", "plugin", "-plugin", QEMU_PLUGIN]
      : []),
    containerWorkPath(context, binary),
    "--scenario", containerWorkPath(context, scenarioPath),
    "--bundle", containerWorkPath(context, artifacts.bundle),
    ...(artifacts.pak ? ["--pak", containerWorkPath(context, artifacts.pak)] : []),
    ...(mode === "correctness"
      ? [
          "--correctness",
          ...(framebufferPath
            ? ["--framebuffer-out", containerWorkPath(context, framebufferPath)]
            : []),
          ...(framebufferDir
            ? ["--framebuffer-dir", containerWorkPath(context, framebufferDir)]
            : []),
        ]
      : ["--markers"]),
  ];
  return args;
}

function runQuickJsGuest(
  context: SuiteContext,
  binary: string,
  scenario: ScenarioV1,
  artifacts: GuestArtifacts,
  directory: string,
): QemuRunArtifacts {
  mkdirSync(directory, { recursive: true });
  const scenarioPath = join(directory, "scenario.json");
  const framebufferPath = join(directory, "correctness.rgba");
  const framebufferDir = join(directory, "correctness-frames");
  writeFileSync(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`);
  const correctness = dockerRun(
    context,
    guestArguments(
      context,
      binary,
      scenarioPath,
      artifacts,
      "correctness",
      framebufferPath,
      framebufferDir,
    ),
    { network: false },
  );
  writeFileSync(join(directory, "correctness.log"), correctness.combined);
  if (correctness.exitCode !== 0) throw failure(`${scenario.id}: QEMU correctness replay`, correctness);
  const expectedFramebufferBytes = framebufferByteLength(scenario);
  if (!existsSync(framebufferPath) || statSync(framebufferPath).size !== expectedFramebufferBytes) {
    throw new Error(
      `${scenario.id}: correctness replay did not emit the expected ` +
        `${expectedFramebufferBytes}-byte RGBA framebuffer`,
    );
  }
  const correctnessFramebufferHash = createHash("sha256")
    .update(readFileSync(framebufferPath))
    .digest("hex");
  const checkpointFramebufferHashes: Record<string, string> = {};
  for (const checkpoint of scenario.checkpoints) {
    if (!checkpoint.capture.includes("framebuffer")) continue;
    const path = join(framebufferDir, `${checkpoint.frame}.rgba`);
    if (!existsSync(path) || statSync(path).size !== expectedFramebufferBytes) {
      throw new Error(`${scenario.id}: missing correctness framebuffer checkpoint ${checkpoint.frame}`);
    }
    checkpointFramebufferHashes[String(checkpoint.frame)] = createHash("sha256")
      .update(readFileSync(path))
      .digest("hex");
  }
  const stateBytes = readFileSync(join(framebufferDir, "state.json"));
  const effectBytes = readFileSync(join(framebufferDir, "effects.json"));
  const correctnessStateHash = sha256Json(JSON.parse(text(stateBytes)));
  const correctnessEffectHash = sha256Json(JSON.parse(text(effectBytes)));
  const measurement = dockerRun(
    context,
    guestArguments(context, binary, scenarioPath, artifacts, "measurement"),
    { network: false },
  );
  writeFileSync(join(directory, "measurement.log"), measurement.combined);
  if (measurement.exitCode !== 0) {
    throw failure(`${scenario.id}: QEMU measurement replay`, measurement);
  }
  const metrics: ArtifactMetrics = {
    "artifact.bundle_bytes": statSync(artifacts.bundle).size,
    ...(artifacts.pak ? { "artifact.pak_bytes": statSync(artifacts.pak).size } : {}),
    "artifact.elf_text_rodata_bytes": elfTextRodata(context, binary),
  };
  return {
    binary,
    correctnessOutput: correctness.combined,
    correctnessFramebufferHash,
    checkpointFramebufferHashes,
    correctnessStateHash,
    correctnessEffectHash,
    measurementOutput: measurement.combined,
    artifactMetrics: metrics,
  };
}

export function qemuScenarioRenderContract(scenario: ScenarioV1): {
  readonly artifactCacheKey: string;
  readonly densityArgument: string;
  readonly framebufferByteLength: number;
} {
  const render = buildRenderConfig(scenario.params);
  return {
    artifactCacheKey: artifactBuildVariantKey(scenario),
    densityArgument: `--density=${render.rasterDensity}`,
    framebufferByteLength: rgbaFramebufferByteLength(render),
  };
}

function framebufferByteLength(scenario: ScenarioV1): number {
  return qemuScenarioRenderContract(scenario).framebufferByteLength;
}

function elfTextRodata(context: SuiteContext, binary: string): number {
  const result = dockerRun(context, [
    context.target.sizeTool,
    "-A", "-d", containerWorkPath(context, binary),
  ], { network: false });
  if (result.exitCode !== 0) throw failure(`inspecting ${basename(binary)} ELF sections`, result);
  let total = 0;
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^\s*(\.text(?:\.[^\s]+)?|\.rodata(?:\.[^\s]+)?)\s+(\d+)\b/.exec(line);
    if (match) total += Number(match[2]);
  }
  if (!Number.isSafeInteger(total) || total <= 0) {
    throw new Error(`${basename(binary)} has no measurable .text/.rodata sections`);
  }
  return total;
}

function binaryHash(paths: readonly { readonly tag: string; readonly path: string | null }[]): string {
  const hash = createHash("sha256");
  for (const item of paths) {
    hash.update(item.tag).update("\0");
    if (!item.path) {
      hash.update("absent\0");
      continue;
    }
    const bytes = readFileSync(item.path);
    hash.update(String(bytes.byteLength)).update("\0").update(bytes);
  }
  return hash.digest("hex");
}

function environment(
  context: SuiteContext,
  scenario: ScenarioV1,
  binarySha256: string,
  profile: string,
  build: {
    readonly target?: string;
    readonly rustFlags?: readonly string[];
    readonly cFlags?: readonly string[];
    readonly linkerFlags?: readonly string[];
  } = {},
): ReceiptEnvironmentV1 {
  const native = nativeProvenance(context.sourceRoot, scenario);
  return {
    source: native.source,
    toolchain: context.toolchain,
    build: {
      target: build.target ?? context.target.rustTarget,
      profile,
      rustFlags: build.rustFlags ?? context.target.rustFlags,
      cFlags: build.cFlags ?? context.target.cFlags,
      linkerFlags: build.linkerFlags ?? [],
    },
    executor: {
      id: context.target.executor,
      version: "QEMU 11.0.3 linux-user / plugin API 6",
      profile: `deterministic-linux-user;host=${context.hostPlatform}/${context.hostArch};` +
        `cpu=${context.target.cpuArgs.join(" ")};` +
        `emulator=${context.target.emulatorArgs.join(" ")};` +
        `entropy=${QEMU_ENTROPY_PROFILE};${context.imageIdentity}`,
      fingerprint: context.fingerprint,
    },
    binary: { sha256: binarySha256 },
  };
}

export function qemuQuickJsReplayReasons(
  scenario: ScenarioV1,
  correctnessOutput: string,
  measurementOutput: string,
  expectedFramebufferTraceHash?: string,
): { readonly correctness: GuestProtocolResult; readonly measurement: GuestProtocolResult; readonly reasons: string[] } {
  const correctness = parseGuestOutput(correctnessOutput, { framebufferTraceHash: "required" });
  const measurement = parseGuestOutput(measurementOutput, { framebufferTraceHash: "forbidden" });
  const reasons = [
    ...(correctness.status === "invalid" ? correctness.reasons.map((reason) => `correctness: ${reason}`) : []),
    ...(measurement.status === "invalid" ? measurement.reasons.map((reason) => `measurement: ${reason}`) : []),
  ];
  if (correctness.complete) {
    if (correctness.complete.scenarioId !== scenario.id) reasons.push("correctness scenarioId mismatch");
    if (correctness.complete.framework !== scenario.subject.framework) reasons.push("correctness framework mismatch");
    if (correctness.complete.framebufferTraceHash && expectedFramebufferTraceHash !== undefined &&
        correctness.complete.framebufferTraceHash !== expectedFramebufferTraceHash) {
      reasons.push("QEMU correctness framebuffer trace differs from Native/WASM correctness replay");
    }
  }
  if (measurement.complete) {
    if (measurement.complete.scenarioId !== scenario.id) reasons.push("measurement scenarioId mismatch");
    if (measurement.complete.framework !== scenario.subject.framework) reasons.push("measurement framework mismatch");
  }
  if (correctness.phases.length !== measurement.phases.length) {
    reasons.push("correctness and measurement emitted different phase counts");
  }
  for (let index = 0; index < Math.max(correctness.phases.length, measurement.phases.length); index += 1) {
    const left = correctness.phases[index];
    const right = measurement.phases[index];
    if (!left || !right) continue;
    if (left.phase !== right.phase || left.phaseId !== right.phaseId || left.iteration !== right.iteration) {
      reasons.push(`correctness/measurement phase ${index} identity differs`);
    }
    if (left.drawListHash !== right.drawListHash) {
      reasons.push(`correctness/measurement DrawList differs after phase ${left.phase}`);
    }
  }
  if (correctness.complete && measurement.complete &&
      correctness.complete.finalDrawListHash !== measurement.complete.finalDrawListHash) {
    reasons.push("correctness/measurement final DrawList differs");
  }
  return { correctness, measurement, reasons };
}

function invalidate(receipts: readonly ReceiptV1[], reasons: readonly string[]): readonly ReceiptV1[] {
  if (reasons.length === 0) return receipts;
  return receipts.map((receipt) => parseReceiptV1({
    ...receipt,
    status: "invalid",
    invalidReasons: [...new Set([...receipt.invalidReasons, ...reasons])],
  }));
}

function nativeCorrectness(result: NativeRunResult, scenario: ScenarioV1): NativeOkResult["correctness"] {
  if (result.status !== "ok") {
    throw new Error(`${scenario.id}: Native correctness replay unsupported: ${result.reasons.join("; ")}`);
  }
  return result.correctness;
}

function applyCorrectness(
  receipts: readonly ReceiptV1[],
  correctness: NativeOkResult["correctness"] | DamageCorrectnessRecordV1,
): readonly ReceiptV1[] {
  return receipts.map((receipt) => {
    if (!receipt.correctness) return receipt;
    return parseReceiptV1({
      ...receipt,
      correctness: {
        ...receipt.correctness,
        stateHash: correctness.stateHash,
        effectHash: correctness.effectHash,
      },
    });
  });
}

function quickJsReceipts(
  context: SuiteContext,
  scenario: ScenarioV1,
  artifacts: GuestArtifacts,
  run: QemuRunArtifacts,
  native: NativeOkResult["correctness"],
): readonly ReceiptV1[] {
  const replay = qemuQuickJsReplayReasons(
    scenario,
    run.correctnessOutput,
    run.measurementOutput,
    native.framebufferTraceHash,
  );
  const reasons = [...replay.reasons];
  if (replay.correctness.complete && replay.correctness.complete.finalDrawListHash !== native.drawListHash) {
    reasons.push("QEMU correctness DrawList differs from Native/WASM correctness replay");
  }
  if (run.correctnessFramebufferHash !== native.finalFramebufferHash) {
    reasons.push("QEMU correctness framebuffer differs from Native/WASM correctness replay");
  }
  for (const [frame, hash] of Object.entries(run.checkpointFramebufferHashes)) {
    const expected = native.checkpoints[frame]?.framebuffer;
    if (!expected) reasons.push(`Native/WASM correctness replay has no framebuffer checkpoint ${frame}`);
    else if (hash !== expected) reasons.push(`QEMU framebuffer differs at correctness checkpoint ${frame}`);
  }
  if (run.correctnessStateHash !== native.stateHash) {
    reasons.push("QEMU correctness state tree differs from Native/WASM correctness replay");
  }
  if (run.correctnessEffectHash !== native.effectHash) {
    reasons.push("QEMU correctness effect trace differs from Native/WASM correctness replay");
  }
  const provenance = environment(
    context,
    scenario,
    binaryHash([
      { tag: "elf", path: run.binary },
      { tag: "bundle", path: artifacts.bundle },
      { tag: "pak", path: artifacts.pak },
    ]),
    "cargo-release-perf-guest",
  );
  const receipts = createQemuReceipts(scenario, run.measurementOutput, {
    provenance,
    target: context.target.qemuTarget,
    correctnessGuestOutput: run.correctnessOutput,
    framebufferHash: native.framebufferTraceHash,
    artifactMetrics: run.artifactMetrics,
    createdAt: new Date().toISOString(),
  });
  return invalidate(applyCorrectness(receipts, native), reasons);
}

function runDamage(
  context: SuiteContext,
  scenario: ScenarioV1,
  directory: string,
): readonly ReceiptV1[] {
  const fixtureDir = join(context.workDir, `damage-${safeName(scenario)}`);
  const fixture = materializeDamageFixture({
    sourceRoot: context.sourceRoot,
    harnessRoot: context.harnessRoot,
    destination: fixtureDir,
    dependencyRoot: "/source",
  });
  const targetDir = join(fixtureDir, "target");
  const binary = buildCargoFixture(context, fixture.manifestPath, targetDir, fixture.binaryName);
  mkdirSync(directory, { recursive: true });
  const scenarioPath = join(context.workDir, `damage-${safeName(scenario)}.json`);
  writeFileSync(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`);
  const base = [
    context.target.emulator,
    ...context.target.cpuArgs,
    ...context.target.emulatorArgs,
    "-L", context.target.sysroot,
    containerWorkPath(context, binary),
    ...damageFixtureArgs(containerWorkPath(context, scenarioPath), "correctness"),
  ];
  const correctnessRun = dockerRun(context, base, { network: false });
  writeFileSync(join(directory, "correctness.log"), correctnessRun.combined);
  if (correctnessRun.exitCode !== 0) throw failure(`${scenario.id}: damage correctness replay`, correctnessRun);
  const correctness = parseDamageCorrectnessOutput(correctnessRun.combined);
  const measurementArgs = [
    context.target.emulator,
    ...context.target.cpuArgs,
    ...context.target.emulatorArgs,
    "-L", context.target.sysroot,
    "-d", "plugin", "-plugin", QEMU_PLUGIN,
    containerWorkPath(context, binary),
    ...damageFixtureArgs(containerWorkPath(context, scenarioPath), "markers"),
  ];
  const measurement = dockerRun(context, measurementArgs, { network: false });
  writeFileSync(join(directory, "measurement.log"), measurement.combined);
  const parsed = parseGuestOutput(measurement.combined);
  const reasons: string[] = [];
  if (measurement.exitCode !== 0) reasons.push(`${scenario.id}: damage measurement exited ${measurement.exitCode}`);
  if (correctness.scenarioId !== scenario.id) reasons.push("damage correctness scenarioId mismatch");
  if (parsed.complete && parsed.complete.finalDrawListHash !== correctness.drawListHash) {
    reasons.push("damage correctness/measurement final DrawList differs");
  }
  const artifactMetrics: ArtifactMetrics = {
    "artifact.elf_text_rodata_bytes": elfTextRodata(context, binary),
  };
  const provenance = environment(
    context,
    scenario,
    binaryHash([{ tag: "elf", path: binary }]),
    "cargo-release-perf-damage",
  );
  const receipts = createQemuReceipts(scenario, measurement.combined, {
    provenance,
    target: context.target.qemuTarget,
    framebufferHash: correctness.framebufferTraceHash,
    artifactMetrics,
    createdAt: new Date().toISOString(),
  });
  return invalidate(applyCorrectness(receipts, correctness), reasons);
}

function parseVaporWorker(result: CommandOutput): VaporQemuResult | { status: "invalid"; reasons: readonly string[] } {
  if (result.exitCode !== 0) throw failure("isolated Vapor QEMU adapter", result);
  const records = result.stdout.split(/\r?\n/)
    .filter((line) => line.startsWith(QEMU_WORKER_OUTPUT_PREFIX));
  if (records.length !== 1) throw failure("isolated Vapor QEMU adapter", result);
  const value = JSON.parse(records[0]!.slice(QEMU_WORKER_OUTPUT_PREFIX.length)) as Record<string, unknown>;
  if (value.status === "invalid") {
    const reasons = Array.isArray(value.reasons) ? value.reasons.map(String) : ["Vapor adapter returned invalid"];
    return { status: "invalid", reasons };
  }
  if (value.status !== "ok" || typeof value.combinedOutput !== "string" ||
      typeof value.framebufferHash !== "string" || typeof value.elfPath !== "string" ||
      typeof value.stateHash !== "string" || typeof value.effectHash !== "string" ||
      typeof value.finalDrawListHash !== "string" ||
      (value.executor !== "qemu-armv7-thumb2" && value.executor !== "qemu-aarch64") ||
      typeof value.artifactMetrics !== "object" || value.artifactMetrics === null ||
      typeof value.build !== "object" || value.build === null) {
    throw new Error("isolated Vapor QEMU adapter returned an invalid result");
  }
  return value as unknown as VaporQemuResult;
}

function runVapor(
  context: SuiteContext,
  scenario: ScenarioV1,
  directory: string,
): readonly ReceiptV1[] {
  mkdirSync(directory, { recursive: true });
  const scenarioPath = join(directory, "scenario.json");
  writeFileSync(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`);
  const worker = command([
    process.execPath,
    join(context.harnessRoot, "tools/perf/executors/qemu-worker.ts"),
    "--scenario", scenarioPath,
    "--executor", context.target.executor,
    "--source-root", context.sourceRoot,
    "--harness-root", context.harnessRoot,
    "--out-dir", directory,
    "--image", context.image,
  ], context.harnessRoot);
  const result = parseVaporWorker(worker);
  if (result.status === "invalid") throw new Error(result.reasons.join("; "));
  if (result.executor !== context.target.executor) {
    throw new Error(`Vapor adapter returned executor ${result.executor} for ${context.target.executor}`);
  }
  writeFileSync(join(directory, "measurement.log"), result.combinedOutput);
  const elfPath = resolve(result.elfPath);
  if (!existsSync(elfPath)) throw new Error(`Vapor adapter ELF is missing: ${elfPath}`);
  const build = result.build;
  if (build.qemuTarget !== context.target.qemuTarget ||
      JSON.stringify(build.cpuArgs) !== JSON.stringify(context.target.cpuArgs) ||
      JSON.stringify(build.emulatorArgs) !== JSON.stringify(context.target.emulatorArgs)) {
    throw new Error(`Vapor adapter QEMU target/invocation profile differs from ${context.target.executor}`);
  }
  const provenance = environment(
    context,
    scenario,
    binaryHash([{ tag: "elf", path: elfPath }]),
    "generated-c-release",
    {
      target: context.target.rustTarget,
      rustFlags: [],
      cFlags: build.cFlags,
      linkerFlags: build.linkerFlags,
    },
  );
  const receipts = createQemuReceipts(scenario, result.combinedOutput, {
    provenance,
    target: build.qemuTarget,
    framebufferHash: result.framebufferHash,
    artifactMetrics: result.artifactMetrics,
    createdAt: new Date().toISOString(),
  });
  return receipts.map((receipt) => receipt.correctness
    ? parseReceiptV1({
        ...receipt,
        correctness: {
          ...receipt.correctness,
          stateHash: result.stateHash,
          effectHash: result.effectHash,
        },
      })
    : receipt);
}

/** Build and run one deterministic local suite under pinned QEMU linux-user. */
export async function runQemuSuite(options: QemuBridgeOptions): Promise<QemuSuiteResult> {
  let scenarios: ScenarioV1[];
  try {
    scenarios = expandSuiteFrameworks(loadScenarioSuite(options.suite, options.scenarioDir));
    if (scenarios.length === 0) {
      return { receipts: [], invalidReasons: [`no scenarios found for suite ${JSON.stringify(options.suite)}`] };
    }
    const capabilityReasons = scenarios.flatMap(qemuScenarioCapabilityReasons);
    if (capabilityReasons.length > 0) {
      return { receipts: [], invalidReasons: capabilityReasons };
    }
    const estimate = estimatedSuiteSeconds(scenarios);
    if (estimate > options.maxEstimatedSeconds) {
      return {
        receipts: [],
        invalidReasons: [
          `${options.suite} suite estimate ${estimate}s exceeds the ${options.maxEstimatedSeconds}s limit`,
        ],
      };
    }
  } catch (error) {
    return { receipts: [], invalidReasons: [error instanceof Error ? error.message : String(error)] };
  }

  let context: SuiteContext;
  try {
    context = makeContext(options);
  } catch (error) {
    return { receipts: [], invalidReasons: [error instanceof Error ? error.message : String(error)] };
  }
  try {
    const receipts: ReceiptV1[] = [];
    const invalidReasons: string[] = [];
    let guestBinary: string | null = null;
    let wasmBuilt = false;
    const builtApps = new Map<string, GuestArtifacts>();

    for (const scenario of scenarios) {
      const directory = join(context.outDir, "raw", safeName(scenario));
      try {
        let next: readonly ReceiptV1[];
        if (scenario.subject.family === "guest-app") {
          if (!wasmBuilt) {
            buildWasm(context.sourceRoot);
            wasmBuilt = true;
          }
          if (!guestBinary) {
            const guest = materializeGuestHarness(context);
            guestBinary = buildCargoFixture(
              context,
              guest.manifest,
              guest.targetDir,
              "pocketjs-perf-guest",
            );
          }
          const appKey = qemuScenarioRenderContract(scenario).artifactCacheKey;
          let artifacts = builtApps.get(appKey);
          if (!artifacts) {
            artifacts = buildGuestArtifacts(context, scenario);
            builtApps.set(appKey, artifacts);
          }
          const native = nativeCorrectness(
            runIsolatedNative(context, scenario, artifacts, join(directory, "native")),
            scenario,
          );
          const run = runQuickJsGuest(context, guestBinary, scenario, artifacts, directory);
          next = quickJsReceipts(context, scenario, artifacts, run, native);
        } else if (isDamageScenario(scenario)) {
          next = runDamage(context, scenario, directory);
        } else if (scenario.subject.family === "vapor") {
          next = runVapor(context, scenario, directory);
        } else {
          throw new Error(`no QEMU adapter for subject family ${JSON.stringify(scenario.subject.family)}`);
        }
        receipts.push(...next);
        for (const receipt of next) {
          if (receipt.status === "invalid") {
            invalidReasons.push(...receipt.invalidReasons.map((reason) => `${scenario.id}: ${reason}`));
          }
        }
      } catch (error) {
        invalidReasons.push(`${scenario.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { receipts, invalidReasons: [...new Set(invalidReasons)] };
  } finally {
    cleanupWorkDirectory(context.outDir, context.workDir, context.image);
  }
}
