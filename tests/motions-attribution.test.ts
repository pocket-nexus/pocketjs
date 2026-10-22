import { describe, expect, test } from "bun:test";
import { BTN } from "../contracts/spec/spec.ts";
import { bootWorld, treeHasText, type SimWorld } from "../programs/sim/sim.ts";

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
});
