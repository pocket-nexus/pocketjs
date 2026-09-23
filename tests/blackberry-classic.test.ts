import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { POCKET_TARGETS } from "../contracts/spec/platforms.ts";
import { checkAppTypes } from "../framework/compiler/app-check.ts";
import { verifyPlanHash } from "../framework/src/manifest/plan.ts";
import { extractHostBuildInputs } from "../framework/src/manifest/host-build-inputs.ts";
import { packageIdentity, renderTemplate } from "../tools/native-host-build.ts";
import {
  BLACKBERRY_CLASSIC_DEV_CONTRACTS,
  BLACKBERRY_CLASSIC_HOST_ABI,
  BLACKBERRY_CLASSIC_LOGICAL_VIEWPORT,
  BLACKBERRY_CLASSIC_PHYSICAL_VIEWPORT,
  BLACKBERRY_CLASSIC_RASTER_DENSITY,
  BLACKBERRY_QNX_DEV_TARGET_ID,
  resolveBlackBerryClassicBuildPlan,
} from "../tools/blackberry-classic-profile.ts";

const repository = join(import.meta.dir, "..");
const manifestPath = join(repository, "apps/blackberry-classic-demo/pocket.json");
const targets = [BLACKBERRY_QNX_DEV_TARGET_ID] as const;

function manifest(): Record<string, any> {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

describe("private BlackBerry Classic profile", () => {
  test("register only the QNX host with its square density-2 contract", () => {
    expect(Object.keys(BLACKBERRY_CLASSIC_DEV_CONTRACTS.targets)).toEqual([...targets]);
    for (const target of targets) {
      expect(POCKET_TARGETS).not.toHaveProperty(target);
      expect(BLACKBERRY_CLASSIC_DEV_CONTRACTS.targets[target]).toEqual({
        hostAbi: BLACKBERRY_CLASSIC_HOST_ABI,
        platform: "blackberry10-qnx",
        form: "takeover",
        display: {
          physicalViewport: BLACKBERRY_CLASSIC_PHYSICAL_VIEWPORT,
          logicalViewports: [BLACKBERRY_CLASSIC_LOGICAL_VIEWPORT],
          presentations: ["native"],
          rasterDensity: BLACKBERRY_CLASSIC_RASTER_DENSITY,
        },
        capabilities: ["input.buttons", "input.touch", "text.glyphs.baked"],
      });
    }
  });

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
      expect(verifyPlanHash(plan)).toBe(true);
    }
  });

  test("derive the platform package identity from the plan, not from a second copy", () => {
    const plan = resolveBlackBerryClassicBuildPlan(manifest(), BLACKBERRY_QNX_DEV_TARGET_ID);
    const inputs = extractHostBuildInputs(plan, { expectedTarget: BLACKBERRY_QNX_DEV_TARGET_ID });
    expect(inputs.app).toEqual({
      id: "dev.pocket-stack.blackberry-classic-demo",
      title: "PocketJS: BlackBerry Classic Hero",
      version: "0.1.1",
    });
    expect(packageIdentity(inputs.app)).toEqual({
      packageId: "dev.pocket_stack.blackberry_classic_demo",
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

describe("BlackBerry Classic toolchain pins", () => {
  const qnx = JSON.parse(
    readFileSync(join(repository, "tools/cli/blackberry-qnx-toolchain.json"), "utf8"),
  );
  test("the QNX host pins QuickJS, Rust, and the Hero manifest", () => {
    expect(qnx.quickjs.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(qnx.rust.toolchain).toBe("nightly-2026-07-02");
    expect(qnx.app.manifest).toBe("apps/blackberry-classic-demo/pocket.json");
  });

  test("the QNX host pins the BBNDK image by digest and ships its Rust target", () => {
    expect(qnx.image.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(qnx.image.platform).toBe("linux/amd64");
    expect(qnx.qnx.architecture).toBe("armle-v7");
    expect(existsSync(join(repository, qnx.rust.target))).toBe(true);
  });
});
