import { describe, expect, test } from "bun:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POCKET_TARGETS } from "../contracts/spec/platforms.ts";
import { verifyPlanHash } from "../framework/src/manifest/plan.ts";
import {
  IPHONE4S_DEV_CONTRACTS,
  IPHONE4S_DEV_HOST_ABI,
  IPHONE4S_DEV_TARGET_ID,
  IPHONE4S_LOGICAL_VIEWPORT,
  IPHONE4S_PHYSICAL_VIEWPORT,
  IPHONE4S_RASTER_DENSITY,
  resolveIPhone4SBuildPlan,
} from "../tools/iphone4s-profile.ts";
import { IPHONE4S_TOOLCHAIN } from "../tools/iphone4s-toolchain.ts";
import { rasterizeIconSvg } from "../tools/icon-raster.ts";
import {
  bakeClassicIPhoneArtwork,
  IPHONE_CLASSIC_ICON_FILE,
  IPHONE_CLASSIC_RETINA_ICON_FILE,
  IPHONE_USER_ICON_FILE,
  IPHONE_USER_RETINA_ICON_FILE,
} from "../tools/iphone-classic-icon.ts";
import {
  buildReceiptsMatch,
  deploymentAcquireLockCommand,
  deploymentInstallCommand,
  deploymentRenewLockCommand,
  iphone4sDeploymentPaths,
} from "../tools/iphone4s.ts";

const repository = join(import.meta.dir, "..");

describe("private iPhone 4S profile", () => {
  test("pins the exact Retina iOS 6 takeover surface", () => {
    expect(POCKET_TARGETS).not.toHaveProperty(IPHONE4S_DEV_TARGET_ID);
    expect(IPHONE4S_DEV_CONTRACTS.targets[IPHONE4S_DEV_TARGET_ID]).toEqual({
      hostAbi: IPHONE4S_DEV_HOST_ABI,
      platform: "ios",
      form: "takeover",
      display: {
        physicalViewport: IPHONE4S_PHYSICAL_VIEWPORT,
        logicalViewports: [IPHONE4S_LOGICAL_VIEWPORT],
        presentations: ["native"],
        rasterDensity: IPHONE4S_RASTER_DENSITY,
      },
      capabilities: ["input.touch", "text.glyphs.baked"],
    });
  });

  test("resolves the iPhone 4S Hero build plan", () => {
    const manifest = JSON.parse(readFileSync(join(repository, "apps/iphone4s-demo/pocket.json"), "utf8"));
    const plan = resolveIPhone4SBuildPlan(manifest);
    expect(plan.target).toEqual({ id: IPHONE4S_DEV_TARGET_ID, hostAbi: IPHONE4S_DEV_HOST_ABI });
    expect(plan.viewport).toEqual({
      logical: IPHONE4S_LOGICAL_VIEWPORT,
      physical: IPHONE4S_PHYSICAL_VIEWPORT,
      presentation: "native",
      rasterDensity: IPHONE4S_RASTER_DENSITY,
      policy: "fixed",
    });
    expect(plan.app.entry).toBe("apps/iphone4s-demo/main.tsx");
    expect(plan.app.output).toBe("iphone4s-demo-main");
    expect(verifyPlanHash(plan)).toBe(true);
  });

  test("pins firmware, sysroot, toolchain, and key-only transport", () => {
    expect(IPHONE4S_TOOLCHAIN.device).toEqual({
      productType: "iPhone4,1",
      hardwareModel: "N94AP",
      productVersion: "6.1.3",
      buildVersion: "10B329",
    });
    expect(IPHONE4S_TOOLCHAIN.firmware.sha1).toHaveLength(40);
    expect(IPHONE4S_TOOLCHAIN.firmware.sharedCacheSha256).toHaveLength(64);
    expect(Object.values(IPHONE4S_TOOLCHAIN.compiler.sysrootFiles)).toHaveLength(7);
    const tool = readFileSync(join(repository, "tools/iphone4s.ts"), "utf8");
    expect(tool).toContain("verifyDeviceIdentity()");
    expect(tool).toContain('deviceValue(udid, "HardwareModel")');
    expect(tool).toContain("passwordauthentication no");
    expect(tool).toContain("dyld_shared_cache_extract_dylibs_progress");
    expect(tool).toContain("writeTextStub");
    expect(tool).toContain("POCKETJS_IPHONE4S_IPSW");
    expect(tool).toContain("byte-exact readback");
    expect(tool).toContain('"build-receipt.json": sha256(receiptPath())');
    expect(tool).toContain("/bin/su mobile -c 'touch ${CAPTURE_REQUEST_PATH}'");
    expect(tool).toContain('label: "native/runtime.build-id-input.o"');
    expect(tool).toContain('label: "native/pocket_runtime.o"');
    expect(tool).toContain("...quickJsObjects.map");
  });

  test("shares the current touch-hit host and keeps transactional rollback", () => {
    const wrapper = readFileSync(join(repository, "hosts/iphone4s/runtime.c"), "utf8");
    const runtime = readFileSync(join(repository, "hosts/ios-legacy/runtime.c"), "utf8");
    const guest = readFileSync(join(repository, "engine/quickjs-c/pocket_runtime.c"), "utf8");
    expect(wrapper).toContain('#include "../ios-legacy/runtime.c"');
    expect(wrapper).toContain("#define POCKET_GL_DEFAULT 1");
    expect(wrapper).toContain("#define POCKET_REQUIRE_GL 1");
    expect(runtime).toContain("pocket_runtime_hit_test_bounds");
    expect(guest).toContain("hit_array");
    expect(runtime).toContain('send_void_float(g_view, "setContentScaleFactor:"');
    expect(runtime).toContain("g_gl_width != POCKET_LOGICAL_WIDTH * POCKET_RASTER_DENSITY");
    expect(runtime).not.toContain("fsync(");
    expect(guest).toContain("#define POCKET_RASTER_DENSITY 1");
    // The build's density is the default; a package runtime sets the plan's at launch.
    expect(guest).toContain("static uint32_t boot_raster_density = POCKET_RASTER_DENSITY;");
    expect(guest).toContain("ui_init(boot_raster_density)");
    expect(readFileSync(join(repository, "tools/iphone4s.ts"), "utf8").match(
      /`-DPOCKET_RASTER_DENSITY=\$\{inputs\.viewport\.rasterDensity\}`/g,
    )).toHaveLength(2);

    const first = iphone4sDeploymentPaths("a".repeat(24));
    const second = iphone4sDeploymentPaths("b".repeat(24));
    expect(first.stage).not.toBe(second.stage);
    expect(first.backup).not.toBe(second.backup);
    expect(first.lock).toBe(second.lock);
    const install = deploymentInstallCommand("a".repeat(24), first);
    expect(install).toContain("trap rollback EXIT HUP INT TERM");
    expect(install).toContain("prepared > \"$lock/phase\"");
    expect(install).toContain("previous > \"$lock/origin\"");
    expect(install).toContain("committed > \"$lock/phase\"");
    expect(install.lastIndexOf("uicache")).toBeLessThan(install.lastIndexOf("trap - EXIT HUP INT TERM"));
    expect(install.lastIndexOf("trap - EXIT HUP INT TERM")).toBeLessThan(install.lastIndexOf('rm -rf "$backup"'));

    const acquire = deploymentAcquireLockCommand("a".repeat(24), first, 1_000, 1_600);
    expect(acquire).toContain('lease=$(cat "$lock/expires"');
    expect(acquire).toContain('[ "$lease" -gt "$now" ]');
    expect(acquire).toContain('reclaim=$lock/reclaim');
    expect(acquire).toContain('reclaim_lease=$(cat "$reclaim/expires"');
    expect(acquire).toContain('mkdir "$reclaim"');
    expect(acquire).toContain('case "$owner" in *[!0-9a-f]*)');
    expect(acquire).toContain('[ "$phase" = committed ]');
    expect(acquire).toContain('mv "$backup" "$dest"');
    expect(acquire).toContain('[ "$origin" = empty ]');
    expect(() => deploymentAcquireLockCommand("a".repeat(24), first, 1_000, 1_000)).toThrow();
    const renew = deploymentRenewLockCommand("a".repeat(24), first, 2_000);
    expect(renew).toContain('test "$(cat "$lock/owner")" = "$tx"');
    expect(renew).toContain('> "$lock/expires"');
  });

  test("compares the complete installed receipt rather than only its build ID", () => {
    const receipt = {
      schema: 1 as const,
      buildId: "a".repeat(32),
      bundleId: "dev.pocket-nexus.iphone4s-demo",
      target: "iphone4s-dev",
      hostAbi: 5,
      deploymentTarget: "6.0",
      files: { "PocketJSiPhone4S": "1".repeat(64), "Info.plist": "2".repeat(64) },
    };
    expect(buildReceiptsMatch(receipt, {
      ...receipt,
      files: { "Info.plist": "2".repeat(64), "PocketJSiPhone4S": "1".repeat(64) },
    })).toBe(true);
    expect(buildReceiptsMatch(receipt, {
      ...receipt,
      files: { ...receipt.files, "PocketJSiPhone4S": "3".repeat(64) },
    })).toBe(false);
  });

  test("leases the deployment lock and reclaims incomplete or expired owners", () => {
    const output = mkdtempSync(join(tmpdir(), "pocket-iphone4s-lock-"));
    const lock = join(output, "deploy.lock");
    const paths = { ...iphone4sDeploymentPaths("a".repeat(24)), lock };
    const runShell = (command: string) => Bun.spawnSync({
      cmd: ["/bin/sh", "-c", command],
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const first = runShell(deploymentAcquireLockCommand("a".repeat(24), paths, 1_000, 1_600));
      expect(first.exitCode).toBe(0);
      expect(readFileSync(join(lock, "owner"), "utf8").trim()).toBe("a".repeat(24));
      expect(readFileSync(join(lock, "expires"), "utf8").trim()).toBe("1600");

      const active = runShell(deploymentAcquireLockCommand("b".repeat(24), paths, 1_100, 1_700));
      expect(active.exitCode).toBe(73);
      expect(active.stderr.toString()).toContain("deployment busy");

      writeFileSync(join(lock, "owner"), "legacy-incomplete\n");
      writeFileSync(join(lock, "expires"), "0\n");
      const recovered = runShell(deploymentAcquireLockCommand("b".repeat(24), paths, 2_000, 2_600));
      expect(recovered.exitCode).toBe(0);
      expect(readFileSync(join(lock, "owner"), "utf8").trim()).toBe("b".repeat(24));

      writeFileSync(join(lock, "expires"), "0\n");
      const reclaim = join(lock, "reclaim");
      mkdirSync(reclaim);
      writeFileSync(join(reclaim, "owner"), "interrupted-recovery\n");
      writeFileSync(join(reclaim, "expires"), "0\n");
      const reclaimRecovered = runShell(
        deploymentAcquireLockCommand("c".repeat(24), paths, 3_000, 3_600),
      );
      expect(reclaimRecovered.exitCode).toBe(0);
      expect(readFileSync(join(lock, "owner"), "utf8").trim()).toBe("c".repeat(24));
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  test("keeps the mask edge color when averaging transparent samples", async () => {
    const canvas = await rasterizeIconSvg('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4" viewBox="0 0 4 4"><rect x=".5" width="3.5" height="4" fill="#efce77"/></svg>', 4, 4, false);
    const pixel = canvas.getContext("2d").getImageData(0, 1, 1, 1).data;
    // Canvas stores premultiplied 8-bit channels, so readback can round by 1.
    for (const [i, color] of [239, 206, 119].entries()) expect(Math.abs(pixel[i] - color)).toBeLessThanOrEqual(1);
    expect(pixel[3]).toBe(128);
  });

  test("bakes pre-masked iOS icons at native sizes without pixel duplication", async () => {
    const output = mkdtempSync(join(tmpdir(), "pocket-iphone4s-artwork-"));
    try {
      await bakeClassicIPhoneArtwork(output);

      const one = await loadImage(join(output, IPHONE_CLASSIC_ICON_FILE));
      const two = await loadImage(join(output, IPHONE_CLASSIC_RETINA_ICON_FILE));
      expect([one.width, one.height]).toEqual([57, 57]);
      expect([two.width, two.height]).toEqual([114, 114]);
      const oneCanvas = createCanvas(one.width, one.height);
      const twoCanvas = createCanvas(two.width, two.height);
      oneCanvas.getContext("2d").drawImage(one, 0, 0);
      twoCanvas.getContext("2d").drawImage(two, 0, 0);
      const onePixels = oneCanvas.getContext("2d").getImageData(0, 0, one.width, one.height).data;
      const twoPixels = twoCanvas.getContext("2d").getImageData(0, 0, two.width, two.height).data;
      const expected = new Uint8ClampedArray(twoPixels.length);
      for (let y = 0; y < two.height; y += 1) {
        for (let x = 0; x < two.width; x += 1) {
          const source = (Math.floor(y / 2) * one.width + Math.floor(x / 2)) * 4;
          const target = (y * two.width + x) * 4;
          expected.set(onePixels.subarray(source, source + 4), target);
        }
      }
      expect(twoPixels).not.toEqual(expected);
      // System applications on the physical iOS 6 host retain opaque corners;
      // the source must supply the mask, with an opaque face and soft edges.
      const alpha = (x: number, y: number) => twoPixels[(y * two.width + x) * 4 + 3];
      for (const [x, y] of [[0, 0], [113, 0], [0, 113], [113, 113]]) expect(alpha(x, y)).toBe(0);
      expect(alpha(57, 57)).toBe(255);
      expect(twoPixels.some((v, i) => i % 4 === 3 && v > 0 && v < 255)).toBe(true);
      for (const filename of ["Default@2x.png", "Default-568h@2x.png"]) {
        const launch = await loadImage(join(output, filename));
        expect(launch.width).toBe(640);
        expect(launch.height).toBe(filename === "Default@2x.png" ? 960 : 1136);
      }
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  test("gives User applications an opaque face for the native SpringBoard mask", async () => {
    const output = mkdtempSync(join(tmpdir(), "pocket-user-artwork-"));
    try {
      await bakeClassicIPhoneArtwork(output, "User");
      for (const [file, size] of [[IPHONE_USER_ICON_FILE, 57], [IPHONE_USER_RETINA_ICON_FILE, 114]] as const) {
        const image = await loadImage(join(output, file));
        expect([image.width, image.height]).toEqual([size, size]);
        const ctx = createCanvas(size, size).getContext("2d");
        ctx.drawImage(image, 0, 0);
        const pixels = ctx.getImageData(0, 0, size, size).data;
        expect(pixels.every((value, index) => index % 4 !== 3 || value === 255)).toBe(true);
        // The top face reaches the edge: no transparent inset or bright rim.
        const pixel = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
        const edge = pixel(Math.floor(size / 2), 0);
        const inside = pixel(Math.floor(size / 2), 3);
        expect(edge[0]).toBeGreaterThan(30);
        for (let channel = 0; channel < 3; channel++) expect(Math.abs(edge[channel] - inside[channel])).toBeLessThan(10);
      }
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
