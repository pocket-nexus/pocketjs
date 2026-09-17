import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gateMetricIds, parseScenarioV1 } from "../core/index.ts";
import type { CorrectnessCapture, ScenarioV1 } from "../core/types.ts";
import {
  expandInputTape,
  nativeInputUnsupportedReasons,
  NATIVE_INPUT_CAPABILITIES,
} from "./input.ts";
import { bootNativePerfWorld } from "./native-world.ts";

export interface NativeSimWorld {
  frame(buttons: number, analog?: number, touches?: readonly number[]): void;
  /** Drain framework promise jobs scheduled by `frame`, matching QuickJS hosts. */
  drainJobs(): Promise<void>;
  tick(): void;
  render(): Uint8Array;
  drawHash(): string;
  readonly ticksPerFrame: number;
  readonly effects: readonly unknown[];
  getTree(): unknown;
}

export interface NativeBootAdapter {
  boot(sourceRoot: string, scenario: ScenarioV1): Promise<NativeSimWorld>;
}

export interface NativeRunOptions {
  /** Revision/worktree to execute. It need not contain tools/perf itself. */
  readonly sourceRoot: string;
  /** Optional directory for the JSON runner result. */
  readonly outDir?: string;
  /** Tests can replace the expensive real WASM boot while exercising the runner. */
  readonly bootAdapter?: NativeBootAdapter;
}

export interface NativeUnsupportedResult {
  readonly schemaVersion: 1;
  readonly kind: "pocketjs.perf.native-result";
  readonly status: "unsupported";
  readonly scenarioId: string;
  readonly executor: "native";
  readonly reasons: readonly string[];
}

export interface NativePhaseTiming {
  readonly name: string;
  readonly startFrame: number;
  readonly endFrame: number;
  /** Diagnostic host time. It is never presented as target/device time. */
  readonly wallTimeNs: number;
}

export interface NativeOkResult {
  readonly schemaVersion: 1;
  readonly kind: "pocketjs.perf.native-result";
  readonly status: "ok";
  readonly scenarioId: string;
  readonly executor: "native";
  readonly sourceRoot: string;
  readonly correctness: {
    readonly framebufferTraceHash: string;
    readonly finalFramebufferHash: string;
    readonly drawListHash: string;
    readonly stateHash: string;
    readonly effectHash: string;
    readonly checkpoints: Readonly<Record<string, Readonly<Record<string, string>>>>;
  };
  readonly measurement: {
    readonly bootWallTimeNs: number;
    readonly phases: readonly NativePhaseTiming[];
    readonly finalFramebufferHash: string;
    readonly finalDrawListHash: string;
  };
  readonly diagnosticMetrics: Readonly<Record<string, { readonly value: number; readonly unit: "ns" | "count" }>>;
  readonly exactMetrics: Readonly<Record<string, { readonly value: number; readonly unit: "bytes" }>>;
  /** Metrics the native sim cannot truthfully observe. */
  readonly unsupportedMetrics: readonly string[];
}

export type NativeRunResult = NativeOkResult | NativeUnsupportedResult;

const NATIVE_CAPABILITIES = new Set<string>([
  "guest.frame",
  "core.ui",
  "renderer.framebuffer",
  "assets.pak",
  "correctness.framebuffer",
  "correctness.draw-list",
  "correctness.effects",
  "correctness.state-final",
  ...NATIVE_INPUT_CAPABILITIES,
]);

const OBSERVABLE_CAPTURES = new Set<CorrectnessCapture>([
  "framebuffer",
  "drawList",
  "effects",
]);

/** Load and strictly validate one scenario manifest. */
export function loadScenario(path: string): ScenarioV1 {
  return parseScenarioV1(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * Execute the full PocketJS framework -> HostOps -> WASM core -> software
 * raster path twice: an observed correctness replay, then a minimally
 * observed measurement replay. The two final frame hashes must agree.
 */
export async function runNativeQuick(
  scenario: ScenarioV1,
  options: NativeRunOptions,
): Promise<NativeRunResult> {
  const sourceRoot = resolve(options.sourceRoot);
  const reasons = unsupportedReasons(scenario);
  if (reasons.length > 0) {
    return writeResult(
      {
        schemaVersion: 1,
        kind: "pocketjs.perf.native-result",
        status: "unsupported",
        scenarioId: scenario.id,
        executor: "native",
        reasons,
      },
      options.outDir,
    );
  }

  const adapter = options.bootAdapter ?? DEFAULT_BOOT_ADAPTER;
  const inputs = expandInputTape(scenario.tape);
  const correctness = await correctnessReplay(adapter, sourceRoot, scenario, inputs);
  const measurement = await measurementReplay(adapter, sourceRoot, scenario, inputs);
  if (correctness.finalFramebufferHash !== measurement.finalFramebufferHash) {
    throw new Error(
      `${scenario.id}: correctness/measurement replay diverged: ` +
        `${correctness.finalFramebufferHash} != ${measurement.finalFramebufferHash}`,
    );
  }
  if (correctness.drawListHash !== measurement.finalDrawListHash) {
    throw new Error(
      `${scenario.id}: correctness/measurement DrawList replay diverged: ` +
        `${correctness.drawListHash} != ${measurement.finalDrawListHash}`,
    );
  }

  const diagnosticMetrics: Record<string, { value: number; unit: "ns" | "count" }> = {
    "native.boot_wall_time_ns": { value: measurement.bootWallTimeNs, unit: "ns" },
    "native.measured_frames": {
      value: scenario.phases
        .filter((phase) => phase.collect)
        .reduce((sum, phase) => sum + phase.endFrame - phase.startFrame, 0),
      unit: "count",
    },
  };
  for (const phase of measurement.phases) {
    diagnosticMetrics[`native.phase.${phase.name}.wall_time_ns`] = {
      value: phase.wallTimeNs,
      unit: "ns",
    };
  }
  diagnosticMetrics["native.wall_time_ns"] = {
    value: measurement.phases.reduce((sum, phase) => sum + phase.wallTimeNs, 0),
    unit: "ns",
  };
  const exactMetrics: Record<string, { value: number; unit: "bytes" }> = {};
  const bundlePath = join(sourceRoot, "dist", `${scenario.subject.entry}.js`);
  const pakPath = join(sourceRoot, "dist", `${scenario.subject.entry}.pak`);
  if (existsSync(bundlePath)) {
    exactMetrics["artifact.bundle_bytes"] = { value: statSync(bundlePath).size, unit: "bytes" };
  }
  if (existsSync(pakPath)) {
    exactMetrics["artifact.pak_bytes"] = { value: statSync(pakPath).size, unit: "bytes" };
  }
  const requestedGateMetrics = gateMetricIds(scenario.params);

  return writeResult(
    {
      schemaVersion: 1,
      kind: "pocketjs.perf.native-result",
      status: "ok",
      scenarioId: scenario.id,
      executor: "native",
      sourceRoot,
      correctness,
      measurement,
      diagnosticMetrics,
      exactMetrics,
      unsupportedMetrics: [
        ...requestedGateMetrics.filter((metric) => !Object.hasOwn(exactMetrics, metric)),
      ],
    },
    options.outDir,
  );
}

function unsupportedReasons(scenario: ScenarioV1): string[] {
  const reasons: string[] = [];
  if (scenario.subject.family !== "guest-app") {
    reasons.push(`native runner has no adapter for subject family ${JSON.stringify(scenario.subject.family)}`);
  }
  for (const requirement of scenario.executorRequirements) {
    if (!NATIVE_CAPABILITIES.has(requirement)) reasons.push(`missing executor capability ${requirement}`);
  }
  for (const track of scenario.tape.tracks) {
    if (track.kind === "relative-axis") {
      reasons.push("hosts/sim guest frame has no RelativeAxis delivery adapter");
    } else if (track.kind === "effect") {
      reasons.push("native runner has no generic recorded-effect delivery adapter");
    }
  }
  reasons.push(...nativeInputUnsupportedReasons(scenario.tape));
  for (const checkpoint of scenario.checkpoints) {
    for (const capture of checkpoint.capture) {
      if (capture === "state" && checkpoint.frame === scenario.frames - 1) continue;
      if (!OBSERVABLE_CAPTURES.has(capture)) {
        reasons.push(`cannot capture ${capture} at frame ${checkpoint.frame}`);
      }
    }
  }
  return [...new Set(reasons)];
}

async function correctnessReplay(
  adapter: NativeBootAdapter,
  sourceRoot: string,
  scenario: ScenarioV1,
  inputs: ReturnType<typeof expandInputTape>,
): Promise<NativeOkResult["correctness"]> {
  const world = await adapter.boot(sourceRoot, scenario);
  const trace = createHash("sha256");
  const checkpoints: Record<string, Record<string, string>> = {};
  let finalFramebufferHash = "";
  let drawListHash = "";

  for (let frame = 0; frame < scenario.frames; frame++) {
    const input = inputs[frame];
    world.frame(input.buttons, input.analog, input.touches);
    await world.drainJobs();
    for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
    const framebuffer = world.render();
    drawListHash = world.drawHash();
    const frameHash = sha256(framebuffer);
    trace.update(frameHash);
    finalFramebufferHash = frameHash;

    for (const checkpoint of scenario.checkpoints) {
      if (checkpoint.frame !== frame) continue;
      const captured: Record<string, string> = {};
      for (const capture of checkpoint.capture) {
        if (capture === "framebuffer") captured.framebuffer = frameHash;
        else if (capture === "drawList") captured.drawList = drawListHash;
        else if (capture === "effects") captured.effects = hashJson(world.effects);
      }
      checkpoints[String(frame)] = captured;
    }
  }

  // getTree is intentionally correctness-only. The DevTools probe advances
  // one extra frame, so it must never run inside a measured phase.
  const effectHash = hashJson(world.effects);
  const stateHash = hashJson(world.getTree());
  const finalCheckpoint = checkpoints[String(scenario.frames - 1)];
  if (finalCheckpoint && scenario.checkpoints
    .find((checkpoint) => checkpoint.frame === scenario.frames - 1)
    ?.capture.includes("state")) {
    finalCheckpoint.state = stateHash;
  }
  return {
    framebufferTraceHash: trace.digest("hex"),
    finalFramebufferHash,
    drawListHash,
    stateHash,
    effectHash,
    checkpoints,
  };
}

async function measurementReplay(
  adapter: NativeBootAdapter,
  sourceRoot: string,
  scenario: ScenarioV1,
  inputs: ReturnType<typeof expandInputTape>,
): Promise<NativeOkResult["measurement"]> {
  const bootStarted = process.hrtime.bigint();
  const world = await adapter.boot(sourceRoot, scenario);
  const bootWallTimeNs = safeNs(process.hrtime.bigint() - bootStarted);
  const started = new Map<string, bigint>();
  const timings: NativePhaseTiming[] = [];
  let finalFramebuffer: Uint8Array | null = null;

  for (let frame = 0; frame < scenario.frames; frame++) {
    for (const phase of scenario.phases) {
      if (phase.collect && phase.startFrame === frame) started.set(phase.name, process.hrtime.bigint());
    }
    const input = inputs[frame];
    world.frame(input.buttons, input.analog, input.touches);
    await world.drainJobs();
    for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
    finalFramebuffer = world.render();
    for (const phase of scenario.phases) {
      if (!phase.collect || phase.endFrame !== frame + 1) continue;
      const phaseStarted = started.get(phase.name);
      if (phaseStarted === undefined) throw new Error(`${scenario.id}: phase ${phase.name} never started`);
      timings.push({
        name: phase.name,
        startFrame: phase.startFrame,
        endFrame: phase.endFrame,
        wallTimeNs: safeNs(process.hrtime.bigint() - phaseStarted),
      });
    }
  }
  if (!finalFramebuffer) throw new Error(`${scenario.id}: no framebuffer was rendered`);
  // Correctness fingerprints stay outside every measured interval.
  const finalDrawListHash = world.drawHash();
  return {
    bootWallTimeNs,
    phases: timings,
    finalFramebufferHash: sha256(finalFramebuffer),
    finalDrawListHash,
  };
}

const DEFAULT_BOOT_ADAPTER: NativeBootAdapter = {
  async boot(sourceRoot, scenario) {
    assertPrebuilt(sourceRoot, scenario);
    return await bootNativePerfWorld(sourceRoot, scenario);
  },
};

function assertPrebuilt(sourceRoot: string, scenario: ScenarioV1): void {
  const missing = [
    join(sourceRoot, "hosts/web/pocketjs.wasm"),
    join(sourceRoot, "dist", `${scenario.subject.entry}.js`),
  ].filter((path) => !existsSync(path));
  if (scenario.executorRequirements.includes("assets.pak")) {
    const pak = join(sourceRoot, "dist", `${scenario.subject.entry}.pak`);
    if (!existsSync(pak)) missing.push(pak);
  }
  if (missing.length > 0) {
    throw new Error(
      `${scenario.id}: native runner only consumes prebuilt artifacts; missing ${missing.join(", ")}`,
    );
  }
}

function safeNs(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`native timing exceeds Number safe range: ${value}`);
  return number;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("cannot hash non-finite JSON number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  if (value === undefined) return "null";
  throw new Error(`cannot hash ${typeof value} as JSON`);
}

function writeResult<T extends NativeRunResult>(result: T, outDir?: string): T {
  if (!outDir) return result;
  mkdirSync(outDir, { recursive: true });
  const safeId = result.scenarioId.replace(/[^a-zA-Z0-9._-]+/g, "-");
  writeFileSync(join(outDir, `${safeId}.native.json`), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
