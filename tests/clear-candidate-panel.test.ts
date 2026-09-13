import { expect, test } from "bun:test";
import { candidateGrid, candidateSlots, createCandidatePanel } from "../apps/clear/candidate-panel.ts";
import { createScrollerWith } from "../framework/src/kinetics-core.ts";
import type { ImeState } from "../framework/src/ime.ts";

test("candidate grid wraps phrases and keeps at least 44-point row hit targets", () => {
  const cells = candidateGrid(["你", "你好", "你好吗", "这是更长的候选词"], 320);
  expect(cells.every(c => c.w >= 64 && c.x + c.w <= 320)).toBe(true);
  expect(cells.at(-1)!.y).toBe(44);
  const phrase = "这是一个需要占据多行才能完整显示的候选词";
  const lines = candidateGrid([phrase, "你"], 320);
  expect(lines.filter(c => c.index === 0).map(c => c.text).join("")).toBe(phrase);
  expect(lines.filter(c => c.index === 0).length).toBeGreaterThan(1);
  const continued = candidateGrid(["你", "你好", "你好吗", "第四个", "第五个"], 320, 0, 3);
  expect(continued.map(c => [c.index, c.x, c.y])).toEqual([[3, 0, 0], [4, 72, 0]]);
});
test("scrolling retains candidate slots and recycles only the departing row", () => {
  const cells = candidateGrid(Array.from({ length: 40 }, (_, i) => `你${i}`), 320);
  const slots = candidateSlots(Array(25).fill(null), cells.slice(0, 25));
  const next = candidateSlots(slots, cells.slice(5, 30));
  expect(next.slice(5)).toEqual(slots.slice(5));
  expect(next.slice(0, 5)).toEqual(cells.slice(25, 30));
  expect(candidateSlots(next, cells.slice(0, 25))).toEqual(slots);
  const lines = candidateGrid(["这是一个需要占据多行才能完整显示的候选词", "你"], 320);
  expect(candidateSlots(Array(3).fill(null), lines).filter(Boolean)).toEqual(lines);
});
test("candidate panel scroll does not select; tap uses absolute index; mode changes close it", () => {
  let panel: ReturnType<typeof createCandidatePanel>;
  const scroll = createScrollerWith(initial => { let value = initial; return [() => value, n => { value = n; }] as const; },
    { max: () => panel?.max() ?? 0, extent: () => 180, overscroll: 0 });
  const selected: number[] = [], reads: number[] = [];
  let complete: Parameters<Parameters<typeof createCandidatePanel>[0]["browse"]>[1];
  panel = createCandidatePanel({ width: 320, height: 180, scroller: scroll, select: index => selected.push(index),
    browse(offset, callback) { reads.push(offset); complete = callback; return 1; } });
  const state: ImeState = { preedit: "ni", raw: "ni", rawCaret: 2, caret: 2, candidates: ["你"], commit: "", page: 0, last: false,
    pending: false, connected: true, error: "", revision: 1, composing: true };
  panel.setState(state, true); panel.toggle(); panel.step();
  expect(reads).toEqual([0]);
  complete!({ offset: 0, candidates: Array.from({ length: 15 }, (_, i) => `候选${i}`), last: false });
  panel.press(0, 30, 150, 1); panel.move(0, 30, 40, 1.1); panel.release(0, false);
  expect(selected).toEqual([]); expect(scroll.offset()).toBeGreaterThan(0);
  scroll.scrollTo(44, { immediate: true }); panel.press(0, 30, 10, 2); panel.release(0, false);
  expect(selected).toEqual([4]); expect(panel.isOpen()).toBe(false);
  panel.toggle(); panel.setState({ ...state, composing: false, preedit: "", revision: 2 }, true);
  expect(panel.isOpen()).toBe(false); panel.toggle(); expect(panel.isOpen()).toBe(false);
  panel.setState(state, false); panel.toggle(); expect(panel.isOpen()).toBe(false);
});
