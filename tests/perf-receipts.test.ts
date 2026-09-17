import { describe, expect, test } from "bun:test";
import {
  compareReceipts,
  parseReceiptV1,
  parseScenarioV1,
  type ScenarioV1,
} from "../tools/perf/core/index.ts";
import type { NativeOkResult } from "../tools/perf/runner/native.ts";
import {
  GUEST_OUTPUT_PREFIX,
  QEMU_OUTPUT_PREFIX,
  canonicalJson,
  createNativeReceipt,
  createQemuReceipts,
  guestDigestToSha256,
  parseGuestOutput,
  parseQemuOutput,
  scenarioPhaseId,
  sha256Json,
  type ReceiptEnvironmentV1,
} from "../tools/perf/receipts/index.ts";

const HASH = {
  content: "1".repeat(64),
  binary: "2".repeat(64),
  framebufferTrace: "3".repeat(64),
  framebufferFinal: "4".repeat(64),
  state: "5".repeat(64),
  effect: "6".repeat(64),
  draw: "7".repeat(64),
};
const FNV = {
  phaseDraw: "fnv1a64:1111111111111111",
  finalDraw: "fnv1a64:1111111111111111",
  state: "fnv1a64:2222222222222222",
  effect: "fnv1a64:3333333333333333",
};

const scenario: ScenarioV1 = parseScenarioV1({
  schemaVersion: 1,
  kind: "pocketjs.perf.scenario",
  id: "receipt-fixture",
  suite: "quick",
  subject: {
    id: "fixture",
    family: "guest-app",
    framework: "solid",
    entry: "fixture-main",
  },
  executorRequirements: ["guest.frame"],
  frames: 4,
  tape: {
    schemaVersion: 1,
    kind: "pocketjs.perf.input-tape",
    id: "receipt-fixture-tape",
    frames: 4,
    tracks: [],
  },
  phases: [{ name: "steady", startFrame: 1, endFrame: 4, collect: true }],
  checkpoints: [{ frame: 3, capture: ["framebuffer", "state", "effects"] }],
  params: {
    gateMetrics: [
      "artifact.bundle_bytes",
      "guest.instructions",
      "memory.allocated_bytes",
    ],
  },
});

const provenance: ReceiptEnvironmentV1 = {
  source: { revision: "fixture", dirty: false, contentHash: HASH.content },
  toolchain: {
    rustc: "rustc 1.93.0",
    cCompiler: "gcc 12.2.0",
    sysroot: "debian-bookworm-20260803",
    qemu: "11.0.3",
  },
  build: {
    target: "armv7-unknown-linux-gnueabihf",
    profile: "release-perf",
    rustFlags: ["-C", "target-feature=+thumb-mode"],
    cFlags: ["-mthumb", "-march=armv7-a", "-mfpu=vfpv3-d16", "-mfloat-abi=hard"],
    linkerFlags: [],
  },
  executor: {
    id: "qemu-armv7-thumb2",
    version: "11.0.3",
    profile: "linux-user-plugin-v1",
    fingerprint: "8".repeat(64),
  },
  binary: { sha256: HASH.binary },
};

function guestPhase(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    event: "phase",
    scenarioId: scenario.id,
    phase: "steady",
    phaseId: scenarioPhaseId(scenario.id, "steady"),
    iteration: 0,
    allocCalls: 7,
    allocatedBytes: 2048,
    currentBytes: 1024,
    peakBytes: 1536,
    quickjsLiveBytesAfterGc: 768,
    drawListHash: FNV.phaseDraw,
    ...overrides,
  };
}

function guestComplete(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    event: "complete",
    scenarioId: scenario.id,
    suite: scenario.suite,
    framework: scenario.subject.framework,
    finalDrawListHash: FNV.finalDraw,
    finalStateHash: FNV.state,
    effectHash: FNV.effect,
    ...overrides,
  };
}

function qemuMeasurement(overrides: Record<string, unknown> = {}) {
  return {
    schema: "pocketjs.perf.qemu",
    version: 1,
    event: "measurement",
    plugin_api: 6,
    qemu_version: "11.0.3",
    target: "arm",
    vcpu: 0,
    phase_id: scenarioPhaseId(scenario.id, "steady"),
    iteration: 0,
    metrics: {
      guest_insn_dispatched: 10_000,
      guest_instruction_bytes: 24_000,
      guest_insn_size_2: 8_000,
      guest_insn_size_4: 2_000,
      guest_load_events: 3_000,
      guest_store_events: 1_000,
    },
    ...overrides,
  };
}

function qemuComplete(overrides: Record<string, unknown> = {}) {
  return {
    schema: "pocketjs.perf.qemu",
    version: 1,
    event: "complete",
    plugin_api: 6,
    qemu_version: "11.0.3",
    target: "arm",
    measurements: 1,
    ...overrides,
  };
}

function line(prefix: string, value: unknown): string {
  return `${prefix}${JSON.stringify(value)}\n`;
}

function combinedOutput(
  guestPhaseValue: unknown = guestPhase(),
  qemuMeasurementValue: unknown = qemuMeasurement(),
  guestCompleteValue: unknown = guestComplete(),
): string {
  return [
    "untrusted program output\n",
    line(GUEST_OUTPUT_PREFIX, guestPhaseValue),
    line(QEMU_OUTPUT_PREFIX, qemuMeasurementValue),
    line(GUEST_OUTPUT_PREFIX, guestCompleteValue),
    line(QEMU_OUTPUT_PREFIX, qemuComplete()),
  ].join("");
}

function correctnessOutput(
  guestCompleteValue: unknown = guestComplete({ framebufferTraceHash: HASH.framebufferTrace }),
): string {
  return [
    line(GUEST_OUTPUT_PREFIX, guestPhase()),
    line(GUEST_OUTPUT_PREFIX, guestCompleteValue),
  ].join("");
}

function nativeResult(overrides: Partial<NativeOkResult> = {}): NativeOkResult {
  return {
    schemaVersion: 1,
    kind: "pocketjs.perf.native-result",
    status: "ok",
    scenarioId: scenario.id,
    executor: "native",
    sourceRoot: "/tmp/pocketjs-fixture",
    correctness: {
      framebufferTraceHash: HASH.framebufferTrace,
      finalFramebufferHash: HASH.framebufferFinal,
      drawListHash: FNV.phaseDraw,
      stateHash: HASH.state,
      effectHash: HASH.effect,
      checkpoints: { "3": { framebuffer: HASH.framebufferFinal, state: HASH.state } },
    },
    measurement: {
      bootWallTimeNs: 1_000,
      phases: [{ name: "steady", startFrame: 1, endFrame: 4, wallTimeNs: 9_000 }],
      finalFramebufferHash: HASH.framebufferFinal,
      finalDrawListHash: FNV.finalDraw,
    },
    diagnosticMetrics: {
      "native.boot_wall_time_ns": { value: 1_000, unit: "ns" },
      "native.measured_frames": { value: 3, unit: "count" },
      "native.phase.steady.wall_time_ns": { value: 9_000, unit: "ns" },
      "native.wall_time_ns": { value: 9_000, unit: "ns" },
    },
    exactMetrics: {
      "artifact.bundle_bytes": { value: 4_096, unit: "bytes" },
      "artifact.pak_bytes": { value: 512, unit: "bytes" },
    },
    unsupportedMetrics: ["guest.instructions", "memory.allocated_bytes"],
    ...overrides,
  };
}

describe("perf receipt hashing", () => {
  test("canonicalizes object keys recursively and hashes semantic JSON", () => {
    expect(canonicalJson({ z: [3, { b: 2, a: 1 }], a: true })).toBe(
      '{"a":true,"z":[3,{"a":1,"b":2}]}',
    );
    expect(sha256Json({ b: 2, a: 1 })).toBe(sha256Json({ a: 1, b: 2 }));
    expect(() => canonicalJson({ bad: undefined })).toThrow("cannot contain undefined");
    expect(guestDigestToSha256("draw-list", FNV.phaseDraw)).toMatch(/^[a-f0-9]{64}$/);
  });

  test("matches the guest's unsigned FNV-1a phase identifier", () => {
    expect(scenarioPhaseId("receipt-fixture", "steady")).toBe(4_292_253_619);
  });
});

describe("strict guest and QEMU protocol parsing", () => {
  test("accepts only complete, versioned protocol streams", () => {
    const output = combinedOutput();
    const guest = parseGuestOutput(output);
    const qemu = parseQemuOutput(output);
    expect(guest.status).toBe("valid");
    expect(qemu.status).toBe("valid");
    expect(guest.phases).toHaveLength(1);
    expect(qemu.measurements).toHaveLength(1);
  });

  test("strictly validates the optional correctness framebuffer trace digest", () => {
    const valid = parseGuestOutput(correctnessOutput());
    expect(valid.status).toBe("valid");
    expect(valid.complete?.framebufferTraceHash).toBe(HASH.framebufferTrace);

    for (const framebufferTraceHash of ["a".repeat(63), "A".repeat(64), 42]) {
      const invalid = parseGuestOutput(correctnessOutput(guestComplete({ framebufferTraceHash })));
      expect(invalid.status).toBe("invalid");
      expect(invalid.reasons.join(" ")).toContain(
        "framebufferTraceHash must be a lowercase SHA-256 digest",
      );
    }
  });

  test("rejects malformed JSON, unknown fields/events, and missing terminals", () => {
    expect(parseGuestOutput(`${GUEST_OUTPUT_PREFIX}{broken\n`).status).toBe("invalid");
    const unknownField = parseGuestOutput(
      line(GUEST_OUTPUT_PREFIX, guestPhase({ device: "vita" })) +
      line(GUEST_OUTPUT_PREFIX, guestComplete()),
    );
    expect(unknownField.status).toBe("invalid");
    expect(unknownField.reasons.join(" ")).toContain("unknown properties");

    const unknownEvent = parseQemuOutput(line(QEMU_OUTPUT_PREFIX, {
      schema: "pocketjs.perf.qemu",
      version: 1,
      event: "summary",
    }));
    expect(unknownEvent.status).toBe("invalid");
    expect(unknownEvent.reasons.join(" ")).toContain("unknown protocol event");

    const noTerminal = parseQemuOutput(line(QEMU_OUTPUT_PREFIX, qemuMeasurement()));
    expect(noTerminal.status).toBe("invalid");
    expect(noTerminal.reasons.join(" ")).toContain("exactly one");
  });

  test("rejects duplicates, out-of-order terminals, wrong counts, and plugin errors", () => {
    const duplicateGuest = parseGuestOutput(
      line(GUEST_OUTPUT_PREFIX, guestPhase()) +
      line(GUEST_OUTPUT_PREFIX, guestPhase()) +
      line(GUEST_OUTPUT_PREFIX, guestComplete()),
    );
    expect(duplicateGuest.status).toBe("invalid");
    expect(duplicateGuest.reasons.join(" ")).toContain("duplicate guest phase");

    const afterTerminal = parseQemuOutput(
      line(QEMU_OUTPUT_PREFIX, qemuComplete()) +
      line(QEMU_OUTPUT_PREFIX, qemuMeasurement()),
    );
    expect(afterTerminal.status).toBe("invalid");
    expect(afterTerminal.reasons.join(" ")).toContain("not the final");

    const wrongCount = parseQemuOutput(
      line(QEMU_OUTPUT_PREFIX, qemuMeasurement()) +
      line(QEMU_OUTPUT_PREFIX, qemuComplete({ measurements: 2 })),
    );
    expect(wrongCount.status).toBe("invalid");
    expect(wrongCount.reasons.join(" ")).toContain("does not match");

    const pluginError = parseQemuOutput(line(QEMU_OUTPUT_PREFIX, {
      schema: "pocketjs.perf.qemu",
      version: 1,
      event: "error",
      plugin_api: 6,
      qemu_version: "11.0.3",
      target: "arm",
      code: "missing_end",
      measurements: 0,
    }));
    expect(pluginError.status).toBe("invalid");
    expect(pluginError.reasons).toContain("QEMU plugin reported missing_end");
  });
});

describe("receipt factories", () => {
  test("merges QEMU counters, guest memory, correctness, and artifact metrics per phase", () => {
    const receipts = createQemuReceipts(scenario, combinedOutput(), {
      provenance,
      target: "arm",
      correctnessGuestOutput: correctnessOutput(),
      framebufferHash: HASH.framebufferTrace,
      artifactMetrics: {
        "artifact.bundle_bytes": 4096,
        "artifact.pak_bytes": 512,
        "artifact.elf_text_rodata_bytes": 80_000,
      },
      createdAt: "2026-08-09T12:00:00.000Z",
    });
    expect(receipts).toHaveLength(1);
    const receipt = parseReceiptV1(receipts[0]);
    expect(receipt.status).toBe("valid");
    expect(receipt.provenance.scenario.id).toBe("receipt-fixture#steady");
    expect(receipt.provenance.scenario.manifestHash).toBe(sha256Json(scenario));
    expect(receipt.provenance.scenario.inputTapeHash).toBe(sha256Json(scenario.tape));
    expect(receipt.gateMetrics).toEqual([
      "artifact.bundle_bytes",
      "guest.instructions",
      "memory.allocated_bytes",
    ]);
    expect(receipt.unsupportedMetrics).toEqual([]);
    expect(receipt.metrics["guest.instructions"]).toEqual({ kind: "exact", value: 10_000, unit: "count" });
    expect(receipt.metrics["guest.load_store_events"]).toEqual({ kind: "exact", value: 4_000, unit: "count" });
    expect(receipt.metrics["memory.allocated_bytes"]).toEqual({ kind: "exact", value: 2048, unit: "bytes" });
    expect(receipt.metrics["quickjs.live_bytes_after_gc"]).toEqual({ kind: "exact", value: 768, unit: "bytes" });
    expect(receipt.metrics["artifact.elf_text_rodata_bytes"]).toEqual({ kind: "exact", value: 80_000, unit: "bytes" });
    if (receipt.status === "valid") {
      expect(receipt.correctness.drawListHash).toBe(guestDigestToSha256("draw-list", FNV.phaseDraw));
      expect(receipt.correctness.framebufferHash).toBe(HASH.framebufferTrace);
    }
  });

  test("sources guest-app framebuffer traces only from a valid correctness replay", () => {
    const artifactMetrics = { "artifact.bundle_bytes": 4_096 } as const;
    const withoutExpectedOracle = createQemuReceipts(scenario, combinedOutput(), {
      provenance,
      target: "arm",
      correctnessGuestOutput: correctnessOutput(),
      artifactMetrics,
    })[0]!;
    expect(withoutExpectedOracle.status).toBe("valid");
    expect(withoutExpectedOracle.correctness?.framebufferHash).toBe(HASH.framebufferTrace);

    const missingOutput = createQemuReceipts(scenario, combinedOutput(), {
      provenance,
      target: "arm",
      framebufferHash: HASH.framebufferTrace,
      artifactMetrics,
    })[0]!;
    expect(missingOutput.status).toBe("invalid");
    expect(missingOutput.invalidReasons.join(" ")).toContain(
      "QEMU guest-app receipt has no correctness guest output",
    );

    const missingField = createQemuReceipts(scenario, combinedOutput(), {
      provenance,
      target: "arm",
      correctnessGuestOutput: correctnessOutput(guestComplete()),
      framebufferHash: HASH.framebufferTrace,
      artifactMetrics,
    })[0]!;
    expect(missingField.status).toBe("invalid");
    expect(missingField.invalidReasons.join(" ")).toContain(
      "guest complete has no required framebufferTraceHash",
    );

    const malformedField = createQemuReceipts(scenario, combinedOutput(), {
      provenance,
      target: "arm",
      correctnessGuestOutput: correctnessOutput(
        guestComplete({ framebufferTraceHash: "A".repeat(64) }),
      ),
      framebufferHash: HASH.framebufferTrace,
      artifactMetrics,
    })[0]!;
    expect(malformedField.status).toBe("invalid");
    expect(malformedField.invalidReasons.join(" ")).toContain(
      "framebufferTraceHash must be a lowercase SHA-256 digest",
    );

    const mismatch = createQemuReceipts(scenario, combinedOutput(), {
      provenance,
      target: "arm",
      correctnessGuestOutput: correctnessOutput(
        guestComplete({ framebufferTraceHash: "a".repeat(64) }),
      ),
      framebufferHash: HASH.framebufferTrace,
      artifactMetrics,
    })[0]!;
    expect(mismatch.status).toBe("invalid");
    expect(mismatch.invalidReasons.join(" ")).toContain(
      "QEMU correctness framebuffer trace differs from the independent correctness replay",
    );

    const measurementLeak = createQemuReceipts(
      scenario,
      combinedOutput(
        guestPhase(),
        qemuMeasurement(),
        guestComplete({ framebufferTraceHash: HASH.framebufferTrace }),
      ),
      {
        provenance,
        target: "arm",
        correctnessGuestOutput: correctnessOutput(),
        framebufferHash: HASH.framebufferTrace,
        artifactMetrics,
      },
    )[0]!;
    expect(measurementLeak.status).toBe("invalid");
    expect(measurementLeak.invalidReasons.join(" ")).toContain(
      "guest complete emitted correctness-only framebufferTraceHash",
    );
  });

  test("detects injected loop, allocation, and bundle-padding regressions", () => {
    const base = createQemuReceipts(scenario, combinedOutput(), {
      provenance,
      target: "arm",
      correctnessGuestOutput: correctnessOutput(),
      framebufferHash: HASH.framebufferTrace,
      artifactMetrics: { "artifact.bundle_bytes": 4_096 },
      createdAt: "2026-08-09T12:00:00.000Z",
    })[0]!;
    const injectedMetrics = {
      ...qemuMeasurement().metrics,
      guest_insn_dispatched: 20_001,
    };
    const injectedOutput = combinedOutput(
      guestPhase({ allocatedBytes: 10_241 }),
      qemuMeasurement({ metrics: injectedMetrics }),
    );
    const candidate = createQemuReceipts(scenario, injectedOutput, {
      provenance: {
        ...provenance,
        binary: { sha256: "9".repeat(64) },
      },
      target: "arm",
      correctnessGuestOutput: correctnessOutput(),
      framebufferHash: HASH.framebufferTrace,
      artifactMetrics: { "artifact.bundle_bytes": 8_193 },
      createdAt: "2026-08-09T12:00:00.000Z",
    })[0]!;
    const comparison = compareReceipts(base, candidate);
    expect(comparison.status).toBe("regression");
    for (const metricId of [
      "guest.instructions",
      "memory.allocated_bytes",
      "artifact.bundle_bytes",
    ]) {
      expect(comparison.metrics.find((metric) => metric.id === metricId)?.status).toBe("regression");
    }
  });

  test("turns missing, unknown, and mismatched phase records into invalid receipts", () => {
    const missingQemu = [
      line(GUEST_OUTPUT_PREFIX, guestPhase()),
      line(GUEST_OUTPUT_PREFIX, guestComplete()),
      line(QEMU_OUTPUT_PREFIX, qemuComplete({ measurements: 0 })),
    ].join("");
    const missingReceipt = createQemuReceipts(scenario, missingQemu, {
      provenance,
      target: "arm",
      correctnessGuestOutput: correctnessOutput(),
      framebufferHash: HASH.framebufferTrace,
    })[0];
    expect(parseReceiptV1(missingReceipt).status).toBe("invalid");
    expect(missingReceipt.invalidReasons.join(" ")).toContain("missing QEMU measurement steady");

    const wrongId = scenarioPhaseId(scenario.id, "another-phase");
    const mismatchReceipt = createQemuReceipts(
      scenario,
      combinedOutput(guestPhase({ phaseId: wrongId }), qemuMeasurement({ phase_id: wrongId })),
      {
        provenance,
        target: "arm",
        correctnessGuestOutput: correctnessOutput(),
        framebufferHash: HASH.framebufferTrace,
      },
    )[0];
    expect(mismatchReceipt.status).toBe("invalid");
    expect(mismatchReceipt.invalidReasons.join(" ")).toContain("phaseId mismatch");

    const unknownReceipt = createQemuReceipts(
      scenario,
      combinedOutput(guestPhase({ phase: "unknown" }), qemuMeasurement()),
      {
        provenance,
        target: "arm",
        correctnessGuestOutput: correctnessOutput(),
        framebufferHash: HASH.framebufferTrace,
      },
    )[0];
    expect(unknownReceipt.status).toBe("invalid");
    expect(unknownReceipt.invalidReasons.join(" ")).toContain("phase order mismatch");
  });

  test("requires QEMU gate observations and exact Native unsupported declarations", () => {
    const gated = parseScenarioV1({
      ...scenario,
      params: { gateMetrics: ["artifact.elf_text_rodata_bytes"] },
    });
    const qemuReceipt = createQemuReceipts(gated, combinedOutput(), {
      provenance,
      target: "arm",
      correctnessGuestOutput: correctnessOutput(),
      framebufferHash: HASH.framebufferTrace,
    })[0]!;
    expect(qemuReceipt.status).toBe("invalid");
    expect(qemuReceipt.invalidReasons).toContain(
      "required gate metric artifact.elf_text_rodata_bytes is missing",
    );

    const nativeGated = parseScenarioV1({
      ...scenario,
      params: { gateMetrics: ["guest.instructions"] },
    });
    const nativeEnvironment = {
      ...provenance,
      toolchain: { rustc: "host", cCompiler: "host", sysroot: "host" },
      build: { target: "wasm32-host", profile: "release", rustFlags: [], cFlags: [], linkerFlags: [] },
      executor: {
        id: "native",
        version: "bun 1.3.14",
        profile: "wasm-sim",
        fingerprint: "8".repeat(64),
      },
    };
    const explicit = createNativeReceipt(nativeGated, nativeResult({
      unsupportedMetrics: ["guest.instructions"],
    }), { provenance: nativeEnvironment });
    expect(explicit.status).toBe("valid");
    expect(explicit.unsupportedMetrics).toEqual(["guest.instructions"]);

    const silent = createNativeReceipt(nativeGated, nativeResult({ unsupportedMetrics: [] }), {
      provenance: nativeEnvironment,
    });
    expect(silent.status).toBe("invalid");
    expect(silent.invalidReasons.join(" ")).toContain("missing without an explicit native unsupported declaration");

    const noGates = parseScenarioV1({ ...scenario, params: {} });
    const extra = createNativeReceipt(noGates, nativeResult({
      unsupportedMetrics: ["guest.instructions"],
    }), { provenance: nativeEnvironment });
    expect(extra.status).toBe("invalid");
    expect(extra.invalidReasons.join(" ")).toContain("marked non-gate metric");
  });

  test("maps native correctness explicitly and refuses to invent a missing draw-list hash", () => {
    const missingDraw = structuredClone(nativeResult()) as any;
    delete missingDraw.correctness.drawListHash;
    const noDraw = createNativeReceipt(scenario, missingDraw, {
      provenance: {
        ...provenance,
        toolchain: { rustc: "host", cCompiler: "host", sysroot: "host" },
        build: { target: "wasm32-host", profile: "release", rustFlags: [], cFlags: [], linkerFlags: [] },
        executor: {
          id: "native",
          version: "bun 1.3.14",
          profile: "wasm-sim",
          fingerprint: "8".repeat(64),
        },
      },
      createdAt: "2026-08-09T12:00:00.000Z",
    });
    expect(parseReceiptV1(noDraw).status).toBe("invalid");
    expect(noDraw.invalidReasons.join(" ")).toContain("native.correctness.drawListHash is missing");
    expect(noDraw.correctness).toBeNull();

    const withDraw = createNativeReceipt(scenario, nativeResult(), {
      provenance: {
        ...provenance,
        toolchain: { rustc: "host", cCompiler: "host", sysroot: "host" },
        build: { target: "wasm32-host", profile: "release", rustFlags: [], cFlags: [], linkerFlags: [] },
        executor: {
          id: "native",
          version: "bun 1.3.14",
          profile: "wasm-sim",
          fingerprint: "8".repeat(64),
        },
      },
      createdAt: "2026-08-09T12:00:00.000Z",
    });
    expect(parseReceiptV1(withDraw).status).toBe("valid");
    expect(withDraw.metrics["native.wall_time_ns"]).toEqual({ kind: "exact", value: 9_000, unit: "ns" });
    expect(withDraw.metrics["artifact.bundle_bytes"]).toEqual({ kind: "exact", value: 4_096, unit: "bytes" });
    if (withDraw.status === "valid") {
      expect(withDraw.correctness).toEqual({
        framebufferHash: HASH.framebufferTrace,
        drawListHash: guestDigestToSha256("draw-list", FNV.phaseDraw),
        stateHash: HASH.state,
        effectHash: HASH.effect,
      });
    }
  });

  test("emits schema-valid invalid receipts for malformed native execution output", () => {
    const malformed = structuredClone(nativeResult()) as unknown as Record<string, unknown>;
    malformed.extra = true;
    const receipt = createNativeReceipt(scenario, malformed, {
      provenance,
      artifactMetrics: { "artifact.bundle_bytes": 10 },
      createdAt: "2026-08-09T12:00:00.000Z",
    });
    expect(parseReceiptV1(receipt).status).toBe("invalid");
    expect(receipt.invalidReasons.join(" ")).toContain("native.extra is unknown");
  });
});
