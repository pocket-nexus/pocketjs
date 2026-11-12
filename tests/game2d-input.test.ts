import { expect, test } from "bun:test";
import { BTN, createInput } from "../framework/src/game2d/input.ts";

const actions = () => createInput({ bindings: { confirm: BTN.CIRCLE, back: BTN.CROSS, jump: BTN.CROSS | BTN.SQUARE }, confirm: "confirm", back: "back" });
const grid = (disabled: number[], count = 9) => {
  const nav = actions().nav(count, { mode: "grid", cols: 3, disabled: (i: number) => disabled.includes(i) });
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

test("an action is any of its buttons, and a press holds until a step consumes it", () => {
  const input = actions();
  input.update(BTN.SQUARE);
  expect(input.held("jump")).toBe(true);
  expect(input.pressed("jump")).toBe(true);
  input.update(0); // released in a frame that ran no step: the press is still there
  expect(input.held("jump")).toBe(false);
  expect(input.pressed("jump")).toBe(true);
  input.endStep();
  expect(input.pressed("jump")).toBe(false);
  input.update(BTN.SQUARE);
  input.endStep();
  input.update(BTN.SQUARE); // still held: no new edge
  expect(input.pressed("jump")).toBe(false);
});

test("bind moves an action to other buttons; an unknown action throws", () => {
  const input = actions();
  input.bind("confirm", BTN.CROSS);
  input.update(BTN.CROSS);
  expect(input.pressed("confirm")).toBe(true);
  expect(() => input.pressed("dash" as "confirm")).toThrow();
});

test("the directions read the d-pad, and axis reuses its object", () => {
  const input = actions();
  input.update(BTN.LEFT | BTN.DOWN);
  const a = input.axis();
  expect([a.x, a.y]).toEqual([-1, 1]);
  input.update(BTN.UP);
  expect(input.axis()).toBe(a);
  expect([a.x, a.y]).toEqual([0, -1]);
});

test("routeNav moves the top menu with repeat and picks with the confirm action", () => {
  const input = actions();
  const picked: number[] = [];
  const nav = input.nav(3, { onPick: (i) => picked.push(i) });
  input.update(BTN.DOWN); expect(input.routeNav(false)).toBe(true); input.endStep();
  expect(nav.index).toBe(1);
  for (let f = 0; f < 22; f++) { input.update(BTN.DOWN); input.routeNav(false); input.endStep(); }
  expect(nav.index).toBe(1); // inside the repeat delay
  for (let f = 0; f < 7; f++) { input.update(BTN.DOWN); input.routeNav(false); input.endStep(); }
  expect(nav.index).toBe(2);
  input.update(0); input.endStep();
  input.update(BTN.CIRCLE); input.routeNav(false);
  expect(picked).toEqual([2]);
});
