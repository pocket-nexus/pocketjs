import type { NativeRunResult } from "../runner/native.ts";
import { isMetricId } from "../core/catalog.ts";

export const NATIVE_RUN_OUTPUT_PREFIX = "POCKETJS_PERF_NATIVE ";

type PlainRecord = Record<string, unknown>;

export type NativeResultParseResult =
  | { readonly success: true; readonly data: NativeRunResult }
  | { readonly success: false; readonly reasons: readonly string[] };

const SHA256 = /^[a-f0-9]{64}$/;
const FNV1A64 = /^fnv1a64:[a-f0-9]{16}$/;

function isRecord(value: unknown): value is PlainRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function keys(
  value: unknown,
  path: string,
  required: readonly string[],
  reasons: string[],
): PlainRecord | null {
  if (!isRecord(value)) {
    reasons.push(`${path} must be an object`);
    return null;
  }
  const allowed = new Set(required);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) reasons.push(`${path}.${key} is unknown`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) reasons.push(`${path}.${key} is missing`);
  }
  return value;
}

function string(value: unknown, path: string, reasons: string[]): value is string {
  if (typeof value === "string" && value.trim().length > 0) return true;
  reasons.push(`${path} must be a non-empty string`);
  return false;
}

function uint(value: unknown, path: string, reasons: string[]): value is number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return true;
  reasons.push(`${path} must be a non-negative safe integer`);
  return false;
}

function hash(value: unknown, path: string, reasons: string[]): value is string {
  if (typeof value === "string" && SHA256.test(value)) return true;
  reasons.push(`${path} must be a lowercase SHA-256 digest`);
  return false;
}

function drawHash(value: unknown, path: string, reasons: string[]): value is string {
  if (typeof value === "string" && FNV1A64.test(value)) return true;
  reasons.push(`${path} must be a lowercase FNV-1a-64 digest`);
  return false;
}

function validateMetricMap(
  value: unknown,
  path: string,
  units: ReadonlySet<string>,
  reasons: string[],
): void {
  if (!isRecord(value)) {
    reasons.push(`${path} must be an object`);
    return;
  }
  for (const [id, sampleValue] of Object.entries(value)) {
    const sample = keys(sampleValue, `${path}.${id}`, ["value", "unit"], reasons);
    if (!sample) continue;
    uint(sample.value, `${path}.${id}.value`, reasons);
    if (typeof sample.unit !== "string" || !units.has(sample.unit)) {
      reasons.push(`${path}.${id}.unit is invalid`);
    }
  }
}

/** Validate the native runner's JSON result before trusting any metric or hash. */
export function parseNativeResult(value: unknown): NativeResultParseResult {
  const reasons: string[] = [];
  if (!isRecord(value)) return { success: false, reasons: ["native result must be an object"] };

  if (value.status === "unsupported") {
    const result = keys(value, "native", [
      "schemaVersion", "kind", "status", "scenarioId", "executor", "reasons",
    ], reasons);
    if (!result) return { success: false, reasons };
    if (result.schemaVersion !== 1) reasons.push("native.schemaVersion must be 1");
    if (result.kind !== "pocketjs.perf.native-result") reasons.push("native.kind is invalid");
    if (result.executor !== "native") reasons.push("native.executor must be native");
    string(result.scenarioId, "native.scenarioId", reasons);
    if (!Array.isArray(result.reasons) || result.reasons.length === 0) {
      reasons.push("native.reasons must be a non-empty array");
    } else {
      result.reasons.forEach((reason, index) => string(reason, `native.reasons[${index}]`, reasons));
    }
  } else if (value.status === "ok") {
    const result = keys(value, "native", [
      "schemaVersion", "kind", "status", "scenarioId", "executor", "sourceRoot",
      "correctness", "measurement", "diagnosticMetrics", "exactMetrics",
      "unsupportedMetrics",
    ], reasons);
    if (!result) return { success: false, reasons };
    if (result.schemaVersion !== 1) reasons.push("native.schemaVersion must be 1");
    if (result.kind !== "pocketjs.perf.native-result") reasons.push("native.kind is invalid");
    if (result.executor !== "native") reasons.push("native.executor must be native");
    string(result.scenarioId, "native.scenarioId", reasons);
    string(result.sourceRoot, "native.sourceRoot", reasons);

    const correctness = keys(result.correctness, "native.correctness", [
      "framebufferTraceHash", "finalFramebufferHash", "drawListHash", "stateHash", "effectHash",
      "checkpoints",
    ], reasons);
    if (correctness) {
      hash(correctness.framebufferTraceHash, "native.correctness.framebufferTraceHash", reasons);
      hash(correctness.finalFramebufferHash, "native.correctness.finalFramebufferHash", reasons);
      drawHash(correctness.drawListHash, "native.correctness.drawListHash", reasons);
      hash(correctness.stateHash, "native.correctness.stateHash", reasons);
      hash(correctness.effectHash, "native.correctness.effectHash", reasons);
      if (!isRecord(correctness.checkpoints)) {
        reasons.push("native.correctness.checkpoints must be an object");
      } else {
        for (const [frame, captureValue] of Object.entries(correctness.checkpoints)) {
          if (!/^(0|[1-9][0-9]*)$/.test(frame)) {
            reasons.push(`native.correctness.checkpoints.${frame} has an invalid frame key`);
          }
          if (!isRecord(captureValue)) {
            reasons.push(`native.correctness.checkpoints.${frame} must be an object`);
            continue;
          }
          for (const [capture, digest] of Object.entries(captureValue)) {
            if (!["framebuffer", "drawList", "state", "effects"].includes(capture)) {
              reasons.push(`native.correctness.checkpoints.${frame}.${capture} is unknown`);
            }
            if (capture === "drawList") {
              drawHash(digest, `native.correctness.checkpoints.${frame}.${capture}`, reasons);
            } else {
              hash(digest, `native.correctness.checkpoints.${frame}.${capture}`, reasons);
            }
          }
        }
      }
    }

    const measurement = keys(result.measurement, "native.measurement", [
      "bootWallTimeNs", "phases", "finalFramebufferHash", "finalDrawListHash",
    ], reasons);
    if (measurement) {
      uint(measurement.bootWallTimeNs, "native.measurement.bootWallTimeNs", reasons);
      hash(measurement.finalFramebufferHash, "native.measurement.finalFramebufferHash", reasons);
      drawHash(measurement.finalDrawListHash, "native.measurement.finalDrawListHash", reasons);
      if (!Array.isArray(measurement.phases)) {
        reasons.push("native.measurement.phases must be an array");
      } else {
        const names = new Set<string>();
        for (const [index, phaseValue] of measurement.phases.entries()) {
          const path = `native.measurement.phases[${index}]`;
          const phase = keys(phaseValue, path, ["name", "startFrame", "endFrame", "wallTimeNs"], reasons);
          if (!phase) continue;
          if (string(phase.name, `${path}.name`, reasons)) {
            if (names.has(phase.name)) reasons.push(`${path}.name is duplicated`);
            names.add(phase.name);
          }
          const start = phase.startFrame;
          const end = phase.endFrame;
          const startOk = uint(start, `${path}.startFrame`, reasons);
          const endOk = uint(end, `${path}.endFrame`, reasons);
          uint(phase.wallTimeNs, `${path}.wallTimeNs`, reasons);
          if (startOk && endOk && end <= start) {
            reasons.push(`${path}.endFrame must be greater than startFrame`);
          }
        }
      }
    }

    validateMetricMap(result.diagnosticMetrics, "native.diagnosticMetrics", new Set(["ns", "count"]), reasons);
    validateMetricMap(result.exactMetrics, "native.exactMetrics", new Set(["bytes"]), reasons);
    if (!Array.isArray(result.unsupportedMetrics)) {
      reasons.push("native.unsupportedMetrics must be an array");
    } else {
      const seen = new Set<string>();
      for (const [index, metric] of result.unsupportedMetrics.entries()) {
        if (string(metric, `native.unsupportedMetrics[${index}]`, reasons)) {
          if (!isMetricId(metric)) reasons.push(`native.unsupportedMetrics[${index}] is not a catalog metric`);
          if (seen.has(metric)) reasons.push(`native.unsupportedMetrics[${index}] is duplicated`);
          seen.add(metric);
        }
      }
    }
  } else {
    reasons.push("native.status must be ok or unsupported");
  }

  if (reasons.length > 0) return { success: false, reasons: [...new Set(reasons)] };
  return { success: true, data: value as unknown as NativeRunResult };
}
