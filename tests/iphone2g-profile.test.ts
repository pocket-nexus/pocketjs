import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAppTypes } from "../framework/compiler/app-check.ts";
import { IPHONE2G_DEV_HOST_ABI, IPHONE2G_DEV_TARGET_ID, IPHONE2G_VIEWPORT, resolveIPhone2GBuildPlan } from "../tools/iphone2g-profile.ts";

const REPOSITORY = fileURLToPath(new URL("../", import.meta.url));
const MANIFEST_PATH = join(REPOSITORY, "apps/iphone2g-demo/pocket.json");
const ENTRY_PATH = join(REPOSITORY, "apps/iphone2g-demo/main.tsx");
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

describe("private iPhone 2G build profile", () => {

  test("resolves the touch-only Hero demo to an exact device plan", () => {
    const plan = resolveIPhone2GBuildPlan(demoManifest());

    expect(plan.target).toEqual({
      id: IPHONE2G_DEV_TARGET_ID,
      hostAbi: IPHONE2G_DEV_HOST_ABI,
    });
    expect(plan.viewport).toEqual({
      logical: IPHONE2G_VIEWPORT,
      physical: IPHONE2G_VIEWPORT,
      presentation: "native",
      rasterDensity: 1,
      policy: "fixed",
    });
    expect(plan.features).toEqual({
      "input.touch": true,
      "text.glyphs.baked": true,
    });
    expect(plan.app.entry).toBe("apps/iphone2g-demo/main.tsx");
  });

  test("refuses capabilities and viewports the device profile cannot provide", () => {
    const needsButtons = demoManifest();
    needsButtons.engine.capabilities.requires.push("input.buttons");
    expect(() => resolveIPhone2GBuildPlan(needsButtons)).toThrow(
      "input.buttons",
    );

    const wrongViewport = demoManifest();
    wrongViewport.app.viewport.fixed.logical = [480, 272];
    expect(() => resolveIPhone2GBuildPlan(wrongViewport)).toThrow("480x272");
  });

  test("type-checks the demo's explicit Solid and PocketJS imports", () => {
    const result = checkAppTypes({
      entry: ENTRY_PATH,
      tsconfigPath: ROOT_TSCONFIG,
      declarationFiles: [JSX_DECLARATIONS],
    });

    expect(typeErrors(result)).toBe("");
    expect(result.ok).toBe(true);
    expect(
      result.checkedFiles.some((file) =>
        file.endsWith("/apps/iphone2g-demo/main.tsx"),
      ),
    ).toBe(true);
    expect(
      result.checkedFiles.some((file) =>
        file.endsWith("/apps/iphone2g-demo/app.tsx"),
      ),
    ).toBe(true);
  });
});
