import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  artifactBuildVariantKey,
  buildRenderConfig,
  parseReceiptV1,
  type ReceiptV1,
  type ScenarioV1,
} from "../core/index.ts";
import { loadScenarioSuite, estimatedSuiteSeconds, expandSuiteFrameworks } from "../runner/suite.ts";
import type { NativeRunResult } from "../runner/native.ts";
import { isDamageScenario } from "../executors/damage.ts";
import { NATIVE_RUN_OUTPUT_PREFIX, parseNativeResult } from "../receipts/native-protocol.ts";
import { HARNESS_ROOT, qemuBridgePath } from "./doctor.ts";
import { runCommand } from "./process.ts";
import { nativeResultToReceipt, writeReceipt } from "./receipts.ts";
import type { ExecutorId, PerfRunSummaryV1, QemuBridge } from "./types.ts";

export interface RunExecutorOptions {
  readonly executor: ExecutorId;
  readonly suite: string;
  readonly sourceRoot?: string;
  readonly harnessRoot?: string;
  readonly scenarioDir?: string;
  readonly outDir?: string;
  readonly maxEstimatedSeconds: number;
}

function prepareOutput(path?: string): string {
  const result = path
    ? resolve(path)
    : mkdtempSync(join(tmpdir(), "pocketjs-perf-run-"));
  mkdirSync(result, { recursive: true });
  return result;
}

function writeSummary(summary: PerfRunSummaryV1): PerfRunSummaryV1 {
  mkdirSync(summary.outputDir, { recursive: true });
  const outputDir = resolve(summary.outputDir);
  const receipts = summary.receipts.map((path) => {
    const absolute = isAbsolute(path) ? resolve(path) : resolve(outputDir, path);
    const local = relative(outputDir, absolute);
    return local.length > 0 && local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local)
      ? local
      : path;
  });
  const portable = { ...summary, outputDir, receipts };
  writeFileSync(join(outputDir, "run.json"), `${JSON.stringify(portable, null, 2)}\n`);
  return portable;
}

function invalidSummary(options: Required<Pick<RunExecutorOptions, "executor" | "suite">> & {
  sourceRoot: string;
  outDir: string;
}, reasons: readonly string[]): PerfRunSummaryV1 {
  return writeSummary({
    schemaVersion: 1,
    kind: "pocketjs.perf.run",
    status: "invalid",
    executor: options.executor,
    suite: options.suite,
    sourceRoot: options.sourceRoot,
    outputDir: options.outDir,
    receipts: [],
    invalidReasons: reasons,
  });
}

function buildGuestApp(
  sourceRoot: string,
  scenario: ScenarioV1,
): string | null {
  if (scenario.subject.family !== "guest-app") return null;
  const render = buildRenderConfig(scenario.params);
  const outDir = join(sourceRoot, "dist");
  const argv = [
    process.execPath,
    join(sourceRoot, "tools/build.ts"),
    scenario.subject.id,
    `--framework=${scenario.subject.framework}`,
    `--density=${render.rasterDensity}`,
    `--outdir=${outDir}`,
  ];
  const build = runCommand(argv, { cwd: sourceRoot });
  if (build.exitCode === 0) return null;
  const detail = new TextDecoder().decode(build.stderr).trim();
  return `${scenario.id}: build failed (${build.exitCode})${detail ? `: ${detail}` : ""}`;
}

function buildNativeRuntime(sourceRoot: string): string | null {
  const build = runCommand([process.execPath, join(sourceRoot, "tools/wasm.ts")], {
    cwd: sourceRoot,
  });
  if (build.exitCode === 0) return null;
  const detail = new TextDecoder().decode(build.stderr).trim();
  return `WASM runtime build failed (${build.exitCode})${detail ? `: ${detail}` : ""}`;
}

function runIsolatedNativeScenario(
  scenario: ScenarioV1,
  options: { sourceRoot: string; harnessRoot: string; rawOutDir: string },
): { result: NativeRunResult; scenarioOutDir: string } {
  const safe = `${scenario.id}.${scenario.subject.framework}`.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const scenarioOutDir = join(options.rawOutDir, safe);
  const scenarioPath = join(scenarioOutDir, "scenario.json");
  mkdirSync(scenarioOutDir, { recursive: true });
  writeFileSync(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`);
  const command = runCommand([
    process.execPath,
    join(options.harnessRoot, "tools/perf/runner/native-cli.ts"),
    scenarioPath,
    "--source-root", options.sourceRoot,
    "--harness-root", options.harnessRoot,
    "--out-dir", scenarioOutDir,
  ], { cwd: options.harnessRoot });
  const stdout = new TextDecoder().decode(command.stdout);
  const records = stdout.split(/\r?\n/)
    .filter((line) => line.startsWith(NATIVE_RUN_OUTPUT_PREFIX));
  if (records.length !== 1) {
    const detail = new TextDecoder().decode(command.stderr).trim();
    throw new Error(
      `${scenario.id}: isolated Native runner emitted ${records.length} result records` +
        `${detail ? `: ${detail}` : ""}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(records[0]!.slice(NATIVE_RUN_OUTPUT_PREFIX.length));
  } catch (error) {
    throw new Error(`${scenario.id}: isolated Native result is not JSON: ${String(error)}`);
  }
  const parsed = parseNativeResult(value);
  if (!parsed.success) {
    throw new Error(`${scenario.id}: ${parsed.reasons.join("; ")}`);
  }
  if (command.exitCode !== 0 && !(command.exitCode === 2 && parsed.data.status === "unsupported")) {
    const detail = new TextDecoder().decode(command.stderr).trim();
    throw new Error(`${scenario.id}: isolated Native runner failed (${command.exitCode})${detail ? `: ${detail}` : ""}`);
  }
  return { result: parsed.data, scenarioOutDir };
}

async function runNative(options: RunExecutorOptions & {
  sourceRoot: string;
  scenarioDir: string;
  outDir: string;
}): Promise<PerfRunSummaryV1> {
  let scenarios: ScenarioV1[];
  try {
    scenarios = expandSuiteFrameworks(loadScenarioSuite(options.suite, options.scenarioDir));
    if (scenarios.length === 0) return invalidSummary(options, [`no scenarios found for suite ${JSON.stringify(options.suite)}`]);
    const estimate = estimatedSuiteSeconds(scenarios);
    if (estimate > options.maxEstimatedSeconds) {
      return invalidSummary(options, [
        `${options.suite} suite estimate ${estimate}s exceeds the ${options.maxEstimatedSeconds}s limit`,
      ]);
    }
  } catch (error) {
    return invalidSummary(options, [error instanceof Error ? error.message : String(error)]);
  }

  try {
    const receipts: string[] = [];
    const invalidReasons: string[] = [];
    if (scenarios.some((scenario) => scenario.subject.family === "guest-app")) {
      const runtimeFailure = buildNativeRuntime(options.sourceRoot);
      if (runtimeFailure) return invalidSummary(options, [runtimeFailure]);
    }
    const builtVariant = new Map<string, string>();
    // Build immediately before each replay. Framework variants may share an
    // output name, so prebuilding the complete matrix would make the final
    // variant silently replace earlier bundles.
    for (const scenario of scenarios) {
      const variant = artifactBuildVariantKey(scenario);
      const alreadyBuilt = builtVariant.get(scenario.subject.entry) === variant;
      const buildFailure = alreadyBuilt ? null : buildGuestApp(options.sourceRoot, scenario);
      if (buildFailure) {
        invalidReasons.push(buildFailure);
        continue;
      }
      if (scenario.subject.family === "guest-app") builtVariant.set(scenario.subject.entry, variant);
      const rawOutDir = join(options.outDir, "raw");
      const isolated = runIsolatedNativeScenario(scenario, {
        sourceRoot: options.sourceRoot,
        harnessRoot: options.harnessRoot ?? HARNESS_ROOT,
        rawOutDir,
      });
      const nativeResult = isolated.result;
      const extraArtifacts = isDamageScenario(scenario)
        ? [join(isolated.scenarioOutDir, "damage-fixture", "target", "release", "pocketjs-perf-damage")]
        : [];
      const receipt = nativeResultToReceipt(
        nativeResult,
        scenario,
        options.sourceRoot,
        extraArtifacts,
      );
      receipts.push(writeReceipt(options.outDir, receipt));
      if (receipt.status === "invalid") invalidReasons.push(...receipt.invalidReasons.map((reason) => `${scenario.id}: ${reason}`));
    }
    return writeSummary({
      schemaVersion: 1,
      kind: "pocketjs.perf.run",
      status: invalidReasons.length === 0 ? "valid" : "invalid",
      executor: "native",
      suite: options.suite,
      sourceRoot: options.sourceRoot,
      outputDir: options.outDir,
      receipts,
      invalidReasons,
    });
  } catch (error) {
    return invalidSummary(options, [error instanceof Error ? error.message : String(error)]);
  }
}

function qemuReceipts(value: unknown): { receipts: readonly ReceiptV1[]; invalidReasons: readonly string[] } | null {
  if (Array.isArray(value)) return { receipts: value.map(parseReceiptV1), invalidReasons: [] };
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.receipts)) return null;
  return {
    receipts: record.receipts.map(parseReceiptV1),
    invalidReasons: Array.isArray(record.invalidReasons)
      ? record.invalidReasons.map((reason) => String(reason))
      : [],
  };
}

async function runQemu(options: RunExecutorOptions & {
  sourceRoot: string;
  harnessRoot: string;
  scenarioDir: string;
  outDir: string;
}): Promise<PerfRunSummaryV1> {
  const bridgePath = qemuBridgePath(options.harnessRoot);
  if (!bridgePath) {
    return invalidSummary(options, [
      "QEMU executor bridge is unavailable; expected tools/perf/executors/qemu.ts",
    ]);
  }
  try {
    const module = await import(pathToFileURL(bridgePath).href) as Partial<QemuBridge>;
    if (typeof module.runQemuSuite !== "function") {
      return invalidSummary(options, [`${bridgePath} does not export runQemuSuite(options)`]);
    }
    const bridgeResult = await module.runQemuSuite({
      executor: options.executor as Exclude<ExecutorId, "native">,
      suite: options.suite,
      sourceRoot: options.sourceRoot,
      harnessRoot: options.harnessRoot,
      scenarioDir: options.scenarioDir,
      outDir: options.outDir,
      maxEstimatedSeconds: options.maxEstimatedSeconds,
    });
    if (typeof bridgeResult === "object" && bridgeResult !== null &&
        "kind" in bridgeResult && bridgeResult.kind === "pocketjs.perf.run") {
      return writeSummary(bridgeResult as PerfRunSummaryV1);
    }
    const normalized = qemuReceipts(bridgeResult);
    if (!normalized) return invalidSummary(options, ["QEMU bridge returned an unsupported result"]);
    const paths = normalized.receipts.map((receipt) => writeReceipt(options.outDir, receipt));
    const receiptReasons = normalized.receipts.flatMap((receipt) =>
      receipt.status === "invalid" ? receipt.invalidReasons : []);
    const invalidReasons = [...normalized.invalidReasons, ...receiptReasons];
    return writeSummary({
      schemaVersion: 1,
      kind: "pocketjs.perf.run",
      status: invalidReasons.length === 0 ? "valid" : "invalid",
      executor: options.executor,
      suite: options.suite,
      sourceRoot: options.sourceRoot,
      outputDir: options.outDir,
      receipts: paths,
      invalidReasons,
    });
  } catch (error) {
    return invalidSummary(options, [error instanceof Error ? error.message : String(error)]);
  }
}

export async function runExecutor(options: RunExecutorOptions): Promise<PerfRunSummaryV1> {
  const harnessRoot = resolve(options.harnessRoot ?? HARNESS_ROOT);
  const sourceRoot = resolve(options.sourceRoot ?? harnessRoot);
  const scenarioDir = resolve(options.scenarioDir ?? join(harnessRoot, "tools/perf/scenarios"));
  const outDir = prepareOutput(options.outDir);
  if (!existsSync(sourceRoot)) return invalidSummary({ ...options, sourceRoot, outDir }, [`source root does not exist: ${sourceRoot}`]);
  if (!existsSync(scenarioDir)) return invalidSummary({ ...options, sourceRoot, outDir }, [`scenario directory does not exist: ${scenarioDir}`]);
  return options.executor === "native"
    ? runNative({ ...options, sourceRoot, scenarioDir, outDir })
    : runQemu({ ...options, sourceRoot, harnessRoot, scenarioDir, outDir });
}
