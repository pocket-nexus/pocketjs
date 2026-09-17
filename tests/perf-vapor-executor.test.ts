import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseScenarioV1 } from "../tools/perf/core/index.ts";
import { scenarioPhaseId } from "../tools/perf/receipts/hash.ts";
import {
  GUEST_OUTPUT_PREFIX,
  QEMU_OUTPUT_PREFIX,
} from "../tools/perf/receipts/protocol.ts";
import {
  prepareVaporQemuFixture,
  runNativeVaporScenario,
  runVaporScenario,
  vaporGuestStateParityReasons,
  vaporQemuReplayReasons,
  VAPOR_QEMU_BUILD_SPECS,
} from "../tools/perf/executors/vapor.ts";

const ROOT = join(import.meta.dir, "..");
const SCENARIO = parseScenarioV1(
  JSON.parse(readFileSync(join(ROOT, "tools/perf/scenarios/vapor.json"), "utf8")),
);

const VAPOR_STATE_OUTPUT_PREFIX = "POCKETJS_PERF_VAPOR ";
const PHASE_DRAW_HASHES = [
  "fnv1a64:1111111111111111",
  "fnv1a64:2222222222222222",
  "fnv1a64:3333333333333333",
] as const;
const STATE_HASHES = [
  "fnv1a64:aaaaaaaaaaaaaaaa",
  "fnv1a64:bbbbbbbbbbbbbbbb",
  "fnv1a64:cccccccccccccccc",
] as const;
const EFFECT_HASH = "fnv1a64:dddddddddddddddd";
const FRAMEBUFFER_TRACE_HASH = "0123456789abcdef".repeat(4);

function protocolLine(prefix: string, value: unknown): string {
  return `${prefix}${JSON.stringify(value)}\n`;
}

function generatedCPhase(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const phase = SCENARIO.phases.filter((candidate) => candidate.collect)[index]!;
  return {
    schemaVersion: 1,
    event: "phase",
    scenarioId: SCENARIO.id,
    phase: phase.name,
    phaseId: scenarioPhaseId(SCENARIO.id, phase.name),
    iteration: 0,
    allocCalls: 0,
    allocatedBytes: 0,
    currentBytes: 0,
    peakBytes: 0,
    quickjsLiveBytesAfterGc: 0,
    drawListHash: PHASE_DRAW_HASHES[index],
    ...overrides,
  };
}

function generatedCCheckpoint(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    event: "state-checkpoint",
    scenarioId: SCENARIO.id,
    frame: SCENARIO.checkpoints[index]!.frame,
    stateHash: STATE_HASHES[index],
    ...overrides,
  };
}

function generatedCComplete(
  includeFramebufferTrace: boolean,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    event: "complete",
    scenarioId: SCENARIO.id,
    suite: SCENARIO.suite,
    framework: SCENARIO.subject.framework,
    finalDrawListHash: PHASE_DRAW_HASHES.at(-1),
    finalStateHash: STATE_HASHES.at(-1),
    effectHash: EFFECT_HASH,
    ...(includeFramebufferTrace ? { framebufferTraceHash: FRAMEBUFFER_TRACE_HASH } : {}),
    ...overrides,
  };
}

function qemuMeasurement(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const phase = SCENARIO.phases.filter((candidate) => candidate.collect)[index]!;
  return {
    schema: "pocketjs.perf.qemu",
    version: 1,
    event: "measurement",
    plugin_api: 6,
    qemu_version: "11.0.3",
    target: "arm",
    vcpu: 0,
    phase_id: scenarioPhaseId(SCENARIO.id, phase.name),
    iteration: 0,
    metrics: {
      guest_insn_dispatched: 100 + index,
      guest_instruction_bytes: 200 + index,
      guest_insn_size_2: 50 + index,
      guest_insn_size_4: 50,
      guest_load_events: 30 + index,
      guest_store_events: 20 + index,
    },
    ...overrides,
  };
}

interface GeneratedCReplayOptions {
  readonly plugin?: boolean;
  readonly phaseOverrides?: Readonly<Record<number, Record<string, unknown>>>;
  readonly checkpointOverrides?: Readonly<Record<number, Record<string, unknown>>>;
  readonly completeOverrides?: Record<string, unknown>;
  readonly qemuOverrides?: Readonly<Record<number, Record<string, unknown>>>;
  readonly omitPhase?: number;
  readonly omitCheckpoint?: number;
}

function generatedCReplayOutput(options: GeneratedCReplayOptions = {}): string {
  const phases = SCENARIO.phases.filter((phase) => phase.collect);
  const lines: string[] = [];
  phases.forEach((_phase, index) => {
    if (options.omitPhase !== index) {
      lines.push(protocolLine(
        GUEST_OUTPUT_PREFIX,
        generatedCPhase(index, options.phaseOverrides?.[index]),
      ));
    }
    if (options.omitCheckpoint !== index) {
      lines.push(protocolLine(
        VAPOR_STATE_OUTPUT_PREFIX,
        generatedCCheckpoint(index, options.checkpointOverrides?.[index]),
      ));
    }
  });
  lines.push(protocolLine(
    GUEST_OUTPUT_PREFIX,
    generatedCComplete(!options.plugin, options.completeOverrides),
  ));
  if (options.plugin) {
    phases.forEach((_phase, index) => {
      if (options.omitPhase !== index) {
        lines.push(protocolLine(
          QEMU_OUTPUT_PREFIX,
          qemuMeasurement(index, options.qemuOverrides?.[index]),
        ));
      }
    });
    lines.push(protocolLine(QEMU_OUTPUT_PREFIX, {
      schema: "pocketjs.perf.qemu",
      version: 1,
      event: "complete",
      plugin_api: 6,
      qemu_version: "11.0.3",
      target: "arm",
      measurements: phases.length - (options.omitPhase === undefined ? 0 : 1),
    }));
  }
  return lines.join("");
}

describe("Vapor performance executor", () => {
  test("adapts two independent oracle replays to the common native protocol", async () => {
    const result = await runNativeVaporScenario(SCENARIO, {
      sourceRoot: ROOT,
      harnessRoot: ROOT,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    expect(result.correctness.finalFramebufferHash).toBe(result.measurement.finalFramebufferHash);
    expect(result.correctness.drawListHash).toBe(result.measurement.finalDrawListHash);
    expect(result.measurement.phases.map((phase) => phase.name)).toEqual([
      "idle",
      "reactive",
      "settle",
    ]);
    expect(Object.keys(result.correctness.checkpoints)).toEqual(["119", "359", "719"]);
    expect(result.correctness.checkpoints["719"]?.state).toMatch(/^[a-f0-9]{64}$/);
    expect(result.exactMetrics).toEqual({});
    expect(result.unsupportedMetrics).toEqual([
      "guest.instructions",
      "memory.allocations",
      "memory.allocated_bytes",
      "artifact.elf_text_rodata_bytes",
    ]);
  });

  test("replays the hardware-neutral tape on the real Vue Vapor oracle deterministically", async () => {
    const options = {
      scenario: SCENARIO,
      executor: "native" as const,
      sourceRoot: ROOT,
      harnessRoot: ROOT,
    };
    const first = await runVaporScenario(options);
    const second = await runVaporScenario(options);
    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    if (first.status !== "ok" || first.executor !== "native" ||
        second.status !== "ok" || second.executor !== "native") return;

    expect(first.framebufferHash).toBe(second.framebufferHash);
    expect(first.finalDrawListHash).toBe(second.finalDrawListHash);
    expect(first.stateHash).toBe(second.stateHash);
    expect(first.effectHash).toBe(second.effectHash);
    expect(first.finalStateDigest).toBe(second.finalStateDigest);
    expect(first.checkpointStateDigests).toEqual(second.checkpointStateDigests);
    expect(first.phaseDrawListHashes).toEqual(second.phaseDrawListHashes);
    expect(first.axisEventsDelivered).toBe(3);
    expect(first.axisEventsObserved).toBe(3);
    expect(first.compiledRelativeAxesUsed).toEqual([0]);
    expect(first.target).toBe("playdate");
    expect(first.finalDrawListHash).toBe("fnv1a64:e8fe72fac6607a31");
    expect(first.framebufferHash).toBe("c6bd7006790065646053ee94c67d61b902e96f3f9f642dc3586c8ec4772d2ca5");
    expect(Object.keys(first.phaseDrawListHashes)).toEqual(["idle", "reactive", "settle"]);
    expect(Object.keys(first.checkpointStateDigests)).toEqual(["119", "359", "719"]);
    expect(first.checkpointStateDigests["719"]).toBe(first.finalStateDigest);
    expect(first.phaseDrawListHashes.idle).not.toBe(first.phaseDrawListHashes.reactive);
  });

  test("isolates concurrent correctness and measurement oracle replays", async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      runNativeVaporScenario(SCENARIO, {
        sourceRoot: ROOT,
        harnessRoot: ROOT,
      })));

    for (const result of results) expect(result.status).toBe("ok");
    const successful = results.filter((result) => result.status === "ok");
    expect(successful).toHaveLength(4);
    expect(new Set(successful.map((result) => result.correctness.finalFramebufferHash)).size).toBe(1);
    expect(new Set(successful.map((result) => result.correctness.drawListHash)).size).toBe(1);
    for (const result of successful) {
      expect(result.correctness.finalFramebufferHash).toBe(result.measurement.finalFramebufferHash);
      expect(result.correctness.drawListHash).toBe(result.measurement.finalDrawListHash);
    }
  });

  test("generates a freestanding, allocation-free Linux guest with pinned ARM flags", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "pocketjs-vapor-fixture-test-"));
    try {
      const fixture = await prepareVaporQemuFixture({
        scenario: SCENARIO,
        executor: "qemu-armv7-thumb2",
        sourceRoot: ROOT,
        harnessRoot: ROOT,
        outDir,
      });
      const harness = readFileSync(fixture.guestHarness, "utf8");
      const header = readFileSync(fixture.runtimeHeader, "utf8");
      const generated = readFileSync(fixture.generatedApp, "utf8");

      expect(generated).toContain("void app_on_axis_delta(u8 axis, s32 delta)");
      expect(generated).toContain("static s32 g_axisEvents;");
      expect(generated).toContain("vp_axis_handler_0");
      expect(generated).toContain("g_axisEvents + 1");
      expect(harness).toContain("app_on_axis_delta(event->control, event->value)");
      expect(harness).toContain("\\\"allocCalls\\\":0");
      expect(harness).toContain("POCKETJS_PERF_VAPOR");
      expect(harness).toContain("if (len != 56u)");
      expect(harness).toContain("u8 n = state.bytes[16]");
      expect(harness).toContain("for (j = 0; j < n; j++)");
      const stateHashSource = harness.slice(
        harness.indexOf("static perf_u64 state_hash(void)"),
        harness.indexOf("static perf_u64 events_hash(void)"),
      );
      expect(stateHashSource).not.toContain("for (i = 0; i < len; i++)");
      expect(harness).not.toMatch(/\b(?:malloc|calloc|realloc|free)\s*\(/);
      expect(harness).toContain("static u8 sha256_self_test(void)");
      expect(harness).toContain("framebufferTraceHash");
      expect(harness.match(/sha256_update\(&perf_framebuffer_trace/g)).toHaveLength(2);
      expect(harness).toContain("if (!sha256_self_test()) return 78;");
      expect(harness).toContain('stack[2], "--correctness"');
      expect(harness).toContain("else if (argc != 1u)");
      const entrySource = harness.slice(harness.indexOf("static __attribute__((used, noreturn, noinline)) void perf_start"));
      const architectureStart = entrySource.slice(entrySource.indexOf("#if defined(__aarch64__)"));
      const aarch64Start = architectureStart.slice(0, architectureStart.indexOf("#else"));
      const armStart = architectureStart.slice(
        architectureStart.indexOf("#else"),
        architectureStart.indexOf("#endif"),
      );
      expect(aarch64Start).not.toMatch(/__attribute__\s*\(\(naked/);
      expect(aarch64Start).not.toContain("void _start(void)");
      expect(aarch64Start).toMatch(/^__asm__\s*\(/m);
      expect(aarch64Start).toContain(".global _start");
      expect(aarch64Start).toContain(".type _start");
      expect(aarch64Start).toMatch(/mov x0, sp[\s\S]*?b perf_start/);
      // Keep the already calibrated ARM/Thumb entry byte-for-byte stable.
      expect(armStart).toContain("__attribute__((naked, noreturn)) void _start(void)");
      expect(armStart).toMatch(/mov r0, sp[\s\S]*?b perf_start/);
      const perfMain = harness.indexOf("static int perf_main(void)");
      const markerEnd = harness.indexOf("pocketjs_perf_end(phase->id, 0)", perfMain);
      const phaseDiagnostic = harness.indexOf("emit_phase(phase)", markerEnd);
      const stateDiagnostic = harness.indexOf("emit_state_checkpoint(frame)", markerEnd);
      expect(perfMain).toBeGreaterThanOrEqual(0);
      expect(markerEnd).toBeGreaterThan(perfMain);
      expect(phaseDiagnostic).toBeGreaterThan(markerEnd);
      expect(stateDiagnostic).toBeGreaterThan(markerEnd);
      expect(header).toContain("typedef uint32_t u32;");
      expect(header).toContain("typedef int32_t s32;");
      expect(fixture.build.cFlags).toEqual(VAPOR_QEMU_BUILD_SPECS["qemu-armv7-thumb2"].cFlags);
      expect(fixture.build.cFlags).toContain("-mthumb");
      expect(fixture.build.cFlags).not.toContain("-mfpu=neon");
      expect(fixture.build.cpuArgs).toEqual([
        "-cpu",
        "cortex-a9,neon=off,vfp-d32=off",
      ]);
      expect(fixture.build.emulatorArgs).toEqual(["-seed", "1"]);
      expect(VAPOR_QEMU_BUILD_SPECS["qemu-aarch64"].cpuArgs).toEqual([
        "-cpu",
        "cortex-a53",
      ]);
      expect(VAPOR_QEMU_BUILD_SPECS["qemu-aarch64"].emulatorArgs).toEqual(["-seed", "1"]);
      expect(fixture.build.linkerFlags).toContain("-nostdlib");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("accepts identical generated-C correctness and measurement replays with plugin output only on measurement", () => {
    const replay = vaporQemuReplayReasons(
      SCENARIO,
      generatedCReplayOutput(),
      generatedCReplayOutput({ plugin: true }),
    );

    expect(replay.reasons).toEqual([]);
    expect(replay.correctness.status).toBe("valid");
    expect(replay.measurement.status).toBe("valid");
    expect(replay.qemu.status).toBe("valid");
    expect(replay.correctness.phases.map((phase) => phase.phase)).toEqual([
      "idle",
      "reactive",
      "settle",
    ]);
    expect(replay.correctness.complete?.finalStateHash).toBe(STATE_HASHES.at(-1));
    expect(replay.correctness.complete?.framebufferTraceHash).toBe(FRAMEBUFFER_TRACE_HASH);
    expect(replay.measurement.complete?.effectHash).toBe(EFFECT_HASH);
    expect(replay.measurement.complete?.framebufferTraceHash).toBeUndefined();
  });

  test("requires a plugin-free correctness replay and a complete measurement plugin stream", () => {
    const correctnessWithPlugin = vaporQemuReplayReasons(
      SCENARIO,
      generatedCReplayOutput({ plugin: true }),
      generatedCReplayOutput({ plugin: true }),
    );
    expect(correctnessWithPlugin.reasons.join("\n")).toContain(
      "correctness replay emitted QEMU plugin records",
    );

    const measurementWithoutPlugin = vaporQemuReplayReasons(
      SCENARIO,
      generatedCReplayOutput(),
      generatedCReplayOutput(),
    );
    expect(measurementWithoutPlugin.reasons.join("\n")).toContain(
      "measurement: no QEMU protocol records",
    );
  });

  test("requires a correctness framebuffer trace and forbids hashing it in measurement", () => {
    const missing = vaporQemuReplayReasons(
      SCENARIO,
      generatedCReplayOutput({
        completeOverrides: { framebufferTraceHash: undefined },
      }),
      generatedCReplayOutput({ plugin: true }),
    );
    expect(missing.reasons.join("\n")).toContain(
      "correctness: guest complete has no required framebufferTraceHash",
    );

    const leaked = vaporQemuReplayReasons(
      SCENARIO,
      generatedCReplayOutput(),
      generatedCReplayOutput({
        plugin: true,
        completeOverrides: { framebufferTraceHash: FRAMEBUFFER_TRACE_HASH },
      }),
    );
    expect(leaked.reasons.join("\n")).toContain(
      "measurement: guest complete emitted correctness-only framebufferTraceHash",
    );
  });

  test("strictly matches phase identity and phase output between generated-C replays", () => {
    const identityDrift = vaporQemuReplayReasons(
      SCENARIO,
      generatedCReplayOutput(),
      generatedCReplayOutput({
        plugin: true,
        phaseOverrides: {
          1: { phase: "reactive-drift", iteration: 1 },
        },
      }),
    );
    expect(identityDrift.reasons.join("\n")).toContain(
      "correctness/measurement phase 1 identity differs",
    );

    const outputDrift = vaporQemuReplayReasons(
      SCENARIO,
      generatedCReplayOutput(),
      generatedCReplayOutput({
        plugin: true,
        phaseOverrides: {
          1: { drawListHash: "fnv1a64:eeeeeeeeeeeeeeee" },
        },
      }),
    );
    expect(outputDrift.reasons.join("\n")).toContain(
      "correctness/measurement DrawList differs after phase reactive",
    );

    const bothIncomplete = vaporQemuReplayReasons(
      SCENARIO,
      generatedCReplayOutput({ omitPhase: 1 }),
      generatedCReplayOutput({ plugin: true, omitPhase: 1 }),
    );
    expect(bothIncomplete.reasons.join("\n")).toContain(
      "correctness emitted 2 phases; expected 3",
    );
    expect(bothIncomplete.reasons.join("\n")).toContain(
      "measurement emitted 2 phases; expected 3",
    );

    const sharedIdentityDrift = vaporQemuReplayReasons(
      SCENARIO,
      generatedCReplayOutput({
        phaseOverrides: { 1: { phase: "shared-drift", phaseId: 1234 } },
      }),
      generatedCReplayOutput({
        plugin: true,
        phaseOverrides: { 1: { phase: "shared-drift", phaseId: 1234 } },
        qemuOverrides: { 1: { phase_id: 1234 } },
      }),
    );
    expect(sharedIdentityDrift.reasons.join("\n")).toContain(
      "correctness phase 1 identity differs from scenario",
    );
    expect(sharedIdentityDrift.reasons.join("\n")).toContain(
      "measurement phase 1 identity differs from scenario",
    );
  });

  test("strictly matches checkpoint identity and state output between generated-C replays", () => {
    const missing = vaporQemuReplayReasons(
      SCENARIO,
      generatedCReplayOutput(),
      generatedCReplayOutput({ plugin: true, omitCheckpoint: 1 }),
    );
    expect(missing.reasons.join("\n")).toContain(
      "correctness and measurement emitted different state checkpoint counts",
    );

    const identityDrift = vaporQemuReplayReasons(
      SCENARIO,
      generatedCReplayOutput(),
      generatedCReplayOutput({
        plugin: true,
        checkpointOverrides: { 1: { frame: 358 } },
      }),
    );
    expect(identityDrift.reasons.join("\n")).toContain(
      "correctness/measurement state checkpoint 1 identity differs",
    );

    const stateDrift = vaporQemuReplayReasons(
      SCENARIO,
      generatedCReplayOutput(),
      generatedCReplayOutput({
        plugin: true,
        checkpointOverrides: { 1: { stateHash: "fnv1a64:eeeeeeeeeeeeeeee" } },
      }),
    );
    expect(stateDrift.reasons.join("\n")).toContain(
      "correctness/measurement state differs at checkpoint 359",
    );

    const bothIncomplete = vaporQemuReplayReasons(
      SCENARIO,
      generatedCReplayOutput({ omitCheckpoint: 1 }),
      generatedCReplayOutput({ plugin: true, omitCheckpoint: 1 }),
    );
    expect(bothIncomplete.reasons.join("\n")).toContain(
      "correctness emitted 2 state checkpoints; expected 3",
    );
    expect(bothIncomplete.reasons.join("\n")).toContain(
      "measurement emitted 2 state checkpoints; expected 3",
    );
  });

  test("strictly matches final generated-C draw, state, effects and measurement identities", () => {
    const finalDrift = vaporQemuReplayReasons(
      SCENARIO,
      generatedCReplayOutput(),
      generatedCReplayOutput({
        plugin: true,
        completeOverrides: {
          suite: "other-suite",
          finalDrawListHash: "fnv1a64:eeeeeeeeeeeeeeee",
          finalStateHash: "fnv1a64:ffffffffffffffff",
          effectHash: "fnv1a64:9999999999999999",
        },
      }),
    );
    expect(finalDrift.reasons).toEqual(expect.arrayContaining([
      "correctness/measurement complete identity differs",
      "correctness/measurement final DrawList differs",
      "correctness/measurement final state differs",
      "correctness/measurement effects differ",
    ]));

    const qemuIdentityDrift = vaporQemuReplayReasons(
      SCENARIO,
      generatedCReplayOutput(),
      generatedCReplayOutput({
        plugin: true,
        qemuOverrides: { 1: { phase_id: 1234, iteration: 1 } },
      }),
    );
    expect(qemuIdentityDrift.reasons.join("\n")).toContain(
      "measurement QEMU phase 1 identity differs from guest phase",
    );
  });

  test("rejects invalid relative-axis samples instead of coercing them", async () => {
    const scenario = parseScenarioV1({
      ...SCENARIO,
      tape: {
        ...SCENARIO.tape,
        tracks: [{
          kind: "relative-axis",
          control: "primary",
          samples: [{ frame: 1, delta: 0 }],
        }],
      },
    });
    const result = await runVaporScenario({
      scenario,
      executor: "native",
      sourceRoot: ROOT,
      harnessRoot: ROOT,
    });
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") expect(result.reasons.join("\n")).toContain("non-zero signed 32-bit integer");
  });

  test("strictly validates generated-C final and checkpoint state against the oracle", () => {
    const hashes = {
      "119": "fnv1a64:0000000000000119",
      "359": "fnv1a64:0000000000000359",
      "719": "fnv1a64:0000000000000719",
    };
    const output = Object.entries(hashes).map(([frame, stateHash]) =>
      `POCKETJS_PERF_VAPOR ${JSON.stringify({
        schemaVersion: 1,
        event: "state-checkpoint",
        scenarioId: SCENARIO.id,
        frame: Number(frame),
        stateHash,
      })}`
    ).join("\n");
    const native = {
      finalStateDigest: hashes["719"],
      checkpointStateDigests: hashes,
    };

    expect(vaporGuestStateParityReasons(SCENARIO, output, hashes["719"], native)).toEqual([]);

    const drifted = output.replace(hashes["359"], "fnv1a64:ffffffffffffffff");
    expect(vaporGuestStateParityReasons(SCENARIO, drifted, "fnv1a64:eeeeeeeeeeeeeeee", native))
      .toEqual(expect.arrayContaining([
        "generated-C state differs from Vue Vapor oracle at checkpoint 359",
        "generated-C final state differs from Vue Vapor oracle",
        "generated-C final state differs between checkpoint and complete records",
      ]));
    expect(vaporGuestStateParityReasons(SCENARIO, output.split("\n").slice(1).join("\n"), hashes["719"], native))
      .toEqual(expect.arrayContaining([
        "generated-C emitted 2 state checkpoints; expected 3",
      ]));
  });

  test("declares every input and correctness capability exercised by the Vapor scenario", () => {
    expect(SCENARIO.executorRequirements).toEqual([
      "fixture.vapor.generated-c",
      "input.buttons",
      "input.relative-axis",
      "correctness.draw-list",
      "correctness.effects",
      "correctness.framebuffer",
      "correctness.state-final",
    ]);
    expect(SCENARIO.params.gateMetrics).toEqual([
      "guest.instructions",
      "memory.allocations",
      "memory.allocated_bytes",
      "artifact.elf_text_rodata_bytes",
    ]);
  });
});
