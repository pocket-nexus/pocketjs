import { describe, expect, test } from "bun:test";
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { POCKET_TARGETS } from "../contracts/spec/platforms.ts";
import { verifyPlanHash } from "../framework/src/manifest/plan.ts";
import {
  IPODTOUCH4_DEV_CONTRACTS,
  IPODTOUCH4_DEV_HOST_ABI,
  IPODTOUCH4_DEV_TARGET_ID,
  IPODTOUCH4_LANDSCAPE_VIEWPORT,
  IPODTOUCH4_LOGICAL_VIEWPORT,
  IPODTOUCH4_PHYSICAL_VIEWPORT,
  IPODTOUCH4_RASTER_DENSITY,
  resolveIPodTouch4BuildPlan,
} from "../tools/ipodtouch4-profile.ts";
import { IPHONE4S_DEV_HOST_ABI } from "../tools/iphone4s-profile.ts";
import {
  IPODTOUCH4_DEPLOYMENT,
  IPODTOUCH4_DEVICE,
  IPODTOUCH4_TOOLCHAIN,
} from "../tools/ipodtouch4-toolchain.ts";
import { IPHONE4S_TOOLCHAIN } from "../tools/iphone4s-toolchain.ts";
import {
  buildReceiptsMatch,
  IPODTOUCH4_APPS,
  selectIPodTouch4App,
} from "../tools/ipodtouch4.ts";

const repository = join(import.meta.dir, "..");

describe("private iPod touch 4 profile", () => {
  test("pins the exact Retina iOS 6 takeover surface", () => {
    expect(POCKET_TARGETS).not.toHaveProperty(IPODTOUCH4_DEV_TARGET_ID);
    expect(IPODTOUCH4_DEV_CONTRACTS.targets[IPODTOUCH4_DEV_TARGET_ID]).toEqual({
      hostAbi: IPODTOUCH4_DEV_HOST_ABI,
      platform: "ios",
      form: "takeover",
      display: {
        physicalViewport: IPODTOUCH4_PHYSICAL_VIEWPORT,
        logicalViewports: [IPODTOUCH4_LOGICAL_VIEWPORT, IPODTOUCH4_LANDSCAPE_VIEWPORT],
        presentations: ["native"],
        rasterDensity: IPODTOUCH4_RASTER_DENSITY,
      },
      capabilities: ["input.touch", "text.glyphs.baked", "io.offload"],
    });
    // Same legacy UIKit runtime, same op table, same guest protocol as the
    // iPhone 4S — the ABI is the protocol revision, the target id the device.
    expect(IPODTOUCH4_DEV_HOST_ABI).toBe(IPHONE4S_DEV_HOST_ABI);
  });

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
    expect(verifyPlanHash(plan)).toBe(true);
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
        bundleId: "dev.pocket-stack.shell", bundleName: "PocketShell.app",
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
    const wrapper = readFileSync(join(repository, "hosts/ipodtouch4/runtime.c"), "utf8");
    expect(wrapper).toContain("NSTemporaryDirectory()");
    const runtime = readFileSync(join(repository, "hosts/ios-legacy/runtime.c"), "utf8");
    expect(runtime).toContain("landscape = POCKET_LOGICAL_WIDTH > POCKET_LOGICAL_HEIGHT");
    expect(runtime).toContain('sel_registerName("setTransform:")');
    const guest = readFileSync(join(repository, "engine/quickjs-c/pocket_runtime.c"), "utf8");
    expect(guest).toContain("#ifdef POCKET_SVC_WIRE");
    expect(guest).toContain('add_host_operation(context, ui, "svcOpen", 1, HostSvcOpen)');
    expect(guest).toContain("svcwire_pump();");
  });

  test("pins the device tuple and shares the validated 4S toolchain", () => {
    expect(IPODTOUCH4_DEVICE).toEqual({
      productType: "iPod4,1",
      hardwareModel: "N81AP",
      productVersion: "6.1.6",
      buildVersion: "10B500",
    });
    expect(IPODTOUCH4_DEPLOYMENT).toEqual({ devicePort: 22, localPort: 2224 });
    // The toolchain IS the iPhone 4S one: link-time TAPI stubs from the
    // validated 6.1.3 ARMv7 shared cache resolve identically on 6.1.6.
    expect(IPODTOUCH4_TOOLCHAIN).toBe(IPHONE4S_TOOLCHAIN);
    const tool = readFileSync(join(repository, "tools/ipodtouch4.ts"), "utf8");
    expect(tool).toContain("verifyDeviceIdentity()");
    expect(tool).toContain('deviceValue(udid, "HardwareModel")');
    expect(tool).toContain("passwordauthentication no");
    expect(tool).toContain("byte-exact readback");
    expect(tool).toContain('"build-receipt.json": sha256(receiptPath())');
    expect(tool).toContain("/bin/su mobile -c 'touch ${paths.capture}'");
    expect(tool).toContain('label: "native/runtime.build-id-input.o"');
    expect(tool).toContain('label: "native/pocket_runtime.o"');
    expect(tool).toContain("...quickJsObjects.map");
    expect(tool).toContain('const ACTION_NAME = "clear_gesture"');
    // Preparation delegates to the pinned 4S flow instead of re-pinning it.
    expect(tool).toContain('delegateToIPhone4S("setup-sources")');
    expect(tool).toContain('delegateToIPhone4S("prepare-sysroot")');
  });

  test("shares the multi-contact touch host and keeps transactional rollback", () => {
    const wrapper = readFileSync(join(repository, "hosts/ipodtouch4/runtime.c"), "utf8");
    const runtime = readFileSync(join(repository, "hosts/ios-legacy/runtime.c"), "utf8");
    const guest = readFileSync(join(repository, "engine/quickjs-c/pocket_runtime.c"), "utf8");
    expect(wrapper).toContain('#include "../ios-legacy/runtime.c"');
    expect(wrapper).toContain("#define POCKET_GL_DEFAULT 1");
    expect(wrapper).toContain("#define POCKET_REQUIRE_GL 1");
    // The legacy runtime tracks a slot table, not one contact: eight wire
    // slots, release-latched delivery, per-contact down-edge hit facts.
    expect(runtime).toContain("#define POCKET_TOUCH_SLOT_COUNT 8");
    expect(runtime).toContain('send_void_bool(g_view, "setMultipleTouchEnabled:", YES)');
    expect(runtime).toContain("pocket_runtime_frame_contacts(&frame_input, 2)");
    expect(runtime).toContain("pocket_runtime_hit_test_bounds");
    expect(guest).toContain("POCKET_RUNTIME_MAX_CONTACTS");
    expect(guest).toContain("pocket_runtime_pack_contact(contact)");
    expect(runtime).toContain("pocket_contacts_sample(&g_contacts");
    expect(runtime).toContain("pocket_touches_cancelled");


  });

  test("compares the complete installed receipt rather than only its build ID", () => {
    const receipt = {
      schema: 1 as const,
      buildId: "a".repeat(32),
      bundleId: "dev.pocket-stack.clear",
      target: IPODTOUCH4_DEV_TARGET_ID,
      hostAbi: IPODTOUCH4_DEV_HOST_ABI,
      deploymentTarget: "6.0",
      files: { PocketJSiPodTouch4: "b".repeat(64), "Info.plist": "c".repeat(64) },
    };
    expect(buildReceiptsMatch(receipt, { ...receipt })).toBe(true);
    expect(buildReceiptsMatch(receipt, { ...receipt, buildId: "d".repeat(32) })).toBe(false);
    expect(
      buildReceiptsMatch(receipt, {
        ...receipt,
        files: { ...receipt.files, "Info.plist": "e".repeat(64) },
      }),
    ).toBe(false);
    expect(
      buildReceiptsMatch(receipt, {
        ...receipt,
        files: { PocketJSiPodTouch4: receipt.files.PocketJSiPodTouch4 },
      }),
    ).toBe(false);
  });
});
