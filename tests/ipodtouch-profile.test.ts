import { afterAll, describe, expect, test } from "bun:test";
import { loadImage } from "@napi-rs/canvas";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAppTypes } from "../framework/compiler/app-check.ts";
import { IPODTOUCH_DEV_HOST_ABI, IPODTOUCH_DEV_TARGET_ID, IPODTOUCH_LOGICAL_VIEWPORT, IPODTOUCH_PHYSICAL_VIEWPORT, IPODTOUCH_RASTER_DENSITY, resolveIPodTouchBuildPlan } from "../tools/ipodtouch-profile.ts";
import { IPODTOUCH_ICON_OUTPUTS, bakeIPodTouchArtwork } from "../tools/ipodtouch-icon.ts";
import { deploymentInstallCommand, ipodTouchDeploymentPaths } from "../tools/ipodtouch.ts";

const REPOSITORY = fileURLToPath(new URL("../", import.meta.url));
const MANIFEST = join(REPOSITORY, "apps/ipodtouch-demo/pocket.json");
const ENTRY = join(REPOSITORY, "apps/ipodtouch-demo/main.tsx");
const OUTPUT = mkdtempSync(join(tmpdir(), "pocketjs-ipodtouch-icon-"));

afterAll(() => rmSync(OUTPUT, { recursive: true, force: true }));

function manifest(): Record<string, any> {
  return JSON.parse(readFileSync(MANIFEST, "utf8"));
}

describe("private iPod touch 6 profile", () => {
  test("resolves the device Hero to a verified plan", () => {
    const plan = resolveIPodTouchBuildPlan(manifest());
    expect(plan.target).toEqual({ id: IPODTOUCH_DEV_TARGET_ID, hostAbi: IPODTOUCH_DEV_HOST_ABI });
    expect(plan.viewport).toEqual({
      logical: IPODTOUCH_LOGICAL_VIEWPORT,
      physical: IPODTOUCH_PHYSICAL_VIEWPORT,
      presentation: "native",
      rasterDensity: IPODTOUCH_RASTER_DENSITY,
      policy: "fixed",
    });
    expect(plan.features).toEqual({ "input.touch": true, "text.glyphs.baked": true });
    expect(plan.app.entry).toBe("apps/ipodtouch-demo/main.tsx");
    expect(plan.app.output).toBe("ipodtouch-demo-main");
  });

  test("rejects capabilities and geometry the host does not provide", () => {
    const buttons = manifest();
    buttons.engine.capabilities.requires.push("input.buttons");
    expect(() => resolveIPodTouchBuildPlan(buttons)).toThrow("input.buttons");

    const wrongViewport = manifest();
    wrongViewport.app.viewport.fixed.logical = [320, 480];
    expect(() => resolveIPodTouchBuildPlan(wrongViewport)).toThrow("320x480");
  });

  test("type-checks explicit Solid and PocketJS imports", () => {
    const result = checkAppTypes({
      entry: ENTRY,
      tsconfigPath: join(REPOSITORY, "tsconfig.json"),
      declarationFiles: [join(REPOSITORY, "framework/src/jsx.d.ts")],
    });
    const errors = result.diagnostics
      .filter((diagnostic) => diagnostic.category === "error")
      .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
      .join("\n");
    expect(errors).toBe("");
    expect(result.ok).toBe(true);
  });

  test("bakes opaque iOS artwork from one SVG source", async () => {
    await bakeIPodTouchArtwork(OUTPUT);
    for (const [name, size] of Object.entries(IPODTOUCH_ICON_OUTPUTS)) {
      const image = await loadImage(join(OUTPUT, name));
      expect([image.width, image.height]).toEqual([size, size]);
    }
    const launch = await loadImage(join(OUTPUT, "Default-568h@2x.png"));
    expect([launch.width, launch.height]).toEqual([640, 1136]);
  });

  test("uses isolated deployment paths and retains rollback through validation", () => {
    const first = ipodTouchDeploymentPaths("a".repeat(24));
    const second = ipodTouchDeploymentPaths("b".repeat(24));
    expect(first.archive).not.toBe(second.archive);
    expect(first.stage).not.toBe(second.stage);
    expect(first.backup).not.toBe(second.backup);
    expect(first.lock).toBe(second.lock);
    expect(() => ipodTouchDeploymentPaths("../unsafe")).toThrow("24 lowercase hex digits");

    const install = deploymentInstallCommand("a".repeat(24), first);
    expect(install).toContain("trap rollback EXIT HUP INT TERM");
    expect(install).toContain('if [ "$installed_new" -eq 1 ]; then rm -rf "$dest"; fi');
    expect(install).toContain('if [ "$had_previous" -eq 1 ] && [ -e "$backup" ]');
    expect(install).toContain('mv "$backup" "$dest"');
    expect(install.lastIndexOf("/usr/bin/uicache")).toBeLessThan(
      install.lastIndexOf("trap - EXIT HUP INT TERM"),
    );
    expect(install.lastIndexOf("trap - EXIT HUP INT TERM")).toBeLessThan(
      install.lastIndexOf('rm -rf "$backup"'),
    );
  });
});
