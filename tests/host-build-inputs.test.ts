import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { describe, expect, test } from "bun:test";
import { extractHostBuildInputs, hostBuildEnvironment } from "../framework/src/manifest/host-build-inputs.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
import { finalizeBuildPlan } from "../framework/src/manifest/plan.ts";
import { canonicalProfileJson } from "../framework/src/profile.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeHostProfileHeader } from "../tools/host-profile.ts";

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
    expect(extractHostBuildInputs(plan, { expectedTarget: "psp" })).toMatchObject({
      profile: plan.profile,
      appOutput: "main",
      app: { id: "dev.pocket-nexus.telemetry", title: "Pocket Telemetry", version: "0.1.0" },
      target: "psp",
      hostAbi: POCKET_BINDING_GENERATION,
      viewport: {
        logical: [480, 272],
        physical: [480, 272],
        presentation: "integer-fit",
        rasterDensity: 1,
      },
    });
  });

  test("rejects an unexpected target", () => {
    const plan = portablePlan();
    expect(() => extractHostBuildInputs(plan, { expectedTarget: "vita" }))
      .toThrow("expected target vita, got psp");
  });

  test("rejects legacy binding generations with a valid plan", () => {
    const plan = portablePlan();
    const { planHash: _hash, ...content } = plan;
    const inputs = extractHostBuildInputs(plan);
    for (let generation = 1; generation < POCKET_BINDING_GENERATION; generation++) {
      const stale = finalizeBuildPlan({ ...content, target: { ...plan.target, hostAbi: generation } });
      expect(() => extractHostBuildInputs(stale)).toThrow("binding generation");
      expect(() => hostBuildEnvironment({ ...inputs, hostAbi: generation }, { outputDirectory: "/tmp", embedApp: false })).toThrow("binding generation");
    }
  });

  test("the standalone compiler rejects a stale plan before looking up application files", () => {
    const parent = join(import.meta.dir, "../.pocket-build/validation/binding-generation");
    mkdirSync(parent, { recursive: true });
    const directory = mkdtempSync(join(parent, "stale-plan-"));
    try {
      const { planHash: _hash, ...content } = portablePlan();
      const stale = finalizeBuildPlan({ ...content, target: { ...content.target, hostAbi: 1 } });
      const path = join(directory, "plan.json");
      writeFileSync(path, JSON.stringify(stale));
      const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../tools/build.ts"), `--plan=${path}`, `--project-root=${directory}`, `--outdir=${directory}/out`]);
      expect(result.success).toBe(false);
      expect(result.stderr.toString()).toContain("binding generation 1 is unsupported");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("generates one target-neutral native environment", () => {
    const inputs = extractHostBuildInputs(portablePlan());
    expect(hostBuildEnvironment(inputs, {
      outputDirectory: "/tmp/pocket",
      embedApp: false,
    })).toMatchObject({
      POCKETJS_PROFILE_JSON: canonicalProfileJson(inputs.profile),
      POCKETJS_TICK_HZ: "60",
      POCKETJS_APP_OUTPUT: "main",
      POCKETJS_APP_ID: "dev.pocket-nexus.telemetry",
      POCKETJS_APP_TITLE: "Pocket Telemetry",
      POCKETJS_APP_VERSION: "0.1.0",
      POCKETJS_EMBED_APP: "0",
      POCKETJS_OUTPUT_DIR: "/tmp/pocket",
      POCKETJS_TARGET: "psp",
      POCKETJS_HOST_ABI: String(POCKET_BINDING_GENERATION),
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

  test("C build header preserves canonical UTF-8 bytes", () => {
    const parent = join(import.meta.dir, "../.pocket-build/validation/profile-admission");
    mkdirSync(parent, { recursive: true });
    const directory = mkdtempSync(join(parent, "header-"));
    try {
      const profile = { ...portablePlan().profile, id: "custom-??/设备" };
      writeHostProfileHeader(directory, profile);
      const source = join(directory, "consumer.c"), binary = join(directory, "consumer");
      writeFileSync(source, '#include <stdio.h>\n#include "pocket_host_profile.h"\nint main(void){fwrite(POCKETJS_HOST_PROFILE_JSON,1,sizeof POCKETJS_HOST_PROFILE_JSON-1,stdout);return POCKETJS_HOST_PROFILE_TICK_HZ==60u?0:1;}\n');
      const compile = Bun.spawnSync([process.env.CC ?? "cc", "-std=c11", "-Wall", "-Wextra", "-Werror", source, "-o", binary]);
      if (!compile.success) throw new Error(compile.stderr.toString());
      const run = Bun.spawnSync([binary]);
      expect(run.success).toBe(true);
      expect(run.stdout).toEqual(Buffer.from(canonicalProfileJson(profile)));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
