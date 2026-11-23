import { describe, expect, test } from "bun:test";
import { ellipsize, wrapText } from "../../framework/src/pocketui/core/text.ts";

// every ASCII character is 6 px, every wide one 12
const measure = (text: string) => {
  let w = 0;
  for (const ch of text) w += ch.codePointAt(0)! >= 0x2e80 ? 12 : 6;
  return w;
};
const lines = (text: string, width: number, options = {}) => wrapText(text, width, measure, options).map((line) => line.text);

describe("wrapText", () => {
  test("words break at spaces and trailing spaces are not drawn", () => {
    expect(lines("the quick brown fox", 60)).toEqual(["the quick", "brown fox"]);
    expect(wrapText("the quick brown fox", 60, measure)[0]!.width).toBe(54);
  });
  test("paragraphs and empty lines are kept", () => {
    expect(lines("a\n\nb", 60)).toEqual(["a", "", "b"]);
    expect(lines("", 60)).toEqual([""]);
    expect(lines("a\n", 60)).toEqual(["a", ""]);
  });
  test("wide characters break anywhere", () => {
    expect(lines("今天天气很好我们出去", 60)).toEqual(["今天天气很", "好我们出去"]);
  });
  test("closing punctuation stays on the line it closes", () => {
    expect(lines("今天天气很。好", 60)).toEqual(["今天天气很。", "好"]);
  });
  test("mixed scripts", () => {
    expect(lines("修复 failing test 然后提交", 72)).toEqual(["修复 failing", "test 然后提", "交"]);
  });
  test("a word wider than the line is cut", () => {
    expect(lines("abcdefghijklmnop", 36)).toEqual(["abcdef", "ghijkl", "mnop"]);
    expect(lines("ab abcdefghijkl", 36)).toEqual(["ab", "abcdef", "ghijkl"]);
  });
  test("an infinite width breaks at newlines only", () => {
    expect(lines("a b c\nd", Infinity)).toEqual(["a b c", "d"]);
  });
  test("maxLines cuts with an ellipsis", () => {
    expect(lines("the quick brown fox jumps", 60, { maxLines: 2, ellipsis: "..." })).toEqual(["the quick", "brown f..."]);
    expect(lines("one\ntwo\nthree", 60, { maxLines: 2, ellipsis: "..." })).toEqual(["one", "two..."]);
    expect(lines("one two", 60, { maxLines: 2, ellipsis: "..." })).toEqual(["one two"]);
  });
  test("offsets name the source", () => {
    const out = wrapText("the quick brown fox", 60, measure);
    expect(out.map((l) => [l.start, l.end])).toEqual([[0, 9], [10, 19]]);
  });
});

describe("ellipsize", () => {
  test("fits or cuts", () => {
    expect(ellipsize("short", 60, measure)).toBe("short");
    expect(ellipsize("a long title here", 60, measure)).toBe("a long...");
  });
});
