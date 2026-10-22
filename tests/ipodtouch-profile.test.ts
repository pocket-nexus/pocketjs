import { afterAll, describe, expect, test } from "bun:test";
import { loadImage } from "@napi-rs/canvas";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { POCKET_TARGETS } from "../contracts/spec/platforms.ts";
import { checkAppTypes } from "../framework/compiler/app-check.ts";
import { verifyPlanHash } from "../framework/src/manifest/plan.ts";
import {
  IPODTOUCH_DEV_CONTRACTS,
  IPODTOUCH_DEV_HOST_ABI,
  IPODTOUCH_DEV_TARGET_ID,
  IPODTOUCH_LOGICAL_VIEWPORT,
  IPODTOUCH_PHYSICAL_VIEWPORT,
  IPODTOUCH_RASTER_DENSITY,
  resolveIPodTouchBuildPlan,
} from "../tools/ipodtouch-profile.ts";
import {
  IPODTOUCH_ICON_OUTPUTS,
  bakeIPodTouchArtwork,
} from "../tools/ipodtouch-icon.ts";
import {
  deploymentInstallCommand,
  ipodTouchDeploymentPaths,
} from "../tools/ipodtouch.ts";

const REPOSITORY = fileURLToPath(new URL("../", import.meta.url));
const MANIFEST = join(REPOSITORY, "apps/ipodtouch-demo/pocket.json");
const ENTRY = join(REPOSITORY, "apps/ipodtouch-demo/main.tsx");
const ICON = join(REPOSITORY, "programs/ipodtouch6/Icon.svg");
const INFO = join(REPOSITORY, "programs/ipodtouch6/Info.plist");
const RUNTIME = join(REPOSITORY, "programs/ipodtouch6/runtime.m");
const SURFACE = join(REPOSITORY, "engine/ios/uikit/PocketSurfaceView.m");
const APPLE_CORE = join(REPOSITORY, "engine/ios/src/lib.rs");
const GUEST = join(REPOSITORY, "engine/guest-rquickjs/src/lib.rs");
const ICON_TOOL = join(REPOSITORY, "tools/ipodtouch-icon.ts");
const TOOL = join(REPOSITORY, "tools/ipodtouch.ts");
const OUTPUT = mkdtempSync(join(tmpdir(), "pocketjs-ipodtouch-icon-"));

afterAll(() => rmSync(OUTPUT, { recursive: true, force: true }));

function manifest(): Record<string, any> {
  return JSON.parse(readFileSync(MANIFEST, "utf8"));
}

describe("private iPod touch 6 profile", () => {
  test("describes the exact Retina takeover surface without entering POCKET_TARGETS", () => {
    expect(POCKET_TARGETS).not.toHaveProperty(IPODTOUCH_DEV_TARGET_ID);
    expect(IPODTOUCH_DEV_CONTRACTS.targets[IPODTOUCH_DEV_TARGET_ID]).toEqual({
      tickHz: 60,
      hostAbi: IPODTOUCH_DEV_HOST_ABI,
      platform: "ios",
      form: "takeover",
      display: {
        physicalViewport: IPODTOUCH_PHYSICAL_VIEWPORT,
        logicalViewports: [IPODTOUCH_LOGICAL_VIEWPORT],
        presentations: ["native"],
        rasterDensity: IPODTOUCH_RASTER_DENSITY,
      },
      capabilities: ["input.touch", "text.glyphs.baked"],
    });
  });

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
    expect(verifyPlanHash(plan)).toBe(true);
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
    const source = readFileSync(ICON, "utf8");
    expect(source).toContain('viewBox="0 0 1024 1024"');
    expect(source).toContain('id="ios7-background"');
    expect(source).toContain('id="ios7-highlight"');
    expect(source).toContain('id="pocket-ambient"');
    expect(source).toContain('stop-color="#171226"');
    expect(source).toContain('stop-color="#ffd23f"');
    expect(source).toContain('stop-color="#ff5f9e"');
    expect(source).toContain('stroke="#ffd23f" stroke-width="2.6"');
    expect(source).toContain('data-brand-source="site/assets/favicon.svg"');
    expect(source).toContain('transform="translate(96 96) scale(26)"');
    expect(source).toContain('<circle cx="10" cy="16" r="3.1"');
    expect(source).toContain('<rect x="16" y="12.6" width="10" height="2.2" rx="1.1"');
    expect(source).toContain('<rect x="16" y="17.2" width="6.5" height="2.2" rx="1.1"');
    expect(source).not.toContain("<text");
    const baker = readFileSync(ICON_TOOL, "utf8");
    expect(baker).toContain("const ICON_SUPERSAMPLE = 8");
    expect(baker).toContain("function svgForRasterSize(size: number)");
    expect(baker).toContain("function exactAreaDownsample");
    expect(baker).toContain("samplesPerPixel");
    expect(source).not.toContain("<filter");
    expect(source).not.toContain('id="pocketSilhouette"');
    expect(source).not.toContain('id="chrome"');
    expect(source).not.toContain('id="enamel"');

    await bakeIPodTouchArtwork(OUTPUT);
    for (const [name, size] of Object.entries(IPODTOUCH_ICON_OUTPUTS)) {
      const image = await loadImage(join(OUTPUT, name));
      expect([image.width, image.height]).toEqual([size, size]);
    }
    const launch = await loadImage(join(OUTPUT, "Default-568h@2x.png"));
    expect([launch.width, launch.height]).toEqual([640, 1136]);
  });

  test("binds the standalone UIKit host to the device identity and receipt", () => {
    const info = readFileSync(INFO, "utf8");
    const runtime = readFileSync(RUNTIME, "utf8");
    const surface = readFileSync(SURFACE, "utf8");
    const appleCore = readFileSync(APPLE_CORE, "utf8");
    const guest = readFileSync(GUEST, "utf8");
    const tool = readFileSync(TOOL, "utf8");

    expect(info).toContain("<string>12.0</string>");
    expect(info).toContain("<string>pocketjs-ipodtouch</string>");
    expect(info).toContain("<string>Icon</string>");
    expect(info.match(/<string>Icon-60<\/string>/g)).toHaveLength(2);
    expect(info).not.toContain("<string>Icon@2x.png</string>");
    expect(info).not.toContain("<string>Icon-60@2x.png</string>");
    expect(runtime).toContain('hostId:@"ipodtouch-dev"');
    expect(runtime).toContain("hostAbi:POCKET_BINDING_GENERATION");
    expect(runtime).toContain("application.idleTimerDisabled = YES");
    expect(runtime).toContain("application.idleTimerDisabled = NO");
    expect(runtime).toContain("screen.brightness = PocketRecoveredBrightness");
    expect(runtime).toContain('@"screen_brightness"');
    expect(runtime).toContain('@"idle_timer_disabled"');
    expect(runtime).toContain('if (![strongSelf.state isEqualToString:@"running"])');
    expect(runtime).toContain('@"ipodtouch.hero_tap"');
    expect(runtime).toContain("completedTouchSequences");
    expect(runtime).toContain("PocketFramePath");
    expect(runtime).toContain('@"loading_guest"');
    expect(runtime).toContain('@"frame_timer_started"');
    expect(runtime).toContain("applicationDidBecomeActive");
    expect(runtime).toContain("startWithFixedFrameTimer");
    expect(surface).toContain("self.onFrame(_frameNumber, count)");
    expect(surface).toContain("startWithFixedFrameTimer");
    expect(surface).toContain("_tickRate > 0 ? _tickRate : kPocketSurfaceDefaultTickRate");
    expect(surface).toContain("[_frameTimer invalidate]");
    expect(surface).toContain("_logicalWidth > 512 || _logicalHeight > 512");
    expect(surface).toContain("0x80000000u");
    expect(surface).toContain("((y & 0x3ff) << 10)");
    expect(appleCore).toContain("pocket_runtime_tick(state.runtime.get())");
    expect(appleCore).toContain("RquickjsGuest::new(BindingProfile::Canonical)");
    expect(guest).toContain("frame.hits.iter().enumerate()");
    expect(tool).toContain('const DEVICE_TYPE = "iPod7,1"');
    expect(tool).toContain('const DEVICE_VERSION = "12.5.8"');
    expect(tool).toContain('const DEVICE_PORT = 44');
    expect(tool).toContain('POCKETJS_IPODTOUCH_PORT ?? "2223"');
    expect(tool).toContain('`${LOCAL_PORT}:${DEVICE_PORT}`');
    expect(tool).toContain('COPYFILE_DISABLE: "1"');
    expect(tool).toContain('label: "native/libpocket_apple.a"');
    expect(tool).toContain("path: rustLibrary");
    expect(tool).toContain('join(REPOSITORY, "tools/ipodtouch.ts")');
    expect(tool).toContain("const port = await availableLocalPort()");
    expect(tool).toContain('cmd: ["iproxy", "-u", udid, `${port}:${DEVICE_PORT}`]');
    expect(tool).not.toContain('if (remote("true").exitCode === 0)');
    const tunnelSource = tool.slice(
      tool.indexOf("async function withTunnel"),
      tool.indexOf("async function doctor"),
    );
    expect(tunnelSource.indexOf("verifyDeviceIdentity()")).toBeLessThan(
      tunnelSource.indexOf("Bun.spawn"),
    );
    expect(tool.indexOf("await tunnel.exited")).toBeLessThan(
      tool.indexOf("new Response(tunnel.stderr"),
    );
    expect(tool).toContain('join(REPOSITORY, "programs/ipodtouch6/Info.plist")');
    expect(tool).toContain('join(REPOSITORY, "tools/ipodtouch-icon.ts")');
    expect(tool).toContain("pocketjs-ipodtouch.deploy.lock");
    expect(tool.indexOf('if mkdir \\"$lock\\"')).toBeLessThan(
      tool.indexOf('rm -rf \\"$stage\\" \\"$unpack\\"'),
    );
    expect(tool).toContain('[ \\"$(cat \\"$lock/owner\\")\\" = \\"$tx\\" ]');
    expect(tool).toContain("byte-exact readback");
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
