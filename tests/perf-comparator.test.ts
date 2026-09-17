import { describe, expect, test } from "bun:test";
import {
  buildRenderConfig,
  DEFAULT_BUDGET_SET,
  METRIC_CATALOG,
  SchemaValidationError,
  compareReceipts,
  comparisonToJson,
  comparisonToMarkdown,
  parseBudgetSetV1,
  parseComparisonV1,
  parseInputTapeV1,
  parseReceiptV1,
  parseScenarioV1,
  safeParseReceiptV1,
  safeParseScenarioV1,
  withHardLimits,
  type BudgetSetV1,
  type InputTapeV1,
  type MetricSampleV1,
  type ReceiptV1,
  type ScenarioV1,
} from "../tools/perf/core/index.ts";

const HASH = {
  content: "1".repeat(64),
  tape: "2".repeat(64),
  manifest: "9".repeat(64),
  binary: "3".repeat(64),
  framebuffer: "4".repeat(64),
  drawList: "5".repeat(64),
  state: "6".repeat(64),
  effect: "7".repeat(64),
};

function exact(value: number, unit: "count" | "bytes" | "ns" = "count"): MetricSampleV1 {
  return { kind: "exact", value, unit };
}

function sampled(samples: readonly number[], unit: "count" | "bytes" | "ns" = "count"): MetricSampleV1 {
  return { kind: "sampled", samples, unit };
}

function receipt(
  metrics: Readonly<Record<string, MetricSampleV1>> = {
    "guest.instructions": exact(100),
  },
  options: {
    revision?: string;
    binary?: string;
    executorId?: string;
    executorProfile?: string;
    executorFingerprint?: string;
    buildProfile?: string;
    rustc?: string;
    scenarioId?: string;
    gateMetrics?: readonly string[];
    unsupportedMetrics?: readonly string[];
  } = {},
): ReceiptV1 {
  return {
    schemaVersion: 1,
    kind: "pocketjs.perf.receipt",
    createdAt: "2026-08-09T12:00:00.000Z",
    status: "valid",
    invalidReasons: [],
    provenance: {
      source: {
        revision: options.revision ?? "base",
        dirty: options.revision === "candidate",
        contentHash: HASH.content,
      },
      scenario: {
        id: options.scenarioId ?? "startup-solid",
        suite: "quick",
        framework: "solid",
        manifestHash: HASH.manifest,
        inputTapeHash: HASH.tape,
      },
      toolchain: {
        rustc: options.rustc ?? "rustc 1.91.0",
        cCompiler: "clang 21.0.0",
        sysroot: "sysroot-sha256:fixture",
        qemu: "11.0.3",
      },
      build: {
        target: "armv7-unknown-linux-gnueabihf",
        profile: options.buildProfile ?? "release-perf",
        rustFlags: ["-C", "target-feature=+thumb-mode"],
        cFlags: ["-mthumb", "-march=armv7-a"],
        linkerFlags: ["-mthumb"],
      },
      executor: {
        id: options.executorId ?? "qemu-armv7-thumb2",
        version: "11.0.3",
        profile: options.executorProfile ?? "armv7a-thumb2-vfpv3-d16-hardfloat",
        fingerprint: options.executorFingerprint ?? "a".repeat(64),
      },
      binary: { sha256: options.binary ?? HASH.binary },
    },
    correctness: {
      framebufferHash: HASH.framebuffer,
      drawListHash: HASH.drawList,
      stateHash: HASH.state,
      effectHash: HASH.effect,
    },
    gateMetrics: options.gateMetrics ?? ["guest.instructions"],
    unsupportedMetrics: options.unsupportedMetrics ?? [],
    metrics,
  };
}

function candidate(
  metrics: Readonly<Record<string, MetricSampleV1>>,
  options: Parameters<typeof receipt>[1] = {},
): ReceiptV1 {
  return receipt(metrics, {
    revision: "candidate",
    binary: "8".repeat(64),
    ...options,
  });
}

function instructionBudget(
  metricBudget: BudgetSetV1["metrics"][string] = {
    warn: { relative: 0.05, absolute: 10 },
    regression: { relative: 0.1, absolute: 20 },
  },
): BudgetSetV1 {
  return {
    schemaVersion: 1,
    kind: "pocketjs.perf.budget-set",
    id: "instruction-test-v1",
    metrics: { "guest.instructions": metricBudget },
  };
}

const inputTape: InputTapeV1 = {
  schemaVersion: 1,
  kind: "pocketjs.perf.input-tape",
  id: "all-input-kinds",
  frames: 4,
  tracks: [
    { kind: "button", control: "confirm", samples: [{ frame: 0, pressed: true }, { frame: 1, pressed: false }] },
    { kind: "analog", control: "primary-x", samples: [{ frame: 0, value: 0 }, { frame: 2, value: 0.5 }] },
    { kind: "touch", control: "primary", samples: [{ frame: 1, phase: "start", x: 12, y: 18 }, { frame: 3, phase: "end", x: 12, y: 18 }] },
    { kind: "relative-axis", control: "scroll-y", samples: [{ frame: 2, delta: 3 }] },
    { kind: "effect", effect: "tile-upload", samples: [{ frame: 3, value: { tile: 4 } }] },
  ],
};

const scenario: ScenarioV1 = {
  schemaVersion: 1,
  kind: "pocketjs.perf.scenario",
  id: "all-input-scenario",
  suite: "quick",
  subject: {
    id: "fixture",
    family: "input",
    framework: "core",
    entry: "fixtures/input.ts",
  },
  executorRequirements: ["native", "qemu-armv7-thumb2"],
  frames: 4,
  tape: inputTape,
  phases: [
    { name: "setup", startFrame: 0, endFrame: 1, collect: false },
    { name: "measure", startFrame: 1, endFrame: 4, collect: true },
  ],
  checkpoints: [{ frame: 3, capture: ["framebuffer", "drawList", "state", "effects"] }],
  params: { repetitions: 1, labels: ["deterministic"] },
};

describe("perf v1 schemas", () => {
  test("strictly validates input tapes and scenarios", () => {
    expect(parseInputTapeV1(inputTape)).toBe(inputTape);
    expect(parseScenarioV1(scenario)).toBe(scenario);

    const extra = structuredClone(scenario) as any;
    extra.subject.device = "vita";
    expect(() => parseScenarioV1(extra)).toThrow("unexpected property");

    const unsorted = structuredClone(inputTape) as any;
    unsorted.tracks[0].samples[1].frame = 0;
    expect(() => parseInputTapeV1(unsorted)).toThrow("strictly increasing");

    const wrongFrames = structuredClone(scenario) as any;
    wrongFrames.frames = 5;
    expect(() => parseScenarioV1(wrongFrames)).toThrow("must equal");

    const diagnosticGate = structuredClone(scenario) as any;
    diagnosticGate.params.gateMetrics = ["memory.current_bytes"];
    expect(() => parseScenarioV1(diagnosticGate)).toThrow("diagnostic metrics cannot be regression gates");

    const duplicateGate = structuredClone(scenario) as any;
    duplicateGate.params.gateMetrics = ["guest.instructions", "guest.instructions"];
    expect(() => parseScenarioV1(duplicateGate)).toThrow("duplicate gate metric");
  });

  test("strictly resolves the shared viewport, density and render-scale contract", () => {
    expect(buildRenderConfig(scenario.params)).toEqual({
      width: 480,
      height: 272,
      rasterDensity: 1,
      renderScale: 1,
    });

    const custom = structuredClone(scenario) as any;
    custom.params.viewport = {
      width: 320,
      height: 180,
      rasterDensity: 3,
      renderScale: 4,
    };
    const parsed = parseScenarioV1(custom);
    expect(buildRenderConfig(parsed.params)).toEqual(custom.params.viewport);

    for (const [field, value] of [
      ["width", 1.5],
      ["width", 32_001],
      ["height", 0],
      ["rasterDensity", 256],
      ["renderScale", 5],
    ] as const) {
      const invalid = structuredClone(scenario) as any;
      invalid.params.viewport = { [field]: value };
      expect(() => parseScenarioV1(invalid), `${field}=${value}`).toThrow("expected an integer");
    }

    const unknown = structuredClone(scenario) as any;
    unknown.params.viewport = { width: 320, deviceScale: 2 };
    const result = safeParseScenarioV1(unknown);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual({
        path: "/params/viewport/deviceScale",
        message: "unexpected property",
      });
    }
  });

  test("rejects wrong versions, unknown properties, non-finite values and unknown metrics", () => {
    const wrongVersion = structuredClone(receipt()) as any;
    wrongVersion.schemaVersion = 2;
    expect(() => parseReceiptV1(wrongVersion)).toThrow('expected 1');

    const extra = structuredClone(receipt()) as any;
    extra.provenance.executor.device = "specific-hardware";
    const parsed = safeParseReceiptV1(extra);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error).toBeInstanceOf(SchemaValidationError);
      expect(parsed.error.issues).toContainEqual({
        path: "/provenance/executor/device",
        message: "unexpected property",
      });
    }

    const infinity = structuredClone(receipt()) as any;
    infinity.metrics["guest.instructions"].value = Number.POSITIVE_INFINITY;
    expect(() => parseReceiptV1(infinity)).toThrow("finite number");

    const unknownMetric = structuredClone(receipt()) as any;
    unknownMetric.metrics["custom.metric"] = exact(1);
    expect(() => parseReceiptV1(unknownMetric)).toThrow("unknown metric id");
  });

  test("requires every valid receipt gate to be observed or explicitly unsupported", () => {
    const missing = structuredClone(receipt()) as any;
    missing.metrics = { "native.wall_time_ns": exact(1, "ns") };
    expect(() => parseReceiptV1(missing)).toThrow("neither observed nor explicitly unsupported");

    missing.unsupportedMetrics = ["guest.instructions"];
    expect(parseReceiptV1(missing).unsupportedMetrics).toEqual(["guest.instructions"]);

    missing.metrics["guest.instructions"] = exact(1);
    expect(() => parseReceiptV1(missing)).toThrow("both observed and unsupported");
  });

  test("enforces valid/invalid receipt invariants and sampled observations", () => {
    const invalid = structuredClone(receipt()) as any;
    invalid.status = "invalid";
    invalid.invalidReasons = ["measurement marker was not closed"];
    invalid.correctness = null;
    invalid.metrics = {};
    expect(parseReceiptV1(invalid).status).toBe("invalid");

    invalid.invalidReasons = [];
    expect(() => parseReceiptV1(invalid)).toThrow("must contain a reason");

    const emptySamples = structuredClone(receipt({
      "guest.instructions": sampled([]),
    }));
    expect(() => parseReceiptV1(emptySamples)).toThrow("at least one observation");
  });

  test("validates budgets and publishes the planned defaults", () => {
    expect(parseBudgetSetV1(DEFAULT_BUDGET_SET)).toBe(DEFAULT_BUDGET_SET);
    expect(DEFAULT_BUDGET_SET.metrics["guest.instructions"]).toMatchObject({
      warn: { relative: 0.005, absolute: 5_000 },
      regression: { relative: 0.01, absolute: 10_000 },
    });
    expect(DEFAULT_BUDGET_SET.metrics["guest.instruction_bytes"]).toMatchObject({
      warn: { relative: 0.005, absolute: 10 * 1024 },
      regression: { relative: 0.01, absolute: 20 * 1024 },
    });
    expect(DEFAULT_BUDGET_SET.metrics["guest.load_store_events"]).toMatchObject({
      warn: { relative: 0.01, absolute: 10_000 },
      regression: { relative: 0.02, absolute: 20_000 },
    });
    expect(DEFAULT_BUDGET_SET.metrics["guest.loads"]).toBeUndefined();
    expect(DEFAULT_BUDGET_SET.metrics["guest.stores"]).toBeUndefined();
    expect(DEFAULT_BUDGET_SET.metrics["memory.current_bytes"]).toBeUndefined();
    expect(DEFAULT_BUDGET_SET.metrics["memory.peak_bytes"]).toBeUndefined();
    expect(DEFAULT_BUDGET_SET.metrics["artifact.elf_text_rodata_bytes"]).toMatchObject({
      warn: { relative: 0.005, absolute: 2 * 1024 },
      regression: { relative: 0.01, absolute: 4 * 1024 },
    });
    expect(DEFAULT_BUDGET_SET.scenarios?.["vapor.todo.reactive-grid.v1"]?.["memory.allocations"])
      .toMatchObject({ hardMax: 0 });

    const partialThreshold = structuredClone(instructionBudget()) as any;
    delete partialThreshold.metrics["guest.instructions"].warn.absolute;
    expect(() => parseBudgetSetV1(partialThreshold)).toThrow("required property is missing");

    const backwards = instructionBudget({
      warn: { relative: 0.1, absolute: 20 },
      regression: { relative: 0.05, absolute: 10 },
    });
    expect(() => parseBudgetSetV1(backwards)).toThrow("greater than or equal");

    for (const diagnostic of [
      "guest.thumb16_instructions",
      "guest.thumb32_instructions",
      "guest.loads",
      "guest.stores",
      "memory.current_bytes",
      "memory.peak_bytes",
      "native.wall_time_ns",
    ]) {
      const globalBudget = structuredClone(instructionBudget()) as any;
      globalBudget.metrics[diagnostic] = { hardMax: 1 };
      expect(() => parseBudgetSetV1(globalBudget)).toThrow(
        "diagnostic metrics cannot have regression budgets",
      );

      const scenarioBudget = structuredClone(instructionBudget()) as any;
      scenarioBudget.scenarios = { "fixture.v1": { [diagnostic]: { hardMax: 1 } } };
      expect(() => parseBudgetSetV1(scenarioBudget)).toThrow(
        "diagnostic metrics cannot have regression budgets",
      );
    }
  });
});

describe("metric catalog", () => {
  test("defines direction, kind and unit, including diagnostics", () => {
    expect(METRIC_CATALOG["guest.instructions"]).toMatchObject({
      direction: "lower-is-better",
      kind: "counter",
      unit: "count",
      diagnostic: false,
    });
    expect(METRIC_CATALOG["guest.thumb16_instructions"].diagnostic).toBe(true);
    expect(METRIC_CATALOG["guest.thumb32_instructions"].diagnostic).toBe(true);
    expect(METRIC_CATALOG["guest.loads"].unit).toBe("count");
    expect(METRIC_CATALOG["guest.stores"].unit).toBe("count");
    expect(METRIC_CATALOG["guest.loads"].diagnostic).toBe(true);
    expect(METRIC_CATALOG["guest.stores"].diagnostic).toBe(true);
    expect(METRIC_CATALOG["memory.current_bytes"].diagnostic).toBe(true);
    expect(METRIC_CATALOG["memory.peak_bytes"].diagnostic).toBe(true);
    expect(METRIC_CATALOG["memory.allocations"].diagnostic).toBe(false);
    expect(METRIC_CATALOG["native.wall_time_ns"]).toMatchObject({ unit: "ns", diagnostic: true });
  });
});

describe("receipt comparison", () => {
  test("requires relative and absolute thresholds together and treats equality as within budget", () => {
    const budget = instructionBudget();
    expect(compareReceipts(receipt(), candidate({ "guest.instructions": exact(110) }), budget).status).toBe("pass");
    expect(compareReceipts(receipt(), candidate({ "guest.instructions": exact(111) }), budget).status).toBe("warn");
    expect(compareReceipts(receipt(), candidate({ "guest.instructions": exact(119) }), budget).status).toBe("warn");
    expect(compareReceipts(receipt(), candidate({ "guest.instructions": exact(120) }), budget).status).toBe("warn");
    expect(compareReceipts(receipt(), candidate({ "guest.instructions": exact(121) }), budget).status).toBe("regression");
    expect(compareReceipts(receipt(), candidate({ "guest.instructions": exact(80) }), budget).status).toBe("pass");
  });

  test("uses the absolute half of conjunction when the baseline is zero", () => {
    const base = receipt({ "guest.instructions": exact(0) });
    const budget = instructionBudget();
    const below = compareReceipts(base, candidate({ "guest.instructions": exact(9) }), budget);
    expect(below.status).toBe("pass");
    expect(below.metrics[0]?.relativeDelta).toBeNull();
    expect(compareReceipts(base, candidate({ "guest.instructions": exact(10) }), budget).status).toBe("pass");
    expect(compareReceipts(base, candidate({ "guest.instructions": exact(11) }), budget).status).toBe("warn");
    expect(compareReceipts(base, candidate({ "guest.instructions": exact(20) }), budget).status).toBe("warn");
    expect(compareReceipts(base, candidate({ "guest.instructions": exact(21) }), budget).status).toBe("regression");
  });

  test("applies hardMax and hardMin as strict absolute bounds", () => {
    const maxBudget = instructionBudget({ hardMax: 100 });
    expect(compareReceipts(receipt(), candidate({ "guest.instructions": exact(100) }), maxBudget).status).toBe("pass");
    expect(compareReceipts(receipt(), candidate({ "guest.instructions": exact(101) }), maxBudget).status).toBe("regression");

    const minBudget = instructionBudget({ hardMin: 100 });
    expect(compareReceipts(receipt(), candidate({ "guest.instructions": exact(100) }), minBudget).status).toBe("pass");
    expect(compareReceipts(receipt(), candidate({ "guest.instructions": exact(99) }), minBudget).status).toBe("regression");

    const zeroAllocation = withHardLimits({
      schemaVersion: 1,
      kind: "pocketjs.perf.budget-set",
      id: "zero-allocation",
      metrics: { "memory.allocations": { hardMax: 2 } },
    }, "memory.allocations", { hardMax: 0 });
    expect(zeroAllocation.metrics["memory.allocations"]?.hardMax).toBe(0);

    const vaporOptions = {
      scenarioId: "vapor.todo.reactive-grid.v1#settle",
      gateMetrics: ["memory.allocations"],
    };
    const vaporBudget: BudgetSetV1 = {
      schemaVersion: 1,
      kind: "pocketjs.perf.budget-set",
      id: "scenario-hard-max",
      metrics: { "artifact.bundle_bytes": { hardMax: 1, executors: ["native"] } },
      scenarios: {
        "vapor.todo.reactive-grid.v1": {
          "memory.allocations": { hardMax: 0, executors: ["qemu-armv7-thumb2"] },
        },
      },
    };
    const zero = compareReceipts(
      receipt({ "memory.allocations": exact(0) }, vaporOptions),
      candidate({ "memory.allocations": exact(0) }, vaporOptions),
      vaporBudget,
    );
    expect(zero.status).toBe("pass");
    expect(zero.metrics.find((metric) => metric.id === "memory.allocations")?.budget?.hardMax).toBe(0);
    const allocated = compareReceipts(
      receipt({ "memory.allocations": exact(0) }, vaporOptions),
      candidate({ "memory.allocations": exact(1) }, vaporOptions),
      vaporBudget,
    );
    expect(allocated.status).toBe("regression");
  });

  test("marks missing and incompatible metric samples invalid", () => {
    const budget = instructionBudget();
    const missing = compareReceipts(
      receipt({ "guest.instructions": exact(100), "memory.current_bytes": exact(2, "bytes") }),
      candidate({ "guest.instructions": exact(100) }),
      budget,
    );
    expect(missing.status).toBe("invalid");
    expect(missing.reasons.some((reason) => reason.code === "metric-missing")).toBe(true);

    const units = compareReceipts(
      receipt({ "guest.instructions": exact(100, "count") }),
      candidate({ "guest.instructions": exact(100, "bytes") }),
      budget,
    );
    expect(units.status).toBe("invalid");
    expect(units.reasons[0]?.code).toBe("unit-mismatch");

    const catalogUnits = compareReceipts(
      receipt({ "guest.instructions": exact(100, "bytes") }),
      candidate({ "guest.instructions": exact(110, "bytes") }),
      budget,
    );
    expect(catalogUnits.status).toBe("invalid");
    expect(catalogUnits.reasons[0]?.code).toBe("catalog-unit-mismatch");
  });

  test("invalidates a declared gate without an applicable budget", () => {
    const noInstructionBudget: BudgetSetV1 = {
      schemaVersion: 1,
      kind: "pocketjs.perf.budget-set",
      id: "unrelated-budget",
      metrics: { "artifact.bundle_bytes": { hardMax: 1_000_000 } },
    };
    const comparison = compareReceipts(
      receipt(),
      candidate({ "guest.instructions": exact(100) }),
      noInstructionBudget,
    );
    expect(comparison.status).toBe("invalid");
    expect(comparison.reasons).toContainEqual(expect.objectContaining({ code: "budget-missing" }));
  });

  test("applies configured budgets to emitted metrics outside the required gate list", () => {
    const base = receipt({
      "guest.instructions": exact(100),
      "guest.instruction_bytes": exact(100_000, "bytes"),
    });
    const next = candidate({
      "guest.instructions": exact(100),
      "guest.instruction_bytes": exact(130_001, "bytes"),
    });
    const comparison = compareReceipts(base, next);
    expect(comparison.status).toBe("regression");
    expect(comparison.metrics.find((metric) => metric.id === "guest.instruction_bytes"))
      .toMatchObject({ status: "regression" });
  });

  test("keeps Native unsupported gates explicit and rejects an applicable gate budget", () => {
    const nativeOptions = {
      executorId: "native",
      executorProfile: "host-diagnostic",
      gateMetrics: ["guest.instructions"],
      unsupportedMetrics: ["guest.instructions"],
    };
    const base = receipt({ "native.wall_time_ns": exact(10, "ns") }, nativeOptions);
    const next = candidate({ "native.wall_time_ns": exact(20, "ns") }, nativeOptions);
    const qemuOnly = instructionBudget({
      warn: { relative: 0.05, absolute: 10 },
      regression: { relative: 0.1, absolute: 20 },
      executors: ["qemu-armv7-thumb2", "qemu-aarch64"],
    });
    const diagnostic = compareReceipts(base, next, qemuOnly);
    expect(diagnostic.status).toBe("pass");
    expect(diagnostic.unsupportedMetrics).toEqual(["guest.instructions"]);
    expect(comparisonToMarkdown(diagnostic)).toContain("Unsupported gates for this executor");

    const omitted: BudgetSetV1 = {
      schemaVersion: 1,
      kind: "pocketjs.perf.budget-set",
      id: "omitted-native-gate",
      metrics: { "artifact.bundle_bytes": { hardMax: 1_000_000 } },
    };
    const missingBudget = compareReceipts(base, next, omitted);
    expect(missingBudget.status).toBe("invalid");
    expect(missingBudget.reasons).toContainEqual(expect.objectContaining({
      code: "budget-missing",
    }));

    const required = compareReceipts(base, next, instructionBudget());
    expect(required.status).toBe("invalid");
    expect(required.reasons).toContainEqual(expect.objectContaining({
      code: "metric-support-mismatch",
    }));
  });

  test("rejects executor, profile and toolchain mismatches but permits different source identities", () => {
    const budget = instructionBudget();
    const base = receipt();
    const sourceChange = compareReceipts(base, candidate({ "guest.instructions": exact(100) }), budget);
    expect(sourceChange.status).toBe("pass");
    expect(sourceChange.comparable).toBe(true);

    const executor = compareReceipts(base, candidate({ "guest.instructions": exact(100) }, { executorId: "qemu-aarch64" }), budget);
    expect(executor.status).toBe("invalid");
    expect(executor.reasons.map((reason) => reason.path)).toContain("/provenance/executor/id");

    const executorProfile = compareReceipts(base, candidate({ "guest.instructions": exact(100) }, { executorProfile: "different-profile" }), budget);
    expect(executorProfile.status).toBe("invalid");
    expect(executorProfile.reasons.map((reason) => reason.path)).toContain("/provenance/executor/profile");

    const executorFingerprint = compareReceipts(base, candidate(
      { "guest.instructions": exact(100) },
      { executorFingerprint: "b".repeat(64) },
    ), budget);
    expect(executorFingerprint.status).toBe("invalid");
    expect(executorFingerprint.reasons.map((reason) => reason.path))
      .toContain("/provenance/executor/fingerprint");

    const buildProfile = compareReceipts(base, candidate({ "guest.instructions": exact(100) }, { buildProfile: "debug" }), budget);
    expect(buildProfile.status).toBe("invalid");
    expect(buildProfile.reasons.map((reason) => reason.path)).toContain("/provenance/build/profile");

    const toolchain = compareReceipts(base, candidate({ "guest.instructions": exact(100) }, { rustc: "rustc 1.92.0" }), budget);
    expect(toolchain.status).toBe("invalid");
    expect(toolchain.reasons.map((reason) => reason.path)).toContain("/provenance/toolchain");
  });

  test("rejects correctness changes and invalid execution receipts", () => {
    const changed = structuredClone(candidate({ "guest.instructions": exact(100) })) as any;
    changed.correctness.stateHash = "9".repeat(64);
    const correctness = compareReceipts(receipt(), changed, instructionBudget());
    expect(correctness.status).toBe("invalid");
    expect(correctness.reasons[0]?.code).toBe("correctness-mismatch");

    const invalid = structuredClone(changed) as any;
    invalid.status = "invalid";
    invalid.invalidReasons = ["measurement marker order was invalid"];
    invalid.correctness = null;
    const execution = compareReceipts(receipt(), invalid, instructionBudget());
    expect(execution.status).toBe("invalid");
    expect(execution.reasons.some((reason) => reason.code === "receipt-invalid")).toBe(true);
  });

  test("keeps paired raw samples and emits a deterministic bootstrap interval", () => {
    const base = receipt({ "guest.instructions": sampled([100, 102, 98, 100]) });
    const next = candidate({ "guest.instructions": sampled([111, 112, 110, 111]) });
    const first = compareReceipts(base, next, instructionBudget());
    const second = compareReceipts(base, next, instructionBudget());
    expect(first.status).toBe("warn");
    expect(first.metrics[0]).toMatchObject({
      baseline: 100,
      candidate: 111,
      delta: 11,
      sampleKind: "paired",
      sampleCount: 4,
      confidenceInterval: {
        level: 0.95,
        method: "paired-bootstrap",
        iterations: 2_000,
      },
    });
    expect(first.metrics[0]?.confidenceInterval).toEqual(second.metrics[0]?.confidenceInterval);

    const conclusive = compareReceipts(
      receipt({ "guest.instructions": sampled([100, 100, 100, 100]) }),
      candidate({ "guest.instructions": sampled([121, 121, 121, 121]) }),
      instructionBudget(),
    );
    expect(conclusive.status).toBe("regression");

    const noisy = compareReceipts(
      receipt({ "guest.instructions": sampled([100, 100, 100, 100]) }),
      candidate({ "guest.instructions": sampled([80, 80, 162, 162]) }),
      instructionBudget(),
    );
    expect(noisy.metrics[0]).toMatchObject({ candidate: 121, status: "warn" });
    expect(noisy.metrics[0]?.reasons[0]?.message).toContain("not conclusive");

    const countMismatch = compareReceipts(
      base,
      candidate({ "guest.instructions": sampled([100, 101]) }),
      instructionBudget(),
    );
    expect(countMismatch.status).toBe("invalid");
    expect(countMismatch.reasons[0]?.code).toBe("sample-count-mismatch");

    const kindMismatch = compareReceipts(
      receipt({ "guest.instructions": exact(100) }),
      candidate({ "guest.instructions": sampled([100, 101]) }),
      instructionBudget(),
    );
    expect(kindMismatch.status).toBe("invalid");
    expect(kindMismatch.reasons[0]?.code).toBe("sample-kind-mismatch");
  });

  test("serializes schema-valid JSON and readable Markdown", () => {
    const comparison = compareReceipts(
      receipt(),
      candidate({ "guest.instructions": exact(121) }),
      instructionBudget(),
    );
    const json = comparisonToJson(comparison);
    expect(json.endsWith("\n")).toBe(true);
    expect(parseComparisonV1(JSON.parse(json))).toEqual(comparison);

    const markdown = comparisonToMarkdown(comparison);
    expect(markdown).toContain("Status: **regression**");
    expect(markdown).toContain("| Guest instructions | 100 | 121 | +21 (+21.00%) | **regression** |");
    expect(markdown).toContain("`threshold-exceeded`");

    const extra = structuredClone(comparison) as any;
    extra.metrics[0].note = "not in v1";
    expect(() => parseComparisonV1(extra)).toThrow("unexpected property");
  });
});
