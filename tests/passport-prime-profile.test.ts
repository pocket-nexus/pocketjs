import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { extractHostBuildInputs } from "../framework/src/manifest/host-build-inputs.ts";
import { PASSPORT_PRIME_TARGET, resolvePassportPrimeBuildPlan } from "../tools/passport-prime-profile.ts";

const clear = () => JSON.parse(readFileSync("apps/clear/pocket.passport-prime.json", "utf8"));

test("Clear resolves the Passport Prime surface: 480x760 below the Control Center, density 1", () => {
  const plan = resolvePassportPrimeBuildPlan(clear());
  const inputs = extractHostBuildInputs(plan, { expectedTarget: PASSPORT_PRIME_TARGET });
  expect(inputs.viewport).toEqual({ logical: [480, 760], physical: [480, 760], rasterDensity: 1, presentation: "native" });
  expect(inputs.hostAbi).toBe(12);
  const taller = clear();
  taller.app.viewport.fixed.logical = [480, 800];
  expect(() => resolvePassportPrimeBuildPlan(taller)).toThrow();
});

test("Passport Prime has no game keys: an app that requires input.buttons does not resolve", () => {
  const manifest = clear();
  manifest.engine.capabilities.requires = ["input.touch", "input.buttons"];
  expect(() => resolvePassportPrimeBuildPlan(manifest)).toThrow(/input\.buttons/);
});
