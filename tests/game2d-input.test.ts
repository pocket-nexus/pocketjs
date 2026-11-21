import { expect, test } from "bun:test";
import { createInput } from "../framework/src/game2d/input.ts";

const grid = (disabled: number[], count = 9) => {
  const nav = createInput().nav(count, { mode: "grid", cols: 3, disabled: (i: number) => disabled.includes(i) });
  return nav;
};

test("down skips a disabled cell and lands on the nearest enabled one in that row", () => {
  const nav = grid([6]);
  nav.set(3);
  nav.move("down");
  expect(nav.index).toBe(7);
});

test("down passes over a row with nothing enabled", () => {
  const nav = grid([3, 4, 5]);
  nav.set(0);
  nav.move("down");
  expect(nav.index).toBe(6);
});

test("down into a shorter last row lands on its last item", () => {
  const nav = grid([], 7);
  nav.set(5);
  nav.move("down");
  expect(nav.index).toBe(6);
});

test("left and right stay in the row and skip disabled cells", () => {
  const nav = grid([1]);
  nav.set(0);
  nav.move("right");
  expect(nav.index).toBe(2);
  nav.move("right");
  expect(nav.index).toBe(2);
});
