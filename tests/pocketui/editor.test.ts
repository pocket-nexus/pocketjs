import { describe, expect, test } from "bun:test";
import { createEditor, type Editor, type EditorLayout, type EditorOptions, type Token } from "../../framework/src/pocketui/core/editor.ts";
import { wrapText } from "../../framework/src/pocketui/core/text.ts";

const session = (name: string, id = name) => ({ kind: "session", id, label: "@" + name });
const mark = (start: number, end: number, id = "t" + start): Token => ({ start, end, kind: "session", id });

/** types one character per insert, as a keyboard does */
const type = (editor: Editor, text: string) => {
  for (const ch of text) editor.insert(ch);
};
/** presses keys the editor must handle */
const press = (editor: Editor, ...names: string[]) => {
  for (const name of names) expect(editor.key(name)).toBe(true);
};
const text = (editor: Editor) => editor.snapshot().text;
const caret = (editor: Editor) => editor.snapshot().selection.focus;
const range = (editor: Editor) => [editor.snapshot().selection.anchor, editor.snapshot().selection.focus];
const ranges = (editor: Editor) => editor.snapshot().tokens.map((token) => [token.start, token.end]);
/** an editor holding `value`, the caret at its end and no history */
const holding = (value: string, tokens: Token[] = [], options: EditorOptions = {}) => {
  const editor = createEditor(options);
  editor.setValue(value, tokens);
  return editor;
};

// every ASCII character is 6 px, every wide one 12, as in text.test.ts
const measure = (s: string) => {
  let w = 0;
  for (const ch of s) w += ch.codePointAt(0)! >= 0x2e80 ? 12 : 6;
  return w;
};
/** the layout a view would hand over: the text wrapped at `width` */
const wrapped = (editor: () => Editor, width: number) => (): EditorLayout => {
  const source = editor().snapshot().text;
  const lines = wrapText(source, width, measure);
  const xOf = (k: number, offset: number) => measure(source.slice(lines[k]!.start, Math.min(offset, lines[k]!.end)));
  return {
    lines,
    x: (offset) => {
      let k = lines.length - 1;
      while (k > 0 && lines[k]!.start > offset) k--;
      return xOf(k, offset);
    },
    offsetAt: (k, x) => {
      let best = lines[k]!.start;
      for (let o = best; o <= lines[k]!.end; o++) if (Math.abs(xOf(k, o) - x) < Math.abs(xOf(k, best) - x)) best = o;
      return best;
    },
  };
};

const FAMILY = "\u{1F468}‍\u{1F469}‍\u{1F467}"; // man, woman, girl joined by U+200D: 8 units
const THUMB = "\u{1F44D}\u{1F3FD}"; // thumbs up with a skin tone: 4 units
const CHINA = "\u{1F1E8}\u{1F1F3}";
const JAPAN = "\u{1F1EF}\u{1F1F5}";

describe("the document", () => {
  test("a new editor is empty", () => {
    const editor = createEditor();
    expect(editor.isEmpty()).toBe(true);
    expect(editor.snapshot()).toEqual({ text: "", tokens: [], selection: { anchor: 0, focus: 0 }, composition: null });
    expect(editor.value()).toEqual({ text: "", tokens: [] });
  });
  test("setValue puts the caret at the end and value() gives it back", () => {
    const editor = holding("hello @Fix the sync test now", [mark(6, 24, "s1")]);
    expect(editor.isEmpty()).toBe(false);
    expect(range(editor)).toEqual([28, 28]);
    expect(editor.value()).toEqual({ text: "hello @Fix the sync test now", tokens: [{ start: 6, end: 24, kind: "session", id: "s1" }] });
    expect(text(editor).slice(6, 24)).toBe("@Fix the sync test");
  });
  test("value() hands out copies", () => {
    const editor = holding("@Bob", [mark(0, 4)]);
    editor.value().tokens[0]!.end = 1;
    expect(ranges(editor)).toEqual([[0, 4]]);
  });
  test("setValue sorts the tokens and drops the ones that are not ranges of the text", () => {
    // a0 b1 _2 @3 x4 _5 c6 d7 _8 and a two-unit emoji at 9
    const editor = holding("ab @x cd \u{1F600}", [
      mark(3, 5, "kept"),
      mark(4, 6, "overlaps the one before"),
      mark(8, 99, "out of bounds"),
      mark(2, 2, "empty"),
      mark(5, 3, "reversed"),
      mark(0.5, 2, "fractional"),
      mark(9, 10, "half an emoji"),
      { start: 6, end: 8, kind: "session" } as unknown as Token,
      mark(0, 2, "first"),
    ]);
    expect(editor.snapshot().tokens).toEqual([
      { start: 0, end: 2, kind: "session", id: "first" },
      { start: 3, end: 5, kind: "session", id: "kept" },
    ]);
  });
  test("the snapshot is the same object until something changes", () => {
    const editor = holding("hi");
    const before = editor.snapshot();
    expect(editor.snapshot()).toBe(before);
    editor.key("ArrowRight");
    expect(editor.snapshot()).toBe(before);
    editor.key("ArrowLeft");
    expect(editor.snapshot()).not.toBe(before);
  });
});

describe("mention tokens", () => {
  test("typing @, picking a session, then Backspace removes the whole mention", () => {
    const editor = createEditor();
    type(editor, "ask @fix");
    const trigger = editor.trigger(["@"])!;
    expect(trigger).toEqual({ char: "@", start: 4, end: 8, query: "fix" });
    editor.insertToken(session("Fix the sync test", "s1"), trigger);
    expect(text(editor)).toBe("ask @Fix the sync test ");
    expect(editor.snapshot().tokens).toEqual([{ start: 4, end: 22, kind: "session", id: "s1" }]);
    expect(caret(editor)).toBe(23);
    press(editor, "Backspace"); // the space after it
    expect(text(editor)).toBe("ask @Fix the sync test");
    expect(ranges(editor)).toEqual([[4, 22]]);
    press(editor, "Backspace"); // the mention, all of it
    expect(text(editor)).toBe("ask ");
    expect(ranges(editor)).toEqual([]);
    expect(caret(editor)).toBe(4);
  });
  test("Delete right before a mention deletes all of it", () => {
    const editor = holding("a @Bob b", [mark(2, 6)]);
    editor.select(2);
    press(editor, "Delete");
    expect(text(editor)).toBe("a  b");
    expect(ranges(editor)).toEqual([]);
    expect(caret(editor)).toBe(2);
  });
  test("the arrows step over a mention as one character", () => {
    const editor = holding("a @Bob b", [mark(2, 6)]);
    editor.select(1);
    const stops: number[] = [];
    for (const name of ["ArrowRight", "ArrowRight", "ArrowRight", "ArrowLeft", "ArrowLeft", "ArrowLeft"]) {
      press(editor, name);
      stops.push(caret(editor));
    }
    expect(stops).toEqual([2, 6, 7, 6, 2, 1]);
    editor.select(2);
    press(editor, "Shift+ArrowRight");
    expect(editor.selectedText()).toBe("@Bob");
  });
  test("text typed at a mention's edge is not part of it", () => {
    const editor = holding("a @Bob b", [mark(2, 6)]);
    editor.select(2);
    editor.insert("x");
    expect(text(editor)).toBe("a x@Bob b");
    expect(ranges(editor)).toEqual([[3, 7]]);
    editor.select(7);
    editor.insert("y");
    expect(text(editor)).toBe("a x@Boby b");
    expect(ranges(editor)).toEqual([[3, 7]]);
  });
  test("an edit before a mention shifts it and one after leaves it", () => {
    const editor = holding("a @Bob b @Cy", [mark(2, 6), mark(9, 12)]);
    editor.select(0);
    editor.insert("xx");
    expect(ranges(editor)).toEqual([[4, 8], [11, 14]]);
    editor.select(10);
    press(editor, "Backspace"); // the "b" between them
    expect(text(editor)).toBe("xxa @Bob  @Cy");
    expect(ranges(editor)).toEqual([[4, 8], [10, 13]]);
    editor.select(13);
    editor.insert("!");
    expect(ranges(editor)).toEqual([[4, 8], [10, 13]]);
  });
  test("the caret never rests inside a mention: it snaps to the nearer edge", () => {
    const editor = holding("a @Bob b", [mark(2, 6)]);
    editor.select(3);
    expect(range(editor)).toEqual([2, 2]);
    editor.select(5);
    expect(range(editor)).toEqual([6, 6]);
    editor.select(4); // the middle goes to the end, where typing continues
    expect(range(editor)).toEqual([6, 6]);
  });
  test("typing over a selection that partly covers a mention removes the whole mention", () => {
    const editor = holding("a @Bob b", [mark(2, 6)]);
    editor.select(1, 5);
    expect(range(editor)).toEqual([1, 6]);
    editor.insert("x");
    expect(text(editor)).toBe("ax b");
    expect(ranges(editor)).toEqual([]);
  });
  test("a selection that covers less than half of a mention leaves it whole", () => {
    const editor = holding("a @Bob b", [mark(2, 6)]);
    editor.select(0, 3);
    editor.insert("x");
    expect(text(editor)).toBe("x@Bob b");
    expect(ranges(editor)).toEqual([[1, 5]]);
  });
  test("a replaced range that cuts into a mention takes all of it", () => {
    const editor = holding("a @Bob b", [mark(2, 6)]);
    editor.insertToken(session("Al", "al"), { start: 1, end: 3 });
    expect(text(editor)).toBe("a@Al  b");
    expect(editor.snapshot().tokens).toEqual([{ start: 1, end: 4, kind: "session", id: "al" }]);
    expect(caret(editor)).toBe(5);
  });
  test("a mention at offset 0", () => {
    const editor = holding("@Bob hi", [mark(0, 4)]);
    editor.select(4);
    press(editor, "ArrowLeft");
    expect(caret(editor)).toBe(0);
    editor.insert("x");
    expect(text(editor)).toBe("x@Bob hi");
    expect(ranges(editor)).toEqual([[1, 5]]);
    press(editor, "Delete");
    expect(text(editor)).toBe("x hi");
    expect(ranges(editor)).toEqual([]);

    const other = holding("@Bob hi", [mark(0, 4)]);
    other.select(4);
    press(other, "Backspace");
    expect(text(other)).toBe(" hi");
    expect(caret(other)).toBe(0);
  });
  test("a mention at the end", () => {
    const editor = holding("hi @Bob", [mark(3, 7)]);
    editor.select(99);
    expect(caret(editor)).toBe(7);
    editor.insert("!");
    expect(ranges(editor)).toEqual([[3, 7]]);
    press(editor, "Backspace", "ArrowLeft");
    expect(caret(editor)).toBe(3);
    press(editor, "ArrowRight", "Backspace");
    expect(text(editor)).toBe("hi ");
    expect(ranges(editor)).toEqual([]);
  });
  test("two mentions side by side are two steps", () => {
    const editor = holding("@A@B", [mark(0, 2), mark(2, 4)]);
    press(editor, "ArrowLeft");
    expect(caret(editor)).toBe(2);
    press(editor, "ArrowRight", "Backspace");
    expect(text(editor)).toBe("@A");
    expect(ranges(editor)).toEqual([[0, 2]]);
  });
  test("a mark typed against a mention is stepped over and deleted without the mention", () => {
    // an accent right after the mention would join its last letter
    const after = holding("@Bob\u0301", [mark(0, 4)]);
    press(after, "ArrowLeft");
    expect(caret(after)).toBe(4);
    press(after, "ArrowRight", "Backspace");
    expect(after.value()).toEqual({ text: "@Bob", tokens: [mark(0, 4)] });
    // a joiner right before it would take its first letter
    const before = holding("e\u200D@Bob", [mark(2, 6)]);
    before.select(0);
    press(before, "ArrowRight");
    expect(caret(before)).toBe(2);
    press(before, "ArrowLeft", "Delete");
    expect(before.value()).toEqual({ text: "@Bob", tokens: [mark(0, 4, "t2")] });
    press(before, "Control+ArrowRight");
    expect(caret(before)).toBe(4);
  });
  test("insertToken at the caret, and over a selection", () => {
    const editor = createEditor();
    editor.insertToken(session("Bob"));
    expect(text(editor)).toBe("@Bob ");
    expect(ranges(editor)).toEqual([[0, 4]]);
    expect(caret(editor)).toBe(5);
    editor.insert("hello");
    editor.select(5, 10);
    editor.insertToken(session("Cy"));
    expect(text(editor)).toBe("@Bob @Cy ");
    expect(ranges(editor)).toEqual([[0, 4], [5, 8]]);
  });
});

describe("characters", () => {
  test("a surrogate pair is one step and one deletion", () => {
    const editor = holding("a\u{1F600}b");
    press(editor, "ArrowLeft", "ArrowLeft");
    expect(caret(editor)).toBe(1);
    press(editor, "ArrowRight");
    expect(caret(editor)).toBe(3);
    press(editor, "Backspace");
    expect(text(editor)).toBe("ab");
  });
  test("select never lands between the halves of a pair", () => {
    const editor = holding("a\u{1F600}b");
    editor.select(2);
    expect(range(editor)).toEqual([1, 1]);
    editor.select(0, 2);
    expect(editor.selectedText()).toBe("a");
  });
  test("a letter and its combining accent", () => {
    const editor = holding("éx");
    editor.select(0);
    press(editor, "ArrowRight");
    expect(caret(editor)).toBe(2);
    press(editor, "Backspace");
    expect(text(editor)).toBe("x");
  });
  test("a heart with its variation selector, and a keycap", () => {
    const editor = holding("❤️1️⃣");
    press(editor, "ArrowLeft");
    expect(caret(editor)).toBe(2);
    press(editor, "ArrowLeft");
    expect(caret(editor)).toBe(0);
    press(editor, "Delete");
    expect(text(editor)).toBe("1️⃣");
  });
  test("a family joined by U+200D is one character", () => {
    const editor = holding("a" + FAMILY + "b");
    press(editor, "ArrowLeft", "ArrowLeft");
    expect(caret(editor)).toBe(1);
    press(editor, "Shift+ArrowRight");
    expect(editor.selectedText()).toBe(FAMILY);
    press(editor, "ArrowRight", "Backspace");
    expect(text(editor)).toBe("ab");
  });
  test("an emoji and its skin tone", () => {
    const editor = holding(THUMB + THUMB);
    press(editor, "Backspace");
    expect(text(editor)).toBe(THUMB);
    press(editor, "ArrowLeft");
    expect(caret(editor)).toBe(0);
  });
  test("flags are pairs of regional indicators", () => {
    const editor = holding(CHINA + JAPAN);
    press(editor, "ArrowLeft");
    expect(caret(editor)).toBe(4);
    press(editor, "ArrowLeft");
    expect(caret(editor)).toBe(0);
    press(editor, "ArrowRight");
    expect(caret(editor)).toBe(4);
    press(editor, "Delete");
    expect(text(editor)).toBe(CHINA);
    // an odd one out is alone, and the pairs before it still pair
    const odd = holding(CHINA + JAPAN.slice(0, 2));
    press(odd, "ArrowLeft");
    expect(caret(odd)).toBe(4);
    press(odd, "ArrowLeft");
    expect(caret(odd)).toBe(0);
  });
  test("a newline is never joined to what is around it", () => {
    const editor = holding("a\ńb");
    editor.select(2);
    press(editor, "Backspace");
    expect(text(editor)).toBe("áb");
  });
});

describe("words", () => {
  // 修0 复1 _2 failing 3..9 _10 test 11..14 _15 然16 后17 提18 交19
  const mixed = "修复 failing test 然后提交";
  test("mixed han and Latin: a Latin word is a run, a han character is a word", () => {
    const editor = holding(mixed);
    editor.select(0);
    const forward: number[] = [];
    for (let i = 0; i < 8; i++) {
      press(editor, i % 2 ? "Control+ArrowRight" : "Alt+ArrowRight");
      forward.push(caret(editor));
    }
    expect(forward).toEqual([1, 2, 10, 15, 17, 18, 19, 20]);
    const back: number[] = [];
    for (let i = 0; i < 8; i++) {
      press(editor, i % 2 ? "Control+ArrowLeft" : "Alt+ArrowLeft");
      back.push(caret(editor));
    }
    expect(back).toEqual([19, 18, 17, 16, 11, 3, 1, 0]);
  });
  test("letters, digits and underscore run together; punctuation is its own run", () => {
    const editor = holding("foo_bar2 baz.qux");
    editor.select(0);
    const stops: number[] = [];
    for (let i = 0; i < 4; i++) {
      press(editor, "Alt+ArrowRight");
      stops.push(caret(editor));
    }
    expect(stops).toEqual([8, 12, 13, 16]);
  });
  test("accented and Cyrillic letters are letters", () => {
    const editor = holding("café привет");
    press(editor, "Alt+ArrowLeft");
    expect(caret(editor)).toBe(5);
    press(editor, "Alt+ArrowLeft");
    expect(caret(editor)).toBe(0);
  });
  test("other scripts: hangul and fullwidth letters run, kana and rare han stand alone, symbols run", () => {
    const stops = (value: string) => {
      const editor = holding(value);
      const out: number[] = [];
      while (caret(editor) > 0) {
        press(editor, "Alt+ArrowLeft");
        out.push(caret(editor));
      }
      return out;
    };
    expect(stops("안녕 하세요")).toEqual([3, 0]);
    expect(stops("ＡＢＣ\u3000ｄｅｆ")).toEqual([4, 0]);
    expect(stops("ｶﾅ")).toEqual([1, 0]);
    expect(stops("\u{20000}\u{20001}")).toEqual([2, 0]);
    expect(stops("ok \u{1F600}\u{1F600}")).toEqual([3, 0]);
    expect(stops("\uE0A0\uE0A1x")).toEqual([2, 0]);
    expect(stops("a\u00D7b")).toEqual([2, 1, 0]);
  });
  test("a mention is a word", () => {
    const editor = holding("go @Fix the sync now", [mark(3, 15)]);
    editor.select(0);
    press(editor, "Alt+ArrowRight", "Alt+ArrowRight");
    expect(caret(editor)).toBe(15);
    press(editor, "Alt+ArrowLeft");
    expect(caret(editor)).toBe(3);
  });
  test("Shift with a word motion extends the selection", () => {
    const editor = holding("hello brave world");
    press(editor, "Alt+Shift+ArrowLeft", "Control+Shift+ArrowLeft");
    expect(range(editor)).toEqual([17, 6]);
    expect(editor.selectedText()).toBe("brave world");
  });
  test("word deletion, backwards and forwards", () => {
    const editor = holding("hello brave world");
    press(editor, "Control+Backspace");
    expect(text(editor)).toBe("hello brave ");
    press(editor, "Alt+Backspace");
    expect(text(editor)).toBe("hello ");
    editor.select(0);
    press(editor, "Control+Delete");
    expect(text(editor)).toBe(" ");
  });
  test("word deletion takes one han character, or a whole mention", () => {
    const han = holding("你好世界");
    press(han, "Control+Backspace");
    expect(text(han)).toBe("你好世");
    const mention = holding("a @Bob ", [mark(2, 6)]);
    press(mention, "Control+Backspace");
    expect(text(mention)).toBe("a ");
    expect(ranges(mention)).toEqual([]);
  });
});

describe("lines", () => {
  // abc 0..2, \n 3, defgh 4..8, \n 9, ij 10..11
  const three = "abc\ndefgh\nij";
  test("Home and End go to the line's edges, with Control to the document's", () => {
    const editor = holding(three);
    editor.select(6);
    press(editor, "Home");
    expect(caret(editor)).toBe(4);
    press(editor, "End");
    expect(caret(editor)).toBe(9);
    press(editor, "Control+Home");
    expect(caret(editor)).toBe(0);
    press(editor, "Control+End");
    expect(caret(editor)).toBe(12);
    editor.select(6);
    press(editor, "Shift+Home");
    expect(range(editor)).toEqual([6, 4]);
    press(editor, "Control+Shift+End");
    expect(range(editor)).toEqual([6, 12]);
  });
  test("ArrowUp and ArrowDown keep the column across a shorter line", () => {
    const editor = holding(three);
    editor.select(8);
    press(editor, "ArrowUp");
    expect(caret(editor)).toBe(3);
    press(editor, "ArrowDown");
    expect(caret(editor)).toBe(8);
    press(editor, "ArrowDown");
    expect(caret(editor)).toBe(12);
    press(editor, "ArrowUp");
    expect(caret(editor)).toBe(8);
  });
  test("ArrowUp on the first line goes to 0, ArrowDown on the last to the end", () => {
    const editor = holding(three);
    editor.select(2);
    press(editor, "ArrowUp");
    expect(caret(editor)).toBe(0);
    editor.select(10);
    press(editor, "ArrowDown");
    expect(caret(editor)).toBe(12);
    // the column survives the trip to the edge
    editor.select(6);
    press(editor, "ArrowUp", "ArrowUp", "ArrowDown");
    expect(caret(editor)).toBe(6);
  });
  test("a sideways move forgets the column", () => {
    const editor = holding(three);
    editor.select(8);
    press(editor, "ArrowUp", "ArrowLeft", "ArrowDown");
    expect(caret(editor)).toBe(6);
  });
  test("Shift with a vertical move extends the selection", () => {
    const editor = holding(three);
    editor.select(1);
    press(editor, "Shift+ArrowDown");
    expect(range(editor)).toEqual([1, 5]);
    expect(editor.selectedText()).toBe("bc\nd");
  });

  describe("wrapped by a layout", () => {
    // "the quick" 0..9, "brown fox" 10..19, "jumps" 20..25: the spaces at 9 and 19 are not drawn
    const wrappedEditor = (value: string, tokens: Token[] = []) => {
      const editor: Editor = createEditor({ layout: wrapped(() => editor, 60) });
      editor.setValue(value, tokens);
      return editor;
    };
    test("vertical moves follow the drawn lines and keep the x", () => {
      const editor = wrappedEditor("the quick brown fox jumps");
      editor.select(14); // "brow|n"
      press(editor, "ArrowUp");
      expect(caret(editor)).toBe(4);
      press(editor, "ArrowDown");
      expect(caret(editor)).toBe(14);
      press(editor, "ArrowDown");
      expect(caret(editor)).toBe(24);
      press(editor, "ArrowDown");
      expect(caret(editor)).toBe(25);
      press(editor, "ArrowUp");
      expect(caret(editor)).toBe(14);
    });
    test("x is in the layout's units, not characters", () => {
      // 今天 0..1 on the first line with "ab" after: 今天ab / cdefgh
      const editor = wrappedEditor("今天ab\ncdefgh");
      editor.select(2); // after 天: x = 24
      press(editor, "ArrowDown");
      expect(caret(editor)).toBe(9); // "cdef|gh"
    });
    test("Home and End go to the drawn line's edges", () => {
      const editor = wrappedEditor("the quick brown fox jumps");
      editor.select(14);
      press(editor, "Home");
      expect(caret(editor)).toBe(10);
      press(editor, "End");
      expect(caret(editor)).toBe(19);
      editor.select(4);
      press(editor, "Shift+End");
      expect(range(editor)).toEqual([4, 9]);
      press(editor, "Home");
      expect(caret(editor)).toBe(0);
    });
    test("where a line ends at the offset the next one starts at, that offset is the next line's", () => {
      // 今天天气很 0..5, 好我们出去 5..10
      const editor = wrappedEditor("今天天气很好我们出去");
      editor.select(2);
      press(editor, "End");
      expect(caret(editor)).toBe(4);
      press(editor, "End");
      expect(caret(editor)).toBe(4);
      editor.select(2);
      press(editor, "ArrowDown");
      expect(caret(editor)).toBe(7);
      press(editor, "Home");
      expect(caret(editor)).toBe(5);
      press(editor, "ArrowUp");
      expect(caret(editor)).toBe(0);
      // from the far right of the second line, up stays on the first line
      editor.select(10);
      press(editor, "ArrowUp");
      expect(caret(editor)).toBe(4);
      press(editor, "ArrowDown");
      expect(caret(editor)).toBe(10);
    });
    test("a mention wrapped over three lines never traps the caret", () => {
      // "say @Fix" 0..8, "the sync" 9..17, "test ok" 18..25; the mention is 4..22
      const editor = wrappedEditor("say @Fix the sync test ok", [mark(4, 22)]);
      const up: number[] = [];
      for (let i = 0; i < 3; i++) {
        press(editor, "ArrowUp");
        up.push(caret(editor));
      }
      expect(up).toEqual([22, 4, 0]);
      editor.select(4);
      const down: number[] = [];
      for (let i = 0; i < 2; i++) {
        press(editor, "ArrowDown");
        down.push(caret(editor));
      }
      expect(down).toEqual([22, 25]);
    });
  });
});

describe("selection", () => {
  test("Shift with an arrow extends, an arrow alone collapses to that edge", () => {
    const editor = holding("hello");
    press(editor, "Shift+ArrowLeft", "Shift+ArrowLeft");
    expect(range(editor)).toEqual([5, 3]);
    expect(editor.selectedText()).toBe("lo");
    press(editor, "ArrowLeft");
    expect(range(editor)).toEqual([3, 3]);
    editor.select(4, 1); // selected backwards
    press(editor, "ArrowRight");
    expect(range(editor)).toEqual([4, 4]);
    editor.select(1, 4);
    press(editor, "ArrowLeft");
    expect(range(editor)).toEqual([1, 1]);
  });
  test("Control+a and selectAll select everything; typing replaces it", () => {
    const editor = holding("hello");
    press(editor, "Control+a");
    expect(range(editor)).toEqual([0, 5]);
    expect(editor.selectedText()).toBe("hello");
    editor.insert("x");
    expect(text(editor)).toBe("x");
    editor.selectAll();
    expect(range(editor)).toEqual([0, 1]);
  });
  test("select clamps, and one argument is a caret", () => {
    const editor = holding("hello");
    editor.select(-5, 99);
    expect(range(editor)).toEqual([0, 5]);
    editor.select(2);
    expect(range(editor)).toEqual([2, 2]);
    expect(editor.selectedText()).toBe("");
    editor.select(Number.NaN, 2.7);
    expect(range(editor)).toEqual([0, 2]);
  });
  test("Backspace and Delete with a selection delete just the selection", () => {
    const editor = holding("hello world");
    editor.select(5, 11);
    press(editor, "Backspace");
    expect(text(editor)).toBe("hello");
    editor.select(0, 1);
    press(editor, "Control+Delete");
    expect(text(editor)).toBe("ello");
  });
});

describe("keys", () => {
  test("Enter is a newline, unless it submits", () => {
    const editor = holding("a");
    expect(editor.key("Enter")).toBe(true);
    expect(text(editor)).toBe("a\n");
    expect(editor.key("Enter", { enterSubmits: true })).toBe(false);
    expect(text(editor)).toBe("a\n");
    expect(editor.key("Shift+Enter", { enterSubmits: true })).toBe(true);
    expect(editor.key("Alt+Enter", { enterSubmits: true })).toBe(true);
    expect(text(editor)).toBe("a\n\n\n");
    expect(editor.key("Control+Enter")).toBe(false);
  });
  test("a single-line editor never takes Enter", () => {
    const editor = holding("a", [], { singleLine: true });
    expect(editor.key("Enter")).toBe(false);
    expect(editor.key("Shift+Enter")).toBe(false);
    expect(editor.key("Alt+Enter")).toBe(false);
    expect(text(editor)).toBe("a");
  });
  test("keys that are not editing keys are left to the caller", () => {
    const editor = holding("hello");
    for (const name of ["Tab", "Shift+Tab", "Escape", "PageUp", "PageDown", "F5", "a", "Control+c", "Meta+a", "Meta+ArrowLeft", "Control+Alt+z", "Alt+Home"]) {
      expect(editor.key(name)).toBe(false);
    }
    expect(editor.snapshot()).toEqual({ text: "hello", tokens: [], selection: { anchor: 5, focus: 5 }, composition: null });
  });
  test("an editing key with nothing to do is still handled", () => {
    const editor = createEditor();
    for (const name of ["Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Control+z", "Control+y", "Control+a"]) {
      expect(editor.key(name)).toBe(true);
    }
    expect(text(editor)).toBe("");
  });
  test("Control+z undoes, Control+Shift+z and Control+y redo", () => {
    const editor = createEditor();
    type(editor, "one");
    press(editor, "Control+z");
    expect(text(editor)).toBe("");
    press(editor, "Control+Shift+z");
    expect(text(editor)).toBe("one");
    press(editor, "Control+z", "Control+y");
    expect(text(editor)).toBe("one");
    press(editor, "Control+z", "Control+Shift+Z"); // Shift may give the capital
    expect(text(editor)).toBe("one");
  });
});

describe("composition", () => {
  /** 我说, then pinyin for 你好 as an IME sends it */
  const composing = () => {
    const editor = createEditor();
    type(editor, "我说");
    editor.compose("n", 1, 1);
    editor.compose("ni", 2, 2);
    editor.compose("ni hao", 6, 6);
    return editor;
  };
  test("the preedit is in the text, with the caret inside it, and not in the value", () => {
    const editor = createEditor();
    type(editor, "我说");
    editor.compose("n", 1, 1);
    expect(editor.snapshot()).toEqual({ text: "我说n", tokens: [], selection: { anchor: 3, focus: 3 }, composition: { start: 2, end: 3, caret: 3 } });
    editor.compose("ni hao", 6, 6);
    expect(editor.snapshot()).toEqual({ text: "我说ni hao", tokens: [], selection: { anchor: 8, focus: 8 }, composition: { start: 2, end: 8, caret: 8 } });
    expect(editor.value()).toEqual({ text: "我说", tokens: [] });
  });
  test("pinyin ending by commit then end, and by end then commit, give the same document", () => {
    const first = composing();
    first.insert("你好");
    first.endComposition();
    const second = composing();
    second.endComposition();
    expect(text(second)).toBe("我说");
    second.insert("你好");
    expect(first.snapshot()).toEqual({ text: "我说你好", tokens: [], selection: { anchor: 4, focus: 4 }, composition: null });
    expect(second.snapshot()).toEqual(first.snapshot());
    expect(second.value()).toEqual(first.value());
  });
  test("a later preedit replaces the earlier one", () => {
    const editor = createEditor();
    editor.compose("ni", 2, 2);
    editor.compose("你", 1, 1);
    expect(editor.snapshot()).toEqual({ text: "你", tokens: [], selection: { anchor: 1, focus: 1 }, composition: { start: 0, end: 1, caret: 1 } });
    expect(editor.isEmpty()).toBe(true);
  });
  test("the IME's caret and selection inside the preedit are kept", () => {
    const editor = holding("ab");
    editor.select(1);
    editor.compose("nihao", 2, 2);
    expect(editor.snapshot().selection).toEqual({ anchor: 3, focus: 3 });
    expect(editor.snapshot().composition).toEqual({ start: 1, end: 6, caret: 3 });
    editor.compose("nihao", 1, 3);
    expect(editor.snapshot().selection).toEqual({ anchor: 2, focus: 4 });
    expect(editor.snapshot().composition).toEqual({ start: 1, end: 6, caret: 4 });
    editor.compose("nihao", -1, 99);
    expect(editor.snapshot().selection).toEqual({ anchor: 1, focus: 6 });
  });
  test("composing over a selection replaces it, and both endings agree", () => {
    const start = () => {
      const editor = holding("hello world");
      editor.select(6, 11);
      editor.compose("shi", 3, 3);
      editor.compose("shi jie", 7, 7);
      return editor;
    };
    const first = start();
    expect(text(first)).toBe("hello shi jie");
    expect(first.value().text).toBe("hello world");
    first.insert("世界");
    first.endComposition();
    const second = start();
    second.endComposition();
    second.insert("世界");
    expect(text(first)).toBe("hello 世界");
    expect(second.snapshot()).toEqual(first.snapshot());
  });
  test("ending a composition alone puts the text and the selection back", () => {
    const editor = holding("hello world");
    editor.select(6, 11);
    editor.compose("shi", 3, 3);
    editor.endComposition();
    expect(editor.snapshot()).toEqual({ text: "hello world", tokens: [], selection: { anchor: 6, focus: 11 }, composition: null });
    editor.endComposition(); // nothing left to end
    expect(text(editor)).toBe("hello world");
  });
  test("an empty preedit ends the composition", () => {
    const editor = holding("ab");
    editor.compose("ni", 2, 2);
    editor.compose("", 0, 0);
    expect(editor.snapshot()).toEqual({ text: "ab", tokens: [], selection: { anchor: 2, focus: 2 }, composition: null });
  });
  test("mentions after the preedit shift in the snapshot and not in the value", () => {
    const editor = holding("ab @Bob", [mark(3, 7)]);
    editor.select(0);
    editor.compose("ni", 2, 2);
    expect(text(editor)).toBe("niab @Bob");
    expect(ranges(editor)).toEqual([[5, 9]]);
    expect(editor.value()).toEqual({ text: "ab @Bob", tokens: [mark(3, 7)] });
    editor.insert("你");
    expect(ranges(editor)).toEqual([[4, 8]]);
  });
  test("composing over a selected mention hides it until the composition is decided", () => {
    const editor = holding("a @Bob b", [mark(2, 6)]);
    editor.select(2, 6);
    editor.compose("x", 1, 1);
    expect(text(editor)).toBe("a x b");
    expect(ranges(editor)).toEqual([]);
    expect(editor.value().tokens).toEqual([mark(2, 6)]);
    editor.endComposition();
    expect(text(editor)).toBe("a @Bob b");
    expect(ranges(editor)).toEqual([[2, 6]]);
  });
  test("the IME owns the keys: only Escape is handled, and it cancels", () => {
    const editor = composing();
    for (const name of ["Backspace", "Delete", "ArrowLeft", "ArrowUp", "Enter", "Home", "Control+z", "Control+a", "Tab", "Shift+Escape"]) {
      expect(editor.key(name)).toBe(false);
    }
    expect(text(editor)).toBe("我说ni hao");
    expect(editor.key("Escape")).toBe(true);
    expect(editor.snapshot()).toEqual({ text: "我说", tokens: [], selection: { anchor: 2, focus: 2 }, composition: null });
    expect(editor.key("Escape")).toBe(false);
  });
  test("no trigger while composing", () => {
    const editor = createEditor();
    type(editor, "@");
    editor.compose("ni", 2, 2);
    expect(editor.trigger(["@"])).toBeNull();
    editor.endComposition();
    expect(editor.trigger(["@"])).toEqual({ char: "@", start: 0, end: 1, query: "" });
  });
  test("preedit changes are not undo steps; the commit is one", () => {
    const cancelled = createEditor();
    type(cancelled, "a");
    cancelled.compose("ni", 2, 2);
    cancelled.compose("你", 1, 1);
    cancelled.endComposition();
    expect(cancelled.undo()).toBe(true);
    expect(text(cancelled)).toBe("");
    expect(cancelled.undo()).toBe(false);

    const committed = createEditor();
    type(committed, "a");
    committed.compose("ni", 2, 2);
    committed.insert("你");
    committed.endComposition();
    expect(committed.undo()).toBe(true);
    expect(text(committed)).toBe("a");
    expect(committed.undo()).toBe(true);
    expect(text(committed)).toBe("");
    expect(committed.undo()).toBe(false);
    expect(committed.redo()).toBe(true);
    expect(committed.redo()).toBe(true);
    expect(text(committed)).toBe("a你");
  });
  test("an IME that commits part and keeps composing the rest", () => {
    const editor = createEditor();
    editor.compose("nihao", 5, 5);
    editor.insert("你");
    editor.compose("hao", 3, 3);
    expect(editor.snapshot()).toEqual({ text: "你hao", tokens: [], selection: { anchor: 4, focus: 4 }, composition: { start: 1, end: 4, caret: 4 } });
    editor.insert("好");
    editor.endComposition();
    expect(editor.value().text).toBe("你好");
  });
  test("undo, select and insertToken during a composition drop the preedit first", () => {
    const editor = holding("hello");
    editor.select(2);
    editor.compose("ni", 2, 2);
    expect(text(editor)).toBe("henillo");
    editor.select(6); // an offset in the text as drawn, preedit included
    expect(editor.snapshot()).toEqual({ text: "hello", tokens: [], selection: { anchor: 4, focus: 4 }, composition: null });
    editor.compose("ni", 2, 2);
    editor.insertToken(session("Bob"));
    expect(text(editor)).toBe("hell@Bob o");
    editor.compose("ni", 2, 2);
    expect(editor.undo()).toBe(true);
    expect(editor.snapshot()).toEqual({ text: "hello", tokens: [], selection: { anchor: 4, focus: 4 }, composition: null });
  });
});

describe("undo", () => {
  test("a run of typing is one step", () => {
    const editor = createEditor();
    type(editor, "hello");
    expect(editor.undo()).toBe(true);
    expect(text(editor)).toBe("");
    expect(editor.undo()).toBe(false);
    expect(editor.redo()).toBe(true);
    expect(text(editor)).toBe("hello");
    expect(editor.redo()).toBe(false);
  });
  test("a space starts the next step, and several spaces are one boundary", () => {
    const editor = createEditor();
    type(editor, "hello brave   world");
    const steps: string[] = [];
    while (editor.undo()) steps.push(text(editor));
    expect(steps).toEqual(["hello brave", "hello", ""]);
    while (editor.redo());
    expect(text(editor)).toBe("hello brave   world");
  });
  test("a newline starts the next step", () => {
    const editor = createEditor();
    type(editor, "ab");
    press(editor, "Enter", "Enter");
    type(editor, "cd");
    const steps: string[] = [];
    while (editor.undo()) steps.push(text(editor));
    expect(steps).toEqual(["ab\n", "ab", ""]);
  });
  test("moving the caret ends the run", () => {
    const editor = createEditor();
    type(editor, "ab");
    press(editor, "ArrowLeft", "ArrowRight");
    type(editor, "cd");
    editor.select(4);
    type(editor, "ef");
    const steps: string[] = [];
    while (editor.undo()) steps.push(text(editor));
    expect(steps).toEqual(["abcd", "ab", ""]);
  });
  test("a run of deletions in one direction is one step", () => {
    const editor = holding("hello");
    editor.select(3);
    press(editor, "Backspace", "Backspace", "Delete", "Delete");
    expect(text(editor)).toBe("h");
    expect(editor.undo()).toBe(true);
    expect(text(editor)).toBe("hlo");
    expect(caret(editor)).toBe(1);
    expect(editor.undo()).toBe(true);
    expect(text(editor)).toBe("hello");
    expect(caret(editor)).toBe(3);
    expect(editor.undo()).toBe(false);
  });
  test("a paste, a mention and the typing around them are separate steps", () => {
    const editor = createEditor();
    type(editor, "ab");
    editor.insert(" pasted text");
    type(editor, "c");
    editor.insertToken(session("Bob"));
    const steps: string[] = [];
    while (editor.undo()) steps.push(text(editor));
    expect(steps).toEqual(["ab pasted textc", "ab pasted text", "ab", ""]);
    while (editor.redo());
    expect(editor.value()).toEqual({ text: "ab pasted textc@Bob ", tokens: [{ start: 15, end: 19, kind: "session", id: "Bob" }] });
  });
  test("undo restores the selection as it was before the step", () => {
    const editor = holding("hello world");
    editor.select(0, 5);
    editor.insert("X");
    expect(text(editor)).toBe("X world");
    editor.undo();
    expect(editor.snapshot()).toEqual({ text: "hello world", tokens: [], selection: { anchor: 0, focus: 5 }, composition: null });
    editor.redo();
    expect(editor.snapshot()).toEqual({ text: "X world", tokens: [], selection: { anchor: 1, focus: 1 }, composition: null });
  });
  test("undoing the deletion of a mention brings the mention back", () => {
    const editor = holding("a @Bob", [mark(2, 6)]);
    press(editor, "Backspace");
    expect(ranges(editor)).toEqual([]);
    editor.undo();
    expect(editor.value()).toEqual({ text: "a @Bob", tokens: [mark(2, 6)] });
  });
  test("a new edit clears redo", () => {
    const editor = createEditor();
    type(editor, "ab");
    editor.undo();
    type(editor, "c");
    expect(editor.redo()).toBe(false);
    expect(text(editor)).toBe("c");
  });
  test("history keeps the last 100 steps", () => {
    const editor = createEditor();
    for (let i = 0; i < 150; i++) editor.insert("ab");
    let undone = 0;
    while (editor.undo()) undone++;
    expect(undone).toBe(100);
    expect(text(editor).length).toBe(100);
  });
  test("setValue clears history and ends the run", () => {
    const editor = createEditor();
    type(editor, "a");
    editor.setValue("b");
    expect(editor.undo()).toBe(false);
    type(editor, "cd");
    expect(editor.undo()).toBe(true);
    expect(text(editor)).toBe("b");
    expect(editor.undo()).toBe(false);
  });
});

describe("limits", () => {
  test("maxLength truncates what is inserted", () => {
    const editor = createEditor({ maxLength: 5 });
    editor.insert("hello world");
    expect(text(editor)).toBe("hello");
    type(editor, "!!");
    expect(text(editor)).toBe("hello");
    editor.select(0, 5);
    editor.insert("abcdefg"); // the selection it replaces makes room
    expect(text(editor)).toBe("abcde");
  });
  test("a truncated insert never ends on half a surrogate pair", () => {
    const editor = createEditor({ maxLength: 3 });
    editor.insert("ab\u{1F600}");
    expect(text(editor)).toBe("ab");
    editor.insert("c\u{1F600}");
    expect(text(editor)).toBe("abc");
  });
  test("maxLength counts the value, not the preedit, and truncates the commit", () => {
    const editor = createEditor({ maxLength: 3 });
    type(editor, "ab");
    editor.compose("nihao", 5, 5);
    expect(text(editor)).toBe("abnihao");
    expect(editor.value().text).toBe("ab");
    editor.insert("你好");
    editor.endComposition();
    expect(text(editor)).toBe("ab你");
  });
  test("setValue is cut to maxLength and a mention that no longer fits is dropped", () => {
    const editor = createEditor({ maxLength: 6 });
    editor.setValue("@A hi @Bob", [mark(0, 2), mark(6, 10)]);
    expect(editor.value()).toEqual({ text: "@A hi ", tokens: [mark(0, 2)] });
  });
  test("a mention is inserted whole or not at all", () => {
    const editor = createEditor({ maxLength: 6 });
    type(editor, "abc");
    editor.insertToken(session("Bob"));
    expect(text(editor)).toBe("abc");
    press(editor, "Backspace");
    editor.insertToken(session("Bob")); // room for the label, not for the space
    expect(text(editor)).toBe("ab@Bob");
    expect(ranges(editor)).toEqual([[2, 6]]);
    expect(caret(editor)).toBe(6);
  });
  test("a single-line editor turns newlines into spaces", () => {
    const editor = createEditor({ singleLine: true });
    editor.insert("a\nb\r\nc");
    expect(text(editor)).toBe("a b c");
    editor.setValue("x\ny");
    expect(text(editor)).toBe("x y");
    editor.compose("n\ni", 3, 3);
    expect(text(editor)).toBe("x yn i");
  });
  test("a multi-line editor keeps newlines, with \\r\\n as one", () => {
    const editor = createEditor();
    editor.insert("a\r\nb\rc");
    expect(text(editor)).toBe("a\nb\nc");
  });
});

describe("onChange", () => {
  test("fires once per call that changed something, saying what", () => {
    const calls: { text: boolean; selection: boolean }[] = [];
    const editor: Editor = createEditor({
      onChange: (snapshot, change) => {
        expect(snapshot).toBe(editor.snapshot()); // the state is already consistent
        calls.push(change);
      },
    });
    const next = () => calls.splice(0);
    editor.insert("hi");
    expect(next()).toEqual([{ text: true, selection: true }]);
    editor.key("ArrowLeft");
    expect(next()).toEqual([{ text: false, selection: true }]);
    editor.key("Delete"); // the caret stays where it is
    expect(next()).toEqual([{ text: true, selection: false }]);
    editor.key("Delete");
    editor.key("ArrowRight");
    editor.key("Tab");
    editor.select(1);
    editor.setValue("h");
    editor.endComposition();
    expect(editor.undo()).toBe(false);
    expect(next()).toEqual([]);
    editor.insertToken(session("Bob"));
    expect(next()).toEqual([{ text: true, selection: true }]);
    editor.compose("ni", 2, 2);
    expect(next()).toEqual([{ text: true, selection: true }]);
    editor.compose("ni", 1, 1);
    expect(next()).toEqual([{ text: false, selection: true }]);
    editor.compose("ni", 1, 1);
    expect(next()).toEqual([]);
    editor.insert("你");
    expect(next()).toEqual([{ text: true, selection: true }]);
    editor.undo();
    expect(next()).toEqual([{ text: true, selection: true }]);
    editor.selectAll();
    expect(next()).toEqual([{ text: false, selection: true }]);
    editor.setValue("h@Bob ", [mark(1, 5, "Bob")]); // the same document, a different caret
    expect(next()).toEqual([{ text: false, selection: true }]);
    editor.setValue("h@Bob ");
    expect(next()).toEqual([{ text: true, selection: false }]);
  });
});

describe("trigger", () => {
  const typed = (value: string) => {
    const editor = createEditor();
    type(editor, value);
    return editor.trigger(["@", "/"]);
  };
  test("at the start of the text, with and without a query", () => {
    expect(typed("@")).toEqual({ char: "@", start: 0, end: 1, query: "" });
    expect(typed("@fo")).toEqual({ char: "@", start: 0, end: 3, query: "fo" });
    expect(typed("/he")).toEqual({ char: "/", start: 0, end: 3, query: "he" });
    expect(typed("")).toBeNull();
    expect(typed("fo")).toBeNull();
  });
  test("after whitespace, an opening bracket or quote, or a han character", () => {
    expect(typed("hi @fo")).toEqual({ char: "@", start: 3, end: 6, query: "fo" });
    expect(typed("hi\n@fo")).toEqual({ char: "@", start: 3, end: 6, query: "fo" });
    expect(typed("(@fo")).toEqual({ char: "@", start: 1, end: 4, query: "fo" });
    expect(typed('"@fo')).toEqual({ char: "@", start: 1, end: 4, query: "fo" });
    expect(typed("你好@修复")).toEqual({ char: "@", start: 2, end: 5, query: "修复" });
    expect(typed("你好，@fo")).toEqual({ char: "@", start: 3, end: 6, query: "fo" });
  });
  test("not inside a word: an address is not a mention", () => {
    expect(typed("me@example")).toBeNull();
    expect(typed("a/b")).toBeNull();
    expect(typed("x)@fo")).toBeNull();
  });
  test("the query has no whitespace, and may hold the trigger character", () => {
    expect(typed("@foo bar")).toBeNull();
    expect(typed("@foo\n")).toBeNull();
    expect(typed("@foo@bar")).toEqual({ char: "@", start: 0, end: 8, query: "foo@bar" });
    expect(typed("/usr/bin")).toEqual({ char: "/", start: 0, end: 8, query: "usr/bin" });
  });
  test("the query is at most maxQuery units", () => {
    const editor = createEditor();
    editor.insert("@" + "x".repeat(32));
    expect(editor.trigger(["@"])!.query.length).toBe(32);
    editor.insert("x");
    expect(editor.trigger(["@"])).toBeNull();
    expect(editor.trigger(["@"], 40)!.query.length).toBe(33);
    editor.setValue("@abcd");
    expect(editor.trigger(["@"], 3)).toBeNull();
    expect(editor.trigger(["@"], 4)).toEqual({ char: "@", start: 0, end: 5, query: "abcd" });
  });
  test("it is the caret's: the query stops there, and a selection has none", () => {
    const editor = holding("@foo bar");
    editor.select(3);
    expect(editor.trigger(["@"])).toEqual({ char: "@", start: 0, end: 3, query: "fo" });
    editor.select(1, 3);
    expect(editor.trigger(["@"])).toBeNull();
  });
  test("a mention is not a query, and a query does not reach back through one", () => {
    const editor = createEditor();
    editor.insertToken(session("Bob"));
    expect(editor.trigger(["@"])).toBeNull();
    press(editor, "Backspace"); // the caret is right after the mention
    expect(editor.trigger(["@"])).toBeNull();
    type(editor, "ab");
    expect(editor.trigger(["@"])).toBeNull();
    type(editor, " @c");
    expect(editor.trigger(["@"])).toEqual({ char: "@", start: 7, end: 9, query: "c" });
  });
});

describe("random editing", () => {
  /** mulberry32 */
  const prng = (seed: number) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const PIECES = ["a", "b", "Z", "_", "7", " ", " ", "\n", ".", "@", "(", "你", "好", "。", "\u{1F600}", THUMB, "é", "́", CHINA, FAMILY, "‍"];
  const LABELS = ["@Fix the sync test", "@你好", "@\u{1F600} party", "@a"];
  const PREEDITS = ["§n", "§ni", "§ni hao", "§你", "§\u{1F600}x"];
  const KEYS = [
    "Enter", "Shift+Enter", "Backspace", "Backspace", "Delete", "Control+Backspace", "Alt+Backspace", "Control+Delete", "Escape", "Tab",
    "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Shift+ArrowLeft", "Shift+ArrowRight", "Shift+ArrowUp", "Shift+ArrowDown",
    "Alt+ArrowLeft", "Alt+ArrowRight", "Control+ArrowLeft", "Control+ArrowRight", "Control+Shift+ArrowLeft", "Alt+Shift+ArrowRight",
    "Home", "End", "Shift+Home", "Shift+End", "Control+Home", "Control+End", "PageUp", "Control+a", "Control+z", "Control+Shift+z", "Control+y",
  ];

  function run(seed: number, steps: number, options: { maxLength: number; singleLine?: boolean; wrap?: number }) {
    const random = prng(seed);
    const int = (n: number) => Math.floor(random() * n);
    const pick = <T>(list: readonly T[]) => list[int(list.length)]!;
    const labels = new Map<string, string>();
    let ids = 0;
    let changes: { text: boolean; selection: boolean }[] = [];
    const editor: Editor = createEditor({
      maxLength: options.maxLength,
      singleLine: options.singleLine === true,
      ...(options.wrap ? { layout: wrapped(() => editor, options.wrap) } : {}),
      onChange: (_, change) => changes.push(change),
    });
    let step = 0;
    let what = "";
    const must = (ok: boolean, rule: string) => {
      if (!ok) throw new Error(`seed ${seed} step ${step} (${what}): ${rule}\n${JSON.stringify(editor.snapshot())}`);
    };
    const checkTokens = (source: string, tokens: readonly Token[]) => {
      let free = 0;
      for (const token of tokens) {
        must(Number.isInteger(token.start) && Number.isInteger(token.end), "token offsets are integers");
        must(token.start >= free && token.end > token.start && token.end <= source.length, "tokens are sorted, apart and in bounds");
        // a token setValue was given at random offsets is known by the text it first covered
        if (!labels.has(token.id)) labels.set(token.id, source.slice(token.start, token.end));
        must(source.slice(token.start, token.end) === labels.get(token.id), "a token's text is its label");
        free = token.end;
      }
    };
    const checkOffset = (source: string, tokens: readonly Token[], offset: number) => {
      must(Number.isInteger(offset) && offset >= 0 && offset <= source.length, "the selection is clamped");
      for (const token of tokens) must(!(offset > token.start && offset < token.end), "the selection is not inside a token");
      const high = source.charCodeAt(offset - 1) >= 0xd800 && source.charCodeAt(offset - 1) <= 0xdbff;
      const low = source.charCodeAt(offset) >= 0xdc00 && source.charCodeAt(offset) <= 0xdfff;
      must(!(high && low), "the selection is not inside a surrogate pair");
    };
    /** no half of a surrogate pair without the other: nothing here types one */
    const wellFormed = (source: string) => {
      for (let i = 0; i < source.length; i++) {
        const c = source.charCodeAt(i);
        if (c >= 0xdc00 && c <= 0xdfff) return false;
        if (c >= 0xd800 && c <= 0xdbff && !(source.charCodeAt(++i) >= 0xdc00 && source.charCodeAt(i) <= 0xdfff)) return false;
      }
      return true;
    };
    const check = () => {
      const shown = editor.snapshot();
      const sent = editor.value();
      must(wellFormed(shown.text) && wellFormed(sent.text), "no surrogate pair is cut in half");
      must(sent.text.length <= options.maxLength, "the value fits maxLength");
      must(!sent.text.includes("§"), "the value has no preedit in it");
      must(!options.singleLine || !shown.text.includes("\n"), "a single line has no newline");
      must(editor.isEmpty() === (sent.text.length === 0), "isEmpty is about the value");
      checkTokens(shown.text, shown.tokens);
      checkTokens(sent.text, sent.tokens);
      checkOffset(shown.text, shown.tokens, shown.selection.anchor);
      checkOffset(shown.text, shown.tokens, shown.selection.focus);
      const composition = shown.composition;
      if (composition === null) {
        must(shown.text === sent.text, "without a preedit the value is the text");
        must(JSON.stringify(shown.tokens) === JSON.stringify(sent.tokens), "without a preedit the value has the tokens");
      } else {
        must(shown.text.slice(composition.start, composition.end).startsWith("§"), "the composition is where the preedit is");
        must(composition.caret === shown.selection.focus && composition.caret >= composition.start && composition.caret <= composition.end, "the caret is in the preedit");
        must(sent.text.startsWith(shown.text.slice(0, composition.start)) && sent.text.endsWith(shown.text.slice(composition.end)), "the preedit is all that differs");
        must(editor.trigger(["@"]) === null, "no trigger while composing");
      }
    };
    /** a piece of text with tokens over it, some of them bad */
    const randomValue = () => {
      let value = "";
      const tokens: Token[] = [];
      for (let i = int(8); i > 0; i--) {
        if (random() < 0.3) {
          const label = pick(LABELS);
          const id = "v" + ids++;
          labels.set(id, label);
          tokens.push({ start: value.length, end: value.length + label.length, kind: "session", id });
          value += label;
        } else value += pick(PIECES);
      }
      if (options.singleLine) value = value.replace(/\n/g, " ");
      if (random() < 0.3) tokens.push({ start: int(value.length + 1), end: int(value.length + 3), kind: "session", id: "r" + ids++ });
      return { value, tokens };
    };
    const act = () => {
      const r = random();
      const length = editor.snapshot().text.length;
      if (r < 0.3) {
        what = "type";
        editor.insert(pick(PIECES));
      } else if (r < 0.36) {
        what = "paste";
        let pasted = "";
        for (let i = 2 + int(5); i > 0; i--) pasted += random() < 0.1 ? "\r\n" : pick(PIECES);
        editor.insert(pasted);
      } else if (r < 0.42) {
        what = "insertToken";
        const label = pick(LABELS);
        const id = "t" + ids++;
        labels.set(id, label);
        const found = editor.trigger(["@"]);
        const a = int(length + 3) - 1;
        editor.insertToken({ kind: "session", id, label }, found !== null && random() < 0.7 ? found : random() < 0.4 ? { start: a, end: a + int(6) } : undefined);
      } else if (r < 0.72) {
        const name = pick(KEYS);
        what = name;
        const composing = editor.snapshot().composition !== null;
        const handled = editor.key(name, { enterSubmits: random() < 0.3 });
        if (composing) must(handled === (name === "Escape"), "while composing only Escape is handled");
        if (name === "Tab" || name === "PageUp") must(!handled, "Tab and PageUp are not handled");
      } else if (r < 0.78) {
        what = "select";
        if (random() < 0.5) editor.select(int(length + 5) - 2);
        else editor.select(int(length + 5) - 2, int(length + 5) - 2);
      } else if (r < 0.8) {
        what = "selectAll";
        editor.selectAll();
      } else if (r < 0.88) {
        what = "compose";
        const pre = random() < 0.1 ? "" : pick(PREEDITS);
        editor.compose(pre, int(pre.length + 2), int(pre.length + 2));
      } else if (r < 0.91) {
        what = "endComposition";
        editor.endComposition();
      } else if (r < 0.94) {
        what = "commit";
        editor.insert(pick(["你", "你好", "世界和平"]));
      } else if (r < 0.97) {
        what = "undo";
        editor.undo();
      } else if (r < 0.99) {
        what = "redo";
        editor.redo();
      } else {
        what = "setValue";
        const { value, tokens } = randomValue();
        editor.setValue(value, tokens);
      }
    };
    for (step = 0; step < steps; step++) {
      const before = editor.snapshot();
      const copy = JSON.parse(JSON.stringify(before)) as typeof before;
      changes = [];
      act();
      const after = editor.snapshot();
      check();
      must(JSON.stringify(before) === JSON.stringify(copy), "a snapshot handed out is never written to");
      // onChange: once when something changed, never otherwise, and it says what
      const textChanged = after.text !== before.text || JSON.stringify(after.tokens) !== JSON.stringify(before.tokens);
      const selectionChanged = JSON.stringify([after.selection, after.composition]) !== JSON.stringify([before.selection, before.composition]);
      must(changes.length === (textChanged || selectionChanged ? 1 : 0), "onChange fires once per call that changed something");
      must(changes.length === 0 || (changes[0]!.text === textChanged && changes[0]!.selection === selectionChanged), "onChange says what changed");
      must((after === before) === (changes.length === 0), "the snapshot is replaced exactly when something changed");
      if (step % 200 === 199) {
        what = "undo all, redo all";
        editor.endComposition();
        const value = editor.value();
        let undone = 0;
        while (editor.undo()) {
          undone++;
          check();
        }
        must(undone <= 100, "history is capped");
        for (let i = 0; i < undone; i++) must(editor.redo(), "every undone step can be redone");
        must(JSON.stringify(editor.value()) === JSON.stringify(value), "undo all then redo all returns to the same value");
      }
    }
    return editor;
  }

  test("a multi-line composer keeps its invariants over 6000 random operations", () => {
    for (const seed of [1, 2, 3]) run(seed, 2000, { maxLength: 80 });
  });
  test("so does one whose lines are wrapped by a layout", () => {
    for (const seed of [11, 12, 13]) run(seed, 2000, { maxLength: 120, wrap: 60 });
  });
  test("and a single-line field with a tight limit", () => {
    for (const seed of [21, 22]) run(seed, 2000, { maxLength: 24, singleLine: true });
  });
  test("the same seed gives the same document", () => {
    const a = run(7, 1500, { maxLength: 80 });
    const b = run(7, 1500, { maxLength: 80 });
    expect(a.snapshot()).toEqual(b.snapshot());
    expect(a.value().text.length).toBeGreaterThan(0);
  });
});
