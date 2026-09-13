import { describe, expect, test } from "bun:test";
import {
  generatePocketSystemV1Schema,
  POCKET_SYSTEM_SCHEMA_ID,
} from "../contracts/spec/pocket-system.ts";
import {
  generatePocketManifestV2Schema,
  POCKET_MANIFEST_SCHEMA_ID,
  type PocketManifestV2,
} from "../contracts/spec/pocket-manifest.ts";
import {
  POCKET_CAPABILITIES,
  POCKET_PLATFORM_CONTRACTS,
  POCKET_TARGETS,
  defineCapabilityRegistry,
  definePlatformContractRegistry,
  defineTargetRegistry,
  type CapabilityId,
  type TargetId,
  type TargetProfile,
} from "../contracts/spec/platforms.ts";
import { verifyPlanHash } from "../framework/src/manifest/plan.ts";
import {
  resolveBuildPlan,
  validateAndResolveBuildPlan,
  validatePlatformContractRegistry,
} from "../framework/src/manifest/resolve.ts";
import { validatePocketManifest } from "../framework/src/manifest/validate.ts";
import { validatePocketSystem } from "../framework/src/manifest/system.ts";

const fixtureUrl = (name: string) => new URL(`./fixtures/manifests/${name}.json`, import.meta.url);
const portableInput: unknown = await Bun.file(fixtureUrl("portable-psp")).json();
const invalidExtraInput: unknown = await Bun.file(fixtureUrl("invalid-extra-field")).json();
const touchInput: unknown = await Bun.file(fixtureUrl("requires-touch")).json();

function manifest(input: unknown): PocketManifestV2 {
  const result = validatePocketManifest(input);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.value;
}

const SYNTHETIC_CAPABILITIES = defineCapabilityRegistry([...POCKET_CAPABILITIES] as const);

type SyntheticCapabilityId = CapabilityId<typeof SYNTHETIC_CAPABILITIES>;

const syntheticTargetDefinitions = {
  psp: POCKET_TARGETS.psp,
  "vita-test": {
    hostAbi: 2,
    platform: "vita",
    form: "takeover",
    display: {
      physicalViewport: [960, 544],
      logicalViewports: [[480, 272]],
      presentations: ["integer-fit"],
      rasterDensity: 2,
    },
    capabilities: [
      "input.analog.left",
      "input.buttons",
      "input.touch",
      "text.glyphs.baked",
    ],
  },
  "dual-test": {
    hostAbi: 8,
    platform: "dual-test",
    form: "takeover",
    display: {
      physicalViewport: [400, 240],
      logicalViewports: [[400, 240]],
      presentations: ["native"],
      rasterDensity: 1,
      auxiliary: {
        physicalViewport: [320, 240],
        logicalViewports: [[320, 240]],
        presentations: ["native"],
        rasterDensity: 1,
      },
    },
    capabilities: [
      "input.buttons",
      "input.touch.auxiliary",
      "display.auxiliary",
      "text.glyphs.baked",
    ],
  },
} as const satisfies Readonly<Record<string, TargetProfile<SyntheticCapabilityId>>>;

const SYNTHETIC_TARGETS = defineTargetRegistry<
  SyntheticCapabilityId,
  typeof syntheticTargetDefinitions
>(syntheticTargetDefinitions);

type SyntheticTargetId = TargetId<typeof SYNTHETIC_TARGETS>;
const SYNTHETIC_CONTRACTS = definePlatformContractRegistry(
  SYNTHETIC_CAPABILITIES,
  SYNTHETIC_TARGETS,
);

describe("pocket.json v2 schema", () => {
  test("uses the schema path deployed by pocketjs.dev", () => {
    expect(POCKET_MANIFEST_SCHEMA_ID).toBe("https://pocketjs.dev/schema/pocket-2.json");
  });

  test("committed JSON Schema is byte-exact with the TypeScript source", async () => {
    const committed = await Bun.file(new URL("../contracts/schema/pocket-2.json", import.meta.url)).text();
    expect(committed).toBe(generatePocketManifestV2Schema());
  });

  test("accepts the portable PSP fixture", () => {
    expect(validatePocketManifest(portableInput).ok).toBe(true);
  });

  test("rejects unknown fields at their exact JSON Pointer", () => {
    const result = validatePocketManifest(invalidExtraInput);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toContainEqual({
      code: "schema.additionalProperty",
      path: "/app/target",
      message: "unknown property",
    });
  });

  test("accepts only relative entries and string capability ids", () => {
    const bad = structuredClone(portableInput) as Record<string, any>;
    bad.app.entry = "../outside.tsx";
    bad.engine.capabilities.requires[0] = { id: "input.buttons", version: 1 };
    const result = validatePocketManifest(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((item) => [item.code, item.path])).toEqual(expect.arrayContaining([
      ["schema.pattern", "/app/entry"],
      ["schema.type", "/engine/capabilities/requires/0"],
    ]));
  });

  test("rejects packaging fields until a backend consumes them", () => {
    const bad = structuredClone(portableInput) as Record<string, any>;
    bad.packages = { psp: { title: "unused" } };
    const result = validatePocketManifest(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toContainEqual({
      code: "schema.additionalProperty",
      path: "/packages",
      message: "unknown property",
    });
  });

  test("accepts declared execution classes and rejects unknown ones", () => {
    const dual = structuredClone(portableInput) as Record<string, any>;
    dual.execution = { classes: ["guest", "aot"] };
    expect(validatePocketManifest(dual).ok).toBe(true);

    const unknown = structuredClone(portableInput) as Record<string, any>;
    unknown.execution = { classes: ["jit"] };
    const result = validatePocketManifest(unknown);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toContainEqual({
      code: "schema.enum",
      path: "/execution/classes/0",
      message: 'expected one of "guest", "aot"',
    });
  });

  test("accepts a fixed auxiliary surface and rejects undeclared fields", () => {
    const dual = structuredClone(portableInput) as Record<string, any>;
    dual.app.surfaces = {
      auxiliary: { fixed: { logical: [320, 240], presentation: "native" } },
    };
    expect(validatePocketManifest(dual).ok).toBe(true);

    dual.app.surfaces.auxiliary.panel = "bottom";
    const result = validatePocketManifest(dual);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toContainEqual({
      code: "schema.additionalProperty",
      path: "/app/surfaces/auxiliary/panel",
      message: "unknown property",
    });
  });
});

describe("Pocket System v1 schema", () => {
  test("uses the deployed schema path and matches the committed JSON Schema", async () => {
    expect(POCKET_SYSTEM_SCHEMA_ID).toBe(
      "https://pocketjs.dev/schema/pocket-system-1.json",
    );
    const committed = await Bun.file(
      new URL("../contracts/schema/pocket-system-1.json", import.meta.url),
    ).text();
    expect(committed).toBe(generatePocketSystemV1Schema());
  });

  test("validates a managed desktop installation model", async () => {
    const system = await Bun.file(
      new URL("./fixtures/systems/managed-desktop.json", import.meta.url),
    ).json();
    expect(validatePocketSystem(system).ok).toBe(true);
  });
});

describe("platform registry", () => {
  test("production advertises only the truthful stock-host profiles", () => {
    expect(Object.keys(POCKET_TARGETS)).toEqual([
      "psp",
      "vita",
      "pocketbook",
      "macos-widget",
      "macos-app",
      "linux-app",
      "web-app",
    ]);
    expect(validatePlatformContractRegistry(POCKET_PLATFORM_CONTRACTS)).toEqual([]);
    expect(POCKET_TARGETS.psp.capabilities).toEqual([
      "input.analog.left",
      "input.buttons",
      "io.offload",
      "text.layout.offload",
      "input.cursor",
      "audio.pcm",
      "text.glyphs.baked",
    ]);
    expect(POCKET_TARGETS.vita.capabilities).toEqual([
      "input.analog.left",
      "input.buttons",
      "input.cursor",
      "input.touch",
      "text.glyphs.baked",
    ]);
    expect(POCKET_TARGETS.vita.display).toEqual({
      physicalViewport: [960, 544],
      logicalViewports: [[480, 272]],
      presentations: ["integer-fit"],
      rasterDensity: 2,
    });
    // The PocketBook e-reader target: real touch, no nub/cursor, and the
    // same nominal 960×544 @2x surface as vita (the host integer-fits it
    // onto whatever panel the device actually has).
    expect(POCKET_TARGETS.pocketbook.capabilities).toEqual([
      "input.buttons",
      "input.touch",
      "text.glyphs.baked",
    ]);
    expect(POCKET_TARGETS.pocketbook.display).toEqual({
      physicalViewport: [960, 544],
      logicalViewports: [[480, 272]],
      presentations: ["integer-fit"],
      rasterDensity: 2,
    });
    // The desktop widget target: dynamic viewport, real pointer/text/IME,
    // runtime glyph baking — and honestly NO nub or synthesized cursor.
    expect(POCKET_TARGETS["macos-widget"].capabilities).toEqual([
      "input.buttons",
      "input.ime",
      "input.pointer",
      "input.text",
      "host.clipboard",
      "display.viewport.live",
      "text.glyphs.baked",
      "text.glyphs.runtime",
    ]);
    expect(POCKET_TARGETS["macos-widget"].display.dynamicViewport).toEqual({
      min: [240, 180],
      max: [4096, 4096],
    });
    // The gpui app frame: same desktop wire generation as the widget shell
    // (hostAbi 4 adds compositor surfaces), a general window that ALSO hosts fixed-viewport apps
    // (acceptsFixed), and host text layout instead of runtime glyph baking.
    // Deliberately NARROW: only host-generic behavior registers — pointer/
    // text/IME/clipboard reach the note via its companion svc adapter and
    // are not target capabilities here (the platforms.ts header rule).
    expect(POCKET_TARGETS["macos-app"].hostAbi).toBe(4);
    expect(POCKET_TARGETS["macos-app"].form).toBe("window");
    expect(POCKET_TARGETS["macos-app"].capabilities).toEqual([
      "input.buttons",
      "display.viewport.live",
      "text.glyphs.baked",
      "io.offload",
      "text.layout.offload",
    ]);
    expect(POCKET_TARGETS["macos-app"].roleCapabilities).toEqual({
      systemUI: ["ui.compositor-surfaces"],
    });
    expect(POCKET_TARGETS["macos-app"].display.dynamicViewport).toEqual({
      min: [240, 180],
      max: [4096, 4096],
      acceptsFixed: true,
    });
    expect(POCKET_TARGETS["linux-app"]).toEqual({
      hostAbi: 4,
      platform: "linux",
      form: "window",
      display: {
        physicalViewport: [1280, 800],
        logicalViewports: [[800, 600]],
        dynamicViewport: {
          min: [240, 180],
          max: [4096, 4096],
          acceptsFixed: true,
        },
        presentations: ["native"],
        rasterDensity: 1,
      },
      capabilities: [
        "input.buttons",
        "display.viewport.live",
        "text.glyphs.baked",
        "io.offload",
      "text.layout.offload",
      ],
      roleCapabilities: { systemUI: ["ui.compositor-surfaces"] },
    });
    expect(POCKET_TARGETS["web-app"]).toEqual({
      hostAbi: 4,
      platform: "web",
      form: "window",
      display: {
        physicalViewport: [800, 600],
        logicalViewports: [[800, 600]],
        dynamicViewport: {
          min: [320, 240],
          max: [4096, 4096],
          acceptsFixed: true,
        },
        presentations: ["native"],
        rasterDensity: 1,
      },
      capabilities: [
        "input.buttons",
        "display.viewport.live",
        "text.glyphs.baked",
        "io.offload",
        "text.layout.offload",
      ],
      roleCapabilities: { systemUI: ["ui.compositor-surfaces"] },
    });
  });

  test("TargetId and capability registries extend without changing the resolver", () => {
    const ids: SyntheticTargetId[] = ["psp", "vita-test"];
    expect(ids).toEqual(["psp", "vita-test"]);
    expect(validatePlatformContractRegistry(SYNTHETIC_CONTRACTS)).toEqual([]);
  });

  test("rejects invalid target raster densities at the registry boundary", () => {
    const invalid = structuredClone(SYNTHETIC_CONTRACTS) as any;
    invalid.targets["vita-test"].display.rasterDensity = 1.5;
    expect(validatePlatformContractRegistry(invalid)).toContainEqual({
      code: "registry.invalidRasterDensity",
      path: "/targets/vita-test/display/rasterDensity",
      message: "target rasterDensity must be an integer from 1 through 255",
    });
  });

  test("reports a missing dynamic range instead of throwing during resolution", async () => {
    const invalid = structuredClone(POCKET_PLATFORM_CONTRACTS) as any;
    delete invalid.targets["macos-widget"].display.dynamicViewport;
    const note = await Bun.file(new URL("../apps/note/pocket.json", import.meta.url)).json();
    const result = validateAndResolveBuildPlan(note, { target: "macos-widget" }, invalid);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toContainEqual({
      code: "registry.dynamicViewportMissing",
      path: "/targets/macos-widget/display",
      message: "widget-form targets must declare display.dynamicViewport",
    });
  });

});

describe("semantic resolution", () => {
  test("the legacy note uses baked text on portable desktop hosts", async () => {
    // Portable hosts never advertise OS text layout. Async text is explicit.
    const note = await Bun.file(new URL("../apps/note/pocket.json", import.meta.url)).json();
    const onApp = validateAndResolveBuildPlan(note, { target: "macos-app" });
    expect(onApp.ok).toBe(true);
    if (!onApp.ok) return;
    expect(onApp.plan.features["text.layout.native"]).toBe(false);
    expect(onApp.plan.features["text.glyphs.runtime"]).toBe(false);
    expect(onApp.plan.target.hostAbi).toBe(4);

    const onWidget = validateAndResolveBuildPlan(note, { target: "macos-widget" });
    expect(onWidget.ok).toBe(true);
    if (!onWidget.ok) return;
    expect(onWidget.plan.features["text.layout.native"]).toBe(false);
    expect(onWidget.plan.features["text.glyphs.runtime"]).toBe(true);

    // The companion adapter is PLAN data now (issue #295): hosts build
    // their svc allowlist and adapter wiring from this list, never from
    // app-name conventions; the viewport policy rides along so hosts
    // derive size-locking from the plan too.
    expect(onApp.plan.companions).toEqual(["note"]);
    expect(onApp.plan.viewport.policy).toBe("dynamic");
    const hero = await Bun.file(new URL("../apps/hero/pocket.json", import.meta.url)).json();
    const heroOnApp = validateAndResolveBuildPlan(hero, { target: "macos-app" });
    expect(heroOnApp.ok).toBe(true);
    if (!heroOnApp.ok) return;
    expect(heroOnApp.plan.companions).toEqual([]);
    expect(heroOnApp.plan.viewport.policy).toBe("dynamic");
    const heroOnPsp = validateAndResolveBuildPlan(hero, { target: "psp" });
    expect(heroOnPsp.ok).toBe(true);
    if (!heroOnPsp.ok) return;
    expect(heroOnPsp.plan.viewport.policy).toBe("fixed");
  });

  test("guest resolution honors the declared execution classes", () => {
    const dual = structuredClone(portableInput) as Record<string, any>;
    dual.execution = { classes: ["guest", "aot"] };
    expect(validateAndResolveBuildPlan(dual, { target: "psp" }).ok).toBe(true);

    const aotOnly = structuredClone(portableInput) as Record<string, any>;
    aotOnly.execution = { classes: ["aot"] };
    const result = validateAndResolveBuildPlan(aotOnly, { target: "psp" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toContainEqual({
      code: "execution.guestExcluded",
      path: "/execution/classes",
      message: "manifest declares no guest execution class; this resolver only builds guest plans",
    });
  });

  test("resolves a small PSP build plan", () => {
    const result = validateAndResolveBuildPlan(portableInput, { target: "psp" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.target).toEqual({ id: "psp", hostAbi: 1 });
    expect(result.plan.app).toEqual({
      id: "dev.pocket-stack.telemetry",
      title: "Pocket Telemetry",
      version: "0.1.0",
      entry: "app/main.tsx",
      output: "main",
      framework: "solid",
    });
    expect(result.plan.viewport).toEqual({
      logical: [480, 272],
      physical: [480, 272],
      presentation: "integer-fit",
      rasterDensity: 1,
      policy: "fixed",
    });
    expect(result.plan.features).toEqual({
      "input.analog.left": true,
      "input.buttons": true,
      "text.glyphs.baked": true,
    });
    expect(result.plan.planHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verifyPlanHash(result.plan)).toBe(true);
  });

  test("desktop-widget capabilities are first-class: PSP admission refuses them", () => {
    // A widget-only app REQUIRES the desktop surface — a PSP plan must be
    // rejected at resolve time, not discovered broken at runtime.
    const widgetOnly = structuredClone(portableInput) as any;
    widgetOnly.engine.capabilities.requires = ["text.glyphs.baked", "input.text", "input.pointer"];
    const onPsp = validateAndResolveBuildPlan(widgetOnly, { target: "psp" });
    expect(onPsp.ok).toBe(false);
    if (onPsp.ok) return;
    const codes = onPsp.diagnostics.map((d) => d.code);
    expect(codes).toContain("capability.unavailable");
  });

  test("resolves the note's dynamic manifest and an explicit fixed variant", async () => {
    const manifest = await Bun.file(new URL("../apps/note/pocket.json", import.meta.url)).json();
    const result = validateAndResolveBuildPlan(manifest, { target: "macos-widget" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.target).toEqual({ id: "macos-widget", hostAbi: 3 });
    // Dynamic-viewport native presentation: density from the profile.
    expect(result.plan.viewport.rasterDensity).toBe(2);
    expect(result.plan.viewport.logical).toEqual([420, 560]);
    // requires are on; enhances resolve to available on this target.
    expect(result.plan.features["input.text"]).toBe(true);
    expect(result.plan.features["input.ime"]).toBe(true);
    expect(result.plan.features["host.clipboard"]).toBe(true);
    expect(result.plan.features["display.viewport.live"]).toBe(true);
    expect(result.plan.features["text.glyphs.runtime"]).toBe(true);

    // The source has a read-only fallback, but its current dynamic-only
    // manifest does not admit on PSP. Adding an explicit fixed variant makes
    // that fallback admissible; the desktop-only enhances then resolve off.
    const onPsp = validateAndResolveBuildPlan(
      { ...manifest, app: { ...manifest.app, viewport: { logical: [480, 272], presentation: "integer-fit" } } },
      { target: "psp" },
    );
    expect(onPsp.ok).toBe(true);
    if (!onPsp.ok) return;
    expect(onPsp.plan.features["input.text"]).toBe(false);
    expect(onPsp.plan.features["input.pointer"]).toBe(false);
  });

  test("dynamic viewport admits in-range sizes and rejects out-of-range", async () => {
    const manifest = await Bun.file(new URL("../apps/note/pocket.json", import.meta.url)).json();
    const tiny = structuredClone(manifest) as any;
    tiny.app.viewport.dynamic.default = [100, 100];
    const rejected = validateAndResolveBuildPlan(tiny, { target: "macos-widget" });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.diagnostics.map((d) => d.code)).toContain("viewport.logicalUnsupported");

    const roomy = structuredClone(manifest) as any;
    roomy.app.viewport.dynamic.default = [800, 600];
    expect(validateAndResolveBuildPlan(roomy, { target: "macos-widget" }).ok).toBe(true);
  });

  test("every committed demo manifest lands on the expected admission matrix", async () => {
    const { readdirSync, existsSync } = await import("node:fs");
    // demo -> [psp, vita, macos-widget, macos-app] admission. Fixed-only
    // console demos stay off the desktop widget (its profile presents
    // "native" over a dynamic viewport, not the console integer-fit
    // contract) but land on the macos-app frame, which hosts fixed apps
    // size-locked (acceptsFixed); Hero declares both policies, while the
    // note is dynamic-only. A new demo missing here fails the test on
    // purpose.
    const expected: Record<string, [boolean, boolean, boolean, boolean]> = {
      "3ds-demo": [false, false, false, false], // requires the private 3ds-dev profile's auxiliary display and touch contracts
      "blackberry-classic-demo": [false, false, false, true], // built by the private blackberry-{qnx,android}-dev profiles; macos-app also admits its fixed 360x360 buttons+glyphs contract
      cafe: [true, true, false, true],
      cards: [true, true, false, true],
      chrome: [true, true, false, true],
      clear: [false, false, false, false], // admitted only by the private ipodtouch4-dev profile (fixed 320x480 portrait touch surface)
      cursor: [true, true, false, true],
      gallery: [true, true, false, true],
      hero: [true, true, true, true],
      "hero-vue-sfc": [true, true, false, true],
      "hero-vue-vapor": [true, true, false, true],
      im: [true, true, false, true],
      "iphone16-demo": [false, true, false, false], // targets the private ios-dev profile; vita shares its touch + integer-fit contract
      "iphone2g-demo": [false, false, false, false], // admitted only by the private iphone2g-dev profile
      "iphone4s-demo": [false, false, false, false], // admitted only by the private iphone4s-dev profile
      "ipodtouch-demo": [false, false, false, false], // admitted only by the private ipodtouch-dev profile
      "meizu-m8-demo": [false, false, false, false], // admitted only by the private meizu-m8-dev profile
      nsengine: [false, true, false, false], // targets the private ios-dev profile; vita shares its touch + integer-fit contract
      "ipod-nano": [false, false, false, false], // admitted by the package-shaped macos-embedded target
      launcher: [true, true, false, true], // the Cover Flow deck (docs/LAUNCHER.md) is an ordinary console app
      library: [true, true, false, true],
      motions: [true, true, false, true],
      music: [true, true, false, true],
      note: [false, false, true, true],
      notifications: [true, true, false, true],
      settings: [true, true, false, true],
      stats: [true, true, false, true],
      "text-offload": [true, false, false, true], // requires a supported companion transport
      "vue-sfc-lab": [true, true, false, true],
      zoomlab: [true, true, false, true],
    };
    const targets = ["psp", "vita", "macos-widget", "macos-app"] as const;
    for (const demo of readdirSync(new URL("../apps/", import.meta.url)).sort()) {
      const url = new URL(`../apps/${demo}/pocket.json`, import.meta.url);
      if (!existsSync(url)) continue;
      const manifest = await Bun.file(url).json();
      expect(expected[demo]).toBeDefined();
      targets.forEach((target, i) => {
        const result = validateAndResolveBuildPlan(manifest, { target });
        expect(`${demo}@${target}:${result.ok}`).toBe(`${demo}@${target}:${expected[demo][i]}`);
      });
    }
    const systemUI = await Bun.file(
      new URL("./fixtures/manifests/system-ui.json", import.meta.url),
    ).json();
    expect(
      validateAndResolveBuildPlan(systemUI, {
        target: "macos-app",
        role: "systemUI",
      }).ok,
    ).toBe(true);
    // The demo shelf rule the site build applies: only psp-admissible
    // manifests are shown — the note stays off the landing/playground.
    const note = await Bun.file(new URL("../apps/note/pocket.json", import.meta.url)).json();
    expect(validateAndResolveBuildPlan(note, { target: "psp" }).ok).toBe(false);
  });

  test("portable text admission requires its offload transport declaration", async () => {
    const manifest = await Bun.file(new URL("../apps/text-offload/pocket.json", import.meta.url)).json();
    manifest.engine.capabilities.requires = manifest.engine.capabilities.requires.filter((cap: string) => cap !== "io.offload");
    for (const target of ["psp", "macos-app"] as const) {
      expect(validateAndResolveBuildPlan(manifest, { target }).ok).toBe(false);
    }
  });

  test("viewport policy: legacy shorthand, dynamic-required, fixed-unhosted", async () => {
    // The bare {logical, presentation} spelling is shorthand for {fixed}.
    const legacy = structuredClone(portableInput) as any;
    legacy.app.viewport = { logical: [480, 272], presentation: "integer-fit" };
    expect(validateAndResolveBuildPlan(legacy, { target: "psp" }).ok).toBe(true);

    // A dynamic-only app is refused by fixed-screen forms…
    const note = await Bun.file(new URL("../apps/note/pocket.json", import.meta.url)).json();
    const onPsp = validateAndResolveBuildPlan(note, { target: "psp" });
    expect(onPsp.ok).toBe(false);
    if (onPsp.ok) return;
    expect(onPsp.diagnostics.map((d) => d.code)).toContain("viewport.fixedRequired");
  });

  test("widget form does not host fixed-viewport apps (acceptsFixed off)", () => {
    const fixedOnly = structuredClone(portableInput) as any;
    fixedOnly.engine.capabilities.requires = ["text.glyphs.baked", "input.buttons"];
    const result = validateAndResolveBuildPlan(fixedOnly, { target: "macos-widget" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => d.code)).toContain("viewport.fixedUnhosted");
  });

  test("diagnostics point into an explicit fixed viewport variant", () => {
    const fixed = structuredClone(portableInput) as any;
    fixed.app.viewport = {
      fixed: { logical: [320, 240], presentation: "stretch" },
    };
    const result = validateAndResolveBuildPlan(fixed, { target: "psp" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((diagnostic) => diagnostic.path)).toEqual(
      expect.arrayContaining([
        "/app/viewport/fixed/logical",
        "/app/viewport/fixed/presentation",
      ]),
    );
  });

  test("profiles carry queryable platform/form fields — ids are labels", () => {
    expect(POCKET_TARGETS.psp.platform).toBe("psp");
    expect(POCKET_TARGETS.psp.form).toBe("takeover");
    expect(POCKET_TARGETS.vita.form).toBe("takeover");
    expect(POCKET_TARGETS["macos-widget"].platform).toBe("macos");
    expect(POCKET_TARGETS["macos-widget"].form).toBe("widget");
  });

  test("stock-demo builds prefer the demo's own manifest over synthesis", async () => {
    const { demoManifestFor } = await import("../tools/demo-identity.ts");
    const root = new URL("../", import.meta.url).pathname;
    const im = demoManifestFor(root, "im") as any;
    expect(im.id).toBe("dev.pocket-stack.im");
    expect(im.app.output).toBe("im-main");
    expect(im.engine.capabilities.enhances).toEqual(["input.analog.left"]);
    // A real manifest owns its framework — the override only applies to
    // the synthesized fallback path.
    const vue = demoManifestFor(root, "hero-vue-vapor", "solid") as any;
    expect(vue.app.framework).toBe("vue-vapor");
  });

  test("resolved PSP plan is byte-exact with its committed fixture", async () => {
    const result = validateAndResolveBuildPlan(portableInput, { target: "psp" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const committed = await Bun.file(
      new URL("./fixtures/plans/portable-psp.plan.json", import.meta.url),
    ).text();
    expect(JSON.stringify(result.plan, null, 2) + "\n").toBe(committed);
  });

  test("portable PSP baseline resolves to a native-density Vita plan", async () => {
    const result = validateAndResolveBuildPlan(portableInput, { target: "vita" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.target).toEqual({ id: "vita", hostAbi: 2 });
    expect(result.plan.viewport).toEqual({
      logical: [480, 272],
      physical: [960, 544],
      presentation: "integer-fit",
      rasterDensity: 2,
      policy: "fixed",
    });
    expect(result.plan.features).toEqual({
      "input.analog.left": true,
      "input.buttons": true,
      "text.glyphs.baked": true,
    });
    const committed = await Bun.file(
      new URL("./fixtures/plans/portable-vita.plan.json", import.meta.url),
    ).text();
    expect(JSON.stringify(result.plan, null, 2) + "\n").toBe(committed);
  });

  test("plan checksum is independent of capability order but covers package identity", () => {
    const changed = structuredClone(portableInput) as Record<string, any>;
    changed.engine.capabilities.requires.reverse();
    changed.id = "dev.pocket-stack.renamed";
    changed.name = "renamed-app";
    changed.title = "Renamed App";
    changed.version = "9.0.0";
    const left = validateAndResolveBuildPlan(portableInput, { target: "psp" });
    const right = validateAndResolveBuildPlan(changed, { target: "psp" });
    expect(left.ok && right.ok).toBe(true);
    if (!left.ok || !right.ok) return;
    expect(left.plan.features).toEqual(right.plan.features);
    expect(left.plan.planHash).not.toBe(right.plan.planHash);
  });

  test("reports unknown targets and missing hard requirements", () => {
    const unknownTarget = validateAndResolveBuildPlan(portableInput, { target: "switch" });
    expect(unknownTarget.ok).toBe(false);
    if (!unknownTarget.ok) expect(unknownTarget.diagnostics[0]?.code).toBe("target.unknown");

    const needsTouch = structuredClone(portableInput) as Record<string, any>;
    needsTouch.engine.capabilities.requires.push("input.touch");
    const unavailable = resolveBuildPlan(manifest(needsTouch), { target: "psp" }, SYNTHETIC_CONTRACTS);
    expect(unavailable.ok).toBe(false);
    if (!unavailable.ok) {
      expect(unavailable.diagnostics.some((item) => item.code === "capability.unavailable")).toBe(true);
    }
  });

  test("rejects duplicate requires/enhances declarations", () => {
    const bad = structuredClone(portableInput) as Record<string, any>;
    bad.engine.capabilities.enhances = ["input.buttons"];
    const result = validateAndResolveBuildPlan(bad, { target: "psp" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.some((item) => item.code === "capability.duplicate")).toBe(true);
  });

  test("a PSP baseline resolves unchanged for a higher-resolution Vita host", () => {
    const result = resolveBuildPlan(manifest(portableInput), { target: "vita-test" }, SYNTHETIC_CONTRACTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.viewport).toEqual({
      logical: [480, 272],
      physical: [960, 544],
      presentation: "integer-fit",
      rasterDensity: 2,
      policy: "fixed",
    });
    expect(Object.values(result.plan.features).every(Boolean)).toBe(true);
  });

  test("enhancements record target availability without gating resolution", () => {
    const adaptive = structuredClone(portableInput) as Record<string, any>;
    adaptive.engine.capabilities.enhances = ["input.touch"];
    const parsed = manifest(adaptive);

    const psp = resolveBuildPlan(parsed, { target: "psp" }, SYNTHETIC_CONTRACTS);
    const vita = resolveBuildPlan(parsed, { target: "vita-test" }, SYNTHETIC_CONTRACTS);
    expect(psp.ok && vita.ok).toBe(true);
    if (!psp.ok || !vita.ok) return;
    expect(psp.plan.features["input.touch"]).toBe(false);
    expect(vita.plan.features["input.touch"]).toBe(true);
  });

  test("production Vita resolves the implemented touch contract", () => {
    const result = validateAndResolveBuildPlan(touchInput, { target: "vita" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.target.hostAbi).toBe(2);
    expect(result.plan.features["input.touch"]).toBe(true);
  });

  test("resolves auxiliary display and touch as separate capabilities", () => {
    const dual = structuredClone(portableInput) as Record<string, any>;
    dual.app.viewport.logical = [400, 240];
    dual.app.viewport.presentation = "native";
    dual.app.surfaces = {
      auxiliary: { fixed: { logical: [320, 240], presentation: "native" } },
    };
    dual.engine.capabilities.requires = [
      "input.buttons",
      "text.glyphs.baked",
      "display.auxiliary",
      "input.touch.auxiliary",
    ];

    const result = resolveBuildPlan(manifest(dual), { target: "dual-test" }, SYNTHETIC_CONTRACTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.surfaces).toEqual({
      auxiliary: {
        logical: [320, 240],
        physical: [320, 240],
        presentation: "native",
        rasterDensity: 1,
      },
    });
    expect(result.plan.features).toEqual({
      "display.auxiliary": true,
      "input.buttons": true,
      "input.touch.auxiliary": true,
      "text.glyphs.baked": true,
    });
    expect(result.plan.features).not.toHaveProperty("input.touch");
    expect(verifyPlanHash(result.plan)).toBe(true);
  });

  test("enforces auxiliary surface declarations, dependencies and geometry", () => {
    const base = structuredClone(portableInput) as Record<string, any>;
    base.app.viewport.logical = [400, 240];
    base.app.viewport.presentation = "native";

    const missingSurface = structuredClone(base);
    missingSurface.engine.capabilities.requires.push("display.auxiliary");
    const missingResult = resolveBuildPlan(
      manifest(missingSurface),
      { target: "dual-test" },
      SYNTHETIC_CONTRACTS,
    );
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) {
      expect(missingResult.diagnostics.map((item) => item.code)).toContain(
        "surface.auxiliaryDeclarationMismatch",
      );
    }

    const touchWithoutDisplay = structuredClone(base);
    touchWithoutDisplay.engine.capabilities.requires.push("input.touch.auxiliary");
    const dependencyResult = resolveBuildPlan(
      manifest(touchWithoutDisplay),
      { target: "dual-test" },
      SYNTHETIC_CONTRACTS,
    );
    expect(dependencyResult.ok).toBe(false);
    if (!dependencyResult.ok) {
      expect(dependencyResult.diagnostics.map((item) => item.code)).toContain(
        "capability.dependency",
      );
    }

    const wrongGeometry = structuredClone(base);
    wrongGeometry.engine.capabilities.requires.push("display.auxiliary");
    wrongGeometry.app.surfaces = {
      auxiliary: { fixed: { logical: [400, 240], presentation: "native" } },
    };
    const geometryResult = resolveBuildPlan(
      manifest(wrongGeometry),
      { target: "dual-test" },
      SYNTHETIC_CONTRACTS,
    );
    expect(geometryResult.ok).toBe(false);
    if (!geometryResult.ok) {
      expect(geometryResult.diagnostics.map((item) => item.code)).toEqual(
        expect.arrayContaining(["surface.logicalUnsupported", "surface.nativeMismatch"]),
      );
    }
  });

  test("rejects target profiles whose auxiliary facts and capabilities drift", () => {
    const missingFacts = definePlatformContractRegistry(
      SYNTHETIC_CAPABILITIES,
      defineTargetRegistry({
        broken: {
          ...syntheticTargetDefinitions["dual-test"],
          display: {
            physicalViewport: [400, 240],
            logicalViewports: [[400, 240]],
            presentations: ["native"],
            rasterDensity: 1,
          },
        },
      }),
    );
    expect(validatePlatformContractRegistry(missingFacts).map((item) => item.code)).toContain(
      "registry.auxiliaryDisplayMismatch",
    );

    const touchWithoutDisplay = definePlatformContractRegistry(
      SYNTHETIC_CAPABILITIES,
      defineTargetRegistry({
        broken: {
          ...syntheticTargetDefinitions["vita-test"],
          capabilities: ["input.touch.auxiliary"],
        },
      }),
    );
    expect(validatePlatformContractRegistry(touchWithoutDisplay).map((item) => item.code)).toContain(
      "registry.auxiliaryTouchWithoutDisplay",
    );
  });
});
