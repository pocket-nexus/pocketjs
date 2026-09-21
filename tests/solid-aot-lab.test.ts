import { expect, test } from "bun:test";
import { bootWorld, type SimWorld } from "../hosts/sim/sim.ts";
import { BTN } from "../contracts/spec/spec.ts";
import { buildAot } from "../microts/compiler/aot-build.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function treeHasText(tree: unknown, expected: string): boolean {
  if (!tree || typeof tree !== "object") return false;
  const node = tree as { t?: string; x?: string | number; k?: unknown[] };
  const content = (value: unknown): string => {
    const child = value as typeof node;
    return child.x === undefined ? (child.k ?? []).map(content).join("") : String(child.x);
  };
  return node.t === "text" && content(node).includes(expected) || (node.k ?? []).some(child => treeHasText(child, expected));
}
function step(world: SimWorld, buttons = 0) { world.frame(buttons); for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick(); }
test("Solid lab executes TSX props, control flow, slots and signal writes on the JS host", async () => {
  const world = await bootWorld("solid-aot-lab-main", 60);
  step(world);
  expect(treeHasText(world.getTree(), "Solid AOT Feature Lab")).toBe(true);
  expect(treeHasText(world.getTree(), "Switch: idle")).toBe(true);
  expect(treeHasText(world.getTree(), "2.KEYED FOR")).toBe(true);
  step(world, BTN.RIGHT); step(world);
  for (let press = 0; press < 4; press++) { step(world, BTN.CIRCLE); step(world); }
  expect(treeHasText(world.getTree(), "parent value: 4")).toBe(true);
  expect(treeHasText(world.getTree(), "Switch: complete")).toBe(true);
  step(world, BTN.CROSS); step(world);
  expect(treeHasText(world.getTree(), "parent value: 0")).toBe(true);
}, 120_000);

test.each(["solid-aot-lab", "vue-sfc-lab"])("%s regenerates deterministic Rust and styles from sources", async app => {
  const result = await buildAot(app, { strict: true });
  const repeated = await buildAot(app, { strict: true, outDir: resolve(".pocket-build/validation/aot-demo-generation", app, "gen") });
  expect(result.files.map(file => file.slice(file.lastIndexOf("/") + 1))).toEqual(
    repeated.files.map(file => file.slice(file.lastIndexOf("/") + 1)),
  );
  for (const file of result.files) {
    const name = file.slice(file.lastIndexOf("/") + 1);
    expect(readFileSync(file)).toEqual(readFileSync(resolve(repeated.outDir, name)));
  }
}, 60_000);
