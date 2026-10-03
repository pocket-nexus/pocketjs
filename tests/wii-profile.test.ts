import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { POCKET_TARGETS } from "../contracts/spec/platforms.ts";
import {
  resolveWiiBuildPlan,
  WII_DEV_CONTRACTS,
  WII_DEV_HOST_ABI,
  WII_DEV_TARGET_ID,
  WII_DEV_VIEWPORT,
} from "../tools/wii-profile.ts";

const heroManifest = JSON.parse(
  readFileSync(join(import.meta.dir, "../apps/hero/pocket.json"), "utf8"),
);

describe("private Wii library profile", () => {
  test("resolves the representative app without registering a stock target", () => {
    expect(POCKET_TARGETS).not.toHaveProperty(WII_DEV_TARGET_ID);
    const plan = resolveWiiBuildPlan(heroManifest);

    expect(plan.target).toEqual({ id: WII_DEV_TARGET_ID, hostAbi: WII_DEV_HOST_ABI });
    expect(plan.viewport).toEqual({
      logical: WII_DEV_VIEWPORT,
      physical: WII_DEV_VIEWPORT,
      presentation: "integer-fit",
      rasterDensity: 1,
      policy: "fixed",
    });
    expect(WII_DEV_CONTRACTS.targets[WII_DEV_TARGET_ID].capabilities).toEqual([
      "input.analog.left",
      "input.buttons",
      "text.glyphs.baked",
    ]);
  });

  test("rejects a required capability the library and example do not provide", () => {
    const needsCursor = structuredClone(heroManifest);
    needsCursor.engine.capabilities.requires.push("input.cursor");

    expect(() => resolveWiiBuildPlan(needsCursor)).toThrow("input.cursor");
  });
});
