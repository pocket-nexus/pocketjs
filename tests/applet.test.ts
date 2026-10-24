// tests/applet.test.ts — the Pocket Applet rules (contracts/spec/applet.ts,
// tools/applet-check.ts): the manifest rules at plan resolution, the source
// rules over an applet's import graph, the bundle budgets, and the applets
// this repository ships.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APPLET_BUDGET, appletManifestDiagnostics, type AppletDeclaration } from "../contracts/spec/applet.ts";
import type { PocketManifestV2 } from "../contracts/spec/pocket-manifest.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
import { validatePocketManifest } from "../framework/src/manifest/validate.ts";
import { resolve3dsBuildPlan } from "../tools/3ds-profile.ts";
import { checkApplet, checkAppletBundle, checkAppletSources } from "../tools/applet-check.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const TMP = mkdtempSync(join(tmpdir(), "pocket-applet-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function manifest(overrides: Record<string, unknown> = {}, capabilities?: { requires?: string[]; enhances?: string[] }): PocketManifestV2 {
  return {
    $schema: "https://pocketjs.dev/schema/pocket-2.json",
    pocket: 2,
    id: "dev.example.notes",
    name: "notes",
    title: "Notes",
    version: "0.1.0",
    applet: { version: 1 },
    engine: {
      capabilities: {
        requires: capabilities?.requires ?? ["text.glyphs.baked", "input.buttons", "display.auxiliary", "input.touch.auxiliary"],
        enhances: capabilities?.enhances ?? ["system.agent"],
      },
    },
    app: {
      entry: "notes/main.tsx",
      output: "notes-main",
      framework: "solid",
      surfaces: { auxiliary: { fixed: { logical: [320, 240], presentation: "native" } } },
      viewport: { fixed: { logical: [400, 240], presentation: "native" } },
    },
    ...overrides,
  } as PocketManifestV2;
}

const codes = (m: PocketManifestV2) => appletManifestDiagnostics(m).map((d) => d.code);

describe("manifest rules", () => {
  test("a minimal applet passes, and an app without the section is not checked", () => {
    expect(codes(manifest())).toEqual([]);
    const app = manifest({ applet: undefined }, { requires: ["input.buttons"], enhances: ["system.wifi"] });
    expect(codes(app)).toEqual([]);
  });

  test("the schema refuses an unknown key, a version other than 1 and a bad host", () => {
    expect(validatePocketManifest(manifest({ applet: { version: 1, cookies: true } })).ok).toBe(false);
    expect(validatePocketManifest(manifest({ applet: { version: 2 } })).ok).toBe(false);
    expect(validatePocketManifest(manifest({ applet: { version: 1, hosts: ["http://x.com"] } })).ok).toBe(false);
    expect(validatePocketManifest(manifest({ applet: { version: 1, hosts: ["api.example.com"], services: ["glyphs"] } })).ok).toBe(true);
    expect(validatePocketManifest(manifest({ applet: { version: 1, summary: "The front page and its threads." } })).ok).toBe(true);
    expect(validatePocketManifest(manifest({ applet: { version: 1, summary: "" } })).ok).toBe(false);
    expect(validatePocketManifest(manifest({ applet: { version: 1, summary: "x".repeat(121) } })).ok).toBe(false);
  });

  test("system capabilities, a missing agent, a long title and a wrong surface are refused", () => {
    expect(codes(manifest({}, { enhances: ["system.agent", "system.wifi"] }))).toContain("applet.capability");
    expect(codes(manifest({}, { enhances: ["link.companion", "system.agent"] }))).toContain("applet.capability");
    expect(codes(manifest({}, { enhances: [] }))).toContain("applet.agent");
    expect(codes(manifest({ title: "A title far too long for a springboard label" }))).toContain("applet.title");
    const wide = manifest();
    const surfaces = { auxiliary: { fixed: { logical: [400, 240], presentation: "native" } } };
    expect(codes({ ...wide, app: { ...wide.app, surfaces } } as unknown as PocketManifestV2)).toContain("applet.surface");
    expect(codes({ ...wide, app: { ...wide.app, model: "rust" } } as PocketManifestV2)).toContain("applet.nativeModel");
    expect(codes({ ...wide, app: { ...wide.app, companions: ["youtube"] } } as PocketManifestV2)).toContain("applet.companions");
  });

  test("storage needs applet.store, network declarations need net.http, cameras are allowed", () => {
    const requires = ["display.auxiliary", "input.touch.auxiliary"];
    expect(codes(manifest({}, { requires: [...requires, "data.fs"] }))).toContain("applet.store");
    expect(codes(manifest({ applet: { version: 1, store: { maxBytes: 65536 } } }, { requires: [...requires, "data.fs"] }))).toEqual([]);
    expect(codes(manifest({ applet: { version: 1, services: ["x"] } }))).toContain("applet.network");
    expect(codes(manifest({}, { requires: [...requires, "camera.photo"] }))).toEqual([]);
  });

  test("plan resolution refuses a broken applet and carries a passing one's section", () => {
    expect(() => resolve3dsBuildPlan(manifest({}, { enhances: ["system.agent", "system.wifi"] }))).toThrow(/system.wifi is not available to applets/);
    const plan = resolve3dsBuildPlan(manifest({ applet: { version: 1, services: ["glyphs"] } }, {
      requires: ["display.auxiliary", "input.touch.auxiliary", "net.http"],
    }));
    expect(plan.applet).toEqual({ version: 1, services: ["glyphs"] });
  });
});

describe("the full-screen presentation", () => {
  const FULL_SCREEN = {
    id: "full-screen",
    entry: "notes/main.tsx",
    modality: { screens: 1, touch: "none", buttons: true },
    viewport: { fixed: { logical: [480, 272], presentation: "native" } },
  };
  const both = (app: Record<string, unknown> = {}, capabilities?: { requires?: string[]; enhances?: string[] }) => {
    const base = manifest({}, {
      requires: capabilities?.requires ?? ["text.glyphs.baked", "input.buttons"],
      enhances: capabilities?.enhances ?? ["system.agent", "display.auxiliary", "input.touch.auxiliary", "input.analog.left"],
    });
    return { ...base, app: { ...base.app, modality: { touch: "auxiliary" }, presentations: [FULL_SCREEN], ...app } } as unknown as PocketManifestV2;
  };

  test("one program serves the touch surface and the full screen", () => {
    expect(codes(both())).toEqual([]);
    const psp = validateAndResolveBuildPlan(both(), { target: "psp" });
    if (!psp.ok) throw new Error(psp.diagnostics.map((d) => d.message).join("; "));
    expect(psp.plan.presentation).toEqual({ id: "full-screen", entry: "notes/main.tsx" });
    expect(psp.plan.app.entry).toBe("notes/main.tsx");
    expect(psp.plan.surfaces?.auxiliary).toBeUndefined();
    const dual = resolve3dsBuildPlan(both());
    expect(dual.presentation).toEqual({ id: "default", entry: "notes/main.tsx" });
    expect(dual.surfaces?.auxiliary?.logical).toEqual([320, 240]);
  });

  test("a second program, another modality, a surface or a new output is refused", () => {
    expect(codes(both({ presentations: [{ ...FULL_SCREEN, entry: "notes/psp.tsx" }] }))).toContain("applet.presentationEntry");
    expect(codes(both({ presentations: [{ ...FULL_SCREEN, modality: { screens: 1, touch: "primary" } }] }))).toContain("applet.presentationModality");
    const surfaces = { auxiliary: { fixed: { logical: [320, 240], presentation: "native" } } };
    expect(codes(both({ presentations: [{ ...FULL_SCREEN, surfaces }] }))).toContain("applet.presentationSurfaces");
    expect(codes(both({ presentations: [{ ...FULL_SCREEN, output: "notes-psp" }] }))).toContain("applet.presentationOutput");
    expect(codes(both({ presentations: [FULL_SCREEN, { ...FULL_SCREEN, id: "again" }] }))).toContain("applet.presentations");
  });

  test("the baseline keeps the touch surface: its modality, enhanced surface capabilities, required buttons", () => {
    expect(codes(both({ modality: undefined }))).toContain("applet.baselineModality");
    expect(codes(both({}, { requires: ["text.glyphs.baked", "input.buttons", "display.auxiliary"], enhances: ["system.agent", "input.touch.auxiliary"] }))).toContain("applet.surfaceEnhanced");
    expect(codes(both({}, { requires: ["text.glyphs.baked"] }))).toContain("applet.buttons");
    // Without the presentation, the v1 rule stands: the surface is required.
    const touchOnly = manifest({}, { requires: ["text.glyphs.baked", "input.buttons"], enhances: ["system.agent", "display.auxiliary", "input.touch.auxiliary"] });
    expect(codes(touchOnly)).toContain("applet.required");
  });
});

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(TMP, "project-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

const CLEAN = {
  "notes/main.tsx": `import App from "./app.tsx";\nimport { mount } from "@pocketjs/framework/solid";\nmount(() => <App />);\n`,
  "notes/app.tsx": [
    `import { createSignal } from "solid-js";`,
    `import { AuxiliarySurface, Text } from "@pocketjs/framework/components";`,
    `import { companionService } from "@pocketjs/framework/link";`,
    `import { fetch } from "@pocketjs/framework/net";`,
    `import { label } from "../ui/label.ts";`,
    `// a comment naming https://not-declared.example.com does not count`,
    `export default function App() {`,
    `  const [text] = createSignal(label);`,
    `  void fetch(companionService("glyphs", "/atlas"));`,
    `  void fetch("https://api.example.com/notes");`,
    `  return <AuxiliarySurface><Text>{text()}</Text></AuxiliarySurface>;`,
    `}`,
  ].join("\n"),
  "ui/label.ts": `export const label = <T,>(value: T): T => value;\n`,
};
const DECLARED: AppletDeclaration = { version: 1, services: ["glyphs"], hosts: ["api.example.com"] };
const sources = (dir: string, applet = DECLARED, capabilities = ["net.http"]) =>
  checkAppletSources({ projectRoot: dir, entry: "notes/main.tsx", applet, capabilities }).map((d) => d.code);

describe("source rules", () => {
  test("a clean applet passes: shared modules in the project, declared service and host", () => {
    expect(sources(project(CLEAN))).toEqual([]);
  });

  test("undeclared services and hosts are named", () => {
    const dir = project(CLEAN);
    expect(sources(dir, { version: 1, services: [], hosts: ["api.example.com"] })).toEqual(["applet.service"]);
    expect(sources(dir, { version: 1, services: ["glyphs"], hosts: [] })).toEqual(["applet.host"]);
  });

  test("eval, Function, dynamic import, other packages, launcher exports and gated modules are refused", () => {
    const dir = project({
      ...CLEAN,
      "notes/bad.ts": [
        `import { readFileSync } from "node:fs";`,
        `import { installApp, companionNow } from "@pocketjs/framework/link";`,
        `import { launchApp } from "@pocketjs/framework/launcher";`,
        `import { openCamera } from "@pocketjs/framework/camera";`,
        `export const run = () => { eval("1"); new Function("return 1"); void import("./app.tsx"); return [readFileSync, installApp, companionNow, launchApp, openCamera]; };`,
      ].join("\n"),
      "notes/main.tsx": `import "./bad.ts";\n${CLEAN["notes/main.tsx"]}`,
    });
    const found = sources(dir);
    for (const code of ["applet.package", "applet.system", "applet.module", "applet.eval", "applet.dynamicImport"]) {
      expect(found).toContain(code);
    }
    // camera is gated, not forbidden.
    const withCamera = checkAppletSources({ projectRoot: dir, entry: "notes/main.tsx", applet: DECLARED, capabilities: ["net.http", "camera.photo"] });
    expect(withCamera.filter((d) => d.message.includes("camera"))).toEqual([]);
  });

  test("a module outside the project root and a UI without AuxiliarySurface are refused", () => {
    const dir = project({
      "notes/main.tsx": `import "../../outside.ts";\nexport const nothing = 1;\n`,
    });
    writeFileSync(join(dir, "..", "outside.ts"), "export {};\n");
    const found = sources(dir);
    expect(found).toContain("applet.surface");
    expect(found.some((code) => code === "applet.outsideProject" || code === "applet.missingModule")).toBe(true);
  });
});

describe("budgets and the shipped applets", () => {
  test("the bundle budgets", () => {
    expect(checkAppletBundle({ jsBytes: APPLET_BUDGET.jsBytes, pakBytes: APPLET_BUDGET.pakBytes })).toEqual([]);
    expect(checkAppletBundle({ jsBytes: APPLET_BUDGET.jsBytes + 1 }).map((d) => d.code)).toEqual(["applet.budget"]);
    expect(checkAppletBundle({ jsBytes: 1, pakBytes: APPLET_BUDGET.pakBytes + 1 }).map((d) => d.code)).toEqual(["applet.budget"]);
  });

  test("Pocket Nexus is an applet and passes", () => {
    expect(checkApplet({ manifestPath: join(ROOT, "apps/nexus/pocket.json"), projectRoot: ROOT })).toEqual([]);
  });
});
