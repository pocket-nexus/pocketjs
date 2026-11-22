import { describe, expect, test } from "bun:test";
import { clampRich, layoutRich, type Span } from "../../framework/src/pocketui/core/rich.ts";

// 6 px per ASCII character, 12 per wide one; style 1 (bold) is 7 px
const measure = (text: string, style: number) => {
  let w = 0;
  for (const ch of text) w += ch.codePointAt(0)! >= 0x2e80 ? 12 : style === 1 ? 7 : 6;
  return w;
};
const show = (spans: Span[], width: number, maxLines?: number) => layoutRich(spans, width, measure, maxLines).map((line) => line.segments.map((s) => `${s.style}:${s.text}@${s.x}`).join("|"));

describe("layoutRich", () => {
  test("one style wraps as plain text does", () => {
    expect(show([{ text: "the quick brown fox", style: 0 }], 60)).toEqual(["0:the quick@0", "0:brown fox@0"]);
  });
  test("segments carry their x", () => {
    expect(show([{ text: "a ", style: 0 }, { text: "bold", style: 1 }, { text: " word", style: 0 }], 200)).toEqual(["0:a @0|1:bold@12|0: word@40"]);
  });
  test("a change of style inside a word is not a break", () => {
    expect(show([{ text: "see un", style: 0 }, { text: "break", style: 1 }, { text: "able now", style: 0 }], 80)).toEqual(["0:see@0", "0:un@0|1:break@12|0:able@47", "0:now@0"]);
  });
  test("punctuation after a styled word stays with it", () => {
    expect(show([{ text: "press ", style: 0 }, { text: "Stop", style: 1 }, { text: ", then wait", style: 0 }], 64)).toEqual(["0:press@0", "1:Stop@0|0:, then@28", "0:wait@0"]);
  });
  test("wide characters break between any two", () => {
    expect(show([{ text: "运行", style: 0 }, { text: "测试", style: 1 }, { text: "然后提交", style: 0 }], 60)).toEqual(["0:运行@0|1:测试@24|0:然@48", "0:后提交@0"]);
  });
  test("an atomic span moves whole", () => {
    expect(show([{ text: "ask ", style: 0 }, { text: "@Fix the sync test", style: 2, atomic: true }, { text: " first", style: 0 }], 120)).toEqual(["0:ask@0", "2:@Fix the sync test@0", "0:first@0"]);
  });
  test("newlines and empty lines", () => {
    expect(show([{ text: "a\n\nb", style: 0 }], 60)).toEqual(["0:a@0", "", "0:b@0"]);
    expect(show([], 60)).toEqual([""]);
  });
  test("a unit wider than the line is cut", () => {
    expect(show([{ text: "abcdefghijkl", style: 0 }], 30)).toEqual(["0:abcde@0", "0:fghij@0", "0:kl@0"]);
  });
  test("line widths ignore trailing spaces", () => {
    const lines = layoutRich([{ text: "hello ", style: 0 }, { text: "world there", style: 1 }], 70, measure);
    expect(lines.map((l) => l.width)).toEqual([30, 35, 35]);
  });
  test("maxLines stops", () => {
    expect(show([{ text: "one two three four five", style: 0 }], 42, 2)).toEqual(["0:one two@0", "0:three@0"]);
  });
});

describe("clampRich", () => {
  const clamp = (spans: Span[], width: number, maxLines: number) => clampRich(layoutRich(spans, width, measure, maxLines + 1), maxLines, width, measure, 9).map((line) => line.segments.map((s) => `${s.style}:${s.text}@${s.x}`).join("|"));
  test("lines that fit are left alone", () => {
    expect(clamp([{ text: "the quick brown fox", style: 0 }], 60, 2)).toEqual(["0:the quick@0", "0:brown fox@0"]);
  });
  test("the last kept line ends in an ellipsis of the given style", () => {
    expect(clamp([{ text: "the quick brown fox jumps", style: 0 }], 60, 2)).toEqual(["0:the quick@0", "0:brown f@0|9:...@42"]);
  });
  test("the ellipsis takes room from the run before it, whatever its style", () => {
    expect(clamp([{ text: "运行", style: 0 }, { text: "测试然后提交代码", style: 1 }], 60, 1)).toEqual(["0:运行@0|1:测@24|9:...@36"]);
  });
  test("a wide width keeps the line and adds the ellipsis", () => {
    expect(clamp([{ text: "one\ntwo", style: 0 }], 200, 1)).toEqual(["0:one@0|9:...@18"]);
  });
});
