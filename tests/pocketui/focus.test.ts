import { describe, expect, test } from "bun:test";
import { firstFocus, pickFocus, type FocusRect } from "../../framework/src/pocketui/core/focus.ts";

const r = (x: number, y: number, w: number, h: number): FocusRect => ({ x, y, w, h });
// a sidebar of three rows beside a pane with a tall card and a button under it
const side = [r(0, 0, 100, 30), r(0, 30, 100, 30), r(0, 60, 100, 30)];
const card = r(110, 0, 200, 70);
const button = r(110, 80, 80, 24);
const all = [...side, card, button];

describe("pickFocus", () => {
  test("down in a list goes to the next row", () => {
    expect(pickFocus(side[0]!, "down", all)).toBe(1);
    expect(pickFocus(side[1]!, "up", all)).toBe(0);
  });
  test("right leaves the list for the pane beside it", () => {
    expect(pickFocus(side[1]!, "right", all)).toBe(3);
  });
  test("left returns to the row in the beam", () => {
    expect(pickFocus(button, "left", all)).toBe(2);
    // three rows share the card's beam: the one nearest its middle
    expect(pickFocus(card, "left", all)).toBe(1);
  });
  test("nothing in that direction", () => {
    expect(pickFocus(side[0]!, "up", all)).toBe(-1);
    expect(pickFocus(side[0]!, "left", all)).toBe(-1);
  });
  test("down from the last row prefers what is under it over the far pane", () => {
    expect(pickFocus(side[2]!, "down", all)).toBe(-1);
    expect(pickFocus(card, "down", all)).toBe(4);
  });
});

test("firstFocus is the top-left control", () => {
  expect(firstFocus([button, card, side[1]!, side[0]!])).toBe(3);
});

test("a control far off to the side is not where a press lands", () => {
  // from a field at the bottom of the right pane, Down must not jump to something far to the left
  const field = r(211, 306, 362, 28);
  const farRow = r(0, 350, 100, 46);
  expect(pickFocus(field, "down", [field, farRow])).toBe(-1);
  // a control just below and a little aside still counts
  expect(pickFocus(field, "down", [field, r(580, 340, 50, 24)])).toBe(1);
});
