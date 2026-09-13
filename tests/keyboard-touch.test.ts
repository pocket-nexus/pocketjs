import { expect, test } from "bun:test";
import { createKeyboardTouch } from "../framework/src/keyboard-touch.ts";

test("touch keyboard releases all contact state and distinguishes spaces from caret drags", () => {
  const calls: string[] = [];
  const touch = createKeyboardTouch({ space: () => calls.push("space"), backspace: () => calls.push("delete"), caret: n => calls.push(`caret:${n}`), trackpad: active => calls.push(`track:${active}`) });
  const rect = { x: 0, y: 0, w: 140, h: 30 };
  touch.begin(1, 20, 10, "space", rect, 0); touch.release(1); touch.release(1);
  expect(calls).toEqual(["space"]); expect(touch.holdingSpace()).toBe(false);
  touch.begin(2, 20, 10, "space", rect, 1); touch.step(1.21); touch.move(2, 44, 10); touch.release(2);
  expect(calls.slice(1)).toEqual(["track:true", "caret:1", "caret:1", "track:false"]);
  expect(touch.tracking()).toBe(false);
  touch.begin(3, 20, 10, "space", rect, 2); touch.move(3, 80, 10); touch.step(2.5); touch.release(3);
  expect(calls.filter(c => c === "space")).toHaveLength(1);
});
test("backspace repeats within a frame budget, cancels off-key and stops on release", () => {
  let deleted = 0;
  const touch = createKeyboardTouch({ space() {}, backspace: () => deleted++, caret() {}, trackpad() {} });
  const rect = { x: 0, y: 0, w: 38, h: 30 };
  touch.begin(1, 10, 10, "backspace", rect, 0); expect(deleted).toBe(1);
  touch.step(.42); expect(deleted).toBe(1); touch.step(.44); expect(deleted).toBe(2);
  touch.step(10); expect(deleted).toBe(4);
  touch.move(1, 100, 10); touch.step(11); expect(deleted).toBe(4);
  touch.release(1); touch.step(12); expect(deleted).toBe(4);
});
