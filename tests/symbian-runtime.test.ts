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
import type { AppConfig } from "../contracts/spec/app-config.ts";
import { resolveAppPlan } from "../framework/compiler/app-plan.ts";
import { loadHostConfig } from "../tools/profile-resolver.ts";
import {
SYMBIAN_E7_DEV_CONTRACTS,
SYMBIAN_E7_DEV_HOST_ABI,
SYMBIAN_E7_DEV_TARGET_ID,
resolveSymbianE7BuildPlan,
symbianE7Orientation,
} from "../tools/symbian-profile.ts";

const repository = new URL("..", import.meta.url).pathname;
/** The host config of a committed application, relative to the repository. */
const config = (path: string) => loadHostConfig(join(repository, path));
const appOf = async (path: string): Promise<AppConfig> => (await config(path)).value.app!;

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

  test("the apps that list the E7 resolve against its viewport range", async () => {
    const listed: string[] = [];
    for (const app of readdirSync(join(repository, "apps")).sort()) {
      for (const path of [`apps/${app}/pocket.host.config.ts`, `apps/${app}/e7/pocket.host.config.ts`]) {
        if (!existsSync(join(repository, path))) continue;
        const loaded = await config(path);
        if (!loaded.profiles.some(profile => profile.id === SYMBIAN_E7_DEV_TARGET_ID)) continue;
        const resolution = resolveAppPlan(loaded.value.app, { target: SYMBIAN_E7_DEV_TARGET_ID }, SYMBIAN_E7_DEV_CONTRACTS);
        expect(resolution.ok, path).toBe(true);
        if (resolution.ok) listed.push(resolution.plan.app.output);
      }
    }
    // Clear's config declares the E7 portrait range and Pocket Nexus has an
    // E7 build in apps/nexus-touch/e7; the fixed 480x272 console demos (Café
    // among them) have no E7 viewport.
    expect(listed).toEqual(["clear-main", "hero-main", "nexus-touch-e7", "note-main"]);
    const cafe = resolveAppPlan(await appOf("apps/cafe/pocket.host.config.ts"), { target: SYMBIAN_E7_DEV_TARGET_ID }, SYMBIAN_E7_DEV_CONTRACTS);
    expect(cafe.ok).toBe(false);
  });

  test("selects the Hero's dynamic E7 viewport without changing its PSP viewport", async () => {
    const hero = await appOf("apps/hero/pocket.host.config.ts");
    const plan = resolveSymbianE7BuildPlan(hero);
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

    const psp = resolveAppPlan(hero, { target: "psp" });
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

  test("holds a portrait-only range in portrait and binds physics for the plans that turn it on", async () => {
    const clear = await appOf("apps/clear/pocket.host.config.ts");
    const nexus = await appOf("apps/nexus-touch/e7/pocket.host.config.ts");
    const hero = await appOf("apps/hero/pocket.host.config.ts");
    // Clear and Pocket Nexus lay out once for 360x640; Hero relayouts live
    expect(symbianE7Orientation(clear.viewport)).toBe("portrait");
    expect(symbianE7Orientation(nexus.viewport)).toBe("portrait");
    expect(symbianE7Orientation(hero.viewport)).toBe("auto");
    // a package compiled elsewhere carries no viewport range and rotates
    expect(symbianE7Orientation(undefined)).toBe("auto");
    const wide = { ...hero, viewport: { dynamic: { default: [640, 360], min: [640, 360], max: [640, 360] } } } as const satisfies AppConfig;
    expect(symbianE7Orientation(wide.viewport)).toBe("landscape");
    expect(resolveSymbianE7BuildPlan(nexus).features["ui.physics"]).toBe(true);
    expect(resolveSymbianE7BuildPlan(clear).features["ui.physics"]).toBeUndefined();
  });
});
