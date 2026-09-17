import type { FrameworkId } from "../core/types.ts";

export const GUEST_OUTPUT_PREFIX = "POCKETJS_PERF_GUEST ";
export const QEMU_OUTPUT_PREFIX = "POCKETJS_PERF_QEMU ";

const FNV1A64 = /^fnv1a64:[a-f0-9]{16}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const FRAMEWORKS = new Set<FrameworkId>(["solid", "vue-vapor", "octane", "core"]);
const QEMU_TARGETS = new Set<QemuTarget>(["arm", "aarch64"]);
const QEMU_METRIC_KEYS = [
  "guest_insn_dispatched",
  "guest_instruction_bytes",
  "guest_insn_size_2",
  "guest_insn_size_4",
  "guest_load_events",
  "guest_store_events",
] as const;

type PlainRecord = Record<string, unknown>;

export interface GuestPhaseRecordV1 {
  readonly schemaVersion: 1;
  readonly event: "phase";
  readonly scenarioId: string;
  readonly phase: string;
  readonly phaseId: number;
  readonly iteration: number;
  readonly allocCalls: number;
  readonly allocatedBytes: number;
  readonly currentBytes: number;
  readonly peakBytes: number;
  readonly quickjsLiveBytesAfterGc: number;
  readonly drawListHash: string;
}

export interface GuestCompleteRecordV1 {
  readonly schemaVersion: 1;
  readonly event: "complete";
  readonly scenarioId: string;
  readonly suite: string;
  readonly framework: FrameworkId;
  readonly finalDrawListHash: string;
  readonly finalStateHash: string;
  readonly effectHash: string;
  /** Present only in an observational correctness replay. */
  readonly framebufferTraceHash?: string;
}

export type QemuTarget = "arm" | "aarch64";

export interface QemuCountersV1 {
  readonly guest_insn_dispatched: number;
  readonly guest_instruction_bytes: number;
  readonly guest_insn_size_2: number;
  readonly guest_insn_size_4: number;
  readonly guest_load_events: number;
  readonly guest_store_events: number;
}

export interface QemuMeasurementRecordV1 {
  readonly schema: "pocketjs.perf.qemu";
  readonly version: 1;
  readonly event: "measurement";
  readonly plugin_api: 6;
  readonly qemu_version: "11.0.3";
  readonly target: QemuTarget;
  readonly vcpu: number;
  readonly phase_id: number;
  readonly iteration: number;
  readonly metrics: QemuCountersV1;
}

export interface QemuCompleteRecordV1 {
  readonly schema: "pocketjs.perf.qemu";
  readonly version: 1;
  readonly event: "complete";
  readonly plugin_api: 6;
  readonly qemu_version: "11.0.3";
  readonly target: QemuTarget;
  readonly measurements: number;
}

export interface QemuErrorRecordV1 {
  readonly schema: "pocketjs.perf.qemu";
  readonly version: 1;
  readonly event: "error";
  readonly plugin_api: 6;
  readonly qemu_version: "11.0.3";
  readonly target?: QemuTarget;
  readonly code: string;
  readonly measurements: number;
}

export type GuestProtocolResult =
  | {
      readonly status: "valid";
      readonly reasons: readonly [];
      readonly phases: readonly GuestPhaseRecordV1[];
      readonly complete: GuestCompleteRecordV1;
    }
  | {
      readonly status: "invalid";
      readonly reasons: readonly string[];
      readonly phases: readonly GuestPhaseRecordV1[];
      readonly complete: GuestCompleteRecordV1 | null;
    };

export interface GuestProtocolParseOptions {
  /** Correctness replays require the trace; measurement replays forbid it. */
  readonly framebufferTraceHash?: "optional" | "required" | "forbidden";
}

export type QemuProtocolResult =
  | {
      readonly status: "valid";
      readonly reasons: readonly [];
      readonly measurements: readonly QemuMeasurementRecordV1[];
      readonly terminal: QemuCompleteRecordV1;
    }
  | {
      readonly status: "invalid";
      readonly reasons: readonly string[];
      readonly measurements: readonly QemuMeasurementRecordV1[];
      readonly terminal: QemuCompleteRecordV1 | QemuErrorRecordV1 | null;
    };

interface PrefixedRecord {
  readonly line: number;
  readonly value: PlainRecord;
}

function isPlainRecord(value: unknown): value is PlainRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function exactKeys(
  record: PlainRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): string | null {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) return `unknown properties: ${unknown.join(", ")}`;
  const missing = required.filter((key) => !Object.hasOwn(record, key));
  return missing.length > 0 ? `missing properties: ${missing.join(", ")}` : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readPrefixed(output: string, prefix: string, label: string): {
  records: PrefixedRecord[];
  reasons: string[];
} {
  const records: PrefixedRecord[] = [];
  const reasons: string[] = [];
  for (const [index, line] of output.split(/\r?\n/u).entries()) {
    if (!line.startsWith(prefix)) continue;
    const lineNumber = index + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.slice(prefix.length));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      reasons.push(`${label} line ${lineNumber}: invalid JSON (${detail})`);
      continue;
    }
    if (!isPlainRecord(parsed)) {
      reasons.push(`${label} line ${lineNumber}: protocol value is not an object`);
      continue;
    }
    records.push({ line: lineNumber, value: parsed });
  }
  if (records.length === 0) reasons.push(`no ${label} protocol records`);
  return { records, reasons };
}

function parseGuestPhase(record: PlainRecord): string | GuestPhaseRecordV1 {
  const keys = exactKeys(record, [
    "schemaVersion", "event", "scenarioId", "phase", "phaseId", "iteration",
    "allocCalls", "allocatedBytes", "currentBytes", "peakBytes",
    "quickjsLiveBytesAfterGc", "drawListHash",
  ]);
  if (keys) return keys;
  if (record.schemaVersion !== 1) return "schemaVersion must be 1";
  if (record.event !== "phase") return "event must be phase";
  if (!nonEmptyString(record.scenarioId)) return "scenarioId must be a non-empty string";
  if (!nonEmptyString(record.phase)) return "phase must be a non-empty string";
  for (const key of [
    "phaseId", "iteration", "allocCalls", "allocatedBytes", "currentBytes",
    "peakBytes", "quickjsLiveBytesAfterGc",
  ] as const) {
    if (!nonNegativeSafeInteger(record[key])) return `${key} must be a non-negative safe integer`;
  }
  if (typeof record.drawListHash !== "string" || !FNV1A64.test(record.drawListHash)) {
    return "drawListHash must be a lowercase FNV-1a-64 digest";
  }
  return record as unknown as GuestPhaseRecordV1;
}

function parseGuestComplete(record: PlainRecord): string | GuestCompleteRecordV1 {
  const keys = exactKeys(record, [
    "schemaVersion", "event", "scenarioId", "suite", "framework",
    "finalDrawListHash", "finalStateHash", "effectHash",
  ], ["framebufferTraceHash"]);
  if (keys) return keys;
  if (record.schemaVersion !== 1) return "schemaVersion must be 1";
  if (record.event !== "complete") return "event must be complete";
  if (!nonEmptyString(record.scenarioId)) return "scenarioId must be a non-empty string";
  if (!nonEmptyString(record.suite)) return "suite must be a non-empty string";
  if (typeof record.framework !== "string" || !FRAMEWORKS.has(record.framework as FrameworkId)) {
    return "framework is unknown";
  }
  for (const key of ["finalDrawListHash", "finalStateHash", "effectHash"] as const) {
    if (typeof record[key] !== "string" || !FNV1A64.test(record[key])) {
      return `${key} must be a lowercase FNV-1a-64 digest`;
    }
  }
  if (record.framebufferTraceHash !== undefined &&
      (typeof record.framebufferTraceHash !== "string" || !SHA256.test(record.framebufferTraceHash))) {
    return "framebufferTraceHash must be a lowercase SHA-256 digest";
  }
  return record as unknown as GuestCompleteRecordV1;
}

export function parseGuestOutput(
  output: string,
  options: GuestProtocolParseOptions = {},
): GuestProtocolResult {
  const prefixed = readPrefixed(output, GUEST_OUTPUT_PREFIX, "guest");
  const reasons = [...prefixed.reasons];
  const phases: GuestPhaseRecordV1[] = [];
  const completes: GuestCompleteRecordV1[] = [];
  const terminalIndexes: number[] = [];

  prefixed.records.forEach(({ line, value }, index) => {
    if (value.event === "phase") {
      const parsed = parseGuestPhase(value);
      if (typeof parsed === "string") reasons.push(`guest line ${line}: ${parsed}`);
      else phases.push(parsed);
    } else if (value.event === "complete") {
      const parsed = parseGuestComplete(value);
      if (typeof parsed === "string") reasons.push(`guest line ${line}: ${parsed}`);
      else {
        completes.push(parsed);
        terminalIndexes.push(index);
      }
    } else {
      reasons.push(`guest line ${line}: unknown protocol event ${JSON.stringify(value.event)}`);
    }
  });

  if (completes.length !== 1) reasons.push("expected exactly one guest complete sentinel");
  if (completes.length === 1 && terminalIndexes[0] !== prefixed.records.length - 1) {
    reasons.push("guest complete sentinel is not the final guest protocol record");
  }
  if (completes.length === 1) {
    const traceMode = options.framebufferTraceHash ?? "optional";
    const hasTrace = completes[0]!.framebufferTraceHash !== undefined;
    if (traceMode === "required" && !hasTrace) {
      reasons.push("guest complete has no required framebufferTraceHash");
    } else if (traceMode === "forbidden" && hasTrace) {
      reasons.push("guest complete emitted correctness-only framebufferTraceHash");
    }
  }
  if (phases.length === 0) reasons.push("guest complete run has no phase records");

  const keys = new Set<string>();
  const ids = new Set<string>();
  for (const phase of phases) {
    const nameKey = `${phase.phase}\0${phase.iteration}`;
    const idKey = `${phase.phaseId}\0${phase.iteration}`;
    if (keys.has(nameKey)) reasons.push(`duplicate guest phase ${phase.phase} iteration ${phase.iteration}`);
    if (ids.has(idKey)) reasons.push(`duplicate guest phaseId ${phase.phaseId} iteration ${phase.iteration}`);
    keys.add(nameKey);
    ids.add(idKey);
  }

  const uniqueReasons = [...new Set(reasons)];
  if (uniqueReasons.length > 0 || completes.length !== 1) {
    return { status: "invalid", reasons: uniqueReasons, phases, complete: completes[0] ?? null };
  }
  return { status: "valid", reasons: [], phases, complete: completes[0]! };
}

function validateQemuEnvelope(record: PlainRecord): string | null {
  if (record.schema !== "pocketjs.perf.qemu") return "schema must be pocketjs.perf.qemu";
  if (record.version !== 1) return "version must be 1";
  if (record.plugin_api !== 6) return "plugin_api must be 6";
  if (record.qemu_version !== "11.0.3") return "qemu_version must be 11.0.3";
  return null;
}

function parseQemuMeasurement(record: PlainRecord): string | QemuMeasurementRecordV1 {
  const keys = exactKeys(record, [
    "schema", "version", "event", "plugin_api", "qemu_version", "target",
    "vcpu", "phase_id", "iteration", "metrics",
  ]);
  if (keys) return keys;
  const envelope = validateQemuEnvelope(record);
  if (envelope) return envelope;
  if (record.event !== "measurement") return "event must be measurement";
  if (typeof record.target !== "string" || !QEMU_TARGETS.has(record.target as QemuTarget)) {
    return "target must be arm or aarch64";
  }
  for (const key of ["vcpu", "phase_id", "iteration"] as const) {
    if (!nonNegativeSafeInteger(record[key])) return `${key} must be a non-negative safe integer`;
  }
  if (!isPlainRecord(record.metrics)) return "metrics must be an object";
  const metricKeys = exactKeys(record.metrics, QEMU_METRIC_KEYS);
  if (metricKeys) return `metric set mismatch (${metricKeys})`;
  for (const key of QEMU_METRIC_KEYS) {
    if (!nonNegativeSafeInteger(record.metrics[key])) {
      return `metric ${key} must be a non-negative safe integer`;
    }
  }
  return record as unknown as QemuMeasurementRecordV1;
}

function parseQemuTerminal(record: PlainRecord): string | QemuCompleteRecordV1 | QemuErrorRecordV1 {
  const isError = record.event === "error";
  const required = [
    "schema", "version", "event", "plugin_api", "qemu_version", "measurements",
    ...(isError ? ["code"] : ["target"]),
  ];
  const keys = exactKeys(record, required, isError ? ["target"] : []);
  if (keys) return keys;
  const envelope = validateQemuEnvelope(record);
  if (envelope) return envelope;
  if (record.event !== "complete" && record.event !== "error") return "unknown terminal event";
  if (Object.hasOwn(record, "target") &&
      (typeof record.target !== "string" || !QEMU_TARGETS.has(record.target as QemuTarget))) {
    return "target must be arm or aarch64";
  }
  if (!nonNegativeSafeInteger(record.measurements)) {
    return "measurements must be a non-negative safe integer";
  }
  if (isError && !nonEmptyString(record.code)) return "error code must be a non-empty string";
  return record as unknown as QemuCompleteRecordV1 | QemuErrorRecordV1;
}

export function parseQemuOutput(output: string): QemuProtocolResult {
  const prefixed = readPrefixed(output, QEMU_OUTPUT_PREFIX, "QEMU");
  const reasons = [...prefixed.reasons];
  const measurements: QemuMeasurementRecordV1[] = [];
  const terminals: (QemuCompleteRecordV1 | QemuErrorRecordV1)[] = [];
  const terminalIndexes: number[] = [];

  prefixed.records.forEach(({ line, value }, index) => {
    if (value.event === "measurement") {
      const parsed = parseQemuMeasurement(value);
      if (typeof parsed === "string") reasons.push(`QEMU line ${line}: ${parsed}`);
      else measurements.push(parsed);
    } else if (value.event === "complete" || value.event === "error") {
      const parsed = parseQemuTerminal(value);
      if (typeof parsed === "string") reasons.push(`QEMU line ${line}: ${parsed}`);
      else {
        terminals.push(parsed);
        terminalIndexes.push(index);
      }
    } else {
      reasons.push(`QEMU line ${line}: unknown protocol event ${JSON.stringify(value.event)}`);
    }
  });

  if (terminals.length !== 1) reasons.push("expected exactly one QEMU complete/error sentinel");
  if (terminals.length === 1 && terminalIndexes[0] !== prefixed.records.length - 1) {
    reasons.push("QEMU complete/error sentinel is not the final QEMU protocol record");
  }
  const terminal = terminals[0] ?? null;
  if (terminal && terminal.measurements !== measurements.length) {
    reasons.push(
      `QEMU terminal measurement count ${terminal.measurements} does not match ${measurements.length} records`,
    );
  }
  if (terminal?.event === "complete" && measurements.length === 0) {
    reasons.push("QEMU complete run has no measurements");
  }
  if (terminal?.event === "error") reasons.push(`QEMU plugin reported ${terminal.code}`);

  const keys = new Set<string>();
  for (const measurement of measurements) {
    const key = `${measurement.phase_id}\0${measurement.iteration}`;
    if (keys.has(key)) {
      reasons.push(
        `duplicate QEMU phaseId ${measurement.phase_id} iteration ${measurement.iteration}`,
      );
    }
    keys.add(key);
  }

  const uniqueReasons = [...new Set(reasons)];
  if (uniqueReasons.length > 0 || !terminal || terminal.event !== "complete") {
    return { status: "invalid", reasons: uniqueReasons, measurements, terminal };
  }
  return { status: "valid", reasons: [], measurements, terminal };
}
