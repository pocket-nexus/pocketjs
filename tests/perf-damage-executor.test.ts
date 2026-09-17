import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseScenarioV1 } from "../tools/perf/core/index.ts";
import {
  DAMAGE_FIXTURE_BINARY,
  DAMAGE_FIXTURE_PACKAGE,
  isDamageScenario,
  materializeDamageFixture,
  runNativeDamageScenario,
} from "../tools/perf/executors/damage.ts";
import { parseNativeResult } from "../tools/perf/receipts/native-protocol.ts";

const ROOT = resolve(import.meta.dir, "..");
const SCENARIO = parseScenarioV1(JSON.parse(
  readFileSync(join(ROOT, "tools/perf/scenarios/damage.json"), "utf8"),
));

describe("core damage performance executor", () => {
  test("stages the harness separately from the core revision under test", () => {
    const temporary = mkdtempSync(join(tmpdir(), "pocketjs-damage-materialize-"));
    try {
      const fixture = materializeDamageFixture({
        sourceRoot: ROOT,
        destination: temporary,
        dependencyRoot: "/source",
      });
      expect(fixture.packageName).toBe(DAMAGE_FIXTURE_PACKAGE);
      expect(fixture.binaryName).toBe(DAMAGE_FIXTURE_BINARY);
      const manifest = readFileSync(fixture.manifestPath, "utf8");
      expect(manifest).toContain('path = "/source/engine/core"');
      expect(manifest).not.toContain(`${ROOT}/engine/core`);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  test("runs all eight real DamagePlan paths twice with stable correctness", async () => {
    expect(isDamageScenario(SCENARIO)).toBe(true);
    const temporary = mkdtempSync(join(tmpdir(), "pocketjs-damage-native-"));
    try {
      const first = await runNativeDamageScenario(SCENARIO, {
        sourceRoot: ROOT,
        outDir: temporary,
      });
      const second = await runNativeDamageScenario(SCENARIO, {
        sourceRoot: ROOT,
        outDir: temporary,
      });
      expect(first.status).toBe("ok");
      expect(second.status).toBe("ok");
      if (first.status !== "ok" || second.status !== "ok") return;
      expect(first.measurement.phases.map((phase) => phase.name)).toEqual([
        "single-small",
        "corner-touch",
        "overlap",
        "eight-sparse",
        "structural",
        "clip-transform",
        "texture-in-place",
        "settle",
      ]);
      expect(first.correctness).toEqual(second.correctness);
      expect(first.correctness.finalFramebufferHash)
        .toBe(first.measurement.finalFramebufferHash);
      expect(first.correctness.drawListHash)
        .toBe(first.measurement.finalDrawListHash);
      expect(first.diagnosticMetrics["native.measured_frames"].value).toBe(960);
      expect(first.diagnosticMetrics["native.damage.eight-sparse.max_regions"].value).toBe(8);
      expect(first.diagnosticMetrics["native.damage.texture-in-place.full_redraw_frames"].value)
        .toBe(120);
      expect(first.diagnosticMetrics["native.damage.settle.empty_frames"].value).toBe(119);
      expect(parseNativeResult(first).success).toBe(true);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 120_000);
});
