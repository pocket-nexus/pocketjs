import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { POCKET_TARGETS } from "../contracts/spec/platforms.ts";
import { POCKET_PACKAGE_TARGET_BYTES } from "../contracts/spec/pocket-package.ts";
import { verifyPlanHash } from "../framework/src/manifest/plan.ts";
import {
  extractHostBuildInputs,
  hostBuildEnvironment,
} from "../framework/src/manifest/host-build-inputs.ts";
import {
  validateAndResolveBuildPlan,
  validatePlatformContractRegistry,
} from "../framework/src/manifest/resolve.ts";
import {
  resolve3dsBuildPlan,
  THREE_DS_AUXILIARY_VIEWPORT,
  THREE_DS_DEV_CONTRACTS,
  THREE_DS_DEV_HOST_ABI,
  THREE_DS_DEV_TARGET_ID,
  THREE_DS_VIEWPORT,
} from "../tools/3ds-profile.ts";
import {
  MAKEROM_REVISION,
  THREE_DS_CONTAINER_IMAGE,
  captureDefines,
  ciaProcessName,
  ciaProductCode,
  ciaTitleId,
  ciaUniqueId,
  parse3dsArguments,
  runtimeSlot,
} from "../tools/3ds.ts";

/** A guest app declaring the top screen exactly: 400x240 logical, native. */
function topScreenManifest(): Record<string, any> {
  return {
    $schema: "https://pocketjs.dev/schema/pocket-2.json",
    pocket: 2,
    id: "dev.pocket-stack.3ds-demo",
    name: "pocketjs-3ds-hero",
    title: "PocketJS: 3DS Hero",
    version: "0.1.0",
    engine: {
      capabilities: {
        requires: ["input.buttons", "text.glyphs.baked"],
        enhances: ["input.analog.left", "audio.pcm"],
      },
    },
    app: {
      entry: "apps/3ds-demo/main.tsx",
      output: "pocket3ds-demo-main",
      framework: "solid",
      viewport: {
        fixed: { logical: [400, 240], presentation: "native" },
      },
    },
  };
}

function dualScreenManifest(): Record<string, any> {
  const value = topScreenManifest();
  value.engine.capabilities.requires.push(
    "display.auxiliary",
    "input.touch.auxiliary",
  );
  value.app.surfaces = {
    auxiliary: {
      fixed: { logical: THREE_DS_AUXILIARY_VIEWPORT, presentation: "native" },
    },
  };
  return value;
}

function diagnosticCodes(manifest: unknown): string[] {
  const resolution = validateAndResolveBuildPlan(
    manifest,
    { target: THREE_DS_DEV_TARGET_ID },
    THREE_DS_DEV_CONTRACTS,
  );
  expect(resolution.ok).toBe(false);
  return resolution.ok ? [] : resolution.diagnostics.map((d) => d.code);
}

describe("private Nintendo 3DS build profile", () => {
  test("stays private until the remaining host paths are covered", () => {
    expect(POCKET_TARGETS).not.toHaveProperty(THREE_DS_DEV_TARGET_ID);
    expect(THREE_DS_DEV_CONTRACTS.targets[THREE_DS_DEV_TARGET_ID]).toEqual({
      hostAbi: THREE_DS_DEV_HOST_ABI,
      platform: "3ds",
      form: "takeover",
      display: {
        physicalViewport: THREE_DS_VIEWPORT,
        logicalViewports: [THREE_DS_VIEWPORT],
        presentations: ["native"],
        rasterDensity: 1,
        auxiliary: {
          physicalViewport: THREE_DS_AUXILIARY_VIEWPORT,
          logicalViewports: [THREE_DS_AUXILIARY_VIEWPORT],
          presentations: ["native"],
          rasterDensity: 1,
        },
      },
      capabilities: [
        "io.offload",
        "media.playback",
        "input.analog.left",
        "input.analog.right",
        "input.buttons",
        "input.cursor",
        "input.touch.auxiliary",
        "display.auxiliary",
        "text.glyphs.baked",
      ],
    });
    expect(validatePlatformContractRegistry(THREE_DS_DEV_CONTRACTS)).toEqual([]);
  });

  test("takes the next hostAbi in the registry-wide sequence", () => {
    // hostAbi is one sequence across every profile, private ones included:
    // 1 psp, 2 vita, 3 macos-widget, 4 symbian-e7-dev, 5 pocketbook,
    // 6 iphone2g-dev, 7 top-screen-only 3DS, 8 dual-screen 3DS,
    // 9 Blackberry Classic, 10 companion media. A collision
    // would let a bundle mount on the wrong host.
    expect(THREE_DS_DEV_HOST_ABI).toBe(10);
    expect(
      Object.values(POCKET_TARGETS).map((profile) => profile.hostAbi),
    ).not.toContain(THREE_DS_DEV_HOST_ABI);
    // The .pocket container stores the target id in a NUL-padded fixed field.
    expect(new TextEncoder().encode(THREE_DS_DEV_TARGET_ID).length).toBeLessThan(
      POCKET_PACKAGE_TARGET_BYTES,
    );
  });

  test("resolves a 400x240 native app to an exact device plan", () => {
    const plan = resolve3dsBuildPlan(topScreenManifest());

    expect(plan.target).toEqual({
      id: THREE_DS_DEV_TARGET_ID,
      hostAbi: THREE_DS_DEV_HOST_ABI,
    });
    expect(plan.viewport).toEqual({
      logical: THREE_DS_VIEWPORT,
      physical: THREE_DS_VIEWPORT,
      presentation: "native",
      rasterDensity: 1,
      policy: "fixed",
    });
    // The nub is provided, so the enhancement resolves true; the host ships no
    // audio module in v1, so audio.pcm resolves false instead of failing.
    expect(plan.features).toEqual({
      "audio.pcm": false,
      "input.analog.left": true,
      "input.buttons": true,
      "text.glyphs.baked": true,
    });
    expect(plan.app.entry).toBe("apps/3ds-demo/main.tsx");
    expect(verifyPlanHash(plan)).toBe(true);
  });

  test("resolves the bottom screen and its touch as an independent output", () => {
    const plan = resolve3dsBuildPlan(dualScreenManifest());
    expect(plan.surfaces).toEqual({
      auxiliary: {
        logical: THREE_DS_AUXILIARY_VIEWPORT,
        physical: THREE_DS_AUXILIARY_VIEWPORT,
        presentation: "native",
        rasterDensity: 1,
      },
    });
    expect(plan.features["display.auxiliary"]).toBe(true);
    expect(plan.features["input.touch.auxiliary"]).toBe(true);
    expect(plan.features).not.toHaveProperty("input.touch");
    expect(
      hostBuildEnvironment(extractHostBuildInputs(plan), {
        outputDirectory: "/tmp/pocket-3ds",
        embedApp: true,
      }),
    ).toMatchObject({
      POCKETJS_AUX_LOGICAL_WIDTH: "320",
      POCKETJS_AUX_LOGICAL_HEIGHT: "240",
      POCKETJS_AUX_PHYSICAL_WIDTH: "320",
      POCKETJS_AUX_PHYSICAL_HEIGHT: "240",
      POCKETJS_AUX_PRESENTATION: "native",
      POCKETJS_AUX_RASTER_DENSITY: "1",
    });
  });

  test("rejects the 480x272 integer-fit corpus", () => {
    // The top screen is smaller than 480x272 on both axes and the resolver has
    // no scaling fallback, so the stock PSP-shaped app corpus cannot be
    // admitted here — 3DS apps declare their own 400x240 native viewport.
    const psp = topScreenManifest();
    psp.app.viewport.fixed = {
      logical: [480, 272],
      presentation: "integer-fit",
    };
    expect(diagnosticCodes(psp)).toEqual([
      "viewport.logicalUnsupported",
      "viewport.presentationUnsupported",
      // 400/480 and 240/272 are not one positive integer scale.
      "viewport.integerFitMismatch",
    ]);
    expect(() => resolve3dsBuildPlan(psp)).toThrow("480x272");
  });

  test("refuses capabilities the top-screen host cannot provide", () => {
    // The touchscreen is the bottom screen: its contacts are not top-screen
    // logical coordinates, so input.touch is not advertised.
    const needsTouch = topScreenManifest();
    needsTouch.engine.capabilities.requires.push("input.touch");
    expect(diagnosticCodes(needsTouch)).toEqual(["capability.unavailable"]);
    expect(() => resolve3dsBuildPlan(needsTouch)).toThrow("input.touch");

    const needsRuntimeGlyphs = topScreenManifest();
    needsRuntimeGlyphs.engine.capabilities.requires.push("text.glyphs.runtime");
    needsRuntimeGlyphs.app.runtimeText = { charset: "ascii" };
    expect(diagnosticCodes(needsRuntimeGlyphs)).toEqual([
      "capability.unavailable",
    ]);
  });

  test("forbids a dynamic viewport on a takeover form", () => {
    const dynamic = topScreenManifest();
    dynamic.app.viewport = { dynamic: { default: [400, 240] } };
    expect(diagnosticCodes(dynamic)).toEqual(["viewport.fixedRequired"]);
  });

  test("publishes the core's viewport as ui.__viewport", () => {
    // framework/src/index.ts sizes the mounted app and overlay layers from
    // ui.__viewport and falls back to the 480x272 spec screen when a host
    // omits it, which lays a 400x240 app out 80 px too wide and pushes every
    // right-anchored element off the panel. Nothing catches that without an
    // emulator, so the publication is pinned here — read back from the core
    // rather than re-derived, so the JS layer and the native root cannot drift.
    const qjs = readFileSync(
      join(new URL("..", import.meta.url).pathname, "hosts/3ds/src/qjs.c"),
      "utf8",
    );
    expect(qjs).toContain('JS_SetPropertyStr(context, ui, "__viewport", viewport)');
    expect(qjs).toContain("ui_viewport_width()");
    expect(qjs).toContain("ui_viewport_height()");
  });

  test("keeps bring-up controls out of the application input path", () => {
    const main = readFileSync(
      join(new URL("..", import.meta.url).pathname, "hosts/3ds/src/main.c"),
      "utf8",
    );
    expect(main).not.toContain("gfx_debug_modes");
    expect(main).not.toContain("hidKeysHeld");
    expect(main).not.toContain("KEY_L");
    expect(main).not.toContain("KEY_R");
    expect(main).not.toContain("KEY_Y");

    const input = readFileSync(
      join(new URL("..", import.meta.url).pathname, "hosts/3ds/src/input.c"),
      "utf8",
    );
    expect(input).toContain("RUNTIME_RELOAD_KEYS");
    expect(input).toContain("held &= ~RUNTIME_RELOAD_KEYS");
    expect(input).toContain("RUNTIME_DEVMENU_KEYS");
    expect(input).toContain("held &= ~RUNTIME_DEVMENU_KEYS");
    expect(input).toContain("RUNTIME_EXIT_KEYS");
    expect(input).toContain("held &= ~RUNTIME_EXIT_KEYS");
    expect(input).toContain("input_exit_requested");
    expect(input).toContain("input_devmenu_blocks_guest");
    expect(main).toContain("if (input_exit_requested()) break");
  });

  test("keeps the development menu native and outside the guest capability surface", () => {
    const root = new URL("..", import.meta.url).pathname;
    const menu = readFileSync(join(root, "hosts/3ds/src/devmenu.c"), "utf8");
    const main = readFileSync(join(root, "hosts/3ds/src/main.c"), "utf8");
    const makefile = readFileSync(join(root, "hosts/3ds/Makefile"), "utf8");
    expect(menu).toContain("const uint32_t *devmenu_draw_list");
    expect(menu).toContain("#define DRAW_RECT 1u");
    expect(menu).toContain("devserver_snapshot(&state)");
    expect(menu).not.toMatch(/\bui_[a-z_]+\s*\(/);
    expect(main).toContain("(void)devmenu_init()");
    expect(main).not.toContain("native development menu failed to initialize");
    expect(main).toContain("auxiliary_list = devmenu_draw_list(&auxiliary_words)");
    expect(makefile).not.toContain("-lcitro2d");
    expect(makefile).toContain("-lcitro3d");
  });

  test("feeds pak images through the shared IMG-entry parser", () => {
    const core = readFileSync(
      join(new URL("..", import.meta.url).pathname, "hosts/3ds/core/src/lib.rs"),
      "utf8",
    );
    const imageArm = core.slice(
      core.indexOf('entry.key.strip_prefix("ui:img.")'),
      core.indexOf('entry.key.strip_prefix("ui:sprite.")'),
    );
    expect(imageArm).toContain("instance.upload_img_entry(blob)");
    expect(imageArm).not.toContain("instance.upload_texture(");
  });

  test("keeps each display batch inside its own shared-arena range", () => {
    const gfx = readFileSync(
      join(new URL("..", import.meta.url).pathname, "hosts/3ds/src/gfx.c"),
      "utf8",
    );
    expect(gfx).toContain("batch->command_first = command_count");
    expect(gfx).toContain("uint32_t start = vertex_count;");
    expect(gfx).not.toContain("uint32_t start = 0;");
  });

  test("pins the device toolchain and rebuilds shell-safe SMDH metadata", () => {
    expect(THREE_DS_CONTAINER_IMAGE).toMatch(
      /^devkitpro\/devkitarm@sha256:[0-9a-f]{64}$/,
    );
    expect(MAKEROM_REVISION).toMatch(/^[0-9a-f]{40}$/);

    const makefile = readFileSync(
      join(new URL("..", import.meta.url).pathname, "hosts/3ds/Makefile"),
      "utf8",
    );
    expect(makefile).toContain("SMDH_STAMP :=");
    expect(makefile).toContain('"$$POCKETJS_SMDH_TITLE"');
    expect(makefile).toContain('"$$POCKETJS_SMDH_DESC"');
    expect(makefile).toContain('"$$POCKETJS_SMDH_AUTHOR"');
    expect(makefile).not.toContain('"$(POCKETJS_SMDH_TITLE)"');
    expect(makefile).toContain(
      "$(ROMFS)/app.pocket: $(POCKETJS_APP_POCKET) romfs-inputs",
    );
    expect(makefile).not.toContain("POCKETJS_APP_JS");
    expect(makefile).not.toContain("POCKETJS_APP_PAK");
    expect(makefile).toContain(
      "$(BUILD)/vshader_shbin.s $(BUILD)/vshader_shbin.h &:",
    );
    expect(makefile).toContain("-DPOCKETJS_RUNTIME_SLOT='");
  });

  test("derives bounded, application-specific Runtime state slots", () => {
    expect(runtimeSlot("dev.pocket-stack.3ds-demo")).toMatch(/^[0-9a-f]{16}$/);
    expect(runtimeSlot("dev.pocket-stack.3ds-demo")).toBe(
      runtimeSlot("dev.pocket-stack.3ds-demo"),
    );
    expect(runtimeSlot("dev.pocket-stack.3ds-demo")).not.toBe(
      runtimeSlot("dev.pocket-stack.term"),
    );
  });

  test("defaults and validates capture defines before they reach make", () => {
    expect(captureDefines({})).toEqual({ input: "", touch: "", start: "0", count: "1" });
    expect(
      captureDefines({
        POCKETJS_CAPTURE_INPUT: "0:0,4:0x20,8:0",
        POCKETJS_CAPTURE_TOUCH: "0:-@6:0,60,110@9:-",
        POCKETJS_CAP_START: "2",
        POCKETJS_CAP_N: "3",
      }),
    ).toEqual({
      input: "0:0,4:0x20,8:0",
      touch: "0:-@6:0,60,110@9:-",
      start: "2",
      count: "3",
    });
    expect(() =>
      captureDefines({ POCKETJS_CAPTURE_INPUT: '0:0";touch /tmp/pwned;"' }),
    ).toThrow("frame:mask pairs");
    expect(() =>
      captureDefines({ POCKETJS_CAPTURE_TOUCH: "0:-@6:0,320,110" }),
    ).toThrow("outside its supported range");
    expect(() =>
      captureDefines({ POCKETJS_CAPTURE_TOUCH: "0:-@6:0,60,110;touch /tmp/pwned" }),
    ).toThrow("frame:- or frame:id,x,y");
    expect(() => captureDefines({ POCKETJS_CAP_N: "0" })).toThrow(
      "outside its supported range",
    );
  });

  test("supports a guest-only package build without native toolchains", () => {
    expect(parse3dsArguments(["--plan=/tmp/app.plan.json", "--manifest=/tmp/pocket.3ds.json"])).toMatchObject({
      planPath: "/tmp/app.plan.json", manifestPath: "/tmp/pocket.3ds.json", cargoArgs: [],
    });
    expect(parse3dsArguments(["3ds-demo", "--pocket-only"])).toMatchObject({
      app: "3ds-demo",
      pocketOnly: true,
      capture: false,
      cia: false,
    });
  });
});

describe("CIA title identity", () => {
  const APP = "dev.pocket-stack.3ds-demo";

  test("puts the unique id in the homebrew block and keeps it stable", () => {
    // 0xFF000-0xFFFFF is the range no retail or system title is assigned, so an
    // installed CIA cannot collide with one the console already has.
    for (const app of [APP, "dev.pocket-stack.voxel", "a", ""]) {
      const unique = Number.parseInt(ciaUniqueId(app), 16);
      expect(unique).toBeGreaterThanOrEqual(0xff000);
      expect(unique).toBeLessThanOrEqual(0xfffff);
    }
    // Derived, so a rebuild replaces the installed title instead of adding one.
    expect(ciaUniqueId(APP)).toBe(ciaUniqueId(APP));
    expect(ciaUniqueId(APP)).not.toBe(ciaUniqueId("dev.pocket-stack.voxel"));
  });

  test("names the directory the installed title lands in", () => {
    // 00040000 is the application category; the low word is the unique id
    // shifted up by the 8-bit variation, which is 0.
    const unique = Number.parseInt(ciaUniqueId(APP), 16);
    expect(ciaTitleId(APP)).toBe(`00040000${((unique << 8) >>> 0).toString(16).padStart(8, "0")}`);
  });

  test("emits a product code makerom accepts without FreeProductCode", () => {
    // makerom's IsValidProductCode: 10..16 characters, CTR or KTR, '-' at 3 and
    // 5, digits or uppercase letters elsewhere.
    for (const app of [APP, "x", "dev.pocket-stack.a-b", "UPPER.case.9"]) {
      expect(ciaProductCode(app)).toMatch(/^CTR-[A-Z0-9]-[A-Z0-9]{4}$/);
    }
    expect(ciaProductCode(APP)).toBe("CTR-P-3DSD");
  });

  test("cuts the process name to the 8 bytes the exheader holds", () => {
    // makerom truncates BasicInfo.Title to 8 silently; doing it here keeps the
    // cut visible. The SMDH still carries the manifest title whole.
    expect(ciaProcessName("PocketJS: 3DS Top Screen", APP)).toBe("PocketJS");
    expect(ciaProcessName("", APP)).not.toBe("");
    // Characters that would end the RSF's quoted scalar or open another
    // substitution are dropped before the cut.
    expect(ciaProcessName('a"b\\c$d', APP)).toBe("abcd");
    for (const title of ["", "字", 'a"b', "a".repeat(40)]) {
      const name = ciaProcessName(title, APP);
      expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(8);
      expect(name).toMatch(/^[\x20-\x7e]+$/);
    }
  });

  test("the RSF asks for the memory region that is the point of a CIA", () => {
    const rsf = readFileSync(
      join(new URL("..", import.meta.url).pathname, "hosts/3ds/app.rsf"),
      "utf8",
    );
    // A .3dsx inherits hbmenu's allocation; a CIA asks for its own region.
    expect(rsf).toMatch(/^\s+SystemMode\s+: 64MB$/m);
    expect(rsf).toMatch(/^\s+SystemModeExt\s+: 124MB$/m);
    // The four values hosts/3ds/Makefile substitutes; a rename breaks here.
    for (const name of ["APP_TITLE", "APP_PRODUCT_CODE", "APP_UNIQUE_ID", "APP_ROMFS"]) {
      expect(rsf).toContain(`$(${name})`);
    }
    // makerom builds the romfs from a directory; the raw image 3dsxtool embeds
    // is rejected as "Invalid RomFS Binary".
    expect(rsf).toMatch(/^RomFs:\n {2}RootPath: \$\(APP_ROMFS\)$/m);
  });
});
