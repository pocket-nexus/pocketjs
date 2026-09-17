import { gateMetricIds } from "../core/catalog.ts";
import { parseReceiptV1 } from "../core/schema.ts";
import type {
  CorrectnessReceiptV1,
  MetricSampleV1,
  ReceiptProvenanceV1,
  ReceiptV1,
  ScenarioV1,
} from "../core/types.ts";
import type { NativeRunResult } from "../runner/native.ts";
import {
  guestDigestToSha256,
  scenarioPhaseId,
  sha256Json,
} from "./hash.ts";
import { parseNativeResult } from "./native-protocol.ts";
import {
  parseGuestOutput,
  parseQemuOutput,
  type GuestPhaseRecordV1,
  type QemuMeasurementRecordV1,
  type QemuTarget,
} from "./protocol.ts";

const SHA256 = /^[a-f0-9]{64}$/;

export type ReceiptEnvironmentV1 = Omit<ReceiptProvenanceV1, "scenario">;
export type ArtifactMetricId =
  | "artifact.bundle_bytes"
  | "artifact.pak_bytes"
  | "artifact.elf_text_rodata_bytes";
export type ArtifactMetrics = Readonly<Partial<Record<ArtifactMetricId, number>>>;

export interface ReceiptFactoryOptions {
  readonly provenance: ReceiptEnvironmentV1;
  readonly artifactMetrics?: ArtifactMetrics;
  readonly createdAt?: string;
}

export interface NativeReceiptOptions extends ReceiptFactoryOptions {
  /** Optional assertion for callers that already wrapped the observed FNV digest. */
  readonly observedDrawListHash?: string;
}

export interface QemuReceiptOptions extends ReceiptFactoryOptions {
  readonly target: QemuTarget;
  /** Optional assertion from an independent correctness oracle. */
  readonly framebufferHash?: string;
  /** Guest protocol emitted by the separate observational correctness replay. */
  readonly correctnessGuestOutput?: string;
}

export const NATIVE_CORRECTNESS_MAPPING = Object.freeze({
  framebufferHash: "correctness.framebufferTraceHash",
  drawListHash: "SHA-256 envelope of correctness.drawListHash",
  stateHash: "correctness.stateHash",
  effectHash: "correctness.effectHash",
  replayInvariant:
    "correctness final framebuffer/drawList hashes equal their measurement replay counterparts",
} as const);

function exact(value: number, unit: "count" | "bytes" | "ns"): MetricSampleV1 {
  return { kind: "exact", value, unit };
}

function date(options: ReceiptFactoryOptions): string {
  return options.createdAt ?? new Date().toISOString();
}

function provenance(
  scenario: ScenarioV1,
  scenarioKey: string,
  environment: ReceiptEnvironmentV1,
): ReceiptProvenanceV1 {
  return {
    ...environment,
    scenario: {
      id: scenarioKey,
      suite: scenario.suite,
      framework: scenario.subject.framework,
      manifestHash: sha256Json(scenario),
      inputTapeHash: sha256Json(scenario.tape),
    },
  };
}

function receipt(
  scenario: ScenarioV1,
  scenarioKey: string,
  options: ReceiptFactoryOptions,
  metrics: Readonly<Record<string, MetricSampleV1>>,
  correctness: CorrectnessReceiptV1 | null,
  reasons: readonly string[],
  unsupportedMetrics: readonly string[] = [],
): ReceiptV1 {
  const uniqueReasons = [...new Set(reasons.filter((reason) => reason.length > 0))];
  const gateMetrics = gateMetricIds(scenario.params);
  const value = uniqueReasons.length === 0
    ? {
        schemaVersion: 1,
        kind: "pocketjs.perf.receipt",
        createdAt: date(options),
        status: "valid",
        invalidReasons: [],
        provenance: provenance(scenario, scenarioKey, options.provenance),
        gateMetrics,
        unsupportedMetrics,
        correctness,
        metrics,
      }
    : {
        schemaVersion: 1,
        kind: "pocketjs.perf.receipt",
        createdAt: date(options),
        status: "invalid",
        invalidReasons: uniqueReasons,
        provenance: provenance(scenario, scenarioKey, options.provenance),
        gateMetrics,
        unsupportedMetrics,
        correctness,
        metrics,
      };
  return parseReceiptV1(value);
}

function collectArtifactMetrics(
  input: unknown,
  reasons: string[],
): Record<string, MetricSampleV1> {
  const metrics: Record<string, MetricSampleV1> = {};
  if (input === undefined) return metrics;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    reasons.push("artifact metrics must be an object");
    return metrics;
  }
  const allowed = new Set<ArtifactMetricId>([
    "artifact.bundle_bytes",
    "artifact.pak_bytes",
    "artifact.elf_text_rodata_bytes",
  ]);
  for (const [id, value] of Object.entries(input)) {
    if (!allowed.has(id as ArtifactMetricId)) {
      reasons.push(`unknown artifact metric ${id}`);
    } else if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      reasons.push(`${id} must be a non-negative safe integer`);
    } else {
      metrics[id] = exact(value, "bytes");
    }
  }
  return metrics;
}

function nativeArtifactMetrics(
  result: Extract<NativeRunResult, { status: "ok" }>,
  external: ArtifactMetrics | undefined,
  reasons: string[],
): Record<string, MetricSampleV1> {
  const metrics = collectArtifactMetrics(external, reasons);
  for (const id of ["artifact.bundle_bytes", "artifact.pak_bytes"] as const) {
    const sample = result.exactMetrics[id];
    if (!sample) continue;
    if (sample.unit !== "bytes" || !Number.isSafeInteger(sample.value) || sample.value < 0) {
      reasons.push(`native exact metric ${id} is invalid`);
      continue;
    }
    const externalSample = metrics[id];
    if (externalSample?.kind === "exact" && externalSample.value !== sample.value) {
      reasons.push(`native and external ${id} values disagree`);
    } else {
      metrics[id] = exact(sample.value, "bytes");
    }
  }
  return metrics;
}

/** Convert one native scenario result into one receipt-v1 document. */
export function createNativeReceipt(
  scenario: ScenarioV1,
  value: unknown,
  options: NativeReceiptOptions,
): ReceiptV1 {
  const parsed = parseNativeResult(value);
  const protocolReasons: string[] = parsed.success === false ? [...parsed.reasons] : [];
  if (!parsed.success) {
    return receipt(
      scenario,
      scenario.id,
      options,
      collectArtifactMetrics(options.artifactMetrics, protocolReasons),
      null,
      protocolReasons,
    );
  }
  const result = parsed.data;
  if (result.scenarioId !== scenario.id) {
    protocolReasons.push(
      `native scenarioId ${JSON.stringify(result.scenarioId)} does not match ${JSON.stringify(scenario.id)}`,
    );
  }
  if (result.status === "unsupported") {
    protocolReasons.push(...result.reasons.map((reason) => `native executor unsupported: ${reason}`));
    return receipt(
      scenario,
      scenario.id,
      options,
      collectArtifactMetrics(options.artifactMetrics, protocolReasons),
      null,
      protocolReasons,
    );
  }

  const metrics = nativeArtifactMetrics(result, options.artifactMetrics, protocolReasons);
  const measuredWallTime = result.measurement.phases.reduce((sum, phase) => sum + phase.wallTimeNs, 0);
  if (!Number.isSafeInteger(measuredWallTime)) {
    protocolReasons.push("native measured wall time exceeds the safe integer range");
  } else {
    metrics["native.wall_time_ns"] = exact(measuredWallTime, "ns");
  }
  const reportedWallTime = result.diagnosticMetrics["native.wall_time_ns"];
  if (!reportedWallTime || reportedWallTime.unit !== "ns" || reportedWallTime.value !== measuredWallTime) {
    protocolReasons.push("native.wall_time_ns does not equal the sum of measured phases");
  }

  const expectedPhases = scenario.phases.filter((phase) => phase.collect);
  if (result.measurement.phases.length !== expectedPhases.length) {
    protocolReasons.push(
      `native measured ${result.measurement.phases.length} phases; expected ${expectedPhases.length}`,
    );
  }
  expectedPhases.forEach((expected, index) => {
    const actual = result.measurement.phases[index];
    if (!actual || actual.name !== expected.name || actual.startFrame !== expected.startFrame ||
        actual.endFrame !== expected.endFrame) {
      protocolReasons.push(`native measured phase ${index} does not match ${expected.name}`);
    }
  });
  if (result.correctness.finalFramebufferHash !== result.measurement.finalFramebufferHash) {
    protocolReasons.push("native correctness and measurement final framebuffers differ");
  }
  if (result.correctness.drawListHash !== result.measurement.finalDrawListHash) {
    protocolReasons.push("native correctness and measurement final draw lists differ");
  }

  let correctness: CorrectnessReceiptV1 | null = null;
  let observedDrawListHash: string | null = null;
  try {
    observedDrawListHash = guestDigestToSha256("draw-list", result.correctness.drawListHash);
  } catch {
    // parseNativeResult normally reports this first; retain a defensive check
    // for callers that bypass TypeScript types at runtime.
    protocolReasons.push("native correctness replay did not capture a valid drawListHash");
  }
  if (options.observedDrawListHash !== undefined) {
    if (!SHA256.test(options.observedDrawListHash)) {
      protocolReasons.push("observedDrawListHash must be a lowercase SHA-256 digest");
    } else if (observedDrawListHash !== options.observedDrawListHash) {
      protocolReasons.push("observedDrawListHash does not match the native correctness replay");
    }
  }
  if (observedDrawListHash) {
    // framebufferHash intentionally represents the complete trace. The final
    // frame is separately checked above as a replay invariant.
    correctness = {
      framebufferHash: result.correctness.framebufferTraceHash,
      drawListHash: observedDrawListHash,
      stateHash: result.correctness.stateHash,
      effectHash: result.correctness.effectHash,
    };
  }

  const requestedGateMetrics = gateMetricIds(scenario.params);
  const requestedGateMetricSet = new Set<string>(requestedGateMetrics);
  const unsupportedMetrics = new Set(result.unsupportedMetrics);
  for (const metricId of unsupportedMetrics) {
    if (!requestedGateMetricSet.has(metricId)) {
      protocolReasons.push(`native marked non-gate metric ${metricId} as unsupported`);
    }
    if (Object.hasOwn(metrics, metricId)) {
      protocolReasons.push(`native gate metric ${metricId} is both observed and unsupported`);
    }
  }
  for (const metricId of requestedGateMetrics) {
    if (!Object.hasOwn(metrics, metricId) && !unsupportedMetrics.has(metricId)) {
      protocolReasons.push(`required gate metric ${metricId} is missing without an explicit native unsupported declaration`);
    }
  }

  return receipt(
    scenario,
    scenario.id,
    options,
    metrics,
    correctness,
    protocolReasons,
    result.unsupportedMetrics,
  );
}

interface ExpectedPhase {
  readonly name: string;
  readonly id: number;
  readonly endFrame: number | null;
}

function expectedQemuPhases(scenario: ScenarioV1): ExpectedPhase[] {
  const names: { name: string; endFrame: number | null }[] = [];
  if (scenario.params.measureBoot === true) {
    names.push({ name: "runtime-init", endFrame: null }, { name: "bundle-eval", endFrame: null });
  }
  names.push(...scenario.phases
    .filter((phase) => phase.collect)
    .map((phase) => ({ name: phase.name, endFrame: phase.endFrame })));
  return names.map((phase) => ({
    ...phase,
    id: scenarioPhaseId(scenario.id, phase.name),
  }));
}

function metricsForQemuPhase(
  guest: GuestPhaseRecordV1 | undefined,
  qemu: QemuMeasurementRecordV1 | undefined,
  artifacts: Readonly<Record<string, MetricSampleV1>>,
  reasons: string[],
): Record<string, MetricSampleV1> {
  const metrics: Record<string, MetricSampleV1> = { ...artifacts };
  if (qemu) {
    const counters = qemu.metrics;
    const loadStores = counters.guest_load_events + counters.guest_store_events;
    if (!Number.isSafeInteger(loadStores)) reasons.push("guest load/store sum exceeds the safe integer range");
    else metrics["guest.load_store_events"] = exact(loadStores, "count");
    metrics["guest.instructions"] = exact(counters.guest_insn_dispatched, "count");
    metrics["guest.instruction_bytes"] = exact(counters.guest_instruction_bytes, "bytes");
    metrics["guest.thumb16_instructions"] = exact(counters.guest_insn_size_2, "count");
    metrics["guest.thumb32_instructions"] = exact(counters.guest_insn_size_4, "count");
    metrics["guest.loads"] = exact(counters.guest_load_events, "count");
    metrics["guest.stores"] = exact(counters.guest_store_events, "count");
  }
  if (guest) {
    metrics["memory.allocations"] = exact(guest.allocCalls, "count");
    metrics["memory.allocated_bytes"] = exact(guest.allocatedBytes, "bytes");
    metrics["memory.current_bytes"] = exact(guest.currentBytes, "bytes");
    metrics["memory.peak_bytes"] = exact(guest.peakBytes, "bytes");
    metrics["quickjs.live_bytes_after_gc"] = exact(guest.quickjsLiveBytesAfterGc, "bytes");
  }
  return metrics;
}

/**
 * Parse an interleaved QEMU/guest log and create one receipt per phase. In
 * receipt schema v1 the phase is encoded in scenario.id as `scenario#phase`;
 * changing that key would make old and new receipts spuriously comparable.
 */
export function createQemuReceipts(
  scenario: ScenarioV1,
  output: string,
  options: QemuReceiptOptions,
): readonly ReceiptV1[] {
  const generatedCTrace = scenario.subject.family === "vapor";
  const guest = parseGuestOutput(output, {
    framebufferTraceHash: generatedCTrace ? "required" : "forbidden",
  });
  const correctnessGuest = options.correctnessGuestOutput === undefined
    ? null
    : parseGuestOutput(options.correctnessGuestOutput, { framebufferTraceHash: "required" });
  const qemu = parseQemuOutput(output);
  const phases = expectedQemuPhases(scenario);
  const globalReasons = [
    ...guest.status === "invalid" ? guest.reasons : [],
    ...qemu.status === "invalid" ? qemu.reasons : [],
    ...(correctnessGuest?.status === "invalid"
      ? correctnessGuest.reasons.map((reason) => `correctness guest: ${reason}`)
      : []),
  ];
  const artifacts = collectArtifactMetrics(options.artifactMetrics, globalReasons);

  if (guest.complete) {
    if (guest.complete.scenarioId !== scenario.id) globalReasons.push("guest complete scenarioId mismatch");
    if (guest.complete.suite !== scenario.suite) globalReasons.push("guest complete suite mismatch");
    if (guest.complete.framework !== scenario.subject.framework) {
      globalReasons.push("guest complete framework mismatch");
    }
  }
  if (options.framebufferHash !== undefined && !SHA256.test(options.framebufferHash)) {
    globalReasons.push("framebufferHash must be a lowercase SHA-256 digest");
  }
  const requiresSeparateGuestTrace = scenario.subject.family === "guest-app";
  if (requiresSeparateGuestTrace && correctnessGuest === null) {
    globalReasons.push("QEMU guest-app receipt has no correctness guest output");
  }
  const separateGuestTraceHash = correctnessGuest?.complete?.framebufferTraceHash;
  if (separateGuestTraceHash && options.framebufferHash &&
      separateGuestTraceHash !== options.framebufferHash) {
    globalReasons.push("QEMU correctness framebuffer trace differs from the independent correctness replay");
  }
  const generatedCTraceHash = generatedCTrace ? guest.complete?.framebufferTraceHash : undefined;
  if (generatedCTraceHash && options.framebufferHash && generatedCTraceHash !== options.framebufferHash) {
    globalReasons.push("generated-C framebuffer trace differs from the independent correctness replay");
  }
  const receiptFramebufferHash = generatedCTrace
    ? generatedCTraceHash
    : correctnessGuest === null
    ? options.framebufferHash
    : separateGuestTraceHash;
  if (!receiptFramebufferHash) {
    globalReasons.push("QEMU receipt has no framebuffer hash from a correctness replay");
  }

  if (guest.phases.length !== phases.length) {
    globalReasons.push(`guest emitted ${guest.phases.length} phases; expected ${phases.length}`);
  }
  if (qemu.measurements.length !== phases.length) {
    globalReasons.push(`QEMU emitted ${qemu.measurements.length} phases; expected ${phases.length}`);
  }
  const expectedIds = new Set(phases.map((phase) => phase.id));
  for (const phase of guest.phases) {
    if (!expectedIds.has(phase.phaseId)) globalReasons.push(`unknown guest phaseId ${phase.phaseId}`);
  }
  for (const measurement of qemu.measurements) {
    if (!expectedIds.has(measurement.phase_id)) {
      globalReasons.push(`unknown QEMU phaseId ${measurement.phase_id}`);
    }
    if (measurement.target !== options.target) globalReasons.push("QEMU measurement target mismatch");
    if (measurement.vcpu !== 0) globalReasons.push(`QEMU measurement used unexpected vCPU ${measurement.vcpu}`);
  }
  if (qemu.terminal && Object.hasOwn(qemu.terminal, "target") && qemu.terminal.target !== options.target) {
    globalReasons.push("QEMU terminal target mismatch");
  }

  if (phases.length === 0) {
    return [receipt(
      scenario,
      `${scenario.id}#protocol`,
      options,
      artifacts,
      null,
      [...globalReasons, "scenario defines no measurable QEMU phases"],
    )];
  }

  return phases.map((expected, index) => {
    const reasons = [...globalReasons];
    const guestPhase = guest.phases[index];
    const qemuPhase = qemu.measurements[index];
    if (!guestPhase) reasons.push(`missing guest phase ${expected.name}`);
    else {
      if (guestPhase.scenarioId !== scenario.id) reasons.push(`guest phase ${expected.name} scenarioId mismatch`);
      if (guestPhase.phase !== expected.name) {
        reasons.push(`guest phase order mismatch: expected ${expected.name}, got ${guestPhase.phase}`);
      }
      if (guestPhase.phaseId !== expected.id) {
        reasons.push(
          `guest phaseId mismatch for ${expected.name}: expected ${expected.id}, got ${guestPhase.phaseId}`,
        );
      }
      if (guestPhase.iteration !== 0) reasons.push(`guest phase ${expected.name} iteration must be 0`);
    }
    if (!qemuPhase) reasons.push(`missing QEMU measurement ${expected.name}`);
    else {
      if (qemuPhase.phase_id !== expected.id) {
        reasons.push(
          `QEMU phaseId mismatch for ${expected.name}: expected ${expected.id}, got ${qemuPhase.phase_id}`,
        );
      }
      if (qemuPhase.iteration !== 0) reasons.push(`QEMU phase ${expected.name} iteration must be 0`);
    }
    if (guestPhase && qemuPhase &&
        (guestPhase.phaseId !== qemuPhase.phase_id || guestPhase.iteration !== qemuPhase.iteration)) {
      reasons.push(`guest/QEMU phase marker mismatch for ${expected.name}`);
    }

    if (expected.endFrame === scenario.frames && guest.complete && guestPhase &&
        guestPhase.drawListHash !== guest.complete.finalDrawListHash) {
      reasons.push(`final guest draw-list hash differs from phase ${expected.name}`);
    }

    let correctness: CorrectnessReceiptV1 | null = null;
    if (receiptFramebufferHash && SHA256.test(receiptFramebufferHash) && guest.complete && guestPhase) {
      correctness = {
        framebufferHash: receiptFramebufferHash,
        drawListHash: guestDigestToSha256("draw-list", guestPhase.drawListHash),
        stateHash: guestDigestToSha256("state", guest.complete.finalStateHash),
        effectHash: guestDigestToSha256("effects", guest.complete.effectHash),
      };
    }
    const metrics = metricsForQemuPhase(guestPhase, qemuPhase, artifacts, reasons);
    const requiredMetrics = gateMetricIds(scenario.params);
    for (const metricId of requiredMetrics) {
      if (!Object.hasOwn(metrics, metricId)) {
        reasons.push(`required gate metric ${metricId} is missing`);
      }
    }
    return receipt(scenario, `${scenario.id}#${expected.name}`, options, metrics, correctness, reasons);
  });
}
