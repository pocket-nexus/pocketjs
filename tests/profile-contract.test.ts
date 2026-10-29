import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  canonicalProfileJson, compiledProfile, pocketProfileSchema, PROFILE_HASH_FIELDS,
  type PocketProfile,
} from "../contracts/spec/profile.ts";
import { validateSchema, type ContractDiagnostic } from "../framework/src/manifest/validate.ts";
import { hashPocketProfile, parsePocketProfile, readPocketProfile, validatePocketProfile } from "../framework/src/profile.ts";
import { POCKET_PROFILES } from "../profiles/index.ts";
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";

const root = resolve(import.meta.dir, "..");
const profile: PocketProfile = {
  format: "pocket-profile/2",
  id: "my-board", platform: "esp-idf", form: "takeover", cadences: [60, 30],
  display: {
    logicalViewports: [[480, 320]], presentations: ["native"], rasterDensity: 1, animation: "repaint",
  },
  panel: { primary: [480, 320] },
  capabilities: ["input.buttons", "text.glyphs.baked"],
};
const diagnostics = (input: unknown) => {
  const result: ContractDiagnostic[] = [];
  validateSchema(input, pocketProfileSchema, "", result);
  return result;
};
const messages = (input: unknown, options: { builtin?: boolean } = {}) => {
  const result = validatePocketProfile(input, options);
  return result.ok ? "" : result.diagnostics.map(item => item.message).join("; ");
};

describe("profile documents", () => {
  test("the schema is the data shape of pocket-profile/2", () => {
    expect(diagnostics(profile)).toEqual([]);
    expect(diagnostics({ ...profile, id: "my-product-board-with-a-long-name" })).toEqual([]);
    expect(diagnostics({ ...profile, toolchain: "nightly" })).not.toEqual([]);
    expect(diagnostics({ ...profile, tickHz: 60 })).not.toEqual([]);
    expect(diagnostics({ ...profile, format: "pocket-profile/1" })).not.toEqual([]);
    expect(diagnostics({ ...profile, cadences: [] })).not.toEqual([]);
    expect(diagnostics({ ...profile, cadences: [60, 60] })).not.toEqual([]);
    expect(diagnostics({ ...profile, display: { ...profile.display, animation: undefined } })).not.toEqual([]);
    expect(diagnostics({ ...profile, display: { ...profile.display, physicalViewport: [480, 320] } })).not.toEqual([]);
    expect(diagnostics({ ...profile, capabilities: ["input.buttons", "input.buttons"] })).not.toEqual([]);
    expect(diagnostics({ ...profile, hostAbi: POCKET_BINDING_GENERATION, limits: { heapBytes: 1 << 20 }, input: { coordinateBits: 9 } })).toEqual([]);
  });

  test("the published JSON schema is the generated one", () => {
    expect(JSON.parse(readFileSync(join(root, "contracts/schema/pocket-profile-2.json"), "utf8"))).toEqual(JSON.parse(JSON.stringify(pocketProfileSchema)));
  });

  test("the hash covers the projection; capability order and extra facts do not change it", () => {
    expect(PROFILE_HASH_FIELDS).toEqual(["id", "platform", "form", "cadences", "display", "capabilities", "roleCapabilities"]);
    const reordered = { ...profile, cadences: [30, 60], capabilities: [...profile.capabilities].reverse() };
    expect(canonicalProfileJson(reordered)).toBe(canonicalProfileJson(profile));
    expect(hashPocketProfile({ ...profile, panel: { primary: [960, 640] }, limits: { heapBytes: 4096 }, hostAbi: 12 } as PocketProfile)).toBe(hashPocketProfile(profile));
    expect(hashPocketProfile({ ...profile, capabilities: [...profile.capabilities, "input.touch"] })).not.toBe(hashPocketProfile(profile));
    expect(canonicalProfileJson(profile)).toBe('{"cadences":[30,60],"capabilities":["input.buttons","text.glyphs.baked"],"display":{"animation":"repaint","logicalViewports":[[480,320]],"presentations":["native"],"rasterDensity":1},"form":"takeover","id":"my-board","platform":"esp-idf"}');
  });

  test("Unicode remains literal and invalid JSON data is rejected", () => {
    expect(canonicalProfileJson({ ...profile, id: "屏幕-🎮" })).toContain('"id":"屏幕-🎮"');
    expect(() => canonicalProfileJson({ ...profile, id: "\ud800" })).toThrow("surrogate");
    expect(() => canonicalProfileJson({ ...profile, cadences: [NaN] })).toThrow("non-finite");
    expect(() => canonicalProfileJson({ ...profile, display: { ...profile.display, logicalViewports: Array(1) } })).toThrow("undefined");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalProfileJson({ ...profile, display: cyclic as unknown as PocketProfile["display"] })).toThrow("cycle");
    expect(messages({ ...profile, hostExtension: cyclic })).toContain("cycle");
  });

  test("parsed documents retain long and Unicode ids and freeze their facts", () => {
    const parsed = parsePocketProfile({ ...profile, id: "树外产品-🎮-with-a-name-longer-than-fifteen-bytes" });
    expect(Object.isFrozen(parsed.display.logicalViewports[0])).toBe(true);
    expect(() => (parsed.capabilities as string[]).push("input.touch")).toThrow();
    expect(messages({ ...profile, id: "\0board" })).toContain("without NUL");
    expect(messages({ ...profile, id: "x".repeat(65536) })).toContain("65535");
    expect(compiledProfile({ ...parsed, hostAbi: 12, hostExtension: { note: 1 } })).not.toHaveProperty("hostAbi");
  });

  test("built-in documents validate, carry no stamp and keep command words out", () => {
    const files = readdirSync(join(root, "profiles")).filter(name => name.endsWith(".json")).sort();
    expect(files).toEqual(Object.keys(POCKET_PROFILES).map(id => `${id}.json`).sort());
    for (const builtin of Object.values(POCKET_PROFILES)) {
      expect(validatePocketProfile(builtin, { builtin: true }).ok).toBe(true);
      expect(builtin).not.toHaveProperty("hostAbi");
    }
    for (const id of ["compile", "target", "profile", "sdk", "pack"]) expect(messages({ ...profile, id })).toContain("command");
  });

  test("a release stamp names the binding generation", () => {
    expect(messages({ ...profile, hostAbi: POCKET_BINDING_GENERATION })).toBe("");
    expect(messages({ ...profile, hostAbi: POCKET_BINDING_GENERATION - 1 })).toContain("binding generation");
    const directory = mkdtempSync(join(tmpdir(), "pocket-profile-"));
    try {
      const file = join(directory, "pocket-profile.json");
      writeFileSync(file, JSON.stringify({ ...profile, hostAbi: POCKET_BINDING_GENERATION + 1 }));
      expect(() => readPocketProfile(file)).toThrow("binding generation");
      writeFileSync(file, JSON.stringify({ ...profile, format: "pocket-profile/1" }));
      expect(() => readPocketProfile(file)).toThrow("pocket-profile/2");
      writeFileSync(file, JSON.stringify(profile));
      expect(readPocketProfile(file)).toEqual(profile);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("viewport, panel, worker and capability relations are checked", () => {
    expect(messages({ ...profile, capabilities: ["made.up"] })).toBe("");
    expect(messages({ ...profile, form: "window" })).toContain("dynamic viewport");
    expect(messages({ ...profile, capabilities: ["display.auxiliary"] })).toContain("geometry");
    expect(messages({ ...profile, capabilities: ["input.touch.auxiliary"] })).toContain("auxiliary display");
    expect(messages({ ...profile, capabilities: ["display.auxiliary"], display: { ...profile.display, auxiliary: { logicalViewports: [[320, 240]], presentations: ["native"], rasterDensity: 1 } } })).toContain("panel");
    expect(messages({ ...profile, worker: { nodes: { http: 1 } } })).toContain("runtime.worker");
    expect(messages({ ...profile, capabilities: ["runtime.worker"], worker: { nodes: { http: 1 } } })).toContain("net.http");
    expect(messages({ ...profile, capabilities: ["runtime.worker", "net.http"], worker: { nodes: { http: 1 } } })).toBe("");
    const dynamic = {
      ...profile, form: "window" as const,
      display: { ...profile.display, dynamicViewport: { min: [240, 180] as const, max: [800, 600] as const } },
      capabilities: [...profile.capabilities, "display.viewport.live"],
    };
    expect(messages(dynamic)).toBe("");
    expect(messages({ ...dynamic, display: { ...dynamic.display, dynamicViewport: { min: [900, 700], max: [800, 600] } } })).toContain("minimum");
    expect(messages({ ...dynamic, capabilities: ["input.touch", "display.viewport.live"], display: { ...dynamic.display, dynamicViewport: { min: [240, 180], max: [2048, 2048] } } })).toContain("10-bit");
    expect(messages({ ...dynamic, capabilities: ["input.touch", "display.viewport.live"], input: { coordinateBits: 9 } })).toContain("9-bit");
  });
});
