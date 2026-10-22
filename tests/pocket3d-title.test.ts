import { expect, test } from "bun:test";
import { FADE_IN, FADE_OUT, level, TICKS } from "../engine/pocket3d/crates/pocket3d-title/web/pocket3d-title.js";

test("the title fades in, holds, and fades out", () => {
  expect(level(FADE_IN - 1)).toBe(256);
  expect(level(TICKS - FADE_OUT - 1)).toBe(256);
  expect(level(TICKS - 1)).toBe(0);
  for (let tick = 1; tick < FADE_IN; tick++) expect(level(tick)).toBeGreaterThanOrEqual(level(tick - 1));
});
