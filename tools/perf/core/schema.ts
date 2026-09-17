import { isMetricId, METRIC_CATALOG } from "./catalog.ts";
import { buildRenderConfig, BuildRenderConfigError } from "./render-config.ts";
import type {
  BudgetSetV1,
  ComparisonReasonV1,
  ComparisonV1,
  CorrectnessCapture,
  CorrectnessReceiptV1,
  FrameworkId,
  InputTapeV1,
  InputTrackV1,
  JsonValue,
  MetricBudgetV1,
  MetricComparisonV1,
  MetricSampleV1,
  ReceiptProvenanceV1,
  ReceiptV1,
  SafeParseResult,
  ScenarioV1,
  SchemaIssue,
} from "./types.ts";
import { SchemaValidationError } from "./types.ts";

type UnknownRecord = Record<string, unknown>;

const FRAMEWORKS = new Set<FrameworkId>([
  "solid",
  "vue-vapor",
  "octane",
  "core",
]);
const CAPTURES = new Set<CorrectnessCapture>([
  "framebuffer",
  "drawList",
  "state",
  "effects",
]);
const COMPARISON_STATUSES = new Set([
  "pass",
  "warn",
  "regression",
  "invalid",
]);
const REASON_CODES = new Set<ComparisonReasonV1["code"]>([
  "receipt-invalid",
  "provenance-mismatch",
  "correctness-mismatch",
  "metric-missing",
  "budget-missing",
  "metric-support-mismatch",
  "unit-mismatch",
  "catalog-unit-mismatch",
  "sample-kind-mismatch",
  "sample-count-mismatch",
  "threshold-exceeded",
  "hard-limit-exceeded",
]);
const SHA256 = /^[a-f0-9]{64}$/;

function pointer(parent: string, key: string | number): string {
  const encoded = String(key).replaceAll("~", "~0").replaceAll("/", "~1");
  return parent === "/" ? `/${encoded}` : `${parent}/${encoded}`;
}

function issue(issues: SchemaIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

function record(
  value: unknown,
  path: string,
  allowedKeys: readonly string[] | null,
  requiredKeys: readonly string[],
  issues: SchemaIssue[],
): UnknownRecord | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    issue(issues, path, "expected an object");
    return null;
  }
  const result = value as UnknownRecord;
  if (allowedKeys) {
    const allowed = new Set(allowedKeys);
    for (const key of Object.keys(result)) {
      if (!allowed.has(key)) issue(issues, pointer(path, key), "unexpected property");
    }
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(result, key)) issue(issues, pointer(path, key), "required property is missing");
  }
  return result;
}

function array(value: unknown, path: string, issues: SchemaIssue[]): unknown[] | null {
  if (!Array.isArray(value)) {
    issue(issues, path, "expected an array");
    return null;
  }
  return value;
}

function nonEmptyString(value: unknown, path: string, issues: SchemaIssue[]): value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    issue(issues, path, "expected a non-empty string");
    return false;
  }
  return true;
}

function literal(value: unknown, expected: string | number, path: string, issues: SchemaIssue[]): boolean {
  if (value !== expected) {
    issue(issues, path, `expected ${JSON.stringify(expected)}`);
    return false;
  }
  return true;
}

function boolean(value: unknown, path: string, issues: SchemaIssue[]): value is boolean {
  if (typeof value !== "boolean") {
    issue(issues, path, "expected a boolean");
    return false;
  }
  return true;
}

function finiteNumber(value: unknown, path: string, issues: SchemaIssue[]): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issue(issues, path, "expected a finite number");
    return false;
  }
  return true;
}

function nonNegativeNumber(value: unknown, path: string, issues: SchemaIssue[]): value is number {
  if (!finiteNumber(value, path, issues)) return false;
  if (value < 0) {
    issue(issues, path, "expected a non-negative number");
    return false;
  }
  return true;
}

function nonNegativeInteger(value: unknown, path: string, issues: SchemaIssue[]): value is number {
  if (!finiteNumber(value, path, issues)) return false;
  if (!Number.isSafeInteger(value) || value < 0) {
    issue(issues, path, "expected a non-negative safe integer");
    return false;
  }
  return true;
}

function positiveInteger(value: unknown, path: string, issues: SchemaIssue[]): value is number {
  if (!nonNegativeInteger(value, path, issues)) return false;
  if (value === 0) {
    issue(issues, path, "expected a positive integer");
    return false;
  }
  return true;
}

function stringArray(
  value: unknown,
  path: string,
  issues: SchemaIssue[],
  options: { nonEmpty?: boolean; unique?: boolean } = {},
): value is string[] {
  const values = array(value, path, issues);
  if (!values) return false;
  if (options.nonEmpty && values.length === 0) issue(issues, path, "expected at least one item");
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const itemPath = pointer(path, index);
    if (!nonEmptyString(values[index], itemPath, issues)) continue;
    const item = values[index] as string;
    if (options.unique && seen.has(item)) issue(issues, itemPath, "duplicate value");
    seen.add(item);
  }
  return true;
}

function enumString<T extends string>(
  value: unknown,
  values: ReadonlySet<T>,
  path: string,
  issues: SchemaIssue[],
): value is T {
  if (typeof value !== "string" || !values.has(value as T)) {
    issue(issues, path, `expected one of ${[...values].join(", ")}`);
    return false;
  }
  return true;
}

function sha256(value: unknown, path: string, issues: SchemaIssue[]): value is string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    issue(issues, path, "expected a lowercase SHA-256 hex digest");
    return false;
  }
  return true;
}

function jsonValue(
  value: unknown,
  path: string,
  issues: SchemaIssue[],
  ancestors: Set<object> = new Set(),
): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return finiteNumber(value, path, issues);
  if (typeof value !== "object" || value === null) {
    issue(issues, path, "expected a JSON value");
    return false;
  }
  if (ancestors.has(value)) {
    issue(issues, path, "cyclic values are not valid JSON");
    return false;
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => jsonValue(item, pointer(path, index), issues, ancestors));
    ancestors.delete(value);
    return true;
  }
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    issue(issues, path, "expected a plain JSON object");
    ancestors.delete(value);
    return false;
  }
  for (const [key, item] of Object.entries(value)) {
    jsonValue(item, pointer(path, key), issues, ancestors);
  }
  ancestors.delete(value);
  return true;
}

function validateFrame(
  value: unknown,
  frames: number | null,
  path: string,
  issues: SchemaIssue[],
): value is number {
  if (!nonNegativeInteger(value, path, issues)) return false;
  if (frames !== null && value >= frames) {
    issue(issues, path, `must be less than tape frame count ${frames}`);
    return false;
  }
  return true;
}

function validateSamples(
  value: unknown,
  path: string,
  frames: number | null,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  validateSample: (sample: UnknownRecord, samplePath: string) => void,
  issues: SchemaIssue[],
): void {
  const samples = array(value, path, issues);
  if (!samples) return;
  let previousFrame = -1;
  samples.forEach((sampleValue, index) => {
    const samplePath = pointer(path, index);
    const sample = record(sampleValue, samplePath, allowedKeys, requiredKeys, issues);
    if (!sample) return;
    if (validateFrame(sample.frame, frames, pointer(samplePath, "frame"), issues)) {
      if (sample.frame <= previousFrame) {
        issue(issues, pointer(samplePath, "frame"), "sample frames must be strictly increasing");
      }
      previousFrame = sample.frame;
    }
    validateSample(sample, samplePath);
  });
}

function validateInputTrack(
  value: unknown,
  path: string,
  frames: number | null,
  issues: SchemaIssue[],
): InputTrackV1 | null {
  const base = record(value, path, null, ["kind"], issues);
  if (!base) return null;
  if (typeof base.kind !== "string") {
    issue(issues, pointer(path, "kind"), "expected an input track kind");
    return null;
  }
  if (base.kind === "button") {
    const track = record(value, path, ["kind", "control", "samples"], ["kind", "control", "samples"], issues);
    if (!track) return null;
    nonEmptyString(track.control, pointer(path, "control"), issues);
    validateSamples(track.samples, pointer(path, "samples"), frames, ["frame", "pressed"], ["frame", "pressed"], (sample, samplePath) => {
      boolean(sample.pressed, pointer(samplePath, "pressed"), issues);
    }, issues);
    return value as InputTrackV1;
  }
  if (base.kind === "analog") {
    const track = record(value, path, ["kind", "control", "samples"], ["kind", "control", "samples"], issues);
    if (!track) return null;
    nonEmptyString(track.control, pointer(path, "control"), issues);
    validateSamples(track.samples, pointer(path, "samples"), frames, ["frame", "value"], ["frame", "value"], (sample, samplePath) => {
      if (finiteNumber(sample.value, pointer(samplePath, "value"), issues) && (sample.value < -1 || sample.value > 1)) {
        issue(issues, pointer(samplePath, "value"), "analog levels must be between -1 and 1");
      }
    }, issues);
    return value as InputTrackV1;
  }
  if (base.kind === "touch") {
    const track = record(value, path, ["kind", "control", "samples"], ["kind", "control", "samples"], issues);
    if (!track) return null;
    nonEmptyString(track.control, pointer(path, "control"), issues);
    validateSamples(track.samples, pointer(path, "samples"), frames, ["frame", "phase", "x", "y"], ["frame", "phase", "x", "y"], (sample, samplePath) => {
      enumString(sample.phase, new Set(["start", "move", "end", "cancel"] as const), pointer(samplePath, "phase"), issues);
      finiteNumber(sample.x, pointer(samplePath, "x"), issues);
      finiteNumber(sample.y, pointer(samplePath, "y"), issues);
    }, issues);
    return value as InputTrackV1;
  }
  if (base.kind === "relative-axis") {
    const track = record(value, path, ["kind", "control", "samples"], ["kind", "control", "samples"], issues);
    if (!track) return null;
    nonEmptyString(track.control, pointer(path, "control"), issues);
    validateSamples(track.samples, pointer(path, "samples"), frames, ["frame", "delta"], ["frame", "delta"], (sample, samplePath) => {
      finiteNumber(sample.delta, pointer(samplePath, "delta"), issues);
    }, issues);
    return value as InputTrackV1;
  }
  if (base.kind === "effect") {
    const track = record(value, path, ["kind", "effect", "samples"], ["kind", "effect", "samples"], issues);
    if (!track) return null;
    nonEmptyString(track.effect, pointer(path, "effect"), issues);
    validateSamples(track.samples, pointer(path, "samples"), frames, ["frame", "value"], ["frame", "value"], (sample, samplePath) => {
      jsonValue(sample.value, pointer(samplePath, "value"), issues);
    }, issues);
    return value as InputTrackV1;
  }
  issue(issues, pointer(path, "kind"), "unknown input track kind");
  return null;
}

function validateInputTape(value: unknown, path: string, issues: SchemaIssue[]): InputTapeV1 | null {
  const tape = record(
    value,
    path,
    ["schemaVersion", "kind", "id", "frames", "tracks"],
    ["schemaVersion", "kind", "id", "frames", "tracks"],
    issues,
  );
  if (!tape) return null;
  literal(tape.schemaVersion, 1, pointer(path, "schemaVersion"), issues);
  literal(tape.kind, "pocketjs.perf.input-tape", pointer(path, "kind"), issues);
  nonEmptyString(tape.id, pointer(path, "id"), issues);
  const frames = positiveInteger(tape.frames, pointer(path, "frames"), issues)
    ? tape.frames as number
    : null;
  const tracks = array(tape.tracks, pointer(path, "tracks"), issues);
  if (tracks) {
    const identities = new Set<string>();
    tracks.forEach((trackValue, index) => {
      const trackPath = pointer(pointer(path, "tracks"), index);
      const track = validateInputTrack(trackValue, trackPath, frames, issues);
      if (!track) return;
      const identity = track.kind === "effect"
        ? `${track.kind}:${track.effect}`
        : `${track.kind}:${track.control}`;
      if (identities.has(identity)) issue(issues, trackPath, `duplicate track ${identity}`);
      identities.add(identity);
    });
  }
  return value as InputTapeV1;
}

function validateScenario(value: unknown, path: string, issues: SchemaIssue[]): ScenarioV1 | null {
  const scenario = record(
    value,
    path,
    ["schemaVersion", "kind", "id", "suite", "subject", "executorRequirements", "frames", "tape", "phases", "checkpoints", "params"],
    ["schemaVersion", "kind", "id", "suite", "subject", "executorRequirements", "frames", "tape", "phases", "checkpoints", "params"],
    issues,
  );
  if (!scenario) return null;
  literal(scenario.schemaVersion, 1, pointer(path, "schemaVersion"), issues);
  literal(scenario.kind, "pocketjs.perf.scenario", pointer(path, "kind"), issues);
  nonEmptyString(scenario.id, pointer(path, "id"), issues);
  nonEmptyString(scenario.suite, pointer(path, "suite"), issues);
  const subjectPath = pointer(path, "subject");
  const subject = record(scenario.subject, subjectPath, ["id", "family", "framework", "entry"], ["id", "family", "framework", "entry"], issues);
  if (subject) {
    nonEmptyString(subject.id, pointer(subjectPath, "id"), issues);
    nonEmptyString(subject.family, pointer(subjectPath, "family"), issues);
    enumString(subject.framework, FRAMEWORKS, pointer(subjectPath, "framework"), issues);
    nonEmptyString(subject.entry, pointer(subjectPath, "entry"), issues);
  }
  stringArray(scenario.executorRequirements, pointer(path, "executorRequirements"), issues, { nonEmpty: true, unique: true });
  const frames = positiveInteger(scenario.frames, pointer(path, "frames"), issues)
    ? scenario.frames as number
    : null;
  const tape = validateInputTape(scenario.tape, pointer(path, "tape"), issues);
  if (frames !== null && tape && frames !== tape.frames) {
    issue(issues, pointer(path, "tape/frames"), "must equal the scenario frame count");
  }
  const phases = array(scenario.phases, pointer(path, "phases"), issues);
  if (phases) {
    if (phases.length === 0) issue(issues, pointer(path, "phases"), "expected at least one phase");
    const names = new Set<string>();
    let previousEnd = 0;
    phases.forEach((phaseValue, index) => {
      const phasePath = pointer(pointer(path, "phases"), index);
      const phase = record(phaseValue, phasePath, ["name", "startFrame", "endFrame", "collect"], ["name", "startFrame", "endFrame", "collect"], issues);
      if (!phase) return;
      if (nonEmptyString(phase.name, pointer(phasePath, "name"), issues)) {
        if (names.has(phase.name)) issue(issues, pointer(phasePath, "name"), "duplicate phase name");
        names.add(phase.name);
      }
      const startOk = nonNegativeInteger(phase.startFrame, pointer(phasePath, "startFrame"), issues);
      const endOk = positiveInteger(phase.endFrame, pointer(phasePath, "endFrame"), issues);
      if (startOk && endOk) {
        const start = phase.startFrame as number;
        const end = phase.endFrame as number;
        if (start >= end) issue(issues, pointer(phasePath, "endFrame"), "must be greater than startFrame");
        if (frames !== null && end > frames) issue(issues, pointer(phasePath, "endFrame"), `must not exceed scenario frame count ${frames}`);
        if (index > 0 && start < previousEnd) issue(issues, pointer(phasePath, "startFrame"), "phases must be ordered and non-overlapping");
        previousEnd = end;
      }
      boolean(phase.collect, pointer(phasePath, "collect"), issues);
    });
  }
  const checkpoints = array(scenario.checkpoints, pointer(path, "checkpoints"), issues);
  if (checkpoints) {
    let previousFrame = -1;
    checkpoints.forEach((checkpointValue, index) => {
      const checkpointPath = pointer(pointer(path, "checkpoints"), index);
      const checkpoint = record(checkpointValue, checkpointPath, ["frame", "capture"], ["frame", "capture"], issues);
      if (!checkpoint) return;
      if (validateFrame(checkpoint.frame, frames, pointer(checkpointPath, "frame"), issues)) {
        if (checkpoint.frame <= previousFrame) issue(issues, pointer(checkpointPath, "frame"), "checkpoint frames must be strictly increasing");
        previousFrame = checkpoint.frame;
      }
      const captures = array(checkpoint.capture, pointer(checkpointPath, "capture"), issues);
      if (captures) {
        if (captures.length === 0) issue(issues, pointer(checkpointPath, "capture"), "expected at least one capture");
        const seen = new Set<string>();
        captures.forEach((capture, captureIndex) => {
          const capturePath = pointer(pointer(checkpointPath, "capture"), captureIndex);
          if (enumString(capture, CAPTURES, capturePath, issues)) {
            if (seen.has(capture)) issue(issues, capturePath, "duplicate capture");
            seen.add(capture);
          }
        });
      }
    });
  }
  const params = record(scenario.params, pointer(path, "params"), null, [], issues);
  if (params) {
    for (const [key, param] of Object.entries(params)) {
      jsonValue(param, pointer(pointer(path, "params"), key), issues);
    }
    if (Object.hasOwn(params, "gateMetrics")) {
      const gatePath = pointer(pointer(path, "params"), "gateMetrics");
      const gates = array(params.gateMetrics, gatePath, issues);
      if (gates) {
        if (gates.length === 0) issue(issues, gatePath, "expected at least one gate metric");
        const seen = new Set<string>();
        gates.forEach((metric, index) => {
          const metricPath = pointer(gatePath, index);
          if (!nonEmptyString(metric, metricPath, issues)) return;
          if (!isMetricId(metric)) {
            issue(issues, metricPath, "unknown metric id");
            return;
          }
          if (seen.has(metric)) issue(issues, metricPath, "duplicate gate metric");
          seen.add(metric);
          if (METRIC_CATALOG[metric].diagnostic) {
            issue(issues, metricPath, "diagnostic metrics cannot be regression gates");
          }
        });
      }
    }
    try {
      buildRenderConfig(params);
    } catch (error) {
      if (!(error instanceof BuildRenderConfigError)) throw error;
      for (const renderIssue of error.issues) {
        const renderPath = renderIssue.path.reduce(
          (current, key) => pointer(current, key),
          pointer(path, "params"),
        );
        issue(issues, renderPath, renderIssue.message);
      }
    }
  }
  return value as ScenarioV1;
}

function validateStringRecord(
  value: unknown,
  path: string,
  allowed: readonly string[],
  required: readonly string[],
  issues: SchemaIssue[],
): UnknownRecord | null {
  const result = record(value, path, allowed, required, issues);
  if (!result) return null;
  for (const key of Object.keys(result)) nonEmptyString(result[key], pointer(path, key), issues);
  return result;
}

function validateProvenance(value: unknown, path: string, issues: SchemaIssue[]): ReceiptProvenanceV1 | null {
  const provenance = record(value, path, ["source", "scenario", "toolchain", "build", "executor", "binary"], ["source", "scenario", "toolchain", "build", "executor", "binary"], issues);
  if (!provenance) return null;
  const sourcePath = pointer(path, "source");
  const source = record(provenance.source, sourcePath, ["revision", "dirty", "contentHash"], ["revision", "dirty", "contentHash"], issues);
  if (source) {
    nonEmptyString(source.revision, pointer(sourcePath, "revision"), issues);
    boolean(source.dirty, pointer(sourcePath, "dirty"), issues);
    sha256(source.contentHash, pointer(sourcePath, "contentHash"), issues);
  }
  const scenarioPath = pointer(path, "scenario");
  const scenario = record(provenance.scenario, scenarioPath, ["id", "suite", "framework", "manifestHash", "inputTapeHash"], ["id", "suite", "framework", "manifestHash", "inputTapeHash"], issues);
  if (scenario) {
    nonEmptyString(scenario.id, pointer(scenarioPath, "id"), issues);
    nonEmptyString(scenario.suite, pointer(scenarioPath, "suite"), issues);
    enumString(scenario.framework, FRAMEWORKS, pointer(scenarioPath, "framework"), issues);
    sha256(scenario.manifestHash, pointer(scenarioPath, "manifestHash"), issues);
    sha256(scenario.inputTapeHash, pointer(scenarioPath, "inputTapeHash"), issues);
  }
  const toolchainPath = pointer(path, "toolchain");
  validateStringRecord(
    provenance.toolchain,
    toolchainPath,
    ["rustc", "cCompiler", "sysroot", "qemu", "bun"],
    ["rustc", "cCompiler", "sysroot"],
    issues,
  );
  const buildPath = pointer(path, "build");
  const build = record(provenance.build, buildPath, ["target", "profile", "rustFlags", "cFlags", "linkerFlags"], ["target", "profile", "rustFlags", "cFlags", "linkerFlags"], issues);
  if (build) {
    nonEmptyString(build.target, pointer(buildPath, "target"), issues);
    nonEmptyString(build.profile, pointer(buildPath, "profile"), issues);
    stringArray(build.rustFlags, pointer(buildPath, "rustFlags"), issues);
    stringArray(build.cFlags, pointer(buildPath, "cFlags"), issues);
    stringArray(build.linkerFlags, pointer(buildPath, "linkerFlags"), issues);
  }
  const executorPath = pointer(path, "executor");
  validateStringRecord(provenance.executor, executorPath, ["id", "version", "profile", "fingerprint"], ["id", "version", "profile", "fingerprint"], issues);
  if (typeof provenance.executor === "object" && provenance.executor !== null) {
    sha256((provenance.executor as UnknownRecord).fingerprint, pointer(executorPath, "fingerprint"), issues);
  }
  const binaryPath = pointer(path, "binary");
  const binary = record(provenance.binary, binaryPath, ["sha256"], ["sha256"], issues);
  if (binary) sha256(binary.sha256, pointer(binaryPath, "sha256"), issues);
  return value as ReceiptProvenanceV1;
}

function validateCorrectness(value: unknown, path: string, issues: SchemaIssue[]): CorrectnessReceiptV1 | null {
  const correctness = record(value, path, ["framebufferHash", "drawListHash", "stateHash", "effectHash"], ["framebufferHash", "drawListHash", "stateHash", "effectHash"], issues);
  if (!correctness) return null;
  for (const key of ["framebufferHash", "drawListHash", "stateHash", "effectHash"] as const) {
    sha256(correctness[key], pointer(path, key), issues);
  }
  return value as CorrectnessReceiptV1;
}

function validateMetrics(value: unknown, path: string, issues: SchemaIssue[]): Record<string, MetricSampleV1> | null {
  const metrics = record(value, path, null, [], issues);
  if (!metrics) return null;
  for (const [metricId, sampleValue] of Object.entries(metrics)) {
    const samplePath = pointer(path, metricId);
    if (!isMetricId(metricId)) issue(issues, samplePath, "unknown metric id");
    const base = record(sampleValue, samplePath, null, ["kind", "unit"], issues);
    if (!base) continue;
    enumString(base.unit, new Set(["count", "bytes", "ns"] as const), pointer(samplePath, "unit"), issues);
    if (base.kind === "exact") {
      const sample = record(sampleValue, samplePath, ["kind", "value", "unit"], ["kind", "value", "unit"], issues);
      if (sample) nonNegativeInteger(sample.value, pointer(samplePath, "value"), issues);
    } else if (base.kind === "sampled") {
      const sample = record(sampleValue, samplePath, ["kind", "samples", "unit"], ["kind", "samples", "unit"], issues);
      if (sample) {
        const samples = array(sample.samples, pointer(samplePath, "samples"), issues);
        if (samples) {
          if (samples.length === 0) issue(issues, pointer(samplePath, "samples"), "expected at least one observation");
          samples.forEach((observation, index) => nonNegativeInteger(observation, pointer(pointer(samplePath, "samples"), index), issues));
        }
      }
    } else {
      issue(issues, pointer(samplePath, "kind"), "expected exact or sampled");
    }
  }
  return value as Record<string, MetricSampleV1>;
}

function validateReceipt(value: unknown, path: string, issues: SchemaIssue[]): ReceiptV1 | null {
  const receipt = record(value, path, ["schemaVersion", "kind", "createdAt", "status", "invalidReasons", "provenance", "correctness", "gateMetrics", "unsupportedMetrics", "metrics"], ["schemaVersion", "kind", "createdAt", "status", "invalidReasons", "provenance", "correctness", "gateMetrics", "unsupportedMetrics", "metrics"], issues);
  if (!receipt) return null;
  literal(receipt.schemaVersion, 1, pointer(path, "schemaVersion"), issues);
  literal(receipt.kind, "pocketjs.perf.receipt", pointer(path, "kind"), issues);
  if (nonEmptyString(receipt.createdAt, pointer(path, "createdAt"), issues)) {
    const date = new Date(receipt.createdAt);
    if (!Number.isFinite(date.valueOf()) || date.toISOString() !== receipt.createdAt) {
      issue(issues, pointer(path, "createdAt"), "expected an ISO 8601 UTC timestamp");
    }
  }
  if (receipt.status !== "valid" && receipt.status !== "invalid") {
    issue(issues, pointer(path, "status"), "expected valid or invalid");
  }
  const reasons = array(receipt.invalidReasons, pointer(path, "invalidReasons"), issues);
  if (reasons) reasons.forEach((reason, index) => nonEmptyString(reason, pointer(pointer(path, "invalidReasons"), index), issues));
  validateProvenance(receipt.provenance, pointer(path, "provenance"), issues);
  const gatePath = pointer(path, "gateMetrics");
  const gates = array(receipt.gateMetrics, gatePath, issues);
  const gateIds = new Set<string>();
  const gateIndexes = new Map<string, number>();
  if (gates) gates.forEach((metric, index) => {
    const metricPath = pointer(gatePath, index);
    if (!nonEmptyString(metric, metricPath, issues)) return;
    if (!isMetricId(metric)) {
      issue(issues, metricPath, "unknown metric id");
      return;
    }
    if (gateIds.has(metric)) issue(issues, metricPath, "duplicate gate metric");
    gateIds.add(metric);
    if (!gateIndexes.has(metric)) gateIndexes.set(metric, index);
    if (METRIC_CATALOG[metric].diagnostic) {
      issue(issues, metricPath, "diagnostic metrics cannot be regression gates");
    }
  });
  const unsupportedPath = pointer(path, "unsupportedMetrics");
  const unsupported = array(receipt.unsupportedMetrics, unsupportedPath, issues);
  const unsupportedIds = new Set<string>();
  const unsupportedIndexes = new Map<string, number>();
  if (unsupported) unsupported.forEach((metric, index) => {
    const metricPath = pointer(unsupportedPath, index);
    if (!nonEmptyString(metric, metricPath, issues)) return;
    if (!isMetricId(metric)) {
      issue(issues, metricPath, "unknown metric id");
      return;
    }
    if (unsupportedIds.has(metric)) issue(issues, metricPath, "duplicate unsupported metric");
    unsupportedIds.add(metric);
    if (!unsupportedIndexes.has(metric)) unsupportedIndexes.set(metric, index);
  });
  const metrics = validateMetrics(receipt.metrics, pointer(path, "metrics"), issues);
  if (receipt.status === "valid") {
    if (reasons && reasons.length !== 0) issue(issues, pointer(path, "invalidReasons"), "must be empty for a valid receipt");
    validateCorrectness(receipt.correctness, pointer(path, "correctness"), issues);
    if (metrics && Object.keys(metrics).length === 0) issue(issues, pointer(path, "metrics"), "a valid receipt must contain metrics");
    if (metrics && gates) {
      for (const metric of unsupportedIds) {
        if (!gateIds.has(metric)) {
          issue(
            issues,
            pointer(unsupportedPath, unsupportedIndexes.get(metric)!),
            "must also be declared in gateMetrics",
          );
        }
      }
      for (const metric of gateIds) {
        const observed = Object.hasOwn(metrics, metric);
        const unsupportedByExecutor = unsupportedIds.has(metric);
        if (observed && unsupportedByExecutor) {
          issue(
            issues,
            pointer(unsupportedPath, unsupportedIndexes.get(metric)!),
            "a gate metric cannot be both observed and unsupported",
          );
        } else if (!observed && !unsupportedByExecutor) {
          issue(
            issues,
            pointer(gatePath, gateIndexes.get(metric)!),
            "gate metric is neither observed nor explicitly unsupported",
          );
        }
      }
    }
  } else if (receipt.status === "invalid") {
    if (reasons && reasons.length === 0) issue(issues, pointer(path, "invalidReasons"), "must contain a reason for an invalid receipt");
    if (receipt.correctness !== null) validateCorrectness(receipt.correctness, pointer(path, "correctness"), issues);
  }
  return value as ReceiptV1;
}

function validateThreshold(value: unknown, path: string, issues: SchemaIssue[]): void {
  const threshold = record(value, path, ["relative", "absolute"], ["relative", "absolute"], issues);
  if (!threshold) return;
  nonNegativeNumber(threshold.relative, pointer(path, "relative"), issues);
  nonNegativeNumber(threshold.absolute, pointer(path, "absolute"), issues);
}

function validateMetricBudget(value: unknown, path: string, issues: SchemaIssue[]): MetricBudgetV1 | null {
  const budget = record(value, path, ["warn", "regression", "hardMax", "hardMin", "executors"], [], issues);
  if (!budget) return null;
  if (!["warn", "regression", "hardMax", "hardMin"].some((key) => Object.hasOwn(budget, key))) {
    issue(issues, path, "expected at least one threshold or hard limit");
  }
  if (Object.hasOwn(budget, "warn")) validateThreshold(budget.warn, pointer(path, "warn"), issues);
  if (Object.hasOwn(budget, "regression")) validateThreshold(budget.regression, pointer(path, "regression"), issues);
  if (Object.hasOwn(budget, "hardMax")) nonNegativeNumber(budget.hardMax, pointer(path, "hardMax"), issues);
  if (Object.hasOwn(budget, "hardMin")) nonNegativeNumber(budget.hardMin, pointer(path, "hardMin"), issues);
  if (Object.hasOwn(budget, "executors")) stringArray(budget.executors, pointer(path, "executors"), issues, { nonEmpty: true, unique: true });
  if (typeof budget.hardMin === "number" && typeof budget.hardMax === "number" && budget.hardMin > budget.hardMax) {
    issue(issues, path, "hardMin must not exceed hardMax");
  }
  const warn = budget.warn as UnknownRecord | undefined;
  const regression = budget.regression as UnknownRecord | undefined;
  if (warn && regression) {
    if (typeof warn.relative === "number" && typeof regression.relative === "number" && regression.relative < warn.relative) {
      issue(issues, pointer(path, "regression/relative"), "must be greater than or equal to warn.relative");
    }
    if (typeof warn.absolute === "number" && typeof regression.absolute === "number" && regression.absolute < warn.absolute) {
      issue(issues, pointer(path, "regression/absolute"), "must be greater than or equal to warn.absolute");
    }
  }
  return value as MetricBudgetV1;
}

function validateBudgetMetricId(metricId: string, path: string, issues: SchemaIssue[]): void {
  if (!isMetricId(metricId)) {
    issue(issues, path, "unknown metric id");
    return;
  }
  if (METRIC_CATALOG[metricId].diagnostic) {
    issue(issues, path, "diagnostic metrics cannot have regression budgets");
  }
}

function validateBudgetSet(value: unknown, path: string, issues: SchemaIssue[]): BudgetSetV1 | null {
  const budgetSet = record(value, path, ["schemaVersion", "kind", "id", "metrics", "scenarios"], ["schemaVersion", "kind", "id", "metrics"], issues);
  if (!budgetSet) return null;
  literal(budgetSet.schemaVersion, 1, pointer(path, "schemaVersion"), issues);
  literal(budgetSet.kind, "pocketjs.perf.budget-set", pointer(path, "kind"), issues);
  nonEmptyString(budgetSet.id, pointer(path, "id"), issues);
  const metrics = record(budgetSet.metrics, pointer(path, "metrics"), null, [], issues);
  if (metrics) {
    if (Object.keys(metrics).length === 0) issue(issues, pointer(path, "metrics"), "expected at least one metric budget");
    for (const [metricId, metricBudget] of Object.entries(metrics)) {
      const metricPath = pointer(pointer(path, "metrics"), metricId);
      validateBudgetMetricId(metricId, metricPath, issues);
      validateMetricBudget(metricBudget, metricPath, issues);
    }
  }
  if (Object.hasOwn(budgetSet, "scenarios")) {
    const scenarios = record(budgetSet.scenarios, pointer(path, "scenarios"), null, [], issues);
    if (scenarios) {
      for (const [scenarioId, scenarioMetricsValue] of Object.entries(scenarios)) {
        const scenarioPath = pointer(pointer(path, "scenarios"), scenarioId);
        nonEmptyString(scenarioId, scenarioPath, issues);
        const scenarioMetrics = record(scenarioMetricsValue, scenarioPath, null, [], issues);
        if (!scenarioMetrics) continue;
        if (Object.keys(scenarioMetrics).length === 0) {
          issue(issues, scenarioPath, "expected at least one metric budget");
        }
        for (const [metricId, metricBudget] of Object.entries(scenarioMetrics)) {
          const metricPath = pointer(scenarioPath, metricId);
          validateBudgetMetricId(metricId, metricPath, issues);
          validateMetricBudget(metricBudget, metricPath, issues);
        }
      }
    }
  }
  return value as BudgetSetV1;
}

function validateReason(value: unknown, path: string, issues: SchemaIssue[]): void {
  const reason = record(value, path, ["code", "path", "message"], ["code", "path", "message"], issues);
  if (!reason) return;
  enumString(reason.code, REASON_CODES, pointer(path, "code"), issues);
  nonEmptyString(reason.path, pointer(path, "path"), issues);
  nonEmptyString(reason.message, pointer(path, "message"), issues);
}

function validateComparison(value: unknown, path: string, issues: SchemaIssue[]): ComparisonV1 | null {
  const comparison = record(value, path, ["schemaVersion", "kind", "status", "comparable", "budgetId", "base", "candidate", "unsupportedMetrics", "reasons", "metrics"], ["schemaVersion", "kind", "status", "comparable", "budgetId", "base", "candidate", "unsupportedMetrics", "reasons", "metrics"], issues);
  if (!comparison) return null;
  literal(comparison.schemaVersion, 1, pointer(path, "schemaVersion"), issues);
  literal(comparison.kind, "pocketjs.perf.comparison", pointer(path, "kind"), issues);
  enumString(comparison.status, COMPARISON_STATUSES, pointer(path, "status"), issues);
  boolean(comparison.comparable, pointer(path, "comparable"), issues);
  nonEmptyString(comparison.budgetId, pointer(path, "budgetId"), issues);
  for (const side of ["base", "candidate"] as const) {
    const sidePath = pointer(path, side);
    const reference = record(comparison[side], sidePath, ["sourceRevision", "binarySha256"], ["sourceRevision", "binarySha256"], issues);
    if (reference) {
      nonEmptyString(reference.sourceRevision, pointer(sidePath, "sourceRevision"), issues);
      sha256(reference.binarySha256, pointer(sidePath, "binarySha256"), issues);
    }
  }
  const unsupportedMetrics = array(comparison.unsupportedMetrics, pointer(path, "unsupportedMetrics"), issues);
  if (unsupportedMetrics) {
    const seen = new Set<string>();
    unsupportedMetrics.forEach((metric, index) => {
      const metricPath = pointer(pointer(path, "unsupportedMetrics"), index);
      if (!nonEmptyString(metric, metricPath, issues)) return;
      if (!isMetricId(metric)) issue(issues, metricPath, "unknown metric id");
      if (seen.has(metric)) issue(issues, metricPath, "duplicate unsupported metric");
      seen.add(metric);
    });
  }
  const reasons = array(comparison.reasons, pointer(path, "reasons"), issues);
  if (reasons) reasons.forEach((reason, index) => validateReason(reason, pointer(pointer(path, "reasons"), index), issues));
  const metrics = array(comparison.metrics, pointer(path, "metrics"), issues);
  const seenMetricIds = new Set<string>();
  if (metrics) metrics.forEach((metricValue, index) => {
    const metricPath = pointer(pointer(path, "metrics"), index);
    const metric = record(metricValue, metricPath, ["id", "label", "direction", "kind", "unit", "status", "baseline", "candidate", "delta", "relativeDelta", "sampleKind", "sampleCount", "confidenceInterval", "budget", "reasons"], ["id", "label", "direction", "kind", "unit", "status", "baseline", "candidate", "delta", "relativeDelta", "sampleKind", "sampleCount", "confidenceInterval", "budget", "reasons"], issues);
    if (!metric) return;
    if (nonEmptyString(metric.id, pointer(metricPath, "id"), issues)) {
      if (!isMetricId(metric.id)) {
        issue(issues, pointer(metricPath, "id"), "unknown metric id");
      } else {
        if (seenMetricIds.has(metric.id)) issue(issues, pointer(metricPath, "id"), "duplicate metric id");
        seenMetricIds.add(metric.id);
        const definition = METRIC_CATALOG[metric.id];
        if (metric.label !== definition.label) issue(issues, pointer(metricPath, "label"), "must match the metric catalog");
        if (metric.direction !== definition.direction) issue(issues, pointer(metricPath, "direction"), "must match the metric catalog");
        if (metric.kind !== definition.kind) issue(issues, pointer(metricPath, "kind"), "must match the metric catalog");
        if (metric.unit !== definition.unit) issue(issues, pointer(metricPath, "unit"), "must match the metric catalog");
      }
    }
    nonEmptyString(metric.label, pointer(metricPath, "label"), issues);
    enumString(metric.direction, new Set(["lower-is-better", "higher-is-better"] as const), pointer(metricPath, "direction"), issues);
    enumString(metric.kind, new Set(["counter", "gauge"] as const), pointer(metricPath, "kind"), issues);
    enumString(metric.unit, new Set(["count", "bytes", "ns"] as const), pointer(metricPath, "unit"), issues);
    enumString(metric.status, COMPARISON_STATUSES, pointer(metricPath, "status"), issues);
    for (const key of ["baseline", "candidate", "delta", "relativeDelta"] as const) {
      if (metric[key] !== null) finiteNumber(metric[key], pointer(metricPath, key), issues);
    }
    enumString(metric.sampleKind, new Set(["exact", "paired"] as const), pointer(metricPath, "sampleKind"), issues);
    if (metric.sampleCount !== null) positiveInteger(metric.sampleCount, pointer(metricPath, "sampleCount"), issues);
    if (metric.confidenceInterval !== null) {
      const intervalPath = pointer(metricPath, "confidenceInterval");
      const interval = record(metric.confidenceInterval, intervalPath, ["level", "lower", "upper", "method", "seed", "iterations"], ["level", "lower", "upper", "method", "seed", "iterations"], issues);
      if (interval) {
        literal(interval.level, 0.95, pointer(intervalPath, "level"), issues);
        finiteNumber(interval.lower, pointer(intervalPath, "lower"), issues);
        finiteNumber(interval.upper, pointer(intervalPath, "upper"), issues);
        literal(interval.method, "paired-bootstrap", pointer(intervalPath, "method"), issues);
        nonNegativeInteger(interval.seed, pointer(intervalPath, "seed"), issues);
        positiveInteger(interval.iterations, pointer(intervalPath, "iterations"), issues);
        if (typeof interval.lower === "number" && typeof interval.upper === "number" && interval.lower > interval.upper) {
          issue(issues, intervalPath, "lower must not exceed upper");
        }
      }
    }
    if (metric.sampleKind === "exact" && (metric.sampleCount !== null || metric.confidenceInterval !== null)) {
      issue(issues, metricPath, "exact comparisons must not contain sample metadata");
    }
    if (metric.sampleKind === "paired" && (metric.sampleCount === null || metric.confidenceInterval === null)) {
      issue(issues, metricPath, "paired comparisons require sampleCount and confidenceInterval");
    }
    if (metric.budget !== null) validateMetricBudget(metric.budget, pointer(metricPath, "budget"), issues);
    const metricReasons = array(metric.reasons, pointer(metricPath, "reasons"), issues);
    if (metricReasons) {
      metricReasons.forEach((reason, reasonIndex) => validateReason(reason, pointer(pointer(metricPath, "reasons"), reasonIndex), issues));
      if (metric.status === "pass" && metricReasons.length > 0) issue(issues, pointer(metricPath, "reasons"), "pass metrics must not contain reasons");
      if (metric.status !== "pass" && metricReasons.length === 0) issue(issues, pointer(metricPath, "reasons"), "non-pass metrics must contain a reason");
    }
  });
  if (comparison.status === "invalid" && comparison.comparable !== false) {
    issue(issues, pointer(path, "comparable"), "must be false when status is invalid");
  }
  if (comparison.status !== "invalid" && comparison.comparable !== true) {
    issue(issues, pointer(path, "comparable"), "must be true when status is not invalid");
  }
  if (comparison.status === "invalid" && reasons && reasons.length === 0) {
    issue(issues, pointer(path, "reasons"), "invalid comparisons must contain a reason");
  }
  return value as ComparisonV1;
}

function parse<T>(schema: string, value: unknown, validator: (value: unknown, path: string, issues: SchemaIssue[]) => T | null): T {
  const issues: SchemaIssue[] = [];
  const result = validator(value, "/", issues);
  if (!result || issues.length > 0) throw new SchemaValidationError(schema, issues);
  return result;
}

function safeParse<T>(parser: (value: unknown) => T, value: unknown): SafeParseResult<T> {
  try {
    return { success: true, data: parser(value) };
  } catch (error) {
    if (error instanceof SchemaValidationError) return { success: false, error };
    throw error;
  }
}

export function parseInputTapeV1(value: unknown): InputTapeV1 {
  return parse("InputTapeV1", value, validateInputTape);
}

export function safeParseInputTapeV1(value: unknown): SafeParseResult<InputTapeV1> {
  return safeParse(parseInputTapeV1, value);
}

export function assertInputTapeV1(value: unknown): asserts value is InputTapeV1 {
  parseInputTapeV1(value);
}

export function parseScenarioV1(value: unknown): ScenarioV1 {
  return parse("ScenarioV1", value, validateScenario);
}

export function safeParseScenarioV1(value: unknown): SafeParseResult<ScenarioV1> {
  return safeParse(parseScenarioV1, value);
}

export function assertScenarioV1(value: unknown): asserts value is ScenarioV1 {
  parseScenarioV1(value);
}

export function parseReceiptV1(value: unknown): ReceiptV1 {
  return parse("ReceiptV1", value, validateReceipt);
}

export function safeParseReceiptV1(value: unknown): SafeParseResult<ReceiptV1> {
  return safeParse(parseReceiptV1, value);
}

export function assertReceiptV1(value: unknown): asserts value is ReceiptV1 {
  parseReceiptV1(value);
}

export function parseBudgetSetV1(value: unknown): BudgetSetV1 {
  return parse("BudgetSetV1", value, validateBudgetSet);
}

export function safeParseBudgetSetV1(value: unknown): SafeParseResult<BudgetSetV1> {
  return safeParse(parseBudgetSetV1, value);
}

export function assertBudgetSetV1(value: unknown): asserts value is BudgetSetV1 {
  parseBudgetSetV1(value);
}

export function parseComparisonV1(value: unknown): ComparisonV1 {
  return parse("ComparisonV1", value, validateComparison);
}

export function safeParseComparisonV1(value: unknown): SafeParseResult<ComparisonV1> {
  return safeParse(parseComparisonV1, value);
}

export function assertComparisonV1(value: unknown): asserts value is ComparisonV1 {
  parseComparisonV1(value);
}

// Unversioned aliases always point at the current wire format.
export const parseInputTape = parseInputTapeV1;
export const parseScenario = parseScenarioV1;
export const parseReceipt = parseReceiptV1;
export const parseBudgetSet = parseBudgetSetV1;
export const parseComparison = parseComparisonV1;

export function expectedMetricUnit(metricId: string): string | undefined {
  return isMetricId(metricId) ? METRIC_CATALOG[metricId].unit : undefined;
}
