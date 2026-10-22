import { describe, expect, test } from "bun:test";
import {
canonicalProfileJson, pocketProfileSchema,
type PocketProfile
} from "../contracts/spec/profile.ts";
import { validateSchema, type ContractDiagnostic } from "../framework/src/manifest/validate.ts";
import { defineProfile, validatePocketProfile } from "../framework/src/profile.ts";
import { POCKET_PROFILES } from "../profiles/index.ts";

const profile: PocketProfile = {
  id: "my-board", platform: "esp-idf", form: "takeover", tickHz: 60,
  display: {
    physicalViewport: [480, 320], logicalViewports: [[480, 320]],
    presentations: ["native"], rasterDensity: 1,
  },
  capabilities: ["input.buttons", "text.glyphs.baked"],
};
const diagnostics = (input: unknown) => {
  const result: ContractDiagnostic[] = [];
  validateSchema(input, pocketProfileSchema, "", result);
  return result;
};

describe("profile identity contract", () => {

  test("profile shape permits tree-external ids without package-v1's 15-byte limit", () => {
    expect(diagnostics({ ...profile, id: "my-product-board-with-a-long-name" })).toEqual([]);
    expect(diagnostics({ ...profile, toolchain: "nightly" })).not.toEqual([]);
    expect(diagnostics({ ...profile, hostAbi: 7 })).not.toEqual([]);
    expect(diagnostics({ ...profile, tickHz: 0 })).not.toEqual([]);
    expect(diagnostics({ ...profile, capabilities: ["input.buttons", "input.buttons"] })).not.toEqual([]);
  });

  test("Unicode remains literal and invalid JSON data is rejected", () => {
    expect(canonicalProfileJson({ ...profile, id: "屏幕-🎮" })).toContain('"id":"屏幕-🎮"');
    expect(() => canonicalProfileJson({ ...profile, id: "\ud800" })).toThrow("surrogate");
    expect(() => canonicalProfileJson({ ...profile, tickHz: NaN })).toThrow("non-finite");
    expect(() => canonicalProfileJson({ ...profile, capabilities: Array(1) })).toThrow("undefined");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalProfileJson({ ...profile, display: cyclic as unknown as PocketProfile["display"] })).toThrow("cycle");
  });

  test("external profiles retain long and Unicode ids and freeze their promises", () => {
    const declared = defineProfile({ ...profile, id: "树外产品-🎮-with-a-name-longer-than-fifteen-bytes", display: structuredClone(profile.display), capabilities: [...profile.capabilities] });
    expect(Object.isFrozen(declared.display.logicalViewports[0])).toBe(true);
    expect(() => (declared.capabilities as string[]).push("input.touch")).toThrow();
    expect(() => defineProfile({ ...profile, id: "\0board" })).toThrow("without NUL");
    expect(() => defineProfile({ ...profile, id: "x".repeat(65536) })).toThrow("65535");
  });

  test("built-in profiles cannot be shadowed", () => {
    for (const builtin of Object.values(POCKET_PROFILES)) {
      expect(validatePocketProfile(builtin, { builtin: true }).ok).toBe(true);
      expect(() => defineProfile({ ...builtin })).toThrow("built-in profile");
      expect(builtin).not.toHaveProperty("hostAbi");
    }
    for (const id of ["compile", "target", "profile", "sdk", "pack"]) {
      expect(() => defineProfile({ ...profile, id })).toThrow("command");
    }
  });

  test("viewport and capability relations are checked before accepting a profile", () => {
    expect(() => defineProfile({ ...profile, capabilities: ["made.up"] })).toThrow("unregistered capability");
    expect(() => defineProfile({ ...profile, form: "window" })).toThrow("dynamic viewport");
    expect(() => defineProfile({ ...profile, capabilities: ["display.auxiliary"] })).toThrow("geometry");
    expect(() => defineProfile({ ...profile, capabilities: ["input.touch.auxiliary"] })).toThrow("auxiliary display");
    const dynamic = {
      ...profile, form: "window" as const,
      display: { ...profile.display, dynamicViewport: { min: [240, 180] as const, max: [800, 600] as const } },
      capabilities: [...profile.capabilities, "display.viewport.live"],
    };
    expect(defineProfile(dynamic)).toBe(dynamic);
    expect(() => defineProfile({ ...dynamic, display: { ...dynamic.display, dynamicViewport: { min: [900, 700], max: [800, 600] } } })).toThrow("minimum");
    expect(() => defineProfile({ ...dynamic, capabilities: ["input.touch", "display.viewport.live"], display: { ...dynamic.display, dynamicViewport: { min: [240, 180], max: [2048, 2048] } } })).toThrow("10-bit");
  });
});
