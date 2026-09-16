import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolveMotoGPlayBuildPlan } from "../tools/moto-g-play-profile.ts";
import { extractHostBuildInputs } from "../framework/src/manifest/host-build-inputs.ts";
test("Moto Clear resolves full-panel logical geometry and requires the implemented offload capability", () => {
  const manifest = JSON.parse(readFileSync("apps/clear/pocket.android.json", "utf8"));
  const plan = resolveMotoGPlayBuildPlan(manifest);
  const inputs = extractHostBuildInputs(plan, { expectedTarget: "moto-g-play-dev" });
  expect(inputs.viewport).toEqual({ logical: [360, 800], physical: [720, 1600], rasterDensity: 2, presentation: "native" });
  manifest.app.viewport.fixed.logical = [320, 480];
  expect(() => resolveMotoGPlayBuildPlan(manifest)).toThrow();
});
