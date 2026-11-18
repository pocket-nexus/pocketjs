// tests/modality.test.ts — the modality view over target profiles, the
// requirement schema modalityMisses tests against, and the modality a build
// plan records.

import { describe, expect, test } from "bun:test";
import { BUTTON_GLYPHS, deriveModality, modalityMisses, modalityRequirementSchema, PORTABLE_MODALITY, type Modality } from "../contracts/spec/modality.ts";
import { validateSchema, type ContractDiagnostic } from "../contracts/spec/json-schema.ts";
import { POCKET_TARGETS } from "../contracts/spec/platforms.ts";
import { resolveAppPlan } from "../framework/compiler/app-plan.ts";
import { POCKET_PROFILES } from "../hosts/index.ts";
import { profileRegistry } from "../tools/profile-resolver.ts";
import { repositoryApp, resolveRepositoryApp } from "./app-fixtures.ts";

// The dual-screen device: the built-in 3ds-runtime host contract.
const THREE_DS_TARGET_ID = POCKET_PROFILES["3ds-runtime"].id;
const THREE_DS_CONTRACTS = profileRegistry(POCKET_PROFILES["3ds-runtime"]);
const threeDs = THREE_DS_CONTRACTS.targets[THREE_DS_TARGET_ID]!;

describe("deriveModality", () => {
  test("the PSP is the portable shape the runtime falls back to", () => {
    expect(deriveModality(POCKET_TARGETS.psp)).toEqual(PORTABLE_MODALITY);
  });

  test("the Vita reports the same screen as the PSP with contacts on it", () => {
    const vita = deriveModality(POCKET_TARGETS.vita);
    expect(vita.screens).toEqual([
      { role: "primary", logical: [480, 272], orientation: "landscape", touch: true, resizable: false },
    ]);
    expect(vita.touch).toBe("primary");
    expect(vita.pointer).toBe("cursor");
    expect(vita.glyphs).toBe("playstation");
  });

  test("the 3DS is two screens with contacts on the auxiliary one", () => {
    const modality = deriveModality(threeDs);
    expect(modality).toEqual({
      form: "takeover",
      screens: [
        { role: "primary", logical: [400, 240], orientation: "landscape", touch: false, resizable: false },
        { role: "auxiliary", logical: [320, 240], orientation: "landscape", touch: true, resizable: false },
      ],
      touch: "auxiliary",
      pointer: "cursor",
      buttons: true,
      analog: 2,
      text: "osk",
      glyphs: "letters",
    } satisfies Modality);
  });

  test("a desktop widget is one resizable portrait screen with a real pointer and a keyboard", () => {
    const widget = deriveModality(POCKET_TARGETS["macos-widget"]);
    expect(widget.screens[0]).toEqual({
      role: "primary",
      logical: [420, 560],
      orientation: "portrait",
      touch: false,
      resizable: true,
    });
    expect(widget.pointer).toBe("pointer");
    expect(widget.text).toBe("keyboard");
    expect(widget.analog).toBe(0);
    expect(widget.glyphs).toBe("letters");
  });

  test("a touch profile without cursor or analog capabilities has no synthesized pointer", () => {
    const reader = deriveModality({ ...POCKET_TARGETS.vita, capabilities: ["input.buttons", "input.touch", "text.glyphs.baked"] });
    expect(reader.touch).toBe("primary");
    expect(reader.pointer).toBe("none");
    expect(reader.analog).toBe(0);
    expect(reader.buttons).toBe(true);
  });

  test("shell glyphs follow the platform, not the target id", () => {
    expect(BUTTON_GLYPHS.playstation.circle).toBe("○");
    expect(BUTTON_GLYPHS.letters.circle).toBe("A");
    expect(BUTTON_GLYPHS.letters.cross).toBe("B");
  });
});

describe("modalityMisses", () => {
  const psp = deriveModality(POCKET_TARGETS.psp);
  const vita = deriveModality(POCKET_TARGETS.vita);
  const dual = deriveModality(threeDs);

  test("an empty requirement matches every device", () => {
    for (const modality of [psp, vita, dual]) expect(modalityMisses(modality, {})).toEqual([]);
  });

  test("names every failing field in declaration order", () => {
    expect(modalityMisses(psp, { screens: 2, touch: "auxiliary" })).toEqual(["screens", "touch"]);
    expect(modalityMisses(dual, { screens: 2, touch: "auxiliary" })).toEqual([]);
    expect(modalityMisses(psp, { touch: "any" })).toEqual(["touch"]);
    expect(modalityMisses(vita, { touch: "any" })).toEqual([]);
  });

  test("screen bounds test the primary screen inclusively", () => {
    expect(modalityMisses(psp, { minScreen: [480, 272] })).toEqual([]);
    expect(modalityMisses(dual, { minScreen: [480, 272] })).toEqual(["minScreen"]);
    expect(modalityMisses(psp, { maxScreen: [400, 240] })).toEqual(["maxScreen"]);
    expect(modalityMisses(dual, { maxScreen: [400, 240] })).toEqual([]);
  });

  test("sticks are a minimum, pointer and text are exact", () => {
    expect(modalityMisses(dual, { analog: 2 })).toEqual([]);
    expect(modalityMisses(psp, { analog: 2 })).toEqual(["analog"]);
    expect(modalityMisses(psp, { pointer: "pointer" })).toEqual(["pointer"]);
    expect(modalityMisses(psp, { text: "keyboard", form: ["window"] })).toEqual(["text", "form"]);
  });
});

describe("modalityRequirementSchema", () => {
  const check = (value: unknown) => {
    const diagnostics: ContractDiagnostic[] = [];
    validateSchema(value, modalityRequirementSchema, "", diagnostics);
    return diagnostics.map((item) => [item.code, item.path]);
  };

  test("accepts the requirements modalityMisses tests", () => {
    expect(check({ screens: 2, touch: "auxiliary", pointer: "any", analog: 2, minScreen: [400, 240], form: ["takeover"] })).toEqual([]);
  });

  test("rejects unknown fields and out-of-range values", () => {
    expect(check({ screenCount: 2 })).toEqual([["schema.additionalProperty", "/screenCount"]]);
    expect(check({ screens: 3, form: [] })).toEqual([["schema.maximum", "/screens"], ["schema.minItems", "/form"]]);
  });
});

describe("the plan's modality", () => {
  test("a build plan records the modality its host derives", () => {
    const app = {
      entry: "app/main.tsx", framework: "solid", features: ["text.glyphs.baked", "input.buttons", "input.touch"],
      viewport: { logical: [480, 272], presentation: "integer-fit" },
    } as const;
    const psp = resolveAppPlan(app, { target: "psp" });
    expect(psp.ok && psp.plan.modality).toEqual(PORTABLE_MODALITY);
    expect(psp.ok && psp.plan.presentation).toEqual({ id: "default", entry: "app/main.tsx" });
    const vita = resolveAppPlan(app, { target: "vita" });
    expect(vita.ok && vita.plan.modality).toEqual(deriveModality(POCKET_TARGETS.vita));
  });

  test("the 3DS demo's plan carries the two-screen modality", async () => {
    const demo = await repositoryApp("apps/3ds-demo/pocket.host.config.ts");
    const result = resolveRepositoryApp(demo, THREE_DS_TARGET_ID, { registry: THREE_DS_CONTRACTS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.modality).toEqual(deriveModality(threeDs));
    expect(result.plan.modality.screens.length).toBe(2);
    expect(result.plan.surfaces?.auxiliary.logical).toEqual([320, 240]);
  });
});
