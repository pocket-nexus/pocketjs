import { describe, expect, test } from "bun:test";
import { bootWorld, treeHasText, type SimWorld } from "../programs/sim/sim.ts";
import { BTN } from "../contracts/spec/spec.ts";

async function step(world: SimWorld, buttons: number): Promise<void> {
  world.frame(buttons);
  for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
  // Vue Vapor schedules dependent render effects in a microtask.
  await Promise.resolve();
}

describe("Vue SFC feature lab", () => {
  test("runs component v-model, conditional fragments, lists, props, emits and slots", async () => {
    const world = await bootWorld("vue-sfc-lab-main.vue-vapor", 60);
    for (let frame = 0; frame < 4; frame++) await step(world, 0);

    const initial = world.getTree();
    expect(treeHasText(initial, "VALUE +1")).toBe(true);
    expect(treeHasText(initial, "v-if: idle")).toBe(true);
    expect(treeHasText(initial, "template v-else: press → then ○")).toBe(true);
    for (const label of ["MODEL", "V-FOR", "SLOTS"]) {
      expect(treeHasText(initial, label)).toBe(true);
    }
    for (const summary of ["1.MODEL", "2.V-FOR", "3.SLOTS"]) {
      expect(treeHasText(initial, summary)).toBe(true);
    }

    await step(world, BTN.RIGHT);
    await step(world, 0);
    for (let press = 0; press < 4; press++) {
      await step(world, BTN.CIRCLE);
      await step(world, 0);
    }

    const updated = world.getTree();
    expect(treeHasText(updated, "parent value: 4")).toBe(true);
    expect(treeHasText(updated, "v-else: complete")).toBe(true);
    expect(treeHasText(updated, "template v-if: fragment")).toBe(true);
  });
});
