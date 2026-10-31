import { describe, expect, test } from "bun:test";
import { gridStep, wrap } from "../apps/studio-handheld/model.ts";

describe("studio-handheld model", () => {
  test("rack movement stops at row and list edges", () => {
    expect(gridStep(0, "left", 12, 4)).toBe(0);
    expect(gridStep(0, "right", 12, 4)).toBe(1);
    expect(gridStep(3, "right", 12, 4)).toBe(3);
    expect(gridStep(1, "down", 12, 4)).toBe(5);
    expect(gridStep(1, "up", 12, 4)).toBe(1);
    expect(gridStep(1, "down", 3, 4)).toBe(2);
    expect(gridStep(2, "down", 3, 4)).toBe(2);
    expect(gridStep(0, "down", 0, 4)).toBe(0);
  });

  test("wrap fits CJK and Latin in a width", () => {
    expect(wrap("贪吃蛇游戏", 24, 12)).toEqual(["贪吃", "蛇游", "戏"]);
    expect(wrap("ab\ncd", 200, 12)).toEqual(["ab", "cd"]);
    for (const line of wrap("make a game 做一个 很好玩的 game", 60, 12)) expect(line.length).toBeGreaterThan(0);
  });
});
