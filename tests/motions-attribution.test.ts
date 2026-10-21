import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BTN } from "../contracts/spec/spec.ts";
import { bootWorld, treeHasText, type SimWorld } from "../programs/sim/sim.ts";
import { MOTION_CREDIT_ASSETS } from "../site/motion-credit.ts";

const ROOT = new URL("..", import.meta.url).pathname;

async function step(world: SimWorld, buttons: number): Promise<void> {
  world.frame(buttons);
  for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
  await Promise.resolve();
}

describe("Motion Lab attribution", () => {
  test("keeps the requested creator credit visible across all four pages", async () => {
    const world = await bootWorld("motions-main", 60);
    await step(world, 0);

    for (const path of ["53", "56", "30", "64"]) {
      const tree = world.getTree();
      expect(treeHasText(tree, `(yui540)`)).toBe(true);
      expect(treeHasText(tree, `yui540.com/motions/${path}`)).toBe(true);
      if (path !== "64") {
        await step(world, BTN.RIGHT);
        await step(world, 0);
      }
    }
  }, 120_000);

  test("records the author's conditions and the separate-permission boundary", () => {
    const attribution = readFileSync(ROOT + "apps/motions/ATTRIBUTION.md", "utf8");
    for (const path of ["53", "56", "30", "64"]) {
      expect(attribution).toContain(`https://yui540.com/motions/${path}`);
    }
    expect(attribution).toContain("August 5, 2026");
    expect(attribution).toMatch(/offered PocketJS continued use/);
    expect(attribution).toContain("PocketJS accepts both conditions");
    expect(attribution).toMatch(/must\s+obtain yui540's permission/);

    const readme = readFileSync(ROOT + "README.md", "utf8");
    const post = readFileSync(ROOT + "site/content/blog/baking-motion.md", "utf8");
    expect(readme).toContain("accepts yui540's two stated conditions");
    expect(post).toContain("PocketJS accepts both conditions");
  });

  test("tracks every public Motion Lab GIF in the credit stamper", () => {
    expect(MOTION_CREDIT_ASSETS.map((asset) => asset.path).sort()).toEqual(
      [
        "assets/screenshots/motions-3d.gif",
        "assets/screenshots/motions-53.gif",
        "site/assets/blog/dpad.gif",
        "site/assets/blog/menu.gif",
        "site/assets/blog/page-3d.gif",
        "site/assets/blog/reload.gif",
        "site/assets/blog/reveal.gif",
        "site/assets/blog/room.gif",
        "site/assets/blog/share.gif",
        "site/assets/blog/spin.gif",
      ].sort(),
    );
  });
});
