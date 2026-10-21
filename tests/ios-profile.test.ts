import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { POCKET_TARGETS } from "../contracts/spec/platforms.ts";
import { checkAppTypes } from "../framework/compiler/app-check.ts";
import { verifyPlanHash } from "../framework/src/manifest/plan.ts";
import {
  IOS_DEV_CONTRACTS,
  IOS_DEV_DEFAULT_DENSITY,
  IOS_DEV_HOST_ABI,
  IOS_DEV_TARGET_ID,
  IOS_DEV_VIEWPORT,
  iosDevContracts,
  resolveIOSDevBuildPlan,
} from "../tools/ios-profile.ts";

const REPOSITORY = fileURLToPath(new URL("../", import.meta.url));
const MANIFEST_PATH = join(REPOSITORY, "apps/nsengine/pocket.json");
const ENTRY_PATH = join(REPOSITORY, "apps/nsengine/main.tsx");
const SURFACE_VIEW_PATH = join(REPOSITORY, "engine/ios/uikit/PocketSurfaceView.m");
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
  test("stays private and describes the embedded PocketSurfaceView", () => {
    expect(POCKET_TARGETS).not.toHaveProperty(IOS_DEV_TARGET_ID);
    expect(IOS_DEV_CONTRACTS.targets[IOS_DEV_TARGET_ID]).toEqual({
      tickHz: 60,
      hostAbi: IOS_DEV_HOST_ABI,
      platform: "ios",
      form: "embedded",
      display: {
        physicalViewport: [
          IOS_DEV_VIEWPORT[0] * IOS_DEV_DEFAULT_DENSITY,
          IOS_DEV_VIEWPORT[1] * IOS_DEV_DEFAULT_DENSITY,
        ],
        logicalViewports: [[480, 272]],
        presentations: ["native", "integer-fit"],
        rasterDensity: IOS_DEV_DEFAULT_DENSITY,
      },
      capabilities: ["input.touch", "text.glyphs.baked"],
    });
  });

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
    expect(verifyPlanHash(plan)).toBe(true);
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

  test("the native surface publishes the profile's identity", () => {
    // Plan-built bundles refuse hosts whose ui.__host/__hostAbi differ
    // (framework/src/host.ts assertNativeHostContract); the surface, the
    // profile and any external-guest host must agree on this pair.
    const surface = readFileSync(SURFACE_VIEW_PATH, "utf8");
    expect(surface).toContain(`kPocketSurfaceHostId = "${IOS_DEV_TARGET_ID}"`);
    expect(surface).toContain("kPocketSurfaceHostAbi = POCKET_BINDING_GENERATION");
    expect(surface).toContain("hostId:[NSString stringWithUTF8String:kPocketSurfaceHostId]");
    expect(surface).toContain("hostAbi:kPocketSurfaceHostAbi");
    expect(surface).toContain("pocket_apple_set_identity(_handle, hostId.UTF8String, hostAbi)");
  });

  test("the tick rate is declared before the bundle evaluates and published at mount", () => {
    // Bundles bake their rate and refuse a host whose ui.__tickHz differs
    // (framework/src/host.ts assertNativeHostContract), which only works if
    // the rate reaches the realm before eval: the C ABI orders
    // [set_tick_rate] ahead of eval_bundle, the surface applies the property
    // in its setter (start only pins the display link), and the mounted
    // namespace carries __tickHz.
    const header = readFileSync(
      join(REPOSITORY, "engine/ios/include/pocket_apple.h"),
      "utf8",
    );
    expect(header).toContain("[set_tick_rate] -> eval_bundle");
    const surface = readFileSync(SURFACE_VIEW_PATH, "utf8");
    expect(surface).toContain("- (void)setTickRate:");
    expect(surface.slice(surface.indexOf("- (void)start"))).not.toContain(
      "set_tick_rate",
    );
    const mount = readFileSync(
      join(REPOSITORY, "engine/guest-rquickjs/src/lib.rs"),
      "utf8",
    );
    expect(mount).toContain('ui.set("__tickHz", environment.tick_hz)');
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
