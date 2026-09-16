import { expect, test } from "bun:test";
import { createKeyboardTouch, KEY_HOLD } from "../apps/clear/keyboard-touch.ts";
function fixture() {
  const events: (string | number | boolean)[] = [];
  const touch = createKeyboardTouch({ space: () => events.push("space"), backspace: () => events.push("delete"),
    caret: d => events.push(d), trackpad: a => events.push(a) });
  const begin = (kind: "space" | "backspace" | "other", id = 0, now = 0) =>
    touch.begin(id, 100, 100, kind, { x: 80, y: 80, w: 60, h: 40 }, now);
  return { touch, events, begin };
}
test("short space commits on release, rolling two-thumb typing keeps order", () => {
  const { touch, events, begin } = fixture();
  begin("space"); touch.step(.15); expect(events).toEqual([]);
  touch.release(0); expect(events).toEqual(["space"]);
  begin("space"); begin("other", 1, .1); events.push("letter"); touch.release(0); touch.release(1);
  expect(events).toEqual(["space", "space", "letter"]);
});
test("space enters caret mode at 200 ms without inserting; detents reject jitter and allow reversal", () => {
  const { touch, events, begin } = fixture();
  expect(KEY_HOLD.space).toBe(.2);
  begin("space"); touch.step(.199); expect(touch.tracking()).toBe(false);
  touch.step(.2); expect(touch.tracking()).toBe(true);
  touch.move(0, 106, 100); expect(events).toEqual([true]);
  touch.move(0, 107, 100); touch.move(0, 106, 100); touch.move(0, 107, 100);
  expect(events).toEqual([true, 1]);
  touch.move(0, 103, 100); expect(events).toEqual([true, 1, -1]);
  touch.move(0, 70, 140); expect(events).toEqual([true, 1, -1, -1, -1, -1]);
  expect(begin("backspace", 1)).toBe(false); touch.release(0);
  expect(events.at(-1)).toBe(false); expect(events).not.toContain("space");
});
test("cancel, leaving a held key and ending trackpad stop their pending actions", () => {
  const { touch, events, begin } = fixture();
  begin("space"); touch.move(0, 130, 100); touch.step(1); touch.release(0); expect(events).toEqual([]);
  begin("backspace"); touch.move(0, 160, 100); touch.step(2); touch.release(0);
  expect(events).toEqual(["delete"]);
  begin("space"); touch.step(.4); touch.cancel(); touch.move(0, 0, 0); touch.step(10);
  expect(events).toEqual(["delete", true, false]);
});
for (const hz of [30, 60, 120]) test(`backspace repeats with time, accelerates, and stops on release at ${hz} Hz`, () => {
  const { touch, events, begin } = fixture();
  begin("backspace"); expect(events).toEqual(["delete"]);
  for (let i = 1; i <= hz; i++) touch.step(i / hz);
  expect(events.length).toBe(8); // down + .43/.515/.60/.685/.77/.855/.94
  for (let i = hz + 1; i <= hz * 3; i++) touch.step(i / hz);
  expect(events.length).toBeGreaterThanOrEqual(39);
  expect(events.length).toBeLessThanOrEqual(40);
  const count = events.length; touch.release(0); touch.step(100); expect(events.length).toBe(count);
});
test("a stalled frame cannot burst an unbounded backlog of deletes or caret moves", () => {
  const { touch, events, begin } = fixture();
  begin("backspace"); touch.step(60); expect(events.length).toBe(3); touch.cancel();
  begin("space"); touch.step(.4); touch.move(0, 10000, 100);
  expect(events.filter(e => e === 1).length).toBe(8);
});

test("space stays held through trackpad activation and a two-thumb chord until release or cancel", () => {
  const { touch, begin } = fixture();
  expect(touch.holdingSpace()).toBe(false);
  begin("space"); expect(touch.holdingSpace()).toBe(true);
  touch.step(.25); expect(touch.holdingSpace()).toBe(true);
  touch.step(.4); expect(touch.holdingSpace()).toBe(true);
  touch.move(0, 70, 140); expect(touch.holdingSpace()).toBe(true);
  touch.release(0); expect(touch.holdingSpace()).toBe(false);
  begin("space"); begin("other", 1, .1); expect(touch.holdingSpace()).toBe(true);
  touch.release(1); expect(touch.holdingSpace()).toBe(true);
  touch.cancel(); expect(touch.holdingSpace()).toBe(false);
  begin("space"); touch.move(0, 130, 100); expect(touch.holdingSpace()).toBe(false);
});
