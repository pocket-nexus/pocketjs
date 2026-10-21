import { describe, expect, test } from "bun:test";
import {
  POCKET_IDF_HOST_SCHEMA_ID,
  generatePocketIdfHostSchema,
  type PocketIdfHostProfile,
} from "../contracts/spec/idf-host.ts";
import {
  hashPocketIdfHostProfile,
  pocketIdfHostExtension,
  readIdfHostExtension,
  pocketIdfHostRegistry,
  validatePocketIdfHostProfile,
} from "../framework/src/manifest/idf-host.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
import { createHostExtension, isHostExtension } from "../framework/src/manifest/host-extension.ts";
import { idfHostBuildEnvironment } from "../framework/src/manifest/idf-host.ts";
import { hashPocketProfile, profileHashProjection } from "../framework/src/profile.ts";

const profile: PocketIdfHostProfile = {
  $schema: POCKET_IDF_HOST_SCHEMA_ID,
  version: 1,
  id: "idf-smoke",
  platform: "esp-idf",
  form: "takeover",
  tickHz: 60,
  display: {
    physicalViewport: [480, 272],
    logicalViewports: [[480, 272]],
    presentations: ["native", "integer-fit"],
    rasterDensity: 1,
  },
  capabilities: ["input.analog.left", "input.buttons", "text.glyphs.baked"],
};

describe("ESP-IDF host profile", () => {
  test("extension identity is generic and payload validation belongs to the IDF adapter", () => {
    const other = createHostExtension("another-host", 2, { answer: 42 });
    expect(isHostExtension(other)).toBe(true);
    expect(readIdfHostExtension(other)).toBeUndefined();
    const extension = pocketIdfHostExtension(`sha256:${"12".repeat(32)}`, 60);
    expect(isHostExtension({ ...extension, payload: { ...extension.payload, tickHz: 61 } })).toBe(false);
    expect(() => readIdfHostExtension({ ...extension, version: 2 })).toThrow(/payload\/version/);
    expect(() => readIdfHostExtension(createHostExtension("esp-idf", 1, { profileHash: "bad", tickHz: 60 }))).toThrow();
    expect(idfHostBuildEnvironment(extension).POCKETJS_TICK_HZ).toBe("60");
  });
  test("committed schema matches the TypeScript source", async () => {
    const committed = await Bun.file(
      new URL("../contracts/schema/pocket-idf-host-1.json", import.meta.url),
    ).text();
    expect(committed).toBe(generatePocketIdfHostSchema());
  });

  test("validates, hashes, and resolves as one project-provided target", async () => {
    const validated = validatePocketIdfHostProfile(profile);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const profileHash = hashPocketIdfHostProfile(validated.value);
    expect(profileHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const manifest = await Bun.file(
      new URL("./fixtures/manifests/portable-psp.json", import.meta.url),
    ).json();
    const result = validateAndResolveBuildPlan(
      manifest,
      { target: profile.id, hostExtension: pocketIdfHostExtension(profileHash, profile.tickHz) },
      pocketIdfHostRegistry(profile),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.target).toEqual({ id: "idf-smoke", hostAbi: 1 });
    expect(result.plan.profile).toEqual(profileHashProjection(profile));
    expect(result.plan.profileHash).toBe(hashPocketProfile(profile));
    expect(readIdfHostExtension(result.plan.hostExtension)).toEqual({ profileHash, tickHz: 60 });
  });

  test("legacy JSON schema metadata is excluded and tickHz remains part of identity", () => {
    expect(hashPocketIdfHostProfile(profile)).toBe(hashPocketProfile(profileHashProjection(profile)));
    expect(hashPocketIdfHostProfile({ ...profile, tickHz: 30 })).not.toBe(hashPocketIdfHostProfile(profile));
    expect(hashPocketIdfHostProfile({ ...profile, version: 2 } as unknown as PocketIdfHostProfile)).toBe(hashPocketIdfHostProfile(profile));
  });

  test("rejects target ids that exceed the package table", () => {
    const invalid = { ...profile, id: "idf-target-name-too-long" };
    const result = validatePocketIdfHostProfile(invalid);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toContainEqual({
      code: "schema.maxLength",
      path: "/id",
      message: "maximum length is 15",
    });
  });

  test("rejects dynamic forms and unsupported rates", () => {
    expect(validatePocketIdfHostProfile({ ...profile, form: "window" }).ok).toBe(false);
    expect(validatePocketIdfHostProfile({ ...profile, tickHz: 0 }).ok).toBe(false);
  });

  test("rejects touch viewports that exceed the packed coordinate range", () => {
    const result = validatePocketIdfHostProfile({
      ...profile,
      display: { ...profile.display, logicalViewports: [[513, 272]] },
      capabilities: [...profile.capabilities, "input.touch"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toContainEqual({
      code: "idfHost.touchViewportTooLarge",
      path: "/display/logicalViewports/0",
      message: "touch-capable logical viewports must fit the 9-bit coordinate contract",
    });
  });
});
