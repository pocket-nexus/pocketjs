import { readPocketManifest } from "../framework/src/manifest/load.ts";
import { describe, expect, test } from "bun:test";
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IPODTOUCH4_DEV_HOST_ABI, IPODTOUCH4_DEV_TARGET_ID, IPODTOUCH4_LANDSCAPE_VIEWPORT, IPODTOUCH4_LOGICAL_VIEWPORT, IPODTOUCH4_PHYSICAL_VIEWPORT, IPODTOUCH4_RASTER_DENSITY, resolveIPodTouch4BuildPlan } from "../tools/ipodtouch4-profile.ts";
import { guestRuntimeDefines, IPODTOUCH4_APPS, selectIPodTouch4App } from "../tools/ipodtouch4.ts";

const repository = join(import.meta.dir, "..");

describe("private iPod touch 4 profile", () => {

  test("resolves the Pocket Clear build plan", () => {
    const manifest = JSON.parse(readFileSync(join(repository, "apps/clear/pocket.json"), "utf8"));
    const plan = resolveIPodTouch4BuildPlan(manifest);
    expect(plan.target).toEqual({ id: IPODTOUCH4_DEV_TARGET_ID, hostAbi: IPODTOUCH4_DEV_HOST_ABI });
    expect(plan.viewport).toEqual({
      logical: IPODTOUCH4_LOGICAL_VIEWPORT,
      physical: IPODTOUCH4_PHYSICAL_VIEWPORT,
      presentation: "native",
      rasterDensity: IPODTOUCH4_RASTER_DENSITY,
      policy: "fixed",
    });
    expect(plan.app.entry).toBe("apps/clear/main.tsx");
    expect(plan.app.output).toBe("clear-main");
    expect(plan.app.framework).toBe("vue-vapor");
  });

  test("resolves Pocket Nexus and binds the physics ops it requires", () => {
    const manifest = readPocketManifest(join(repository, "apps/nexus-touch/pocket.json")).manifest as any;
    const plan = resolveIPodTouch4BuildPlan(manifest);
    expect(plan.app.entry).toBe("apps/nexus-touch/main.tsx");
    expect(plan.app.output).toBe("nexus-touch-main");
    expect(plan.app.framework).toBe("solid");
    expect(plan.viewport.logical).toEqual(IPODTOUCH4_LOGICAL_VIEWPORT);
    expect(plan.viewport.rasterDensity).toBe(IPODTOUCH4_RASTER_DENSITY);
    expect(plan.features).toEqual({ "input.touch": true, "ui.physics": true });
    // a second installable app: every device-side name differs from Clear's
    const nexus = selectIPodTouch4App("nexus-touch");
    const clear = IPODTOUCH4_APPS.clear;
    for (const key of ["bundleId", "bundleName", "executable", "scheme", "receiptSlug", "actionName"] as const) {
      expect(nexus[key]).not.toBe(clear[key]);
    }
    // the guest runtime binds ops 52..56 for this plan only; Clear keeps its op table
    expect(guestRuntimeDefines(plan.features)).toEqual(["-DPOCKET_PHYSICS"]);
    const clearPlan = resolveIPodTouch4BuildPlan(JSON.parse(readFileSync(join(repository, "apps/clear/pocket.json"), "utf8")));
    expect(guestRuntimeDefines(clearPlan.features)).toEqual([]);
  });

  test("resolves an external landscape app with independent device identity", () => {
    const manifest = JSON.parse(readFileSync(join(repository, "apps/clear/pocket.json"), "utf8"));
    manifest.app.entry = "ipod/main.tsx";
    manifest.app.output = "external-shell";
    manifest.app.framework = "solid";
    manifest.app.viewport.fixed.logical = [480, 320];
    const plan = resolveIPodTouch4BuildPlan(manifest);
    expect(plan.viewport).toEqual({
      logical: IPODTOUCH4_LANDSCAPE_VIEWPORT,
      physical: [IPODTOUCH4_PHYSICAL_VIEWPORT[1], IPODTOUCH4_PHYSICAL_VIEWPORT[0]],
      presentation: "native",
      rasterDensity: IPODTOUCH4_RASTER_DENSITY,
      policy: "fixed",
    });
    expect(plan.app.output).toBe("external-shell");
    expect(plan.app.framework).toBe("solid");
    // A second app on the device needs its own bundle, executable, scheme and
    // receipt paths; the network app compiles the svc wire in.
    const root = mkdtempSync(join(tmpdir(), "pocket-external-ipod-"));
    let remote;
    try {
      mkdirSync(join(root, "ipod"));
      writeFileSync(join(root, "ipod/pocket.json"), JSON.stringify(manifest));
      const descriptor = join(root, "ipod/ipodtouch4.json");
      writeFileSync(descriptor, JSON.stringify({
        id: "shell", projectRoot: "..", manifest: "ipod/pocket.json",
        bundleId: "dev.pocket-nexus.shell", bundleName: "PocketShell.app",
        executable: "PocketShell", title: "Pocket Shell", scheme: "pocketjs-shell",
        receiptSlug: "pocketjs-shell", actionName: "shell_action", svcWire: true,
      }));
      remote = selectIPodTouch4App(undefined, descriptor);
      expect(remote.root).toBe(root);
    } finally { rmSync(root, { recursive: true, force: true }); }
    const clear = selectIPodTouch4App(undefined);
    expect(clear).toBe(IPODTOUCH4_APPS.clear);
    expect(remote.svcWire).toBe(true);
    expect(clear.svcWire).toBe(false);
    for (const key of ["bundleId", "bundleName", "executable", "scheme", "receiptSlug"] as const) {
      expect(remote[key]).not.toBe(clear[key]);
    }
    expect(() => selectIPodTouch4App("nope")).toThrow("unknown app");
  });

  test("validates external native archives and source files before building", () => {
    const root = mkdtempSync(join(tmpdir(), "pocket-native-ipod-"));
    try {
      const file = join(root, "app.json");
      for (const name of ["pocket.json", "Cargo.toml", "bridge.c"]) writeFileSync(join(root, name), "");
      const descriptor = {
        id: "game", manifest: "pocket.json", bundleId: "dev.pocket.game", bundleName: "Game.app",
        executable: "Game", title: "Game", scheme: "pocket-game", receiptSlug: "game", actionName: "game_touch",
        nativeCore: { manifest: "Cargo.toml", library: "libgame.a", features: ["native"], sources: ["bridge.c"] },
      };
      writeFileSync(file, JSON.stringify(descriptor));
      expect(selectIPodTouch4App(undefined, file).nativeCore).toEqual(descriptor.nativeCore);
      for (const nativeCore of [null, { ...descriptor.nativeCore, library: "../other.a" },
        { ...descriptor.nativeCore, features: ["native,other"] }, { ...descriptor.nativeCore, sources: ["missing.c"] },
        { ...descriptor.nativeCore, manifest: "." }]) {
        writeFileSync(file, JSON.stringify({ ...descriptor, nativeCore }));
        expect(() => selectIPodTouch4App(undefined, file)).toThrow("invalid nativeCore");
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
