import { afterEach, expect, test } from "bun:test";
import { createCaretBlink } from "../framework/src/animation.ts";
import { __advanceClock, resetClock } from "../framework/src/clock.ts";

afterEach(() => { delete (globalThis as any).__simHz; resetClock(); });
for (const hz of [30, 60]) test(`caret focus, edit reset, drag and disposal at ${hz} Hz`, () => {
  (globalThis as any).__simHz = hz; resetClock(); __advanceClock();
  const states: boolean[] = [];
  const blink = createCaretBlink({ onChange: value => states.push(value) });
  const frames = (n: number) => { for (let i = 0; i < n; i++) __advanceClock(); };
  frames(hz); expect(states).toEqual([]);
  blink.setActive(true); frames(hz / 2 - 1); expect(states).toEqual([true]);
  frames(1); expect(states).toEqual([true, false]);
  blink.reset(); frames(hz / 2 - 1); expect(states).toEqual([true, false, true]);
  blink.reset(); frames(1); expect(states.at(-1)).toBe(true); // old deadline cancelled
  blink.setHeld(true); frames(hz * 2); expect(states).toEqual([true, false, true]);
  blink.setHeld(false); frames(hz / 2); expect(states.at(-1)).toBe(false);
  blink.setActive(false); const count = states.length; frames(hz * 2); expect(states).toHaveLength(count);
  blink.setActive(true); blink.dispose(); frames(hz * 2); expect(states.slice(-2)).toEqual([true, false]);
  blink.reset(); blink.setActive(true); blink.setHeld(false); frames(hz); expect(states.at(-1)).toBe(false);
});
test("invalid caret timing is rejected", () => {
  for (const intervalMs of [0, -1, NaN, Infinity]) {
    expect(() => createCaretBlink({ intervalMs, onChange() {} })).toThrow(RangeError);
  }
});
test("a visibility callback may reset without creating duplicate deadlines", () => {
  resetClock(); __advanceClock();
  const states: boolean[] = [];
  const blink = createCaretBlink({ onChange(value) {
    states.push(value);
    if (states.length === 2) blink.reset();
  } });
  blink.setActive(true);
  for (let i = 0; i < 60; i++) __advanceClock();
  expect(states).toEqual([true, false, true, false]);
  blink.dispose();
});
