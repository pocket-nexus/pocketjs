import { copyFileSync, existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScenarioV1 } from "../core/index.ts";
import type { NativeOkResult, NativeRunResult } from "../runner/native.ts";

export const DAMAGE_FIXTURE_PACKAGE = "pocketjs-perf-damage";
export const DAMAGE_FIXTURE_BINARY = "pocketjs-perf-damage";
export const DAMAGE_OUTPUT_PREFIX = "POCKETJS_PERF_DAMAGE ";

const DEFAULT_HARNESS_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const SHA256 = /^[a-f0-9]{64}$/;
const FNV1A64 = /^fnv1a64:[a-f0-9]{16}$/;

export type DamageFixtureMode = "correctness" | "measurement" | "markers";

export interface MaterializeDamageFixtureOptions {
  /** Revision whose engine/core implementation is under test. */
  readonly sourceRoot: string;
  /** Revision containing this executor and fixture source. */
  readonly harnessRoot?: string;
  /** Existing or new staging directory. */
  readonly destination: string;
  /** Core path as seen by the compiler (for example /source in Docker). */
  readonly dependencyRoot?: string;
}

export interface MaterializedDamageFixture {
  readonly root: string;
  readonly manifestPath: string;
  readonly packageName: typeof DAMAGE_FIXTURE_PACKAGE;
  readonly binaryName: typeof DAMAGE_FIXTURE_BINARY;
}

export interface DamageCorrectnessRecordV1 {
  readonly schemaVersion: 1;
  readonly event: "correctness";
  readonly scenarioId: string;
  readonly framebufferTraceHash: string;
  readonly finalFramebufferHash: string;
  readonly drawListHash: string;
  readonly stateHash: string;
  readonly effectHash: string;
  readonly checkpoints: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly phaseStats: readonly {
    readonly name: string;
    readonly frames: number;
    readonly fullRedrawFrames: number;
    readonly emptyFrames: number;
    readonly maxRegions: number;
    readonly totalDamageArea: number;
  }[];
}

export interface DamageMeasurementRecordV1 {
  readonly schemaVersion: 1;
  readonly event: "measurement";
  readonly scenarioId: string;
  readonly bootWallTimeNs: number;
  readonly phases: readonly {
    readonly name: string;
    readonly startFrame: number;
    readonly endFrame: number;
    readonly wallTimeNs: number;
  }[];
  readonly finalFramebufferHash: string;
  readonly finalDrawListHash: string;
}

export interface RunNativeDamageOptions {
  readonly sourceRoot: string;
  readonly harnessRoot?: string;
  readonly outDir?: string;
  readonly cargoPath?: string;
}

/** The discriminator shared by Native and QEMU suite dispatch. */
export function isDamageScenario(scenario: ScenarioV1): boolean {
  return scenario.subject.family === "core-lab" &&
    scenario.subject.framework === "core" &&
    scenario.executorRequirements.includes("fixture.core.damage");
}

/**
 * Stage the current harness around a possibly older core checkout. The
 * generated manifest is the important isolation boundary: a baseline never
 * accidentally links the candidate's pocketjs-core.
 */
export function materializeDamageFixture(
  options: MaterializeDamageFixtureOptions,
): MaterializedDamageFixture {
  const sourceRoot = resolve(options.sourceRoot);
  const harnessRoot = resolve(options.harnessRoot ?? DEFAULT_HARNESS_ROOT);
  const destination = resolve(options.destination);
  const fixtureRoot = join(harnessRoot, "tools", "perf", "damage-fixture");
  const fixtureSource = join(fixtureRoot, "src", "main.rs");
  const fixtureLock = join(fixtureRoot, "Cargo.lock");
  if (!existsSync(fixtureSource) || !existsSync(fixtureLock)) {
    throw new Error(`damage fixture source is incomplete under ${fixtureRoot}`);
  }
  const dependencyRoot = options.dependencyRoot ?? sourceRoot;
  const dependency = join(dependencyRoot, "engine", "core");
  if (options.dependencyRoot === undefined && !existsSync(join(dependency, "Cargo.toml"))) {
    throw new Error(`source root has no engine/core/Cargo.toml: ${sourceRoot}`);
  }

  mkdirSync(join(destination, "src"), { recursive: true });
  copyFileSync(fixtureSource, join(destination, "src", "main.rs"));
  copyFileSync(fixtureLock, join(destination, "Cargo.lock"));
  writeFileSync(join(destination, "Cargo.toml"), stagedManifest(dependency));
  return {
    root: destination,
    manifestPath: join(destination, "Cargo.toml"),
    packageName: DAMAGE_FIXTURE_PACKAGE,
    binaryName: DAMAGE_FIXTURE_BINARY,
  };
}

export function damageFixtureArgs(
  scenarioPath: string,
  mode: DamageFixtureMode,
): readonly string[] {
  return ["--scenario", scenarioPath, `--${mode}`];
}

/** Parse the correctness replay without trusting unrelated process output. */
export function parseDamageCorrectnessOutput(output: string): DamageCorrectnessRecordV1 {
  const value = parseDamageRecord(output, "correctness");
  string(value.scenarioId, "scenarioId");
  sha(value.framebufferTraceHash, "framebufferTraceHash");
  sha(value.finalFramebufferHash, "finalFramebufferHash");
  fnv(value.drawListHash, "drawListHash");
  sha(value.stateHash, "stateHash");
  sha(value.effectHash, "effectHash");
  if (!plainRecord(value.checkpoints)) throw new Error("damage checkpoints must be an object");
  for (const [frame, captures] of Object.entries(value.checkpoints)) {
    if (!/^(0|[1-9][0-9]*)$/.test(frame) || !plainRecord(captures)) {
      throw new Error(`damage checkpoint ${frame} is invalid`);
    }
    for (const [capture, digest] of Object.entries(captures)) {
      if (capture === "drawList") fnv(digest, `checkpoints.${frame}.${capture}`);
      else if (["framebuffer", "state", "effects"].includes(capture)) {
        sha(digest, `checkpoints.${frame}.${capture}`);
      } else {
        throw new Error(`damage checkpoint capture ${capture} is unknown`);
      }
    }
  }
  if (!Array.isArray(value.phaseStats) || value.phaseStats.length !== 8) {
    throw new Error("damage correctness must report eight phaseStats");
  }
  for (const [index, entry] of value.phaseStats.entries()) {
    if (!plainRecord(entry)) throw new Error(`damage phaseStats[${index}] must be an object`);
    string(entry.name, `phaseStats[${index}].name`);
    for (const key of ["frames", "fullRedrawFrames", "emptyFrames", "maxRegions", "totalDamageArea"]) {
      uint(entry[key], `phaseStats[${index}].${key}`);
    }
  }
  return value as unknown as DamageCorrectnessRecordV1;
}

export function parseDamageMeasurementOutput(output: string): DamageMeasurementRecordV1 {
  const value = parseDamageRecord(output, "measurement");
  string(value.scenarioId, "scenarioId");
  uint(value.bootWallTimeNs, "bootWallTimeNs");
  sha(value.finalFramebufferHash, "finalFramebufferHash");
  fnv(value.finalDrawListHash, "finalDrawListHash");
  if (!Array.isArray(value.phases) || value.phases.length !== 8) {
    throw new Error("damage measurement must report eight phases");
  }
  for (const [index, entry] of value.phases.entries()) {
    if (!plainRecord(entry)) throw new Error(`damage phases[${index}] must be an object`);
    string(entry.name, `phases[${index}].name`);
    for (const key of ["startFrame", "endFrame", "wallTimeNs"]) {
      uint(entry[key], `phases[${index}].${key}`);
    }
    if ((entry.endFrame as number) <= (entry.startFrame as number)) {
      throw new Error(`damage phases[${index}] has an empty range`);
    }
  }
  return value as unknown as DamageMeasurementRecordV1;
}

/** Execute the core-only correctness and minimally observed measurement replays. */
export async function runNativeDamageScenario(
  scenario: ScenarioV1,
  options: RunNativeDamageOptions,
): Promise<NativeRunResult> {
  if (!isDamageScenario(scenario)) {
    return {
      schemaVersion: 1,
      kind: "pocketjs.perf.native-result",
      status: "unsupported",
      scenarioId: scenario.id,
      executor: "native",
      reasons: ["scenario is not the fixture.core.damage core-lab subject"],
    };
  }
  const sourceRoot = resolve(options.sourceRoot);
  const staging = options.outDir
    ? join(resolve(options.outDir), "damage-fixture")
    : mkdtempSync(join(tmpdir(), "pocketjs-perf-damage-"));
  const materialized = materializeDamageFixture({
    sourceRoot,
    harnessRoot: options.harnessRoot,
    destination: staging,
  });
  const scenarioPath = join(staging, "scenario.json");
  writeFileSync(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`);
  const targetDir = join(staging, "target");
  const cargo = options.cargoPath ?? "cargo";
  const build = Bun.spawnSync([
    cargo,
    "build",
    "--release",
    "--locked",
    "--manifest-path",
    materialized.manifestPath,
    "--target-dir",
    targetDir,
  ], { cwd: staging, stdout: "pipe", stderr: "pipe" });
  if (build.exitCode !== 0) {
    throw commandFailure("building native damage fixture", build.exitCode, build.stderr);
  }
  const binary = join(targetDir, "release", DAMAGE_FIXTURE_BINARY);
  if (!existsSync(binary) || !statSync(binary).isFile()) {
    throw new Error(`cargo did not produce damage fixture binary: ${binary}`);
  }
  const correctness = parseDamageCorrectnessOutput(
    runFixture(binary, damageFixtureArgs(scenarioPath, "correctness"), staging),
  );
  const measurement = parseDamageMeasurementOutput(
    runFixture(binary, damageFixtureArgs(scenarioPath, "measurement"), staging),
  );
  if (correctness.scenarioId !== scenario.id || measurement.scenarioId !== scenario.id) {
    throw new Error("damage fixture returned a mismatched scenarioId");
  }
  if (correctness.finalFramebufferHash !== measurement.finalFramebufferHash) {
    throw new Error("damage correctness and measurement framebuffers diverged");
  }
  if (correctness.drawListHash !== measurement.finalDrawListHash) {
    throw new Error("damage correctness and measurement DrawLists diverged");
  }
  const expectedPhases = scenario.phases.filter((phase) => phase.collect);
  if (measurement.phases.length !== expectedPhases.length || measurement.phases.some((phase, index) => {
    const expected = expectedPhases[index];
    return !expected || phase.name !== expected.name || phase.startFrame !== expected.startFrame ||
      phase.endFrame !== expected.endFrame;
  })) {
    throw new Error("damage measurement phase sequence differs from the scenario");
  }

  const diagnosticMetrics: Record<string, { value: number; unit: "ns" | "count" }> = {
      "native.boot_wall_time_ns": { value: measurement.bootWallTimeNs, unit: "ns" },
      "native.measured_frames": {
        value: expectedPhases.reduce((sum, phase) => sum + phase.endFrame - phase.startFrame, 0),
        unit: "count",
      },
    };
  for (const phase of measurement.phases) {
    diagnosticMetrics[`native.phase.${phase.name}.wall_time_ns`] = {
      value: phase.wallTimeNs,
      unit: "ns",
    };
  }
  for (const phase of correctness.phaseStats) {
    diagnosticMetrics[`native.damage.${phase.name}.full_redraw_frames`] = {
      value: phase.fullRedrawFrames,
      unit: "count",
    };
    diagnosticMetrics[`native.damage.${phase.name}.empty_frames`] = {
      value: phase.emptyFrames,
      unit: "count",
    };
    diagnosticMetrics[`native.damage.${phase.name}.max_regions`] = {
      value: phase.maxRegions,
      unit: "count",
    };
  }
  diagnosticMetrics["native.wall_time_ns"] = {
    value: measurement.phases.reduce((sum, phase) => sum + phase.wallTimeNs, 0),
    unit: "ns",
  };
  const requestedGateMetrics = Array.isArray(scenario.params.gateMetrics)
    ? scenario.params.gateMetrics.filter((metric): metric is string => typeof metric === "string")
    : [];
  const result: NativeOkResult = {
    schemaVersion: 1,
    kind: "pocketjs.perf.native-result",
    status: "ok",
    scenarioId: scenario.id,
    executor: "native",
    sourceRoot,
    correctness: {
      framebufferTraceHash: correctness.framebufferTraceHash,
      finalFramebufferHash: correctness.finalFramebufferHash,
      drawListHash: correctness.drawListHash,
      stateHash: correctness.stateHash,
      effectHash: correctness.effectHash,
      checkpoints: correctness.checkpoints,
    },
    measurement: {
      bootWallTimeNs: measurement.bootWallTimeNs,
      phases: measurement.phases,
      finalFramebufferHash: measurement.finalFramebufferHash,
      finalDrawListHash: measurement.finalDrawListHash,
    },
    diagnosticMetrics,
    exactMetrics: {},
    unsupportedMetrics: [...new Set(requestedGateMetrics)],
  };
  if (options.outDir) {
    mkdirSync(resolve(options.outDir), { recursive: true });
    const safeId = scenario.id.replace(/[^a-zA-Z0-9._-]+/g, "-");
    writeFileSync(
      join(resolve(options.outDir), `${safeId}.native.json`),
      `${JSON.stringify(result, null, 2)}\n`,
    );
  }
  return result;
}

function stagedManifest(corePath: string): string {
  return `[workspace]\n\n` +
    `[package]\n` +
    `name = ${JSON.stringify(DAMAGE_FIXTURE_PACKAGE)}\n` +
    `version = "0.1.0"\n` +
    `edition = "2024"\n` +
    `publish = false\n\n` +
    `[dependencies]\n` +
    `libc = "0.2"\n` +
    `pocketjs-core = { path = ${JSON.stringify(corePath)}, features = ["std"] }\n` +
    `serde = { version = "1", features = ["derive"] }\n` +
    `serde_json = "1"\n` +
    `sha2 = "0.10"\n\n` +
    `[profile.release]\n` +
    `opt-level = 3\n` +
    `lto = "thin"\n` +
    `codegen-units = 1\n` +
    `panic = "abort"\n` +
    `strip = "debuginfo"\n`;
}

function runFixture(binary: string, args: readonly string[], cwd: string): string {
  const result = Bun.spawnSync([binary, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw commandFailure(`running ${basename(binary)}`, result.exitCode, result.stderr);
  }
  return new TextDecoder().decode(result.stdout);
}

function commandFailure(action: string, exitCode: number, stderr: Uint8Array): Error {
  const detail = new TextDecoder().decode(stderr).trim();
  return new Error(`${action} failed (${exitCode})${detail ? `: ${detail}` : ""}`);
}

function parseDamageRecord(output: string, event: "correctness" | "measurement"): Record<string, unknown> {
  const records = output.split(/\r?\n/)
    .filter((line) => line.startsWith(DAMAGE_OUTPUT_PREFIX))
    .map((line) => JSON.parse(line.slice(DAMAGE_OUTPUT_PREFIX.length)) as unknown);
  if (records.length !== 1 || !plainRecord(records[0])) {
    throw new Error(`expected exactly one ${event} damage protocol record`);
  }
  const value = records[0];
  if (value.schemaVersion !== 1 || value.event !== event) {
    throw new Error(`invalid damage ${event} protocol envelope`);
  }
  return value;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`damage ${path} must be a string`);
}

function uint(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`damage ${path} must be a non-negative safe integer`);
  }
}

function sha(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`damage ${path} must be SHA-256`);
}

function fnv(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !FNV1A64.test(value)) throw new Error(`damage ${path} must be FNV-1a-64`);
}
