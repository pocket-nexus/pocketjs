import { DEFAULT_BUDGET_SET } from "./budgets.ts";
import { isMetricId, METRIC_CATALOG, METRIC_IDS, type MetricId } from "./catalog.ts";
import {
  parseBudgetSetV1,
  parseComparisonV1,
  parseReceiptV1,
} from "./schema.ts";
import type {
  BudgetSetV1,
  ComparisonReasonV1,
  ComparisonStatus,
  ComparisonV1,
  MetricBudgetV1,
  MetricComparisonV1,
  MetricDirection,
  MetricSampleV1,
  ReceiptV1,
  RelativeAbsoluteThresholdV1,
} from "./types.ts";

const BOOTSTRAP_SEED = 0x5eedc0de;
const BOOTSTRAP_ITERATIONS = 2_000;

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => valuesEqual(value, right[index]));
  }
  if (typeof left === "object" || typeof right === "object") {
    if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    return valuesEqual(leftKeys, rightKeys) && leftKeys.every((key) => valuesEqual(leftRecord[key], rightRecord[key]));
  }
  return Object.is(left, right);
}

function mismatch(
  path: string,
  left: unknown,
  right: unknown,
): ComparisonReasonV1 | null {
  if (valuesEqual(left, right)) return null;
  return {
    code: "provenance-mismatch",
    path,
    message: `baseline and candidate differ (${JSON.stringify(left)} vs ${JSON.stringify(right)})`,
  };
}

/**
 * Source revision/content and binary hash intentionally do not participate:
 * they identify the two things being compared. Everything that defines the
 * workload or execution environment must match exactly.
 */
export function provenanceMismatches(
  baseline: ReceiptV1,
  candidate: ReceiptV1,
): ComparisonReasonV1[] {
  const pairs: readonly [string, unknown, unknown][] = [
    ["/provenance/scenario/id", baseline.provenance.scenario.id, candidate.provenance.scenario.id],
    ["/provenance/scenario/suite", baseline.provenance.scenario.suite, candidate.provenance.scenario.suite],
    ["/provenance/scenario/framework", baseline.provenance.scenario.framework, candidate.provenance.scenario.framework],
    ["/provenance/scenario/manifestHash", baseline.provenance.scenario.manifestHash, candidate.provenance.scenario.manifestHash],
    ["/provenance/scenario/inputTapeHash", baseline.provenance.scenario.inputTapeHash, candidate.provenance.scenario.inputTapeHash],
    ["/provenance/toolchain", baseline.provenance.toolchain, candidate.provenance.toolchain],
    ["/provenance/build/target", baseline.provenance.build.target, candidate.provenance.build.target],
    ["/provenance/build/profile", baseline.provenance.build.profile, candidate.provenance.build.profile],
    ["/provenance/build/rustFlags", baseline.provenance.build.rustFlags, candidate.provenance.build.rustFlags],
    ["/provenance/build/cFlags", baseline.provenance.build.cFlags, candidate.provenance.build.cFlags],
    ["/provenance/build/linkerFlags", baseline.provenance.build.linkerFlags, candidate.provenance.build.linkerFlags],
    ["/provenance/executor/id", baseline.provenance.executor.id, candidate.provenance.executor.id],
    ["/provenance/executor/version", baseline.provenance.executor.version, candidate.provenance.executor.version],
    ["/provenance/executor/profile", baseline.provenance.executor.profile, candidate.provenance.executor.profile],
    ["/provenance/executor/fingerprint", baseline.provenance.executor.fingerprint, candidate.provenance.executor.fingerprint],
    ["/gateMetrics", baseline.gateMetrics, candidate.gateMetrics],
  ];
  return pairs.flatMap(([path, left, right]) => {
    const reason = mismatch(path, left, right);
    return reason ? [reason] : [];
  });
}

export function areProvenancesComparable(
  baseline: ReceiptV1,
  candidate: ReceiptV1,
): boolean {
  return provenanceMismatches(baseline, candidate).length === 0;
}

function receiptInvalidReasons(side: "baseline" | "candidate", receipt: ReceiptV1): ComparisonReasonV1[] {
  if (receipt.status === "valid") return [];
  return receipt.invalidReasons.map((reason, index) => ({
    code: "receipt-invalid",
    path: `/${side}/invalidReasons/${index}`,
    message: `${side} receipt is invalid: ${reason}`,
  }));
}

function correctnessMismatches(
  baseline: ReceiptV1,
  candidate: ReceiptV1,
): ComparisonReasonV1[] {
  if (baseline.correctness === null || candidate.correctness === null) return [];
  return (Object.keys(baseline.correctness) as (keyof typeof baseline.correctness)[])
    .flatMap((key) => baseline.correctness?.[key] === candidate.correctness?.[key]
      ? []
      : [{
          code: "correctness-mismatch" as const,
          path: `/correctness/${key}`,
          message: `${key} differs between baseline and candidate`,
        }]);
}

function metricSupportMismatches(
  baseline: ReceiptV1,
  candidate: ReceiptV1,
): ComparisonReasonV1[] {
  if (valuesEqual(baseline.unsupportedMetrics, candidate.unsupportedMetrics)) return [];
  return [{
    code: "metric-support-mismatch",
    path: "/unsupportedMetrics",
    message:
      `baseline and candidate declare different unsupported gates (` +
      `${JSON.stringify(baseline.unsupportedMetrics)} vs ${JSON.stringify(candidate.unsupportedMetrics)})`,
  }];
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function hashSeed(value: string): number {
  let result = BOOTSTRAP_SEED;
  for (let index = 0; index < value.length; index += 1) {
    result = Math.imul(result ^ value.charCodeAt(index), 16_777_619) >>> 0;
  }
  return result;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

function pairedBootstrap(
  metricId: string,
  baseline: readonly number[],
  candidate: readonly number[],
): NonNullable<MetricComparisonV1["confidenceInterval"]> {
  const deltas = candidate.map((value, index) => value - baseline[index]);
  const random = mulberry32(hashSeed(metricId));
  const estimates = new Array<number>(BOOTSTRAP_ITERATIONS);
  for (let iteration = 0; iteration < BOOTSTRAP_ITERATIONS; iteration += 1) {
    let total = 0;
    for (let sample = 0; sample < deltas.length; sample += 1) {
      total += deltas[Math.floor(random() * deltas.length)]!;
    }
    estimates[iteration] = total / deltas.length;
  }
  estimates.sort((left, right) => left - right);
  const lowerIndex = Math.floor((BOOTSTRAP_ITERATIONS - 1) * 0.025);
  const upperIndex = Math.ceil((BOOTSTRAP_ITERATIONS - 1) * 0.975);
  return {
    level: 0.95,
    lower: estimates[lowerIndex]!,
    upper: estimates[upperIndex]!,
    method: "paired-bootstrap",
    seed: hashSeed(metricId),
    iterations: BOOTSTRAP_ITERATIONS,
  };
}

function statusRank(status: ComparisonStatus): number {
  return { pass: 0, warn: 1, regression: 2, invalid: 3 }[status];
}

function worstStatus(statuses: readonly ComparisonStatus[]): ComparisonStatus {
  return statuses.reduce<ComparisonStatus>(
    (worst, status) => statusRank(status) > statusRank(worst) ? status : worst,
    "pass",
  );
}

function thresholdExceeded(
  worsening: number,
  baseline: number,
  threshold: RelativeAbsoluteThresholdV1,
): boolean {
  if (worsening <= 0) return false;
  const relativeWorsening = baseline === 0 ? Number.POSITIVE_INFINITY : worsening / Math.abs(baseline);
  return worsening > threshold.absolute && relativeWorsening > threshold.relative;
}

function thresholdReason(
  metricId: string,
  level: "warn" | "regression",
  threshold: RelativeAbsoluteThresholdV1,
): ComparisonReasonV1 {
  return {
    code: "threshold-exceeded",
    path: `/metrics/${metricId}`,
    message: `${level} threshold exceeded (relative ${threshold.relative}, absolute ${threshold.absolute})`,
  };
}

function unavailableMetric(
  metricId: MetricId,
  budget: MetricBudgetV1 | null,
  reasons: readonly ComparisonReasonV1[],
  baseline: number | null = null,
  candidate: number | null = null,
): MetricComparisonV1 {
  const definition = METRIC_CATALOG[metricId];
  return {
    id: metricId,
    label: definition.label,
    direction: definition.direction,
    kind: definition.kind,
    unit: definition.unit,
    status: "invalid",
    baseline,
    candidate,
    delta: baseline === null || candidate === null ? null : candidate - baseline,
    relativeDelta: baseline === null || candidate === null || baseline === 0
      ? null
      : (candidate - baseline) / Math.abs(baseline),
    sampleKind: "exact",
    sampleCount: null,
    confidenceInterval: null,
    budget,
    reasons,
  };
}

function samplePoint(sample: MetricSampleV1): number {
  return sample.kind === "exact" ? sample.value : mean(sample.samples);
}

function compareMetric(
  metricId: MetricId,
  baselineSample: MetricSampleV1 | undefined,
  candidateSample: MetricSampleV1 | undefined,
  budget: MetricBudgetV1 | null,
  requiredGate: boolean,
): MetricComparisonV1 {
  const definition = METRIC_CATALOG[metricId];
  const metricPath = `/metrics/${metricId}`;
  if (!baselineSample || !candidateSample) {
    const missing = !baselineSample && !candidateSample
      ? "baseline and candidate"
      : !baselineSample ? "baseline" : "candidate";
    return unavailableMetric(metricId, budget, [{
      code: "metric-missing",
      path: metricPath,
      message: `${missing} receipt is missing the metric`,
    }]);
  }
  const baseline = samplePoint(baselineSample);
  const candidate = samplePoint(candidateSample);
  if (requiredGate && budget === null) {
    return unavailableMetric(metricId, budget, [{
      code: "budget-missing",
      path: `/budgets/metrics/${metricId}`,
      message: "declared gate metric has no budget applicable to this executor and scenario",
    }], baseline, candidate);
  }
  if (baselineSample.unit !== candidateSample.unit) {
    return unavailableMetric(metricId, budget, [{
      code: "unit-mismatch",
      path: `${metricPath}/unit`,
      message: `baseline uses ${baselineSample.unit}, candidate uses ${candidateSample.unit}`,
    }], baseline, candidate);
  }
  if (baselineSample.unit !== definition.unit) {
    return unavailableMetric(metricId, budget, [{
      code: "catalog-unit-mismatch",
      path: `${metricPath}/unit`,
      message: `receipt uses ${baselineSample.unit}, catalog requires ${definition.unit}`,
    }], baseline, candidate);
  }
  if (baselineSample.kind !== candidateSample.kind) {
    return unavailableMetric(metricId, budget, [{
      code: "sample-kind-mismatch",
      path: `${metricPath}/kind`,
      message: `baseline uses ${baselineSample.kind}, candidate uses ${candidateSample.kind}`,
    }], baseline, candidate);
  }
  if (
    baselineSample.kind === "sampled" &&
    candidateSample.kind === "sampled" &&
    baselineSample.samples.length !== candidateSample.samples.length
  ) {
    return unavailableMetric(metricId, budget, [{
      code: "sample-count-mismatch",
      path: `${metricPath}/samples`,
      message: `paired samples require equal lengths (${baselineSample.samples.length} vs ${candidateSample.samples.length})`,
    }], baseline, candidate);
  }

  const delta = candidate - baseline;
  const relativeDelta = baseline === 0 ? null : delta / Math.abs(baseline);
  const worsening = definition.direction === "lower-is-better" ? delta : -delta;
  const paired = baselineSample.kind === "sampled" && candidateSample.kind === "sampled";
  const confidenceInterval = paired
    ? pairedBootstrap(metricId, baselineSample.samples, candidateSample.samples)
    : null;
  const confidentWorsening = confidenceInterval === null
    ? worsening
    : definition.direction === "lower-is-better"
      ? confidenceInterval.lower
      : -confidenceInterval.upper;
  const reasons: ComparisonReasonV1[] = [];
  let status: ComparisonStatus = "pass";

  if (budget) {
    if (budget.hardMax !== undefined && candidate > budget.hardMax) {
      status = "regression";
      reasons.push({
        code: "hard-limit-exceeded",
        path: `${metricPath}/hardMax`,
        message: `candidate ${candidate} exceeds hardMax ${budget.hardMax}`,
      });
    }
    if (budget.hardMin !== undefined && candidate < budget.hardMin) {
      status = "regression";
      reasons.push({
        code: "hard-limit-exceeded",
        path: `${metricPath}/hardMin`,
        message: `candidate ${candidate} is below hardMin ${budget.hardMin}`,
      });
    }
    if (budget.regression && thresholdExceeded(worsening, baseline, budget.regression)) {
      if (!paired || thresholdExceeded(confidentWorsening, baseline, budget.regression)) {
        status = "regression";
        reasons.push(thresholdReason(metricId, "regression", budget.regression));
      } else if (status === "pass") {
        status = "warn";
        reasons.push({
          code: "threshold-exceeded",
          path: metricPath,
          message: "regression point estimate exceeded the threshold, but the paired 95% bootstrap interval is not conclusive",
        });
      }
    } else if (status === "pass" && budget.warn && thresholdExceeded(worsening, baseline, budget.warn)) {
      status = "warn";
      reasons.push(thresholdReason(metricId, "warn", budget.warn));
    }
  }

  return {
    id: metricId,
    label: definition.label,
    direction: definition.direction,
    kind: definition.kind,
    unit: definition.unit,
    status,
    baseline,
    candidate,
    delta,
    relativeDelta,
    sampleKind: paired ? "paired" : "exact",
    sampleCount: paired ? baselineSample.samples.length : null,
    confidenceInterval,
    budget,
    reasons,
  };
}

function metricBudgetForExecutor(
  budgetSet: BudgetSetV1,
  metricId: MetricId,
  executorId: string,
  scenarioId: string,
): MetricBudgetV1 | null {
  const baseScenarioId = scenarioId.split("#", 1)[0]!;
  const layers = [
    budgetSet.metrics[metricId],
    budgetSet.scenarios?.[baseScenarioId]?.[metricId],
    baseScenarioId === scenarioId ? undefined : budgetSet.scenarios?.[scenarioId]?.[metricId],
  ].filter((budget): budget is MetricBudgetV1 =>
    budget !== undefined && (!budget.executors || budget.executors.includes(executorId)));
  if (layers.length === 0) return null;
  return Object.assign({}, ...layers) as MetricBudgetV1;
}

function hasConfiguredMetricBudget(
  budgetSet: BudgetSetV1,
  metricId: MetricId,
  scenarioId: string,
): boolean {
  const baseScenarioId = scenarioId.split("#", 1)[0]!;
  return budgetSet.metrics[metricId] !== undefined ||
    budgetSet.scenarios?.[baseScenarioId]?.[metricId] !== undefined ||
    (baseScenarioId !== scenarioId && budgetSet.scenarios?.[scenarioId]?.[metricId] !== undefined);
}

function comparisonReference(receipt: ReceiptV1): ComparisonV1["base"] {
  return {
    sourceRevision: receipt.provenance.source.revision,
    binarySha256: receipt.provenance.binary.sha256,
  };
}

export function compareReceipts(
  baselineInput: ReceiptV1,
  candidateInput: ReceiptV1,
  budgetInput: BudgetSetV1 = DEFAULT_BUDGET_SET,
): ComparisonV1 {
  const baseline = parseReceiptV1(baselineInput);
  const candidate = parseReceiptV1(candidateInput);
  const budgetSet = parseBudgetSetV1(budgetInput);
  const globalReasons = [
    ...receiptInvalidReasons("baseline", baseline),
    ...receiptInvalidReasons("candidate", candidate),
    ...provenanceMismatches(baseline, candidate),
    ...correctnessMismatches(baseline, candidate),
    ...metricSupportMismatches(baseline, candidate),
  ];
  const base = comparisonReference(baseline);
  const candidateReference = comparisonReference(candidate);

  if (globalReasons.length > 0) {
    return {
      schemaVersion: 1,
      kind: "pocketjs.perf.comparison",
      status: "invalid",
      comparable: false,
      budgetId: budgetSet.id,
      base,
      candidate: candidateReference,
      unsupportedMetrics: [],
      reasons: globalReasons,
      metrics: [],
    };
  }

  const executorId = baseline.provenance.executor.id;
  const scenarioId = baseline.provenance.scenario.id;
  const gateMetrics = baseline.gateMetrics.filter(isMetricId);
  const gateSet = new Set<MetricId>(gateMetrics);
  const declaredUnsupported = new Set(
    baseline.unsupportedMetrics.filter(isMetricId),
  );
  const unsupportedMetrics: MetricId[] = [];
  const metricIds = METRIC_IDS.filter((metricId) => {
    const present = baseline.metrics[metricId] !== undefined || candidate.metrics[metricId] !== undefined;
    return present || gateSet.has(metricId);
  });
  const metrics = metricIds.flatMap((metricId): MetricComparisonV1[] => {
    const requiredGate = gateSet.has(metricId);
    // Budgets govern any observation a subject actually emits. gateMetrics is
    // the stricter minimum-observation contract, not an allow-list that could
    // silently disable a configured budget such as instruction bytes.
    const budget = metricBudgetForExecutor(budgetSet, metricId, executorId, scenarioId);
    if (declaredUnsupported.has(metricId)) {
      if (budget === null) {
        if (!hasConfiguredMetricBudget(budgetSet, metricId, scenarioId)) {
          return [unavailableMetric(metricId, null, [{
            code: "budget-missing",
            path: `/budgets/metrics/${metricId}`,
            message: "declared gate metric has no configured budget",
          }])];
        }
        unsupportedMetrics.push(metricId);
        return [];
      }
      return [unavailableMetric(metricId, budget, [{
        code: "metric-support-mismatch",
        path: `/unsupportedMetrics/${metricId}`,
        message: "executor declares this gate unsupported, but an applicable budget requires it",
      }])];
    }
    return [compareMetric(
      metricId,
      baseline.metrics[metricId],
      candidate.metrics[metricId],
      budget,
      requiredGate,
    )];
  });
  const metricReasons = metrics.flatMap((metric) => metric.reasons);
  const status = worstStatus(metrics.map((metric) => metric.status));
  const comparable = status !== "invalid";
  return {
    schemaVersion: 1,
    kind: "pocketjs.perf.comparison",
    status,
    comparable,
    budgetId: budgetSet.id,
    base,
    candidate: candidateReference,
    unsupportedMetrics,
    reasons: metricReasons,
    metrics,
  };
}

function formatValue(value: number | null, unit: string): string {
  if (value === null) return "—";
  if (unit === "bytes") return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)} B`;
  if (unit === "ns") return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)} ns`;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function formatDelta(metric: MetricComparisonV1): string {
  if (metric.delta === null) return "—";
  const sign = metric.delta > 0 ? "+" : "";
  const relative = metric.relativeDelta === null
    ? "n/a at zero baseline"
    : `${metric.relativeDelta > 0 ? "+" : ""}${(metric.relativeDelta * 100).toFixed(2)}%`;
  return `${sign}${formatValue(metric.delta, metric.unit)} (${relative})`;
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function comparisonToJson(comparison: ComparisonV1, pretty = true): string {
  return `${JSON.stringify(parseComparisonV1(comparison), null, pretty ? 2 : undefined)}\n`;
}

export function comparisonToMarkdown(comparisonInput: ComparisonV1): string {
  const comparison = parseComparisonV1(comparisonInput);
  const lines = [
    "# PocketJS performance comparison",
    "",
    `Status: **${comparison.status}**`,
    "",
    `Baseline: \`${comparison.base.sourceRevision}\` (\`${comparison.base.binarySha256.slice(0, 12)}\`)`,
    `Candidate: \`${comparison.candidate.sourceRevision}\` (\`${comparison.candidate.binarySha256.slice(0, 12)}\`)`,
    `Budget: \`${comparison.budgetId}\``,
  ];
  if (comparison.unsupportedMetrics.length > 0) {
    lines.push(
      "",
      `Unsupported gates for this executor: ${comparison.unsupportedMetrics.map((metric) => `\`${metric}\``).join(", ")}`,
    );
  }
  if (comparison.metrics.length > 0) {
    lines.push(
      "",
      "| Metric | Baseline | Candidate | Delta | Status |",
      "| --- | ---: | ---: | ---: | --- |",
      ...comparison.metrics.map((metric) =>
        `| ${escapeCell(metric.label)} | ${formatValue(metric.baseline, metric.unit)} | ${formatValue(metric.candidate, metric.unit)} | ${formatDelta(metric)} | **${metric.status}** |`),
    );
  }
  if (comparison.reasons.length > 0) {
    lines.push(
      "",
      "## Reasons",
      "",
      ...comparison.reasons.map((reason) => `- \`${reason.code}\` at \`${reason.path}\`: ${reason.message}`),
    );
  }
  return `${lines.join("\n")}\n`;
}

export const renderComparisonJson = comparisonToJson;
export const renderComparisonMarkdown = comparisonToMarkdown;
