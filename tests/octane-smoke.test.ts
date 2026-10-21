import { describe, expect, test } from "bun:test";
import { bootWorld, treeHasText, type SimWorld } from "../programs/sim/sim.ts";
import { BTN } from "../contracts/spec/spec.ts";

async function step(world: SimWorld, buttons: number): Promise<void> {
  world.frame(buttons);
  for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
  // Octane universal roots schedule re-renders on the microtask queue.
  await Promise.resolve();
}

describe("Octane hero demo", () => {
  test("boots, renders and reacts to CIRCLE presses", async () => {
    const world = await bootWorld("hero-main.octane", 60);
    for (let frame = 0; frame < 4; frame++) await step(world, 0);

    const initial = world.getTree();
    expect(treeHasText(initial, "PocketJS")).toBe(true);
    expect(treeHasText(initial, "Octane + RUST + SCEGU")).toBe(true);
    expect(treeHasText(initial, "ONE RUST CORE - ONE OCTANE APP")).toBe(true);
    expect(treeHasText(initial, "Count: 0")).toBe(true);
    expect(treeHasText(initial, "Reactive on real hardware.")).toBe(false);

    await step(world, BTN.DOWN); // establish focus on the first focusable
    await step(world, 0);
    for (let press = 0; press < 4; press++) {
      await step(world, BTN.CIRCLE);
      await step(world, 0);
    }

    const updated = world.getTree();
    expect(treeHasText(updated, "Count: 4")).toBe(true);
    expect(treeHasText(updated, "Reactive on real hardware.")).toBe(true);
  });
});
