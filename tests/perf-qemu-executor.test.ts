import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseScenarioV1 } from "../tools/perf/core/index.ts";
import {
  QEMU_ENTROPY_PROFILE,
  qemuCleanupFallbackArgs,
  qemuHarnessFingerprint,
  qemuInvocationProfile,
  qemuQuickJsReplayReasons,
  qemuScenarioRenderContract,
  snapshotGuestArtifacts,
} from "../tools/perf/executors/qemu.ts";
import {
  GUEST_OUTPUT_PREFIX,
  scenarioPhaseId,
} from "../tools/perf/receipts/index.ts";

const ROOT = join(import.meta.dir, "..");
const BOOT = parseScenarioV1(JSON.parse(
  readFileSync(join(ROOT, "tools/perf/scenarios/boot.json"), "utf8"),
));
const FRAMEBUFFER_TRACE = "3".repeat(64);
const DRAW_LIST = "fnv1a64:1111111111111111";
const STATE = "fnv1a64:2222222222222222";
const EFFECT = "fnv1a64:3333333333333333";

function guestLine(value: unknown): string {
  return `${GUEST_OUTPUT_PREFIX}${JSON.stringify(value)}\n`;
}

function quickJsGuestOutput(completeOverrides: Record<string, unknown> = {}): string {
  return [
    guestLine({
      schemaVersion: 1,
      event: "phase",
      scenarioId: BOOT.id,
      phase: "first-frame",
      phaseId: scenarioPhaseId(BOOT.id, "first-frame"),
      iteration: 0,
      allocCalls: 7,
      allocatedBytes: 2_048,
      currentBytes: 1_024,
      peakBytes: 1_536,
      quickjsLiveBytesAfterGc: 768,
      drawListHash: DRAW_LIST,
    }),
    guestLine({
      schemaVersion: 1,
      event: "complete",
      scenarioId: BOOT.id,
      suite: BOOT.suite,
      framework: BOOT.subject.framework,
      finalDrawListHash: DRAW_LIST,
      finalStateHash: STATE,
      effectHash: EFFECT,
      ...completeOverrides,
    }),
  ].join("");
}

describe("QEMU render/build contract", () => {
  test("confines the permission cleanup fallback to the disposable work directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "pocketjs-qemu-cleanup-"));
    try {
      const work = join(directory, ".qemu-work-fixture");
      mkdirSync(work, { mode: 0o700 });
      expect(qemuCleanupFallbackArgs("pocketjs-perf-qemu:11.0.3", work)).toEqual([
        "docker", "run", "--rm",
        "--network", "none",
        "--read-only",
        "--cap-drop", "ALL",
        "--cap-add", "DAC_OVERRIDE",
        "--security-opt", "no-new-privileges",
        "--mount", `type=bind,source=${realpathSync(work)},target=/work`,
        "--entrypoint", "find",
        "pocketjs-perf-qemu:11.0.3",
        "/work", "-mindepth", "1", "-delete",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("separates pinned CPU and deterministic emulator arguments", () => {
    expect(qemuInvocationProfile("qemu-armv7-thumb2")).toEqual({
      cpuArgs: ["-cpu", "cortex-a9,neon=off,vfp-d32=off"],
      emulatorArgs: ["-seed", "1"],
      entropyProfile: QEMU_ENTROPY_PROFILE,
    });
    expect(qemuInvocationProfile("qemu-aarch64")).toEqual({
      cpuArgs: ["-cpu", "cortex-a53"],
      emulatorArgs: ["-seed", "1"],
      entropyProfile: QEMU_ENTROPY_PROFILE,
    });
    expect(QEMU_ENTROPY_PROFILE).toBe("seed-1+guest-shim-v1");
  });

  test("fingerprints the host Bun runtime and harness lockfile", () => {
    const directory = mkdtempSync(join(tmpdir(), "pocketjs-qemu-fingerprint-"));
    try {
      writeFileSync(join(directory, "bun.lock"), "lock-v1");
      const first = qemuHarnessFingerprint(
        directory,
        "sha256:" + "1".repeat(64) + " linux/amd64 []",
        "qemu-armv7-thumb2",
        "Bun 1.3.14",
        "darwin",
        "arm64",
      );
      const runtimeChanged = qemuHarnessFingerprint(
        directory,
        "sha256:" + "1".repeat(64) + " linux/amd64 []",
        "qemu-armv7-thumb2",
        "Bun 1.3.15",
        "darwin",
        "arm64",
      );
      expect(runtimeChanged).not.toBe(first);

      const hostChanged = qemuHarnessFingerprint(
        directory,
        "sha256:" + "1".repeat(64) + " linux/amd64 []",
        "qemu-armv7-thumb2",
        "Bun 1.3.14",
        "linux",
        "x64",
      );
      expect(hostChanged).not.toBe(first);

      writeFileSync(join(directory, "bun.lock"), "lock-v2");
      const lockChanged = qemuHarnessFingerprint(
        directory,
        "sha256:" + "1".repeat(64) + " linux/amd64 []",
        "qemu-armv7-thumb2",
        "Bun 1.3.14",
        "darwin",
        "arm64",
      );
      expect(lockChanged).not.toBe(first);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps framebuffer trace hashing in correctness replay and matches Native", () => {
    const valid = qemuQuickJsReplayReasons(
      BOOT,
      quickJsGuestOutput({ framebufferTraceHash: FRAMEBUFFER_TRACE }),
      quickJsGuestOutput(),
      FRAMEBUFFER_TRACE,
    );
    expect(valid.reasons).toEqual([]);
    expect(valid.correctness.complete?.framebufferTraceHash).toBe(FRAMEBUFFER_TRACE);
    expect(valid.measurement.complete?.framebufferTraceHash).toBeUndefined();

    const missing = qemuQuickJsReplayReasons(
      BOOT,
      quickJsGuestOutput(),
      quickJsGuestOutput(),
      FRAMEBUFFER_TRACE,
    );
    expect(missing.reasons.join(" ")).toContain(
      "guest complete has no required framebufferTraceHash",
    );

    const malformed = qemuQuickJsReplayReasons(
      BOOT,
      quickJsGuestOutput({ framebufferTraceHash: "A".repeat(64) }),
      quickJsGuestOutput(),
      FRAMEBUFFER_TRACE,
    );
    expect(malformed.reasons.join(" ")).toContain(
      "framebufferTraceHash must be a lowercase SHA-256 digest",
    );

    const mismatch = qemuQuickJsReplayReasons(
      BOOT,
      quickJsGuestOutput({ framebufferTraceHash: "a".repeat(64) }),
      quickJsGuestOutput(),
      FRAMEBUFFER_TRACE,
    );
    expect(mismatch.reasons).toContain(
      "QEMU correctness framebuffer trace differs from Native/WASM correctness replay",
    );

    const measurementLeak = qemuQuickJsReplayReasons(
      BOOT,
      quickJsGuestOutput({ framebufferTraceHash: FRAMEBUFFER_TRACE }),
      quickJsGuestOutput({ framebufferTraceHash: FRAMEBUFFER_TRACE }),
      FRAMEBUFFER_TRACE,
    );
    expect(measurementLeak.reasons.join(" ")).toContain(
      "guest complete emitted correctness-only framebufferTraceHash",
    );
  });

  test("uses one strict config for the build density, cache key and framebuffer size", () => {
    const scenario = parseScenarioV1({
      ...BOOT,
      params: {
        ...BOOT.params,
        viewport: {
          width: 320,
          height: 180,
          rasterDensity: 2,
          renderScale: 3,
        },
      },
    });
    const contract = qemuScenarioRenderContract(scenario);
    expect(contract.densityArgument).toBe("--density=2");
    expect(contract.artifactCacheKey).toEndWith("\0density=2");
    expect(contract.framebufferByteLength).toBe(320 * 3 * 180 * 3 * 4);

    const otherDensity = parseScenarioV1({
      ...scenario,
      params: {
        ...scenario.params,
        viewport: {
          ...(scenario.params.viewport as Record<string, number>),
          rasterDensity: 3,
        },
      },
    });
    expect(qemuScenarioRenderContract(otherDensity).artifactCacheKey)
      .not.toBe(contract.artifactCacheKey);

    const otherEntry = parseScenarioV1({
      ...scenario,
      subject: { ...scenario.subject, entry: `${scenario.subject.entry}-alternate` },
    });
    expect(qemuScenarioRenderContract(otherEntry).artifactCacheKey)
      .not.toBe(contract.artifactCacheKey);
  });

  test("snapshots build outputs before another framework can overwrite dist", () => {
    const directory = mkdtempSync(join(tmpdir(), "pocketjs-qemu-artifacts-"));
    try {
      const bundle = join(directory, "source.js");
      const pak = join(directory, "source.pak");
      writeFileSync(bundle, "variant-a");
      writeFileSync(pak, "pak-a");
      const frozen = snapshotGuestArtifacts(bundle, pak, join(directory, "work"), "variant-a");

      writeFileSync(bundle, "variant-b");
      writeFileSync(pak, "pak-b");

      expect(readFileSync(frozen.bundle, "utf8")).toBe("variant-a");
      expect(readFileSync(frozen.pak!, "utf8")).toBe("pak-a");
      expect(frozen.bundle.startsWith(join(directory, "work"))).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
