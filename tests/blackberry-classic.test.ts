import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkAppTypes } from "../framework/compiler/app-check.ts";
import { extractHostBuildInputs } from "../framework/src/manifest/host-build-inputs.ts";
import { packageIdentity, renderTemplate } from "../tools/native-host-build.ts";
import { BLACKBERRY_CLASSIC_HOST_ABI, BLACKBERRY_CLASSIC_LOGICAL_VIEWPORT, BLACKBERRY_CLASSIC_PHYSICAL_VIEWPORT, BLACKBERRY_CLASSIC_RASTER_DENSITY, BLACKBERRY_QNX_DEV_TARGET_ID, resolveBlackBerryClassicBuildPlan } from "../tools/blackberry-classic-profile.ts";

const repository = join(import.meta.dir, "..");
const manifestPath = join(repository, "apps/blackberry-classic-demo/pocket.json");
const targets = [BLACKBERRY_QNX_DEV_TARGET_ID] as const;

function manifest(): Record<string, any> {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

describe("private BlackBerry Classic profile", () => {

  test("resolve the Hero demo to the exact QNX device plan", () => {
    for (const target of targets) {
      const plan = resolveBlackBerryClassicBuildPlan(manifest(), target);
      expect(plan.target).toEqual({ id: target, hostAbi: BLACKBERRY_CLASSIC_HOST_ABI });
      expect(plan.viewport).toEqual({
        logical: BLACKBERRY_CLASSIC_LOGICAL_VIEWPORT,
        physical: BLACKBERRY_CLASSIC_PHYSICAL_VIEWPORT,
        presentation: "native",
        rasterDensity: BLACKBERRY_CLASSIC_RASTER_DENSITY,
        policy: "fixed",
      });
      expect(plan.features).toEqual({
        "input.buttons": true,
        "input.touch": true,
        "text.glyphs.baked": true,
      });
      expect(plan.companions).toEqual([]);
      expect(plan.app.output).toBe("blackberry-classic-main");
    }
  });

  test("derive the platform package identity from the plan, not from a second copy", () => {
    const plan = resolveBlackBerryClassicBuildPlan(manifest(), BLACKBERRY_QNX_DEV_TARGET_ID);
    const inputs = extractHostBuildInputs(plan, { expectedTarget: BLACKBERRY_QNX_DEV_TARGET_ID });
    expect(inputs.app).toEqual({
      id: "dev.pocket-nexus.blackberry-classic-demo",
      title: "PocketJS: BlackBerry Classic Hero",
      version: "0.1.1",
    });
    expect(packageIdentity(inputs.app)).toEqual({
      packageId: "dev.pocket_nexus.blackberry_classic_demo",
      version: "0.1.1",
      versionCode: 1001,
      title: "PocketJS: BlackBerry Classic Hero",
    });
    expect(() => packageIdentity({ ...inputs.app, id: "dev.9bad.segment" })).toThrow("package name");
    expect(() => packageIdentity({ ...inputs.app, version: "1.2" })).toThrow("major.minor.patch");
    expect(packageIdentity({ ...inputs.app, version: "2.34.5-rc.1" }).versionCode).toBe(2_034_005);
    expect(renderTemplate("<id>@POCKET_ID@</id>", { ID: "a.b" })).toBe("<id>a.b</id>");
    expect(() => renderTemplate("<id>@POCKET_ID@</id>", {})).toThrow("@POCKET_ID@");
  });

  test("reject capabilities and viewports the Classic host does not implement", () => {
    const needsIme = manifest();
    needsIme.engine.capabilities.requires.push("input.ime");
    expect(() => resolveBlackBerryClassicBuildPlan(needsIme, BLACKBERRY_QNX_DEV_TARGET_ID))
      .toThrow("input.ime");

    const stretched = manifest();
    stretched.app.viewport.fixed.logical = [320, 480];
    expect(() => resolveBlackBerryClassicBuildPlan(stretched, BLACKBERRY_QNX_DEV_TARGET_ID))
      .toThrow("320x480");
  });

  test("type-check the explicit Solid and PocketJS imports of the demo", () => {
    const result = checkAppTypes({
      entry: join(repository, "apps/blackberry-classic-demo/main.tsx"),
      tsconfigPath: join(repository, "tsconfig.json"),
      declarationFiles: [join(repository, "framework/src/jsx.d.ts")],
    });
    expect(
      result.diagnostics
        .filter((diagnostic) => diagnostic.category === "error")
        .map((diagnostic) => diagnostic.message),
    ).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
