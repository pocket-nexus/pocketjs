import { describe, expect, test } from "bun:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IPHONE4S_DEV_HOST_ABI, IPHONE4S_DEV_TARGET_ID, IPHONE4S_LOGICAL_VIEWPORT, IPHONE4S_PHYSICAL_VIEWPORT, IPHONE4S_RASTER_DENSITY, resolveIPhone4SBuildPlan } from "../tools/iphone4s-profile.ts";
import { rasterizeIconSvg } from "../tools/icon-raster.ts";
import { bakeClassicIPhoneArtwork, IPHONE_CLASSIC_ICON_FILE, IPHONE_CLASSIC_RETINA_ICON_FILE, IPHONE_USER_ICON_FILE, IPHONE_USER_RETINA_ICON_FILE } from "../tools/iphone-classic-icon.ts";
import { deploymentAcquireLockCommand, deploymentInstallCommand, deploymentRenewLockCommand, iphone4sDeploymentPaths } from "../tools/iphone4s.ts";

const repository = join(import.meta.dir, "..");

describe("private iPhone 4S profile", () => {

  test("resolves the iPhone 4S Hero build plan", () => {
    const manifest = JSON.parse(readFileSync(join(repository, "apps/iphone4s-demo/pocket.app.json"), "utf8"));
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
  });

  test("uses isolated deployment paths and generates rollback commands", () => {
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
