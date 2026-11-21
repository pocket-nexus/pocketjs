// tests/note.test.ts — Pocket Note: markdown parser + editor caret math
// (pure, fake measure), plus a sim boot smoke test.
//
//   bun tools/build.ts note-main && bun test tests/note.test.ts

import { describe, expect, test } from "bun:test";
import { parseInline, parseMarkdown } from "../apps/note/markdown.ts";
import {
  backspace,
  caretFromX,
  caretLine,
  caretX,
  insertAt,
  layoutDoc,
  lineEnd,
  lineStart,
  moveVertical,
  wordRangeAt,
} from "../apps/note/editor.ts";
import { runScenario, treeHasText } from "../programs/sim/sim.ts";

// ---------------------------------------------------------------------------
// markdown.ts
// ---------------------------------------------------------------------------

describe("markdown blocks", () => {
  test("headings, paragraphs, rules", () => {
    const blocks = parseMarkdown("# Title\n\nBody one\nBody two\n\n---\n\n## Sub");
    expect(blocks.map((b) => b.kind)).toEqual(["h1", "p", "hr", "h2"]);
    const p = blocks[1];
    if (p.kind !== "p") throw new Error("expected p");
    // Soft-joined paragraph.
    expect(p.spans[0].text).toBe("Body one Body two");
    expect(p.line).toBe(2);
  });

  test("lists carry markers and depth", () => {
    const blocks = parseMarkdown("- a\n  - b\n1. c\n12. d");
    expect(blocks.map((b) => (b.kind === "li" ? `${b.marker}/${b.depth}` : "?"))).toEqual([
      "•/0",
      "•/1",
      "1./0",
      "12./0",
    ]);
  });

  test("fenced code is verbatim, unterminated fence swallows the tail", () => {
    const blocks = parseMarkdown("```\na **b**\n```\n\n```\ntail");
    expect(blocks.map((b) => b.kind)).toEqual(["code", "code"]);
    const [a, b] = blocks;
    if (a.kind !== "code" || b.kind !== "code") throw new Error("expected code");
    expect(a.text).toBe("a **b**");
    expect(b.text).toBe("tail");
  });

  test("quotes merge adjacent lines", () => {
    const blocks = parseMarkdown("> a\n> b");
    expect(blocks).toHaveLength(1);
    const q = blocks[0];
    if (q.kind !== "quote") throw new Error("expected quote");
    expect(q.spans[0].text).toBe("a\nb");
  });
});

describe("markdown inline", () => {
  test("styles split into spans", () => {
    expect(parseInline("a **b** `c` *d* [e](f)")).toEqual([
      { text: "a ", style: "plain" },
      { text: "b", style: "bold" },
      { text: " ", style: "plain" },
      { text: "c", style: "code" },
      { text: " ", style: "plain" },
      { text: "d", style: "em" },
      { text: " ", style: "plain" },
      { text: "e", style: "link" },
    ]);
  });

  test("unterminated markers stay literal", () => {
    expect(parseInline("a **b")).toEqual([{ text: "a **b", style: "plain" }]);
    expect(parseInline("3 * 4 * 5")).toEqual([{ text: "3 * 4 * 5", style: "plain" }]);
  });

  test("escapes suppress markup", () => {
    expect(parseInline("\\*not em\\*")).toEqual([{ text: "*not em*", style: "plain" }]);
  });
});

// ---------------------------------------------------------------------------
// editor.ts — fake measure: every char 10px, so maxW 100 = 10 chars/line
// ---------------------------------------------------------------------------

const M = (text: string) => text.length * 10;

describe("editor wrap", () => {
  test("every source char lands on exactly one line", () => {
    const doc = "alpha beta gamma delta\n\nepsilon";
    const lines = layoutDoc(doc, 100, M);
    // Offsets tile the document: each line starts where wrap math put it,
    // hard-broken lines skip their '\n'.
    let cursor = 0;
    for (const line of lines) {
      expect(line.start).toBeGreaterThanOrEqual(cursor);
      expect(line.start - cursor).toBeLessThanOrEqual(1); // at most the '\n'
      expect(line.end).toBeGreaterThanOrEqual(line.start);
      cursor = line.end;
    }
    expect(cursor).toBe(doc.length);
  });

  test("soft breaks land after a space", () => {
    const lines = layoutDoc("alpha beta gamma", 100, M);
    // "alpha beta" is exactly 10 chars — fits; break after its space.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ start: 0, end: 6, soft: true });
    expect(lines[1]).toMatchObject({ start: 6, end: 16, soft: false });
  });

  test("spaceless overflow breaks mid-word; empty lines survive", () => {
    const lines = layoutDoc("abcdefghijklmno\n\nx", 100, M);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatchObject({ start: 0, end: 10, soft: true });
    expect(lines[1]).toMatchObject({ start: 10, end: 15, soft: false });
    expect(lines[2]).toMatchObject({ start: 16, end: 16 });
    expect(lines[3]).toMatchObject({ start: 17, end: 18 });
  });
});

describe("editor caret", () => {
  const doc = "alpha beta gamma";
  const lines = layoutDoc(doc, 100, M); // ["alpha ", "beta gamma"] offsets 0..6, 6..16

  test("caret at a soft boundary belongs to the next line", () => {
    expect(caretLine(lines, 5)).toBe(0);
    expect(caretLine(lines, 6)).toBe(1);
    expect(caretLine(lines, 16)).toBe(1);
  });

  test("caret x measures the line prefix", () => {
    expect(caretX(doc, lines, 8, M)).toBe(20); // "be" on line 1
  });

  test("click placement snaps to nearest boundary and round-trips", () => {
    expect(caretFromX(doc, lines, 1, 24, M)).toBe(8); // 24px → after "be"
    expect(caretFromX(doc, lines, 1, 26, M)).toBe(9); // past midpoint → "bet|"
    expect(caretFromX(doc, lines, 0, 999, M)).toBe(5); // end of soft line: before its space
    expect(caretFromX(doc, lines, 1, 999, M)).toBe(16);
  });

  test("vertical moves keep the goal column", () => {
    expect(moveVertical(doc, lines, 8, -1, 20, M)).toBe(2); // up from "be|" → "al|"
    expect(moveVertical(doc, lines, 2, 1, 20, M)).toBe(8);
    expect(moveVertical(doc, lines, 2, -1, 20, M)).toBe(0); // top exits to 0
    expect(moveVertical(doc, lines, 8, 1, 20, M)).toBe(doc.length);
  });

  test("home/end respect soft trailing spaces", () => {
    expect(lineStart(lines, 3)).toBe(0);
    expect(lineEnd(lines, 3)).toBe(5); // before the soft space
    expect(lineEnd(lines, 8)).toBe(16);
  });

  test("edits move the caret with the text", () => {
    let s = { doc: "ab", caret: 1 };
    s = insertAt(s, "XY");
    expect(s).toEqual({ doc: "aXYb", caret: 3 });
    s = backspace(s);
    expect(s).toEqual({ doc: "aXb", caret: 2 });
  });
});

// ---------------------------------------------------------------------------
// sim smoke: the bundle boots on a plain ui host and renders the sample
// ---------------------------------------------------------------------------

describe("note-main boots standalone", () => {
  test("sample note renders without a widget host", async () => {
    const trace = await runScenario({ app: "note-main", seconds: 2 });
    // The POCKET NOTE wordmark is widget-chrome (hidden off macos-widget),
    // so the structural smoke pins sample-document content instead.
    expect(treeHasText(trace.tree, "Pocket Note")).toBe(true);
    expect(treeHasText(trace.tree, "What works")).toBe(true);
  }, 30000);
});

// ---------------------------------------------------------------------------
// selection + undo/redo (editor.ts)
// ---------------------------------------------------------------------------

import {
  backspaceSel,
  deleteSel,
  emptyHistory,
  breakRun,
  hasSelection,
  recordEdit,
  redo,
  selBounds,
  typeText,
  undo,
  type SelEdit,
} from "../apps/note/editor.ts";
import {
  cmpPos,
  rowChFromX,
  rowFromY,
  rowSelSpan,
  rowText,
  rowXOfCh,
  selectedText,
} from "../apps/note/select.ts";
import type { Seg, ViewRow } from "../apps/note/layout.ts";

describe("editor selection", () => {
  const sel = (doc: string, anchor: number, caret: number): SelEdit => ({ doc, caret, anchor });

  test("bounds normalize either drag direction", () => {
    expect(selBounds(sel("abcdef", 4, 1))).toEqual([1, 4]);
    expect(selBounds(sel("abcdef", 1, 4))).toEqual([1, 4]);
    expect(hasSelection(sel("ab", 1, 1))).toBe(false);
  });

  test("typing replaces the selection and collapses", () => {
    const s = typeText(sel("hello world", 6, 11), "there");
    expect(s.doc).toBe("hello there");
    expect(s.caret).toBe(11);
    expect(s.anchor).toBe(11);
  });

  test("backspace/delete eat the selection as one unit", () => {
    expect(backspaceSel(sel("hello world", 5, 11)).doc).toBe("hello");
    expect(deleteSel(sel("hello world", 11, 5)).doc).toBe("hello");
    // No selection: single-char behavior.
    expect(backspaceSel(sel("ab", 1, 1)).doc).toBe("b");
    expect(deleteSel(sel("ab", 1, 1)).doc).toBe("a");
  });
});

describe("undo/redo history", () => {
  const st = (doc: string, caret = 0): SelEdit => ({ doc, caret, anchor: caret });

  test("undo returns to the recorded state; redo replays", () => {
    const h = emptyHistory();
    let cur = st("a");
    recordEdit(h, cur, "other");
    cur = st("ab", 2);
    const back = undo(h, cur)!;
    expect(back.doc).toBe("a");
    const fwd = redo(h, back)!;
    expect(fwd.doc).toBe("ab");
    expect(undo(h, fwd)!.doc).toBe("a");
  });

  test("typing runs coalesce into one undo step", () => {
    const h = emptyHistory();
    let cur = st("");
    // Type "abc" one char at a time.
    for (const ch of ["a", "b", "c"]) {
      recordEdit(h, cur, "type");
      cur = typeText(cur, ch);
    }
    expect(h.past).toHaveLength(1);
    expect(undo(h, cur)!.doc).toBe("");
  });

  test("a caret move breaks the coalescing run", () => {
    const h = emptyHistory();
    let cur = st("");
    recordEdit(h, cur, "type");
    cur = typeText(cur, "ab");
    breakRun(h); // click / arrow
    recordEdit(h, cur, "type");
    cur = typeText(cur, "cd");
    expect(h.past).toHaveLength(2);
    expect(undo(h, cur)!.doc).toBe("ab");
  });

  test("delete runs coalesce separately from typing", () => {
    const h = emptyHistory();
    let cur = st("abcd", 4);
    recordEdit(h, cur, "delete");
    cur = backspaceSel(cur);
    recordEdit(h, cur, "delete");
    cur = backspaceSel(cur);
    recordEdit(h, cur, "type");
    cur = typeText(cur, "X");
    expect(h.past).toHaveLength(2); // one delete run + one type run
    expect(cur.doc).toBe("abX");
    expect(undo(h, cur)!.doc).toBe("ab");
  });

  test("a new edit clears the redo stack", () => {
    const h = emptyHistory();
    let cur = st("a");
    recordEdit(h, cur, "other");
    cur = st("ab", 2);
    cur = undo(h, cur)!;
    recordEdit(h, cur, "other");
    expect(redo(h, st("whatever"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// preview selection (select.ts) — fake measure: 10px per char, every slot
// ---------------------------------------------------------------------------

const MS = (text: string, _slot: number) => text.length * 10;

function lineRow(y: number, indent: number, segs: Seg[], wrapCont = false): ViewRow {
  return { kind: "line", key: `${y}`, y, h: 20, segs, indent, bar: false, wrapCont, srcLine: 0 };
}

describe("preview selection", () => {
  // "Bold" (bold) + " text" (plain) at indent 0; second row "next" at indent 18
  // with a marker seg that must not count as text.
  const rows: ViewRow[] = [
    lineRow(0, 0, [
      { text: "Bold", x: 0, slot: 8, style: "bold" },
      { text: " text", x: 40, slot: 1, style: "plain" },
    ]),
    lineRow(20, 18, [
      { text: "•", x: -18, slot: 8, style: "marker" },
      { text: "next", x: 0, slot: 1, style: "plain" },
    ]),
    { kind: "hr", key: "hr", y: 40, h: 17, srcLine: 0 },
    { kind: "code", key: "c", y: 57, h: 34, text: "code line", srcLine: 0 },
  ];

  test("rowText skips markers; hr is inert", () => {
    expect(rowText(rows[0])).toBe("Bold text");
    expect(rowText(rows[1])).toBe("next");
    expect(rowText(rows[2])).toBe("");
    expect(rowText(rows[3])).toBe("code line");
  });

  test("x↔ch round-trips across segment boundaries and indent", () => {
    expect(rowChFromX(rows[0], 0, MS)).toBe(0);
    expect(rowChFromX(rows[0], 44, MS)).toBe(4); // just inside " text"
    expect(rowXOfCh(rows[0], 4, MS)).toBe(40);
    expect(rowXOfCh(rows[0], 9, MS)).toBe(90);
    // Indented row: canvas x includes the indent; marker is not text.
    expect(rowChFromX(rows[1], 18, MS)).toBe(0);
    expect(rowXOfCh(rows[1], 2, MS)).toBe(38);
  });

  test("y → row snaps gaps to the following row", () => {
    expect(rowFromY(rows, 5)).toBe(0);
    expect(rowFromY(rows, 25)).toBe(1);
    expect(rowFromY(rows, 999)).toBe(3);
  });

  test("selection spans: boundary rows clip, interior spans, hr skips", () => {
    const start = { row: 0, ch: 5 }; // after "Bold "
    const end = { row: 3, ch: 0 };
    expect(cmpPos(start, end)).toBeLessThan(0);
    expect(rowSelSpan(rows, 0, start, end, MS)).toEqual({ x0: 50, x1: 90 });
    expect(rowSelSpan(rows, 1, start, end, MS)).toEqual({ x0: 18, x1: 58 });
    expect(rowSelSpan(rows, 2, start, end, MS)).toBeNull();
    // Code block: any overlap selects the whole box.
    expect(rowSelSpan(rows, 3, start, end, MS)).toEqual({ x0: 0, x1: 106 });
  });

  test("single-row selection clips both ends; empty span is null", () => {
    const a = { row: 0, ch: 2 };
    const b = { row: 0, ch: 6 };
    expect(rowSelSpan(rows, 0, a, b, MS)).toEqual({ x0: 20, x1: 60 });
    expect(rowSelSpan(rows, 0, a, a, MS)).toBeNull();
  });

  test("selectedText: boundary slices, hr skipped, code atomic", () => {
    // rows[1] is a bullet item whose selection covers the line start —
    // the rendered marker rides along ("• next"), like the numbered "1."
    // a user expects to see in a paste.
    expect(selectedText(rows, { row: 0, ch: 5 }, { row: 3, ch: 0 })).toBe(
      "text\n• next\ncode line",
    );
    expect(selectedText(rows, { row: 0, ch: 2 }, { row: 0, ch: 6 })).toBe("ld t");
  });

  test("selectedText: markers only when the line start is covered", () => {
    const li = [
      lineRow(0, 18, [
        { text: "1.", x: -18, slot: 1, style: "marker" },
        { text: "first", x: 0, slot: 1, style: "plain" },
      ]),
      lineRow(20, 18, [
        { text: "2.", x: -18, slot: 1, style: "marker" },
        { text: "second", x: 0, slot: 1, style: "plain" },
      ]),
    ];
    expect(selectedText(li, { row: 0, ch: 0 }, { row: 1, ch: 6 })).toBe("1. first\n2. second");
    // Mid-line start: the first row's marker is not part of the selection.
    expect(selectedText(li, { row: 0, ch: 3 }, { row: 1, ch: 6 })).toBe("st\n2. second");
  });

  test("selectedText re-joins soft-wrapped rows with a space", () => {
    const wrapped: ViewRow[] = [
      lineRow(0, 0, [{ text: "alpha beta", x: 0, slot: 1, style: "plain" }]),
      lineRow(20, 0, [{ text: "gamma", x: 0, slot: 1, style: "plain" }], true),
      lineRow(40, 0, [{ text: "hard line", x: 0, slot: 1, style: "plain" }]),
    ];
    expect(selectedText(wrapped, { row: 0, ch: 0 }, { row: 2, ch: 9 })).toBe(
      "alpha beta gamma\nhard line",
    );
  });
});

describe("double-click word selection", () => {
  test("selects the word around the caret", () => {
    //         0123456789012345
    const d = "# Pocket Note";
    expect(wordRangeAt(d, 4)).toEqual([2, 8]); // inside "Pocket"
    expect(wordRangeAt(d, 2)).toEqual([2, 8]); // at its first char
    expect(wordRangeAt(d, 9)).toEqual([9, 13]); // "Note"
  });

  test("a caret just past a word still selects that word", () => {
    const d = "one two";
    // caretFromX rounds to the nearest boundary: index 3 is the space,
    // but the click was on "one"'s right half.
    expect(wordRangeAt(d, 3)).toEqual([0, 3]);
    expect(wordRangeAt(d, 7)).toEqual([4, 7]); // end of document
  });

  test("whitespace and punctuation select as runs, browser-style", () => {
    expect(wordRangeAt("a   b", 2)).toEqual([1, 4]); // space run
    expect(wordRangeAt("a --- b", 3)).toEqual([2, 5]); // punct run
    expect(wordRangeAt("x\ny", 1)).toEqual([0, 1]); // end of line: the word wins
    expect(wordRangeAt("x\n\ny", 2)).toEqual([2, 3]); // an empty line's newline
  });

  test("non-ASCII counts as word characters (CJK, emoji pairs)", () => {
    const d = "见 中文排版 ok";
    expect(wordRangeAt(d, 3)).toEqual([2, 6]); // 中文排版 as one run
    const e = "a 😀😀 b";
    expect(wordRangeAt(e, 3)).toEqual([2, 6]); // surrogate pairs intact
  });

  test("degenerate inputs", () => {
    expect(wordRangeAt("", 0)).toEqual([0, 0]);
    expect(wordRangeAt("w", 5)).toEqual([0, 1]); // clamped past the end
  });
});
