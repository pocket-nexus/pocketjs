export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export const PERF_SCHEMA_VERSION = 1 as const;

export type FrameworkId = "solid" | "vue-vapor" | "octane" | "core";

export interface ButtonInputTrackV1 {
  readonly kind: "button";
  readonly control: string;
  readonly samples: readonly {
    readonly frame: number;
    readonly pressed: boolean;
  }[];
}

export interface AnalogInputTrackV1 {
  readonly kind: "analog";
  readonly control: string;
  readonly samples: readonly {
    readonly frame: number;
    readonly value: number;
  }[];
}

export interface TouchInputTrackV1 {
  readonly kind: "touch";
  readonly control: string;
  readonly samples: readonly {
    readonly frame: number;
    readonly phase: "start" | "move" | "end" | "cancel";
    readonly x: number;
    readonly y: number;
  }[];
}

export interface RelativeAxisInputTrackV1 {
  readonly kind: "relative-axis";
  readonly control: string;
  readonly samples: readonly {
    readonly frame: number;
    readonly delta: number;
  }[];
}

export interface EffectInputTrackV1 {
  readonly kind: "effect";
  readonly effect: string;
  readonly samples: readonly {
    readonly frame: number;
    readonly value: JsonValue;
  }[];
}

export type InputTrackV1 =
  | ButtonInputTrackV1
  | AnalogInputTrackV1
  | TouchInputTrackV1
  | RelativeAxisInputTrackV1
  | EffectInputTrackV1;

export interface InputTapeV1 {
  readonly schemaVersion: 1;
  readonly kind: "pocketjs.perf.input-tape";
  readonly id: string;
  readonly frames: number;
  readonly tracks: readonly InputTrackV1[];
}

export type CorrectnessCapture =
  | "framebuffer"
  | "drawList"
  | "state"
  | "effects";

export interface ScenarioV1 {
  readonly schemaVersion: 1;
  readonly kind: "pocketjs.perf.scenario";
  readonly id: string;
  readonly suite: string;
  readonly subject: {
    readonly id: string;
    readonly family: string;
    readonly framework: FrameworkId;
    readonly entry: string;
  };
  readonly executorRequirements: readonly string[];
  readonly frames: number;
  readonly tape: InputTapeV1;
  readonly phases: readonly {
    readonly name: string;
    readonly startFrame: number;
    readonly endFrame: number;
    readonly collect: boolean;
  }[];
  readonly checkpoints: readonly {
    readonly frame: number;
    readonly capture: readonly CorrectnessCapture[];
  }[];
  readonly params: Readonly<Record<string, JsonValue>>;
}

export type MetricDirection = "lower-is-better" | "higher-is-better";
export type MetricKind = "counter" | "gauge";
export type MetricUnit = "count" | "bytes" | "ns";

export interface MetricDefinition {
  readonly id: string;
  readonly label: string;
  readonly direction: MetricDirection;
  readonly kind: MetricKind;
  readonly unit: MetricUnit;
  readonly diagnostic: boolean;
}

export interface ExactMetricSampleV1 {
  readonly kind: "exact";
  readonly value: number;
  readonly unit: MetricUnit;
}

export interface SampledMetricSampleV1 {
  readonly kind: "sampled";
  /** Raw observations, kept in execution order for paired comparisons. */
  readonly samples: readonly number[];
  readonly unit: MetricUnit;
}

export type MetricSampleV1 = ExactMetricSampleV1 | SampledMetricSampleV1;

export interface ReceiptProvenanceV1 {
  readonly source: {
    readonly revision: string;
    readonly dirty: boolean;
    readonly contentHash: string;
  };
  readonly scenario: {
    readonly id: string;
    readonly suite: string;
    readonly framework: FrameworkId;
    readonly manifestHash: string;
    readonly inputTapeHash: string;
  };
  readonly toolchain: {
    readonly rustc: string;
    readonly cCompiler: string;
    readonly sysroot: string;
    readonly qemu?: string;
    readonly bun?: string;
  };
  readonly build: {
    readonly target: string;
    readonly profile: string;
    readonly rustFlags: readonly string[];
    readonly cFlags: readonly string[];
    readonly linkerFlags: readonly string[];
  };
  readonly executor: {
    readonly id: string;
    readonly version: string;
    readonly profile: string;
    readonly fingerprint: string;
  };
  readonly binary: {
    readonly sha256: string;
  };
}

export interface CorrectnessReceiptV1 {
  readonly framebufferHash: string;
  readonly drawListHash: string;
  readonly stateHash: string;
  readonly effectHash: string;
}

interface ReceiptBaseV1 {
  readonly schemaVersion: 1;
  readonly kind: "pocketjs.perf.receipt";
  readonly createdAt: string;
  readonly provenance: ReceiptProvenanceV1;
  /** Scenario-declared observations that must have an applicable budget. */
  readonly gateMetrics: readonly string[];
  /** Gate observations this executor cannot truthfully produce. */
  readonly unsupportedMetrics: readonly string[];
  readonly metrics: Readonly<Record<string, MetricSampleV1>>;
}

export interface ValidReceiptV1 extends ReceiptBaseV1 {
  readonly status: "valid";
  readonly invalidReasons: readonly [];
  readonly correctness: CorrectnessReceiptV1;
}

export interface InvalidReceiptV1 extends ReceiptBaseV1 {
  readonly status: "invalid";
  readonly invalidReasons: readonly string[];
  readonly correctness: CorrectnessReceiptV1 | null;
}

export type ReceiptV1 = ValidReceiptV1 | InvalidReceiptV1;

export interface RelativeAbsoluteThresholdV1 {
  /** Ratio rather than percentage: 0.01 means one percent. */
  readonly relative: number;
  readonly absolute: number;
}

export interface MetricBudgetV1 {
  readonly warn?: RelativeAbsoluteThresholdV1;
  readonly regression?: RelativeAbsoluteThresholdV1;
  readonly hardMax?: number;
  readonly hardMin?: number;
  /** Omitted means the budget applies to every executor. */
  readonly executors?: readonly string[];
}

export interface BudgetSetV1 {
  readonly schemaVersion: 1;
  readonly kind: "pocketjs.perf.budget-set";
  readonly id: string;
  readonly metrics: Readonly<Record<string, MetricBudgetV1>>;
  /** Exact scenario id, or the base id before a `#phase` suffix. */
  readonly scenarios?: Readonly<Record<string, Readonly<Record<string, MetricBudgetV1>>>>;
}

export type ComparisonStatus = "pass" | "warn" | "regression" | "invalid";

export interface ComparisonReasonV1 {
  readonly code:
    | "receipt-invalid"
    | "provenance-mismatch"
    | "correctness-mismatch"
    | "metric-missing"
    | "budget-missing"
    | "metric-support-mismatch"
    | "unit-mismatch"
    | "catalog-unit-mismatch"
    | "sample-kind-mismatch"
    | "sample-count-mismatch"
    | "threshold-exceeded"
    | "hard-limit-exceeded";
  readonly path: string;
  readonly message: string;
}

export interface MetricComparisonV1 {
  readonly id: string;
  readonly label: string;
  readonly direction: MetricDirection;
  readonly kind: MetricKind;
  readonly unit: MetricUnit;
  readonly status: ComparisonStatus;
  readonly baseline: number | null;
  readonly candidate: number | null;
  readonly delta: number | null;
  /** Signed candidate delta divided by abs(baseline), or null at baseline zero. */
  readonly relativeDelta: number | null;
  readonly sampleKind: "exact" | "paired";
  readonly sampleCount: number | null;
  readonly confidenceInterval: {
    readonly level: 0.95;
    readonly lower: number;
    readonly upper: number;
    readonly method: "paired-bootstrap";
    readonly seed: number;
    readonly iterations: number;
  } | null;
  readonly budget: MetricBudgetV1 | null;
  readonly reasons: readonly ComparisonReasonV1[];
}

export interface ComparisonV1 {
  readonly schemaVersion: 1;
  readonly kind: "pocketjs.perf.comparison";
  readonly status: ComparisonStatus;
  readonly comparable: boolean;
  readonly budgetId: string;
  readonly base: {
    readonly sourceRevision: string;
    readonly binarySha256: string;
  };
  readonly candidate: {
    readonly sourceRevision: string;
    readonly binarySha256: string;
  };
  /** Gates intentionally unavailable on both sides for this executor. */
  readonly unsupportedMetrics: readonly string[];
  readonly reasons: readonly ComparisonReasonV1[];
  readonly metrics: readonly MetricComparisonV1[];
}

export interface SchemaIssue {
  readonly path: string;
  readonly message: string;
}

export type SafeParseResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: SchemaValidationError };

export class SchemaValidationError extends Error {
  readonly issues: readonly SchemaIssue[];

  constructor(schema: string, issues: readonly SchemaIssue[]) {
    super(
      `${schema} validation failed: ${issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`,
    );
    this.name = "SchemaValidationError";
    this.issues = issues;
  }
}
