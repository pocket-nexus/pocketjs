import { readPocketManifest } from "../framework/src/manifest/load.ts";
import { describe, expect, test } from "bun:test";
import {
existsSync,
mkdtempSync,
readdirSync,
readFileSync,
rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
import {
SYMBIAN_E7_DEV_CONTRACTS,
SYMBIAN_E7_DEV_HOST_ABI,
SYMBIAN_E7_DEV_TARGET_ID,
resolveSymbianE7BuildPlan,
symbianE7Orientation,
} from "../tools/symbian-profile.ts";

const repository = new URL("..", import.meta.url).pathname;

describe("experimental Nokia E7 runtime profile", () => {
  test("maps the E7 scan matrix without changing unrelated keys", () => {
    const compiler = Bun.which("cc");
    expect(
      compiler,
      "cc is required to validate the Symbian key mapper",
    ).toBeTruthy();
    if (!compiler) return;
    const root = mkdtempSync(join(tmpdir(), "pocketjs-e7-key-map-"));
    try {
      const executable = join(root, "symbian-key-map-test");
      const compiled = Bun.spawnSync([
        compiler,
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        join(
          repository,
          "tests/fixtures/symbian-key-normalization-test.c",
        ),
        "-o",
        executable,
      ], { cwd: repository });
      expect(compiled.exitCode, compiled.stderr.toString()).toBe(0);

      // Managed macOS hosts can attach provenance to a freshly linked
      // temporary executable and hold its first launch beyond Bun's timeout.
      // This file is built above from the committed hermetic fixture.
      if (process.platform === "darwin") {
        const xattr = Bun.which("xattr");
        if (xattr) {
          Bun.spawnSync([
            xattr,
            "-d",
            "com.apple.provenance",
            executable,
          ]);
        }
      }
      const ran = Bun.spawnSync([executable], { cwd: repository });
      expect(ran.exitCode, ran.stderr.toString()).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the E7 profile admits only the apps whose viewport range it hosts", () => {
    const outputs: string[] = [];
    for (const app of readdirSync(join(repository, "apps")).sort()) {
      const manifestPath = join(repository, "apps", app, "pocket.app.json");
      if (!existsSync(manifestPath)) continue;
      const resolution = validateAndResolveBuildPlan(
        readPocketManifest(manifestPath).manifest,
        { target: SYMBIAN_E7_DEV_TARGET_ID },
        SYMBIAN_E7_DEV_CONTRACTS,
      );
      if (resolution.ok) outputs.push(resolution.plan.app.output);
    }
    // Clear's single manifest declares the E7 portrait range; the fixed
    // 480x272 console demos (Café among them) have no E7 viewport.
    expect(outputs).toEqual(["clear-main", "hero-main", "note-main"]);
  });

  test("selects the Hero's dynamic E7 viewport without changing its PSP viewport", () => {
    const manifest = JSON.parse(
      readFileSync(join(repository, "apps/hero/pocket.app.json"), "utf8"),
    );
    const plan = resolveSymbianE7BuildPlan(manifest);
    expect(plan.target).toEqual({
      id: SYMBIAN_E7_DEV_TARGET_ID,
      hostAbi: SYMBIAN_E7_DEV_HOST_ABI,
    });
    expect(plan.viewport).toEqual({
      logical: [640, 360],
      physical: [640, 360],
      presentation: "native",
      rasterDensity: 1,
      policy: "dynamic",
    });
    expect(plan.features["display.viewport.live"]).toBe(true);

    const psp = validateAndResolveBuildPlan(manifest, { target: "psp" });
    expect(psp.ok).toBe(true);
    if (!psp.ok) return;
    expect(psp.plan.viewport).toEqual({
      logical: [480, 272],
      physical: [480, 272],
      presentation: "integer-fit",
      rasterDensity: 1,
      policy: "fixed",
    });
    expect(psp.plan.features["display.viewport.live"]).toBe(false);
  });

  test("holds a portrait-only range in portrait and binds physics for the plans that require it", () => {
    const manifest = (path: string) => readPocketManifest(join(repository, path)).manifest as any;
    const orientation = (path: string) => symbianE7Orientation(manifest(path), resolveSymbianE7BuildPlan(manifest(path)));
    // Clear and Pocket Nexus lay out once for 360x640; Hero relayouts live
    expect(orientation("apps/clear/pocket.app.json")).toBe("portrait");
    expect(orientation("apps/nexus-touch/pocket.app.symbian.json")).toBe("portrait");
    expect(orientation("apps/hero/pocket.app.json")).toBe("auto");
    // a navigation registry entry held in portrait folds into the same lock
    const hero = manifest("apps/hero/pocket.app.json");
    expect(symbianE7Orientation(hero, resolveSymbianE7BuildPlan(hero), "portrait")).toBe("portrait");
    const wide = { ...hero, app: { ...hero.app, viewport: { dynamic: { default: [640, 360], min: [640, 360], max: [640, 360] } } } };
    expect(symbianE7Orientation(wide, resolveSymbianE7BuildPlan(wide))).toBe("landscape");
    expect(() => symbianE7Orientation(wide, resolveSymbianE7BuildPlan(wide), "portrait")).toThrow("admits landscape only");
    expect(resolveSymbianE7BuildPlan(manifest("apps/nexus-touch/pocket.app.symbian.json")).features["ui.physics"]).toBe(true);
    expect(resolveSymbianE7BuildPlan(manifest("apps/clear/pocket.app.json")).features["ui.physics"]).toBeUndefined();

  });
});
