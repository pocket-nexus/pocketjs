import { describe, expect, test } from "bun:test";
import {
  extractHostBuildInputs,
  hostBuildEnvironment,
} from "../framework/src/manifest/host-build-inputs.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";

const portableInput: unknown = await Bun.file(
  new URL("./fixtures/manifests/portable-psp.json", import.meta.url),
).json();

function portablePlan() {
  const result = validateAndResolveBuildPlan(portableInput, { target: "psp" });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.plan;
}

describe("custom host build boundary", () => {
  test("projects a verified plan onto stable host inputs", () => {
    const plan = portablePlan();
    expect(extractHostBuildInputs(plan, { expectedTarget: "psp" })).toEqual({
      appOutput: "main",
      app: { id: "dev.pocket-nexus.telemetry", title: "Pocket Telemetry", version: "0.1.0" },
      target: "psp",
      hostAbi: 1,
      viewport: {
        logical: [480, 272],
        physical: [480, 272],
        presentation: "integer-fit",
        rasterDensity: 1,
      },
    });
  });

  test("rejects a modified plan and an unexpected target", () => {
    const plan = portablePlan();
    expect(() => extractHostBuildInputs({ ...plan, app: { ...plan.app, output: "other" } }))
      .toThrow("invalid ResolvedBuildPlan checksum");
    expect(() => extractHostBuildInputs(plan, { expectedTarget: "vita" }))
      .toThrow("expected target vita, got psp");
  });

  test("generates one target-neutral native environment", () => {
    const inputs = extractHostBuildInputs(portablePlan());
    expect(hostBuildEnvironment(inputs, {
      outputDirectory: "/tmp/pocket",
      embedApp: false,
    })).toEqual({
      POCKETJS_APP_OUTPUT: "main",
      POCKETJS_APP_ID: "dev.pocket-nexus.telemetry",
      POCKETJS_APP_TITLE: "Pocket Telemetry",
      POCKETJS_APP_VERSION: "0.1.0",
      POCKETJS_EMBED_APP: "0",
      POCKETJS_OUTPUT_DIR: "/tmp/pocket",
      POCKETJS_TARGET: "psp",
      POCKETJS_HOST_ABI: "1",
      POCKETJS_LOGICAL_WIDTH: "480",
      POCKETJS_LOGICAL_HEIGHT: "272",
      POCKETJS_PHYSICAL_WIDTH: "480",
      POCKETJS_PHYSICAL_HEIGHT: "272",
      POCKETJS_PRESENTATION: "integer-fit",
      POCKETJS_RASTER_DENSITY: "1",
      POCKETJS_AUX_LOGICAL_WIDTH: "",
      POCKETJS_AUX_LOGICAL_HEIGHT: "",
      POCKETJS_AUX_PHYSICAL_WIDTH: "",
      POCKETJS_AUX_PHYSICAL_HEIGHT: "",
      POCKETJS_AUX_PRESENTATION: "",
      POCKETJS_AUX_RASTER_DENSITY: "",
    });
  });
});
