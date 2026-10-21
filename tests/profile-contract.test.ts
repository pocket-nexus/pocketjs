import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  canonicalProfileJson, pocketProfileSchema, PROFILE_HASH_BYTES, PROFILE_HASH_FIELDS,
  profileHashProjection, PROFILE_CAPABILITY_BITS, PROFILE_PRESENTATION_BITS, type PocketProfile,
} from "../contracts/spec/profile.ts";
import { validateSchema, type ContractDiagnostic } from "../framework/src/manifest/validate.ts";
import { defineProfile, hashPocketProfile, validatePocketProfile } from "../framework/src/profile.ts";
import { POCKET_PROFILES } from "../profiles/index.ts";
import { POCKET_CAPABILITIES } from "../contracts/spec/platform-types.ts";

const profile: PocketProfile = {
  id: "my-board", platform: "esp-idf", form: "takeover", tickHz: 60,
  display: {
    physicalViewport: [480, 320], logicalViewports: [[480, 320]],
    presentations: ["native"], rasterDensity: 1,
  },
  capabilities: ["input.buttons", "text.glyphs.baked"],
};
const hash = (input: PocketProfile) => createHash("sha256").update(canonicalProfileJson(input), "utf8").digest("hex");
const diagnostics = (input: unknown) => {
  const result: ContractDiagnostic[] = [];
  validateSchema(input, pocketProfileSchema, "", result);
  return result;
};

describe("profile identity contract", () => {
  test("native convenience masks cover the registered vocabulary with fixed bits", () => {
    expect(Object.keys(PROFILE_CAPABILITY_BITS).sort()).toEqual([...POCKET_CAPABILITIES].sort());
    const bits = Object.values(PROFILE_CAPABILITY_BITS);
    expect(new Set(bits).size).toBe(bits.length);
    expect(bits.every(bit => bit > 0n && bit < (1n << 64n) && (bit & (bit - 1n)) === 0n)).toBe(true);
    expect(PROFILE_CAPABILITY_BITS["input.buttons"]).toBe(0x00000004n);
    expect(PROFILE_CAPABILITY_BITS["text.layout.offload"]).toBe(0x10000000n);
    expect(PROFILE_PRESENTATION_BITS).toEqual({ fill: 1, fit: 2, "integer-fit": 4, native: 8, stretch: 16 });
  });

  test("canonical projection has seven permitted fields and UTF-8 hash input", () => {
    expect(PROFILE_HASH_FIELDS).toEqual(["id", "platform", "form", "tickHz", "display", "capabilities", "roleCapabilities"]);
    expect(canonicalProfileJson(profile)).toBe('{"capabilities":["input.buttons","text.glyphs.baked"],"display":{"logicalViewports":[[480,320]],"physicalViewport":[480,320],"presentations":["native"],"rasterDensity":1},"form":"takeover","id":"my-board","platform":"esp-idf","tickHz":60}');
    expect(hash(profile)).toHaveLength(PROFILE_HASH_BYTES * 2);
    expect(hash(profile)).toBe("91d9e23af99a35dc3b094fb7ace738745b2a81a5308897b221a016ba3afbf267");
    expect(profileHashProjection(profile)).not.toHaveProperty("roleCapabilities");
  });

  test("object key order and metadata do not change identity", () => {
    const reverse = Object.fromEntries(Object.entries(profile).reverse()) as unknown as PocketProfile;
    expect(hash(reverse)).toBe(hash(profile));
    expect(hash({ ...profile, hostExtension: { panel: "st7796", build: 42 } })).toBe(hash(profile));
    expect(hash({ ...profile, hostExtension: { panel: "other" } })).toBe(hash(profile));
  });

  test("every software fact changes identity; added capabilities are not compatible", () => {
    const changes: PocketProfile[] = [
      { ...profile, id: "new-board" }, { ...profile, platform: "baremetal" },
      { ...profile, form: "kiosk" }, { ...profile, tickHz: 30 },
      { ...profile, display: { ...profile.display, rasterDensity: 2 } },
      { ...profile, capabilities: [...profile.capabilities, "input.touch"] },
      { ...profile, roleCapabilities: { systemUI: ["ui.compositor-surfaces"] } },
    ];
    for (const changed of changes) expect(hash(changed)).not.toBe(hash(profile));
    expect(hash({ ...profile, capabilities: [...profile.capabilities].reverse() })).not.toBe(hash(profile));
  });

  test("profile shape permits tree-external ids without package-v1's 15-byte limit", () => {
    expect(diagnostics({ ...profile, id: "my-product-board-with-a-long-name" })).toEqual([]);
    expect(diagnostics({ ...profile, toolchain: "nightly" })).not.toEqual([]);
    expect(diagnostics({ ...profile, hostAbi: 7 })).not.toEqual([]);
    expect(diagnostics({ ...profile, tickHz: 0 })).not.toEqual([]);
    expect(diagnostics({ ...profile, capabilities: ["input.buttons", "input.buttons"] })).not.toEqual([]);
  });

  test("Unicode remains literal; invalid JSON data cannot hash as valid data", () => {
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
    expect(hashPocketProfile(declared)).toBe(`sha256:${hash(declared)}`);
    expect(Object.isFrozen(declared.display.logicalViewports[0])).toBe(true);
    expect(() => (declared.capabilities as string[]).push("input.touch")).toThrow();
    expect(() => defineProfile({ ...profile, id: "\0board" })).toThrow("without NUL");
    expect(() => defineProfile({ ...profile, id: "x".repeat(65536) })).toThrow("65535");
  });

  test("built-in profiles use the same projection and cannot be shadowed", () => {
    expect(Object.keys(POCKET_PROFILES)).toHaveLength(21);
    for (const builtin of Object.values(POCKET_PROFILES)) {
      expect(validatePocketProfile(builtin, { builtin: true }).ok).toBe(true);
      expect(hashPocketProfile(builtin)).toBe(`sha256:${hash(builtin)}`);
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
