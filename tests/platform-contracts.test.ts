import { describe, expect, test } from "bun:test";
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import {
defineCapabilityRegistry,
definePlatformContractRegistry,
defineTargetRegistry,
POCKET_CAPABILITIES,
POCKET_PLATFORM_CONTRACTS,
POCKET_TARGETS,
type CapabilityId,
type TargetId,
type TargetProfile,
} from "../contracts/spec/platforms.ts";
import { validateAppConfig } from "../contracts/spec/app-config.ts";
import {
appIdentity,
appOutput,
resolveAppPlan,
validatePlatformContractRegistry,
} from "../framework/compiler/app-plan.ts";
import { createHostExtension } from "../framework/compiler/host-extension.ts";
import { defineHostConfig } from "../framework/src/host-config.ts";
import { validatePocketProfile } from "../framework/src/profile.ts";
import { POCKET_PROFILES } from "../hosts/index.ts";
import { BUILTIN_PROFILE_IDS } from "../hosts/ids.ts";
import { cadenceFor } from "../contracts/spec/admission.ts";
import { loadHostConfig, profileRegistry } from "../tools/profile-resolver.ts";
import { dirname, resolve } from "node:path";
import { PORTABLE_APP, ROOT, portableApp, repositoryApp, repositoryAppConfigs, resolveRepositoryApp } from "./app-fixtures.ts";

const SYNTHETIC_CAPABILITIES = defineCapabilityRegistry([...POCKET_CAPABILITIES] as const);

type SyntheticCapabilityId = CapabilityId<typeof SYNTHETIC_CAPABILITIES>;

const syntheticTargetDefinitions = {
  psp: POCKET_TARGETS.psp,
  "vita-test": {
    cadences: [60],
    hostAbi: POCKET_BINDING_GENERATION,
    platform: "vita",
    form: "takeover",
    display: {
      physicalViewport: [960, 544],
      logicalViewports: [[480, 272]],
      presentations: ["integer-fit"],
      rasterDensity: 2,
      animation: "composited",
    },
    capabilities: [
      "input.analog.left",
      "input.buttons",
      "input.touch",
      "text.glyphs.baked",
    ],
  },
  "dual-test": {
    cadences: [60],
    hostAbi: POCKET_BINDING_GENERATION,
    platform: "dual-test",
    form: "takeover",
    display: {
      physicalViewport: [400, 240],
      logicalViewports: [[400, 240]],
      presentations: ["native"],
      rasterDensity: 1,
      animation: "repaint",
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
} as const satisfies Readonly<Record<string, TargetProfile>>;

const SYNTHETIC_TARGETS = defineTargetRegistry<
  string,
  typeof syntheticTargetDefinitions
>(syntheticTargetDefinitions);

type SyntheticTargetId = TargetId<typeof SYNTHETIC_TARGETS>;
const SYNTHETIC_CONTRACTS = definePlatformContractRegistry(
  SYNTHETIC_CAPABILITIES,
  SYNTHETIC_TARGETS,
);

const codes = (result: ReturnType<typeof resolveAppPlan>) => result.ok ? [] : result.diagnostics.map(item => item.code);
const paths = (result: ReturnType<typeof resolveAppPlan>) => result.ok ? [] : result.diagnostics.map(item => [item.code, item.path]);

describe("the app section of a host config", () => {
  test("accepts the portable application", () => {
    expect(validateAppConfig(PORTABLE_APP)).toEqual([]);
  });

  test("rejects unknown fields at their exact JSON Pointer", () => {
    expect(validateAppConfig({ ...portableApp(), target: "psp" })).toContainEqual({
      code: "schema.additionalProperty", path: "/app/target", message: "unknown property",
    });
  });

  test("manifest fields are not app fields", () => {
    for (const [field, value] of [
      ["engine", { capabilities: { requires: ["input.buttons"] } }],
      ["presentations", [{ id: "touch", entry: "touch.tsx", modality: { touch: "primary" } }]],
      ["modality", { touch: "primary" }],
      ["domains", { worker: { entry: "worker.ts", nodes: [] } }],
      ["name", "telemetry"],
    ] as const) {
      expect(validateAppConfig({ ...portableApp(), [field]: value }), field).toContainEqual({
        code: "schema.additionalProperty", path: `/app/${field}`, message: "unknown property",
      });
    }
  });

  test("accepts only relative entries and string feature ids", () => {
    const bad = portableApp();
    bad.entry = "../outside.tsx";
    bad.features[0] = { id: "input.buttons", version: 1 };
    expect(validateAppConfig(bad).map((item) => [item.code, item.path])).toEqual(expect.arrayContaining([
      ["schema.pattern", "/app/entry"],
      ["schema.type", "/app/features/0"],
    ]));
    expect(validateAppConfig({ ...portableApp(), features: ["input.buttons", "input.buttons"] }).map(item => [item.code, item.path]))
      .toContainEqual(["schema.uniqueItems", "/app/features"]);
  });

  test("identity carries id, title, version, author and a relative PNG icon", () => {
    expect(validateAppConfig({ ...portableApp(), author: "Pocket Nexus", icon: "assets/icon.png" })).toEqual([]);
    for (const icon of ["/abs/icon.png", "../icon.png", "icon.svg"]) {
      expect(validateAppConfig({ ...portableApp(), icon }).map(item => item.path), icon).toEqual(["/app/icon"]);
    }
    for (const [field, value] of [["id", "telemetry"], ["version", "1.0"], ["title", ""]] as const) {
      expect(validateAppConfig({ ...portableApp(), [field]: value }).map(item => item.path), field).toEqual([`/app/${field}`]);
    }
  });

  test("theme is animation content: a config imports its module", () => {
    expect(validateAppConfig({ ...portableApp(), theme: { keyframes: { fade: { from: { opacity: 0 }, to: { opacity: 1 } } } } })).toEqual([]);
    expect(validateAppConfig({ ...portableApp(), theme: "./theme.ts" }).map(item => [item.code, item.path])).toEqual([["schema.type", "/app/theme"]]);
    expect(validateAppConfig({ ...portableApp(), theme: { keyframes: { fade: { from: { opacity: [] } } } } }).map(item => item.path))
      .toEqual(["/app/theme/keyframes/fade/from/opacity"]);
  });

  test("accepts a fixed auxiliary surface and rejects undeclared fields", () => {
    const dual = portableApp();
    dual.surfaces = { auxiliary: { fixed: { logical: [320, 240], presentation: "native" } } };
    expect(validateAppConfig(dual)).toEqual([]);
    dual.surfaces.auxiliary.panel = "bottom";
    expect(validateAppConfig(dual)).toContainEqual({
      code: "schema.additionalProperty", path: "/app/surfaces/auxiliary/panel", message: "unknown property",
    });
  });

  test("defineHostConfig takes host contract files and built-in host ids", () => {
    expect(defineHostConfig({ host: "psp", app: PORTABLE_APP }).host).toBe("psp");
    expect(defineHostConfig({ hosts: ["./pocket.host.json", ...BUILTIN_PROFILE_IDS] }).hosts).toHaveLength(BUILTIN_PROFILE_IDS.length + 1);
    expect(() => defineHostConfig({ host: "switch" })).toThrow("built-in host ids");
    expect(() => defineHostConfig({ hosts: ["psp", "psp"] })).toThrow("unique");
    expect(() => defineHostConfig({ host: "psp", app: PORTABLE_APP, presentations: [] } as never)).toThrow("host/hosts, app and build only");
    expect(() => defineHostConfig({ host: "psp", app: { ...PORTABLE_APP, entry: "../main.tsx" } })).toThrow("/app/entry:");
    expect(() => defineHostConfig({ host: "psp", app: { ...PORTABLE_APP, viewport: { logical: [480], presentation: "native" } } as never }))
      .toThrow("/app/viewport:");
  });

  test("a config names built-in hosts by id and reads their contracts", async () => {
    const hero = await loadHostConfig(resolve(ROOT, "apps/hero/pocket.host.config.ts"));
    expect(hero.profiles.map(profile => profile.id)).toEqual(hero.value.hosts as string[]);
    expect(hero.profilePaths[0]).toBe(resolve(ROOT, "hosts/psp/pocket.host.json"));
    expect(hero.profiles[0]).toEqual(POCKET_PROFILES.psp);
  });
});

describe("platform registry", () => {
  test("profiles cannot select a legacy binding generation", () => {
    for (let hostAbi = 1; hostAbi < POCKET_BINDING_GENERATION; hostAbi++) {
      const registry = definePlatformContractRegistry(POCKET_CAPABILITIES, { psp: { ...POCKET_TARGETS.psp, hostAbi } });
      expect(validatePlatformContractRegistry(registry)).toContainEqual({
        code: "registry.bindingGeneration", path: "/targets/psp/hostAbi",
        message: `target must use binding generation ${POCKET_BINDING_GENERATION}`,
      });
    }
  });

  test("production advertises only the truthful stock-host profiles", () => {
    expect(Object.keys(POCKET_TARGETS)).toEqual([
      "psp",
      "vita",
      "pocketbook",
      "macos-widget",
      "web-app",
    ]);
    expect(validatePlatformContractRegistry(POCKET_PLATFORM_CONTRACTS)).toEqual([]);
    expect(POCKET_TARGETS.psp.capabilities).toEqual([
      "audio.pcm",
      "data.fs",
      "data.pack",
      "input.analog.left",
      "input.buttons",
      "input.cursor",
      "io.offload",
      "text.glyphs.baked",
      "text.glyphs.streamed",
      "text.layout.offload",
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
      animation: "composited",
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
      animation: "still",
    });
    // The desktop widget target: dynamic viewport, real pointer/text/IME,
    // runtime glyph baking, and no nub or synthesized cursor.
    expect(POCKET_TARGETS["macos-widget"].capabilities).toEqual([
      "display.viewport.live",
      "host.clipboard",
      "input.buttons",
      "input.ime",
      "input.pointer",
      "input.text",
      "text.glyphs.baked",
      "text.glyphs.runtime",
    ]);
    expect(POCKET_TARGETS["macos-widget"].display.dynamicViewport).toEqual({
      min: [240, 180],
      max: [4096, 4096],
    });
    expect(POCKET_TARGETS["web-app"]).toEqual({
      cadences: [60],
      hostAbi: POCKET_BINDING_GENERATION,
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
        animation: "composited",
      },
      capabilities: [
        "display.viewport.live",
        "input.buttons",
        "io.offload",
        "text.glyphs.baked",
        "text.glyphs.runtime",
        "text.layout.offload",
      ],
      source: POCKET_PROFILES["web-app"],
    });
  });

  test("TargetId and capability registries extend without changing the resolver", () => {
    const ids: SyntheticTargetId[] = ["psp", "vita-test"];
    const capability: SyntheticCapabilityId = "input.touch";
    expect(ids).toEqual(["psp", "vita-test"]);
    expect(capability).toBe("input.touch");
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
    const note = await repositoryApp("apps/note/pocket.host.config.ts");
    const result = resolveRepositoryApp(note, "macos-widget", { registry: invalid });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toContainEqual({
      code: "registry.dynamicViewportMissing",
      path: "/targets/macos-widget/display",
      message: "widget-form targets must declare display.dynamicViewport",
    });
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
            animation: "repaint",
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

  test("profiles carry queryable platform/form fields; ids are labels", () => {
    expect(POCKET_TARGETS.psp.platform).toBe("psp");
    expect(POCKET_TARGETS.psp.form).toBe("takeover");
    expect(POCKET_TARGETS.vita.form).toBe("takeover");
    expect(POCKET_TARGETS["macos-widget"].platform).toBe("macos");
    expect(POCKET_TARGETS["macos-widget"].form).toBe("widget");
  });
});

describe("the repository's applications", () => {
  test("each application's config resolves for every host it lists", async () => {
    const configs = repositoryAppConfigs();
    // apps/<name>/ for every application, and the Nokia E7 build of nexus-touch.
    expect(configs).toContain(resolve(ROOT, "apps/nexus-touch/e7/pocket.host.config.ts"));
    expect(configs.length).toBeGreaterThanOrEqual(30);
    for (const path of configs) {
      const config = await loadHostConfig(path);
      expect(config.value.app, path).toBeDefined();
      expect(config.profiles.length, path).toBeGreaterThan(0);
      for (const profile of config.profiles) {
        const result = resolveAppPlan(config.value.app, { target: profile.id, configDirectory: dirname(path), projectRoot: ROOT }, profileRegistry(profile));
        expect(`${path.slice(ROOT.length + 1)}@${profile.id}:${result.ok ? "ok" : JSON.stringify(result.diagnostics)}`)
          .toBe(`${path.slice(ROOT.length + 1)}@${profile.id}:ok`);
        if (!result.ok) continue;
        // Entries are rebased onto the repository root the tools compile from.
        expect(resolve(ROOT, result.plan.app.entry)).toBe(resolve(dirname(path), config.value.app!.entry));
        for (const feature of config.value.app!.features ?? []) expect(typeof result.plan.features[feature], feature).toBe("boolean");
      }
    }
  });

  test("the site's demo shelf lists the applications built for the PSP", async () => {
    // The note is a dynamic-window application: its config does not list psp.
    const note = await repositoryApp("apps/note/pocket.host.config.ts");
    expect(note.config.profiles.map(profile => profile.id)).not.toContain("psp");
    expect(codes(resolveRepositoryApp(note, "psp", { registry: POCKET_PLATFORM_CONTRACTS }))).toContain("viewport.fixedRequired");
    const motions = await repositoryApp("apps/motions/pocket.host.config.ts");
    expect(motions.config.profiles.map(profile => profile.id)).toContain("psp");
  });

  test("the note resolves runtime glyphs and companions for browser and widget hosts", async () => {
    // Portable hosts never advertise OS text layout. Async text is explicit.
    const note = await repositoryApp("apps/note/pocket.host.config.ts");
    const onApp = resolveRepositoryApp(note, "web-app");
    expect(onApp.ok).toBe(true);
    if (!onApp.ok) return;
    expect(onApp.plan.features["text.layout.native"]).toBe(false);
    expect(onApp.plan.features["text.glyphs.runtime"]).toBe(true);
    expect(onApp.plan.target.hostAbi).toBe(POCKET_BINDING_GENERATION);
    // The theme module the config imports is plan content.
    expect(onApp.plan.app.theme?.keyframes).toBeDefined();

    const onWidget = resolveRepositoryApp(note, "macos-widget");
    expect(onWidget.ok).toBe(true);
    if (!onWidget.ok) return;
    expect(onWidget.plan.features["text.layout.native"]).toBe(false);
    expect(onWidget.plan.features["text.glyphs.runtime"]).toBe(true);
    // Dynamic-viewport native presentation: density from the profile.
    expect(onWidget.plan.viewport.rasterDensity).toBe(2);
    expect(onWidget.plan.viewport.logical).toEqual([420, 560]);
    for (const feature of ["input.text", "input.ime", "host.clipboard", "display.viewport.live", "text.glyphs.runtime"]) {
      expect(onWidget.plan.features[feature], feature).toBe(true);
    }

    // Hosts build their svc allowlist and adapter wiring from the plan's
    // companion list (issue #295); the viewport policy rides along so hosts
    // derive size-locking from the plan too.
    expect(onApp.plan.companions).toEqual(["note"]);
    expect(onApp.plan.viewport.policy).toBe("dynamic");
    const hero = await repositoryApp("apps/hero/pocket.host.config.ts");
    const heroOnApp = resolveRepositoryApp(hero, "web-app");
    expect(heroOnApp.ok).toBe(true);
    if (!heroOnApp.ok) return;
    expect(heroOnApp.plan.companions).toEqual([]);
    expect(heroOnApp.plan.viewport.policy).toBe("dynamic");
    const heroOnPsp = resolveRepositoryApp(hero, "psp");
    expect(heroOnPsp.ok).toBe(true);
    if (!heroOnPsp.ok) return;
    expect(heroOnPsp.plan.viewport.policy).toBe("fixed");
    expect(heroOnPsp.plan.app).toEqual({
      id: "dev.pocket-nexus.hero", title: "PocketJS: Hero", version: "0.15.0",
      entry: "apps/hero/main.tsx", output: "hero-main", framework: "solid", aot: true, model: "compiled",
    });
  });

  test("an explicit fixed variant makes the note resolvable on the PSP with its desktop features off", async () => {
    const note = await repositoryApp("apps/note/pocket.host.config.ts");
    const onPsp = resolveRepositoryApp(note, "psp", {
      registry: POCKET_PLATFORM_CONTRACTS,
      app: { ...note.app, viewport: { logical: [480, 272], presentation: "integer-fit" } },
    });
    expect(onPsp.ok).toBe(true);
    if (!onPsp.ok) return;
    expect(onPsp.plan.features["input.text"]).toBe(false);
    expect(onPsp.plan.features["input.pointer"]).toBe(false);
  });

  test("one clear config resolves its hosts to their sizes", async () => {
    const clear = await repositoryApp("apps/clear/pocket.host.config.ts");
    const viewport = (target: string) => {
      const result = resolveRepositoryApp(clear, target);
      if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
      return [result.plan.viewport.logical, result.plan.viewport.policy];
    };
    expect(viewport("ipodtouch4-dev")).toEqual([[320, 480], "fixed"]);
    expect(viewport("symbian-e7-dev")).toEqual([[360, 640], "dynamic"]);
  });

  test("portable text needs its offload transport feature", async () => {
    const text = await repositoryApp("apps/text-offload/pocket.host.config.ts");
    const app = { ...text.app, features: text.app.features!.filter(feature => feature !== "io.offload") };
    for (const target of ["psp", "web-app"]) {
      expect(paths(resolveRepositoryApp(text, target, { app }))).toContainEqual(["capability.offloadDependency", "/app/features"]);
    }
  });
});

describe("app resolution", () => {
  test("resolves a small PSP build plan", () => {
    const result = resolveAppPlan(PORTABLE_APP, { target: "psp" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.target).toEqual({ id: "psp", hostAbi: POCKET_BINDING_GENERATION });
    expect(result.plan.app).toEqual({
      id: "dev.pocket-nexus.telemetry",
      title: "Pocket Telemetry",
      version: "0.1.0",
      entry: "app/main.tsx",
      output: "main",
      framework: "solid",
    });
    expect(result.plan.presentation).toEqual({ id: "default", entry: "app/main.tsx" });
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
    expect(result.plan.companions).toEqual([]);
  });

  test("identity defaults derive from the output name", () => {
    const { id: _id, title: _title, version: _version, ...anonymous } = PORTABLE_APP;
    const result = resolveAppPlan(anonymous, { target: "psp" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([result.plan.app.id, result.plan.app.title, result.plan.app.version]).toEqual(["local.main", "main", "0.1.0"]);
    expect(appIdentity({}, "hero-main")).toEqual({ id: "local.hero-main", title: "hero-main", version: "0.1.0" });
    expect(appIdentity({ id: "dev.example.x", title: "X", version: "2.0.0" }, "x")).toEqual({ id: "dev.example.x", title: "X", version: "2.0.0" });
  });

  test("the output name is app.output or the entry's file name", () => {
    expect(appOutput({ entry: "app/main.tsx" })).toBe("main");
    expect(appOutput({ entry: "src/game.ts", output: "my-game" })).toBe("my-game");
    const derived = resolveAppPlan({ ...PORTABLE_APP, entry: "app/Main.tsx" }, { target: "psp" });
    expect(paths(derived)).toEqual([["app.outputUnderivable", "/app/entry"]]);
    const explicit = resolveAppPlan({ ...PORTABLE_APP, entry: "app/Main.tsx", output: "main-screen" }, { target: "psp" });
    expect(explicit.ok && explicit.plan.app.output).toBe("main-screen");
  });

  test("entries are rebased from the config's directory onto the project root", () => {
    const rebased = resolveAppPlan(PORTABLE_APP, { target: "psp", configDirectory: "/work/game/apps/one", projectRoot: "/work/game" });
    expect(rebased.ok && rebased.plan.app.entry).toBe("apps/one/app/main.tsx");
    expect(rebased.ok && rebased.plan.presentation.entry).toBe("apps/one/app/main.tsx");
    const same = resolveAppPlan(PORTABLE_APP, { target: "psp", configDirectory: "/work/game" });
    expect(same.ok && same.plan.app.entry).toBe("app/main.tsx");
    const outside = resolveAppPlan(PORTABLE_APP, { target: "psp", configDirectory: "/work/game", projectRoot: "/work/game/app/inner" });
    expect(paths(outside)).toEqual([["app.entryOutsideProject", "/app/entry"]]);
  });

  test("an invalid app section returns its schema diagnostics", () => {
    const result = resolveAppPlan({ ...PORTABLE_APP, framework: "react" }, { target: "psp" });
    expect(paths(result)).toEqual([["schema.enum", "/app/framework"]]);
  });

  test("AOT compilation requires app.aot", () => {
    expect(paths(resolveAppPlan(PORTABLE_APP, { target: "psp", executionClass: "aot" }))).toEqual([["execution.aotDisabled", "/app/aot"]]);
    const aot = resolveAppPlan({ ...PORTABLE_APP, aot: true, model: "compiled", recursionLimit: 64 }, { target: "psp", executionClass: "aot" });
    expect(aot.ok && [aot.plan.app.aot, aot.plan.app.model, aot.plan.app.recursionLimit]).toEqual([true, "compiled", 64]);
  });

  test("a host extension must carry a verified payload", () => {
    const extension = createHostExtension("product", 1, { mode: "kiosk" });
    const result = resolveAppPlan(PORTABLE_APP, { target: "psp", hostExtension: extension });
    expect(result.ok && result.plan.hostExtension).toEqual(extension);
    const forged = resolveAppPlan(PORTABLE_APP, { target: "psp", hostExtension: { ...extension, payload: { mode: "other" } } });
    expect(paths(forged)).toEqual([["hostExtension.invalid", "/hostExtension"]]);
  });

  test("a fixed viewport takes the first listed or in-range size the target lists", () => {
    const withLogical = (logical: unknown) => ({ ...portableApp(), viewport: { fixed: { logical, presentation: "integer-fit" } } });
    const logical = (input: unknown, target: string) => {
      const result = resolveAppPlan(input, { target });
      return result.ok ? result.plan.viewport.logical : result.diagnostics.map(item => item.code);
    };
    expect(logical(withLogical([[320, 240], [480, 272]]), "psp")).toEqual([480, 272]);
    expect(logical(withLogical({ min: [400, 200], max: [500, 300] }), "psp")).toEqual([480, 272]);
    expect(logical(withLogical([[320, 240]]), "psp")).toContain("viewport.logicalUnsupported");
    expect(logical(withLogical({ min: [100, 100], max: [200, 200] }), "psp")).toEqual(["viewport.logicalUnsupported"]);
    expect(validateAppConfig(withLogical([])).map(item => item.path)).toEqual(["/app/viewport"]);
  });

  test("viewport refusals point into the viewport the application states", () => {
    // The bare {logical, presentation} spelling is shorthand for {fixed}.
    expect(resolveAppPlan({ ...PORTABLE_APP, viewport: { logical: [480, 272], presentation: "integer-fit" } }, { target: "psp" }).ok).toBe(true);
    const dynamicOnly = { ...PORTABLE_APP, viewport: { dynamic: { default: [420, 560] } } };
    expect(paths(resolveAppPlan(dynamicOnly, { target: "psp" }))).toEqual([["viewport.fixedRequired", "/app/viewport"]]);
    // A window form without a dynamic variant, and a widget form that does not host fixed sizes.
    expect(paths(resolveAppPlan({ ...PORTABLE_APP, viewport: {} }, { target: "web-app" }))).toEqual([["viewport.dynamicRequired", "/app/viewport"]]);
    expect(paths(resolveAppPlan(PORTABLE_APP, { target: "macos-widget" }))).toEqual([["viewport.fixedUnhosted", "/app/viewport"]]);
    expect(paths(resolveAppPlan({ ...PORTABLE_APP, viewport: { dynamic: { default: [100, 100] } } }, { target: "macos-widget" })))
      .toEqual([["viewport.logicalUnsupported", "/app/viewport/dynamic/default"]]);
    expect(resolveAppPlan({ ...PORTABLE_APP, viewport: { dynamic: { default: [800, 600] } } }, { target: "macos-widget" }).ok).toBe(true);
    const unsupported = resolveAppPlan({ ...PORTABLE_APP, viewport: { fixed: { logical: [320, 240], presentation: "stretch" } } }, { target: "psp" });
    expect(paths(unsupported)).toEqual(expect.arrayContaining([
      ["viewport.logicalUnsupported", "/app/viewport/fixed/logical"],
      ["viewport.presentationUnsupported", "/app/viewport/fixed/presentation"],
    ]));
    // PSP presents integer-fit only; native presentation would need the logical size to fill the panel.
    const native = resolveAppPlan({ ...PORTABLE_APP, viewport: { fixed: { logical: [400, 240], presentation: "native" } } }, { target: "dual-test" }, SYNTHETIC_CONTRACTS);
    expect(native.ok).toBe(true);
    const registry = definePlatformContractRegistry(SYNTHETIC_CAPABILITIES, defineTargetRegistry({
      wide: { ...syntheticTargetDefinitions["vita-test"], display: { ...syntheticTargetDefinitions["vita-test"].display, logicalViewports: [[480, 272], [400, 240]], presentations: ["native", "integer-fit"] } },
    }));
    expect(paths(resolveAppPlan({ ...PORTABLE_APP, viewport: { fixed: { logical: [400, 240], presentation: "native" } } }, { target: "wide" }, registry)))
      .toEqual([["viewport.nativeMismatch", "/app/viewport/fixed"]]);
    expect(paths(resolveAppPlan({ ...PORTABLE_APP, viewport: { fixed: { logical: [400, 240], presentation: "integer-fit" } } }, { target: "wide" }, registry)))
      .toEqual([["viewport.integerFitMismatch", "/app/viewport/fixed"]]);
  });

  test("the application states its rate; the target must present it at a whole divisor", () => {
    const rate = (tickHz: number | undefined, target: string) => {
      const result = resolveAppPlan({ ...PORTABLE_APP, ...(tickHz === undefined ? {} : { tickHz }) }, { target });
      return result.ok ? result.plan.profile.tickHz : result.diagnostics.map(item => [item.code, item.path]);
    };
    expect(rate(undefined, "psp")).toBe(60);
    expect(rate(30, "psp")).toBe(30);
    expect(rate(20, "psp")).toBe(20);
    // Vita presents at 60 only; 30 is not a whole multiple of 60.
    expect(rate(30, "vita")).toEqual([["app.tickHz", "/app/tickHz"]]);
    // PocketBook presents at 30; the default 60 runs two core ticks per frame.
    expect(cadenceFor(60, POCKET_PROFILES.pocketbook.cadences)).toBe(30);
    for (const tickHz of [0, 61, 2.5]) {
      expect(validateAppConfig({ ...PORTABLE_APP, tickHz }).map(item => item.path), String(tickHz)).toEqual(["/app/tickHz"]);
    }
  });

  test("a feature the host lacks resolves to false; an unknown feature is refused", () => {
    // Desktop features on the PSP are compile-time facts the bundle reads.
    const widgetFeatures = { ...PORTABLE_APP, features: ["text.glyphs.baked", "input.text", "input.pointer"] };
    const onPsp = resolveAppPlan(widgetFeatures, { target: "psp" });
    expect(onPsp.ok && onPsp.plan.features).toEqual({ "input.pointer": false, "input.text": false, "text.glyphs.baked": true });
    const unknown = resolveAppPlan({ ...PORTABLE_APP, features: ["input.buttons", "input.telepathy"] }, { target: "psp" });
    expect(unknown.ok ? [] : unknown.diagnostics).toEqual([{
      code: "capability.unknown", path: "/app/features/1",
      message: 'unknown capability "input.telepathy": neither the registry nor host psp defines it',
    }]);
    const unknownTarget = resolveAppPlan(PORTABLE_APP, { target: "switch" });
    expect(codes(unknownTarget)).toEqual(["target.unknown"]);
  });

  describe("a host-defined capability", () => {
    // A product's host contract: the PSP's facts and an id the registry
    // does not know.
    const product = {
      ...POCKET_PROFILES.psp,
      id: "psp-product",
      capabilities: [...POCKET_PROFILES.psp.capabilities, "vendor.camera"],
    };
    const lister = { ...PORTABLE_APP, features: [...PORTABLE_APP.features, "vendor.camera"] };

    test("is not registered, and the host contract that lists it validates", () => {
      expect(POCKET_CAPABILITIES as readonly string[]).not.toContain("vendor.camera");
      expect(validatePocketProfile(product).ok).toBe(true);
      expect(validatePlatformContractRegistry(profileRegistry(product))).toEqual([]);
    });

    test("resolves for an application that lists it and the plan carries it", () => {
      const result = resolveAppPlan(lister, { target: product.id }, profileRegistry(product));
      if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
      expect(result.plan.features["vendor.camera"]).toBe(true);
      expect(result.plan.profile.capabilities).toContain("vendor.camera");
    });

    test("is unknown on a host that does not define it", () => {
      for (const target of ["psp", "vita"] as const) {
        const result = resolveAppPlan(lister, { target }, profileRegistry(POCKET_PROFILES[target]));
        expect(result.ok ? [] : result.diagnostics).toEqual([{
          code: "capability.unknown", path: `/app/features/${PORTABLE_APP.features.length}`,
          message: `unknown capability "vendor.camera": neither the registry nor host ${target} defines it`,
        }]);
      }
    });

    test("leaves a stock application's plan on that host unchanged", () => {
      const onProduct = resolveAppPlan(PORTABLE_APP, { target: product.id }, profileRegistry(product));
      const onPsp = resolveAppPlan(PORTABLE_APP, { target: "psp" }, profileRegistry(POCKET_PROFILES.psp));
      if (!onProduct.ok || !onPsp.ok) throw new Error("the stock application must resolve on both hosts");
      expect(onProduct.plan.features).toEqual(onPsp.plan.features);
      expect(Object.keys(onProduct.plan.features)).not.toContain("vendor.camera");
      expect(onProduct.plan.viewport).toEqual(onPsp.plan.viewport);
      expect(onProduct.plan.modality).toEqual(onPsp.plan.modality);
    });
  });

  test("feature resolution is independent of feature order and identity", () => {
    const changed = { ...portableApp(), id: "dev.pocket-nexus.renamed", title: "Renamed App", version: "9.0.0" };
    changed.features.reverse();
    const left = resolveAppPlan(PORTABLE_APP, { target: "psp" });
    const right = resolveAppPlan(changed, { target: "psp" });
    expect(left.ok && right.ok).toBe(true);
    if (!left.ok || !right.ok) return;
    expect(left.plan.features).toEqual(right.plan.features);
  });

  test("the portable application resolves to a native-density Vita plan", () => {
    for (const [target, registry] of [["vita", POCKET_PLATFORM_CONTRACTS], ["vita-test", SYNTHETIC_CONTRACTS]] as const) {
      const result = resolveAppPlan(PORTABLE_APP, { target }, registry);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
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
    }
  });

  test("features record host availability", () => {
    const touch = { ...PORTABLE_APP, features: ["text.glyphs.baked", "input.buttons", "input.touch"] };
    const psp = resolveAppPlan(touch, { target: "psp" }, SYNTHETIC_CONTRACTS);
    const vita = resolveAppPlan(touch, { target: "vita-test" }, SYNTHETIC_CONTRACTS);
    const production = resolveAppPlan(touch, { target: "vita" });
    expect(psp.ok && vita.ok && production.ok).toBe(true);
    if (!psp.ok || !vita.ok || !production.ok) return;
    expect(psp.plan.features["input.touch"]).toBe(false);
    expect(vita.plan.features["input.touch"]).toBe(true);
    expect(production.plan.features["input.touch"]).toBe(true);
  });
});

describe("auxiliary surfaces", () => {
  const dual = (surfaces?: unknown, features = ["input.buttons", "text.glyphs.baked", "display.auxiliary", "input.touch.auxiliary"]) => ({
    ...portableApp(),
    viewport: { logical: [400, 240], presentation: "native" },
    ...(surfaces === undefined ? {} : { surfaces }),
    features,
  });

  test("resolves auxiliary display and touch as separate features", () => {
    const result = resolveAppPlan(dual({ auxiliary: { fixed: { logical: [320, 240], presentation: "native" } } }), { target: "dual-test" }, SYNTHETIC_CONTRACTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.surfaces).toEqual({
      auxiliary: { logical: [320, 240], physical: [320, 240], presentation: "native", rasterDensity: 1 },
    });
    expect(result.plan.features).toEqual({
      "display.auxiliary": true,
      "input.buttons": true,
      "input.touch.auxiliary": true,
      "text.glyphs.baked": true,
    });
    expect(result.plan.features).not.toHaveProperty("input.touch");
    const adaptive = resolveAppPlan(dual({ auxiliary: { adaptive: { min: [240, 160], max: [400, 300] } } }), { target: "dual-test" }, SYNTHETIC_CONTRACTS);
    expect(adaptive.ok && adaptive.plan.surfaces?.auxiliary.logical).toEqual([320, 240]);
  });

  test("the surface and the display.auxiliary feature come together", () => {
    expect(paths(resolveAppPlan(dual(undefined), { target: "dual-test" }, SYNTHETIC_CONTRACTS)))
      .toEqual([["surface.auxiliaryDeclarationMismatch", "/app/surfaces"]]);
    expect(paths(resolveAppPlan(dual({ auxiliary: { fixed: { logical: [320, 240], presentation: "native" } } }, ["input.buttons"]), { target: "dual-test" }, SYNTHETIC_CONTRACTS)))
      .toEqual([["surface.auxiliaryDeclarationMismatch", "/app/surfaces"]]);
    expect(paths(resolveAppPlan(dual(undefined, ["input.buttons", "input.touch.auxiliary"]), { target: "dual-test" }, SYNTHETIC_CONTRACTS)))
      .toEqual([["capability.dependency", "/app/features/1"]]);
    const both = { auxiliary: { fixed: { logical: [320, 240], presentation: "native" }, adaptive: { min: [240, 160], max: [400, 300] } } };
    expect(paths(resolveAppPlan(dual(both), { target: "dual-test" }, SYNTHETIC_CONTRACTS)))
      .toEqual([["surface.auxiliaryPolicy", "/app/surfaces/auxiliary"]]);
  });

  test("an auxiliary surface the host cannot present turns its features off", () => {
    const wrong = resolveAppPlan(dual({ auxiliary: { fixed: { logical: [400, 240], presentation: "native" } } }), { target: "dual-test" }, SYNTHETIC_CONTRACTS);
    expect(wrong.ok).toBe(true);
    if (!wrong.ok) return;
    expect(wrong.plan.surfaces).toBeUndefined();
    expect(wrong.plan.features["display.auxiliary"]).toBe(false);
    expect(wrong.plan.features["input.touch.auxiliary"]).toBe(false);
    // A host without an auxiliary display: the features are off and no surface resolves.
    const single = resolveAppPlan({ ...dual({ auxiliary: { fixed: { logical: [320, 240], presentation: "native" } } }), viewport: PORTABLE_APP.viewport }, { target: "psp" });
    expect(single.ok && [single.plan.surfaces, single.plan.features["display.auxiliary"]]).toEqual([undefined, false]);
  });
});
