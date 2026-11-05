import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAppTypes } from "../framework/compiler/app-check.ts";
import { IOS_DEV_DEFAULT_DENSITY, IOS_DEV_HOST_ABI, IOS_DEV_TARGET_ID, iosDevContracts, resolveIOSDevBuildPlan } from "../tools/ios-profile.ts";

const REPOSITORY = fileURLToPath(new URL("../", import.meta.url));
const MANIFEST_PATH = join(REPOSITORY, "apps/nsengine/pocket.app.json");
const ENTRY_PATH = join(REPOSITORY, "apps/nsengine/main.tsx");
const ROOT_TSCONFIG = join(REPOSITORY, "tsconfig.json");
const JSX_DECLARATIONS = join(REPOSITORY, "framework/src/jsx.d.ts");

function demoManifest(): Record<string, any> {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
}

function typeErrors(result: ReturnType<typeof checkAppTypes>): string {
  return result.diagnostics
    .filter((diagnostic) => diagnostic.category === "error")
    .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
    .join("\n");
}

describe("private iOS build profile", () => {

  test("resolves the nsengine demo to an exact surface plan", () => {
    const plan = resolveIOSDevBuildPlan(demoManifest());

    expect(plan.target).toEqual({
      id: IOS_DEV_TARGET_ID,
      hostAbi: IOS_DEV_HOST_ABI,
    });
    expect(plan.viewport).toEqual({
      logical: [480, 272],
      physical: [480 * IOS_DEV_DEFAULT_DENSITY, 272 * IOS_DEV_DEFAULT_DENSITY],
      presentation: "integer-fit",
      rasterDensity: IOS_DEV_DEFAULT_DENSITY,
      policy: "fixed",
    });
    expect(plan.features).toEqual({
      "input.touch": true,
      "text.glyphs.baked": true,
    });
    expect(plan.app.entry).toBe("apps/nsengine/main.tsx");
    expect(plan.app.output).toBe("nsengine-main");
  });

  test("density selects the physical surface", () => {
    expect(
      iosDevContracts(2).targets[IOS_DEV_TARGET_ID].display.physicalViewport,
    ).toEqual([960, 544]);
    expect(resolveIOSDevBuildPlan(demoManifest(), 4).viewport.physical).toEqual([1920, 1088]);
    expect(() => iosDevContracts(0)).toThrow("1..4");
    expect(() => iosDevContracts(5)).toThrow("1..4");
    expect(() => iosDevContracts(2.5)).toThrow("1..4");
  });

  test("refuses capabilities and viewports the surface cannot provide", () => {
    const needsButtons = demoManifest();
    needsButtons.engine.capabilities.requires.push("input.buttons");
    expect(() => resolveIOSDevBuildPlan(needsButtons)).toThrow("input.buttons");

    const wrongViewport = demoManifest();
    wrongViewport.app.viewport.fixed.logical = [320, 480];
    expect(() => resolveIOSDevBuildPlan(wrongViewport)).toThrow("320x480");
  });

  test("type-checks the nsengine demo's explicit imports", () => {
    const result = checkAppTypes({
      entry: ENTRY_PATH,
      tsconfigPath: ROOT_TSCONFIG,
      declarationFiles: [JSX_DECLARATIONS],
    });

    expect(typeErrors(result)).toBe("");
    expect(result.ok).toBe(true);
    expect(
      result.checkedFiles.some((file) => file.endsWith("/apps/nsengine/main.tsx")),
    ).toBe(true);
    expect(
      result.checkedFiles.some((file) => file.endsWith("/apps/nsengine/app.tsx")),
    ).toBe(true);
  });
});
