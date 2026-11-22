import { describe, expect, test } from "bun:test";
import { parseInline, parseMarkdown, plainText, runsText, type Block, type Run } from "../../framework/src/pocketui/core/markdown.ts";

const p = (...runs: Run[]): Block => ({ t: "p", runs });
const t = (text: string): Run => ({ text });
const b = (text: string): Run => ({ text, bold: true });
const i = (text: string): Run => ({ text, italic: true });
const c = (text: string): Run => ({ text, code: true });
const a = (text: string, href: string): Run => ({ text, href });
const bullets = (...items: Block[][]): Block => ({ t: "list", ordered: false, start: 1, items: items.map((blocks) => ({ blocks })) });
const numbered = (start: number, ...items: Block[][]): Block => ({ t: "list", ordered: true, start, items: items.map((blocks) => ({ blocks })) });
const text = (source: string) => runsText(parseInline(source));

const sameStyle = (x: Run, y: Run) => !x.bold === !y.bold && !x.italic === !y.italic && !x.code === !y.code && !x.strike === !y.strike && x.href === y.href;

/** The output invariants, over a whole block list. */
function checkRuns(runs: Run[]): void {
  for (let k = 0; k < runs.length; k++) {
    if (runs[k]!.text.length === 0) throw new Error("empty run");
    if (runs[k]!.href === "") throw new Error("empty href");
    if (k > 0 && sameStyle(runs[k - 1]!, runs[k]!)) throw new Error(`unmerged runs: ${JSON.stringify(runs)}`);
  }
}
function check(blocks: Block[]): Block[] {
  for (const block of blocks) {
    if (block.t === "p" || block.t === "h") checkRuns(block.runs);
    if (block.t === "p" && block.runs.length === 0) throw new Error("empty paragraph");
    if (block.t === "quote") check(block.blocks);
    if (block.t === "list") {
      if (block.items.length === 0) throw new Error("empty list");
      for (const item of block.items) check(item.blocks);
    }
    if (block.t === "table") {
      if (block.align.length !== block.head.length) throw new Error("align width");
      for (const row of [block.head, ...block.rows]) {
        if (row.length !== block.head.length) throw new Error("row width");
        row.forEach(checkRuns);
      }
    }
  }
  return blocks;
}
const md = (source: string) => check(parseMarkdown(source));

/** The fastest of `rounds` runs, in milliseconds. */
function fastest(rounds: number, run: () => void): number {
  let best = Infinity;
  for (let k = 0; k < rounds; k++) {
    const start = performance.now();
    run();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

describe("paragraphs", () => {
  test("nothing in, nothing out", () => {
    expect(md("")).toEqual([]);
    expect(md("\n\n  \n\t\n")).toEqual([]);
  });
  test("blank lines separate paragraphs", () => {
    expect(md("one\n\ntwo\n\n\n\nthree")).toEqual([p(t("one")), p(t("two")), p(t("three"))]);
  });
  test("a soft line break is one space", () => {
    expect(md("the quick\nbrown fox\n")).toEqual([p(t("the quick brown fox"))]);
    expect(md("the quick \n   brown fox")).toEqual([p(t("the quick brown fox"))]);
  });
  test("a soft line break between two CJK characters is nothing", () => {
    expect(md("今天天气\n很好。\n我们出去")).toEqual([p(t("今天天气很好。我们出去"))]);
    expect(md("修复\nfailing test\n然后提交")).toEqual([p(t("修复 failing test 然后提交"))]);
    // the characters that meet decide, not the delimiters between them
    expect(md("这是**重点**\n**然后**继续")).toEqual([p(t("这是"), b("重点然后"), t("继续"))]);
    expect(md("한국어\n문장")).toEqual([p(t("한국어 문장"))]);
  });
  test("a hard break is a newline in the text", () => {
    expect(md("line one  \nline two")).toEqual([p(t("line one\nline two"))]);
    expect(md("line one\\\nline two")).toEqual([p(t("line one\nline two"))]);
    expect(md("line one<br>line two<BR/>three<br />four")).toEqual([p(t("line one\nline two\nthree\nfour"))]);
    // nothing follows it: there is no break to draw
    expect(md("line one  \n")).toEqual([p(t("line one"))]);
  });
  test("line endings and trailing whitespace", () => {
    expect(md("a\r\nb\r\n\r\nc\rd")).toEqual([p(t("a b")), p(t("c d"))]);
    expect(md("  padded   \n\n\tindented\t")).toEqual([p(t("padded")), p(t("indented"))]);
  });
  test("four spaces of indentation is not code", () => {
    expect(md("    not code\n    still text")).toEqual([p(t("not code still text"))]);
    expect(md("para\n        deep continuation")).toEqual([p(t("para deep continuation"))]);
  });
});

describe("headings", () => {
  test("levels one to six", () => {
    for (let level = 1; level <= 6; level++) {
      expect(md(`${"#".repeat(level)} Title`)).toEqual([{ t: "h", level: level as 1, runs: [t("Title")] }]);
    }
    expect(md("####### seven")).toEqual([p(t("####### seven"))]);
  });
  test("closing #s are stripped, a # that belongs to the text is not", () => {
    expect(md("## Title ##")).toEqual([{ t: "h", level: 2, runs: [t("Title")] }]);
    expect(md("## Title ####   ")).toEqual([{ t: "h", level: 2, runs: [t("Title")] }]);
    expect(md("# C#")).toEqual([{ t: "h", level: 1, runs: [t("C#")] }]);
    expect(md("# issue #12")).toEqual([{ t: "h", level: 1, runs: [t("issue #12")] }]);
  });
  test("inline styles, and no space means text", () => {
    expect(md("### 第一步：**安装** `bun`")).toEqual([{ t: "h", level: 3, runs: [t("第一步："), b("安装"), t(" "), c("bun")] }]);
    expect(md("#hashtag and #42")).toEqual([p(t("#hashtag and #42"))]);
  });
  test("a heading ends the paragraph above it; setext underlines are not headings", () => {
    expect(md("intro\n# Title\nbody")).toEqual([p(t("intro")), { t: "h", level: 1, runs: [t("Title")] }, p(t("body"))]);
    expect(md("Title\n=====\n")).toEqual([p(t("Title ====="))]);
    expect(md("Title\n---\nbody")).toEqual([p(t("Title")), { t: "hr" }, p(t("body"))]);
  });
});

describe("fenced code", () => {
  test("content is verbatim and the info string's first word is the language", () => {
    expect(md("```ts title=\"a.ts\"\nconst a = `**x**`;\n\n  # not a heading\n```\nafter")).toEqual([
      { t: "code", lang: "ts", text: "const a = `**x**`;\n\n  # not a heading" },
      p(t("after")),
    ]);
    expect(md("```\n```")).toEqual([{ t: "code", lang: "", text: "" }]);
  });
  test("tildes, and a longer fence holds a shorter one", () => {
    expect(md("~~~py\nprint(1)\n~~~")).toEqual([{ t: "code", lang: "py", text: "print(1)" }]);
    expect(md("````md\n```js\nx\n```\n````")).toEqual([{ t: "code", lang: "md", text: "```js\nx\n```" }]);
    expect(md("```\n~~~\n```")).toEqual([{ t: "code", lang: "", text: "~~~" }]);
    // a closing fence carries no text
    expect(md("```\na\n``` b\n```")).toEqual([{ t: "code", lang: "", text: "a\n``` b" }]);
  });
  test("the opening fence's indentation is removed from the content", () => {
    expect(md("  ```sh\n  ls\n    -la\n ok\n  ```")).toEqual([{ t: "code", lang: "sh", text: "ls\n  -la\nok" }]);
    expect(md("```make\nall:\n\tcc main.c\n```")).toEqual([{ t: "code", lang: "make", text: "all:\n\tcc main.c" }]);
  });
  test("an unclosed fence is an open code block", () => {
    expect(md("```js\nconst a = 1;")).toEqual([{ t: "code", lang: "js", text: "const a = 1;", open: true }]);
    expect(md("```js\nconst a = 1;\n")).toEqual([{ t: "code", lang: "js", text: "const a = 1;", open: true }]);
    expect(md("```js\na\n\n")).toEqual([{ t: "code", lang: "js", text: "a\n", open: true }]);
    expect(md("```")).toEqual([{ t: "code", lang: "", text: "", open: true }]);
    expect(md("```js\na\n``")).toEqual([{ t: "code", lang: "js", text: "a\n``", open: true }]);
  });
  test("a fence ends a paragraph; three backticks around inline code are not a fence", () => {
    expect(md("run this:\n```\nls\n```")).toEqual([p(t("run this:")), { t: "code", lang: "", text: "ls" }]);
    expect(md("```inline``` then text")).toEqual([p(c("inline"), t(" then text"))]);
    // under a paragraph such a line still starts a new one: "```" alone had ended it
    expect(md("text\n```inline``` more")).toEqual([p(t("text")), p(c("inline"), t(" more"))]);
  });
});

describe("block quotes", () => {
  test("a run of > lines, with or without the space", () => {
    expect(md("> one\n>two\n\nout")).toEqual([{ t: "quote", blocks: [p(t("one two"))] }, p(t("out"))]);
  });
  test("nested quotes and blocks inside", () => {
    expect(md("> # Title\n> text\n>\n> > inner\n> > more\n>\n> back")).toEqual([
      {
        t: "quote",
        blocks: [{ t: "h", level: 1, runs: [t("Title")] }, p(t("text")), { t: "quote", blocks: [p(t("inner more"))] }, p(t("back"))],
      },
    ]);
    expect(md("> ```js\n> a\n>\n> b\n> ```")).toEqual([{ t: "quote", blocks: [{ t: "code", lang: "js", text: "a\n\nb" }] }]);
  });
  test("no lazy continuation: a line without > is outside", () => {
    expect(md("> quoted\nnot quoted")).toEqual([{ t: "quote", blocks: [p(t("quoted"))] }, p(t("not quoted"))]);
  });
  test("a list in a quote", () => {
    expect(md("> - a\n> - b\n>   1. c")).toEqual([{ t: "quote", blocks: [bullets([p(t("a"))], [p(t("b")), numbered(1, [p(t("c"))])])] }]);
  });
});

describe("lists", () => {
  test("bullets with any of the three markers", () => {
    for (const marker of ["-", "*", "+"]) {
      expect(md(`${marker} one\n${marker} two`)).toEqual([bullets([p(t("one"))], [p(t("two"))])]);
    }
  });
  test("a different marker starts a new list", () => {
    expect(md("- a\n* b")).toEqual([bullets([p(t("a"))]), bullets([p(t("b"))])]);
    expect(md("1. a\n1) b")).toEqual([numbered(1, [p(t("a"))]), numbered(1, [p(t("b"))])]);
    expect(md("- a\n1. b\n- c")).toEqual([bullets([p(t("a"))]), numbered(1, [p(t("b"))]), bullets([p(t("c"))])]);
  });
  test("ordered lists keep their start", () => {
    expect(md("1. one\n2. two\n3. three")).toEqual([numbered(1, [p(t("one"))], [p(t("two"))], [p(t("three"))])]);
    expect(md("7) seven\n8) eight")).toEqual([numbered(7, [p(t("seven"))], [p(t("eight"))])]);
    expect(md("3.14 is pi\n-5 degrees\n+1 from me")).toEqual([p(t("3.14 is pi -5 degrees +1 from me"))]);
  });
  test("a list ends the paragraph above it only when it could not be text", () => {
    expect(md("steps:\n- a\n- b")).toEqual([p(t("steps:")), bullets([p(t("a"))], [p(t("b"))])]);
    expect(md("steps:\n1. a")).toEqual([p(t("steps:")), numbered(1, [p(t("a"))])]);
    expect(md("the year was\n2024. A good one.")).toEqual([p(t("the year was 2024. A good one."))]);
    expect(md("a\n-\nb")).toEqual([p(t("a - b"))]);
  });
  test("tight and loose items both hold blocks", () => {
    expect(md("- a\n\n- b\n\n\n- c")).toEqual([bullets([p(t("a"))], [p(t("b"))], [p(t("c"))])]);
    expect(md("- a\n\n  second paragraph\n- b")).toEqual([bullets([p(t("a")), p(t("second paragraph"))], [p(t("b"))])]);
    expect(md("- a\n  same paragraph")).toEqual([bullets([p(t("a same paragraph"))])]);
    expect(md("- a\n\nnot in the list")).toEqual([bullets([p(t("a"))]), p(t("not in the list"))]);
  });
  test("nested three deep, by two or by four spaces", () => {
    const nested = [bullets([p(t("a")), bullets([p(t("b")), bullets([p(t("c"))])], [p(t("d"))])], [p(t("e"))])];
    expect(md("- a\n  - b\n    - c\n  - d\n- e")).toEqual(nested);
    expect(md("- a\n    - b\n        - c\n    - d\n- e")).toEqual(nested);
    expect(md("* a\n\t* b\n\t\t* c\n\t* d\n* e")).toEqual(nested);
  });
  test("mixed ordered and bullet nesting", () => {
    expect(md("1. first\n   - x\n   - y\n     1. deep\n2. second\n  - lenient: two spaces under a three-wide marker")).toEqual([
      numbered(1, [p(t("first")), bullets([p(t("x"))], [p(t("y")), numbered(1, [p(t("deep"))])])], [
        p(t("second")),
        bullets([p(t("lenient: two spaces under a three-wide marker"))]),
      ]),
    ]);
  });
  test("code in a list item loses the item's indentation", () => {
    expect(md("1. run:\n   ```sh\n   bun test\n     --watch\n\n   echo done\n   ```\n2. next")).toEqual([
      numbered(1, [p(t("run:")), { t: "code", lang: "sh", text: "bun test\n  --watch\n\necho done" }], [p(t("next"))]),
    ]);
    expect(md("- ```\n  x\n  ```")).toEqual([bullets([{ t: "code", lang: "", text: "x" }])]);
  });
  test("other blocks in an item", () => {
    expect(md("- # Title\n  > quote\n\n  | a |\n  |---|\n  | 1 |")).toEqual([
      bullets([
        { t: "h", level: 1, runs: [t("Title")] },
        { t: "quote", blocks: [p(t("quote"))] },
        { t: "table", head: [[t("a")]], rows: [[[t("1")]]], align: ["left"] },
      ]),
    ]);
  });
  test("task items", () => {
    expect(md("- [ ] todo\n- [x] done\n- [X] **also** done\n- plain\n1. [ ] numbered")).toEqual([
      {
        t: "list",
        ordered: false,
        start: 1,
        items: [
          { blocks: [p(t("todo"))], checked: false },
          { blocks: [p(t("done"))], checked: true },
          { blocks: [p(b("also"), t(" done"))], checked: true },
          { blocks: [p(t("plain"))] },
        ],
      },
      { t: "list", ordered: true, start: 1, items: [{ blocks: [p(t("numbered"))], checked: false }] },
    ]);
    expect(md("- [x]not a box\n- [link](u)")).toEqual([bullets([p(t("[x]not a box"))], [p(a("link", "u"))])]);
  });
  test("items start at any indentation and siblings need not line up", () => {
    expect(md("  - a\n  - b\n- c")).toEqual([bullets([p(t("a"))], [p(t("b"))], [p(t("c"))])]);
  });
});

describe("tables", () => {
  test("header, alignment, body", () => {
    expect(md("| Name | Qty | Price | Note |\n|------|:---:|------:|:-----|\n| `bun` | 1 | **$0** | fast |\n| node | 2 | $0 | ~~slow~~ |")).toEqual([
      {
        t: "table",
        head: [[t("Name")], [t("Qty")], [t("Price")], [t("Note")]],
        rows: [
          [[c("bun")], [t("1")], [b("$0")], [t("fast")]],
          [[t("node")], [t("2")], [t("$0")], [{ text: "slow", strike: true }]],
        ],
        align: ["left", "center", "right", "left"],
      },
    ]);
  });
  test("the outer pipes are optional", () => {
    expect(md("a | b\n--- | ---\n1 | 2")).toEqual([{ t: "table", head: [[t("a")], [t("b")]], rows: [[[t("1")], [t("2")]]], align: ["left", "left"] }]);
  });
  test("an escaped pipe stays in its cell", () => {
    expect(md("| op | means |\n|---|---|\n| `a \\| b` | a \\| b |")).toEqual([
      { t: "table", head: [[t("op")], [t("means")]], rows: [[[c("a | b")], [t("a | b")]]], align: ["left", "left"] },
    ]);
  });
  test("short rows are padded and long rows cut", () => {
    const [block] = md("| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 | 5 |\n| | x |");
    expect(block).toEqual({
      t: "table",
      head: [[t("a")], [t("b")], [t("c")]],
      rows: [
        [[t("1")], [], []],
        [[t("1")], [t("2")], [t("3")]],
        [[], [t("x")], []],
      ],
      align: ["left", "left", "left"],
    });
  });
  test("without a delimiter row of the header's width it is a paragraph", () => {
    expect(md("| a | b |\n| 1 | 2 |")).toEqual([p(t("| a | b | | 1 | 2 |"))]);
    expect(md("| a | b |\n|---|\n| 1 | 2 |")).toEqual([p(t("| a | b | |---| | 1 | 2 |"))]);
    expect(md("| a |\n---\n")).toEqual([p(t("| a |")), { t: "hr" }]);
  });
  test("a table ends the paragraph above it and ends at a blank line or another block", () => {
    expect(md("results:\n| a |\n|---|\n| 1 |\n\nafter")).toEqual([
      p(t("results:")),
      { t: "table", head: [[t("a")]], rows: [[[t("1")]]], align: ["left"] },
      p(t("after")),
    ]);
    expect(md("| a |\n|---|\n| 1 |\n# Next")).toEqual([
      { t: "table", head: [[t("a")]], rows: [[[t("1")]]], align: ["left"] },
      { t: "h", level: 1, runs: [t("Next")] },
    ]);
    // as on GitHub, a line right under a table is a row of it
    expect(md("| a | b |\n|---|---|\ntrailing words")).toEqual([
      { t: "table", head: [[t("a")], [t("b")]], rows: [[[t("trailing words")], []]], align: ["left", "left"] },
    ]);
  });
  test("line breaks and links in cells", () => {
    expect(md("| a |\n|---|\n| one<br>two [x](https://x.dev) |")).toEqual([
      { t: "table", head: [[t("a")]], rows: [[[t("one\ntwo "), a("x", "https://x.dev")]]], align: ["left"] },
    ]);
  });
});

describe("thematic breaks", () => {
  test("three or more of - * _", () => {
    for (const source of ["---", "***", "___", "- - -", "*  *  *", "__________", " ---  "]) expect(md(source)).toEqual([{ t: "hr" }]);
    expect(md("--")).toEqual([p(t("--"))]);
    expect(md("---a")).toEqual([p(t("---a"))]);
    expect(md("-*-")).toEqual([p(t("-*-"))]);
  });
  test("a rule ends a list and separates paragraphs", () => {
    expect(md("- a\n---\nb\n\n***\nc")).toEqual([bullets([p(t("a"))]), { t: "hr" }, p(t("b")), { t: "hr" }, p(t("c"))]);
  });
});

describe("inline", () => {
  test("bold and italic with either delimiter", () => {
    expect(parseInline("a **bold** b __bold__ c")).toEqual([t("a "), b("bold"), t(" b "), b("bold"), t(" c")]);
    expect(parseInline("a *it* b _it_ c")).toEqual([t("a "), i("it"), t(" b "), i("it"), t(" c")]);
    expect(parseInline("***both*** and ___both___")).toEqual([
      { text: "both", bold: true, italic: true },
      t(" and "),
      { text: "both", bold: true, italic: true },
    ]);
  });
  test("nesting and overlap", () => {
    expect(parseInline("**bold *and italic* bold**")).toEqual([b("bold "), { text: "and italic", bold: true, italic: true }, b(" bold")]);
    expect(parseInline("*a **b** c*")).toEqual([i("a "), { text: "b", bold: true, italic: true }, i(" c")]);
    expect(parseInline("***a* b**")).toEqual([{ text: "a", bold: true, italic: true }, b(" b")]);
    expect(parseInline("**a *b***")).toEqual([b("a "), { text: "b", bold: true, italic: true }]);
    expect(parseInline("**2*3=6**")).toEqual([b("2*3=6")]);
    expect(parseInline("2*3*4")).toEqual([t("2"), i("3"), t("4")]);
    expect(parseInline("*a ~~b* c~~")).toEqual([i("a "), { text: "b", italic: true, strike: true }, { text: " c", strike: true }]);
  });
  test("delimiters beside spaces are text", () => {
    expect(parseInline("a * b * c")).toEqual([t("a * b * c")]);
    expect(parseInline("def f(*args, **kwargs)")).toEqual([t("def f(*args, **kwargs)")]);
    expect(parseInline("** not bold **")).toEqual([t("** not bold **")]);
    expect(parseInline("5 * 3 ** 2")).toEqual([t("5 * 3 ** 2")]);
  });
  test("underscores only at word boundaries", () => {
    expect(parseInline("snake_case_name and __init__.py")).toEqual([t("snake_case_name and "), b("init"), t(".py")]);
    expect(parseInline("MAX_DEPTH and _private and a_b")).toEqual([t("MAX_DEPTH and _private and a_b")]);
    expect(parseInline("(_note_) _foo_bar_")).toEqual([t("("), i("note"), t(") "), i("foo_bar")]);
    // a CJK character is a letter: an identifier that mixes scripts stays whole
    expect(parseInline("用户_id_列 和，_强调_。")).toEqual([t("用户_id_列 和，"), i("强调"), t("。")]);
  });
  test("code spans", () => {
    expect(parseInline("run `bun test` now")).toEqual([t("run "), c("bun test"), t(" now")]);
    expect(parseInline("``a ` b`` and ``` `` ```")).toEqual([c("a ` b"), t(" and "), c("``")]);
    expect(parseInline("` a ` and `  ` and ` `` `")).toEqual([c("a"), t(" and "), c("  "), t(" and "), c("``")]);
    // never re-parsed
    expect(parseInline("`**x** [y](z) &amp; \\* <br>`")).toEqual([c("**x** [y](z) &amp; \\* <br>")]);
    expect(parseInline("**`bold code`**")).toEqual([{ text: "bold code", bold: true, code: true }]);
    expect(parseInline("`a\nb`")).toEqual([c("a b")]);
  });
  test("strike", () => {
    expect(parseInline("~~gone~~ kept")).toEqual([{ text: "gone", strike: true }, t(" kept")]);
    expect(parseInline("~~**both**~~")).toEqual([{ text: "both", bold: true, strike: true }]);
    // one tilde means "about", three are not a strike
    expect(parseInline("~5 min, ~/src, ~~~x~~~")).toEqual([t("~5 min, ~/src, ~~~x~~~")]);
  });
  test("links", () => {
    expect(parseInline("see [the docs](https://x.dev/a) now")).toEqual([t("see "), a("the docs", "https://x.dev/a"), t(" now")]);
    expect(parseInline('[t](https://x.dev "a title") [u](<a b.md> \'t\')')).toEqual([a("t", "https://x.dev"), t(" "), a("u", "a b.md")]);
    expect(parseInline("[a **b** `c`](u)")).toEqual([a("a ", "u"), { text: "b", bold: true, href: "u" }, a(" ", "u"), { text: "c", code: true, href: "u" }]);
    expect(parseInline("**[bold link](u)**")).toEqual([{ text: "bold link", bold: true, href: "u" }]);
    expect(parseInline("[wiki](https://en.wikipedia.org/wiki/A_(b))")).toEqual([a("wiki", "https://en.wikipedia.org/wiki/A_(b)")]);
    expect(parseInline("[x](a\\)b&amp;c)")).toEqual([a("x", "a)b&c")]);
    expect(parseInline("[https://a.dev](https://b.dev)")).toEqual([a("https://a.dev", "https://b.dev")]);
  });
  test("what is not a link stays text", () => {
    expect(parseInline("[x] and [y][ref] and [^1] and a[0](1)")).toEqual([t("[x] and [y][ref] and [^1] and a"), a("0", "1")]);
    expect(parseInline("[x](a b)")).toEqual([t("[x](a b)")]);
    expect(parseInline("[a [b](c) d](e)")).toEqual([t("[a "), a("b", "c"), t(" d](e)")]);
    // an empty destination links nowhere: the text is kept, the syntax goes
    expect(parseInline("[text]()")).toEqual([t("text")]);
  });
  test("images are links that show their alt text", () => {
    expect(parseInline("![a diagram](d.png)")).toEqual([a("a diagram", "d.png")]);
    expect(parseInline("![](d.png) [](u)")).toEqual([a("d.png", "d.png"), t(" "), a("u", "u")]);
    expect(parseInline("[![build](badge.svg)](https://ci.dev)")).toEqual([a("build", "https://ci.dev")]);
    expect(parseInline("wow! [x](u)!")).toEqual([t("wow! "), a("x", "u"), t("!")]);
  });
  test("autolinks", () => {
    expect(parseInline("<https://x.dev/a?b=1> <mailto:a@b.c>")).toEqual([a("https://x.dev/a?b=1", "https://x.dev/a?b=1"), t(" "), a("mailto:a@b.c", "mailto:a@b.c")]);
    expect(parseInline("vector<std::string> a < b <https://x y>")).toEqual([t("vector<std::string> a < b <"), a("https://x", "https://x"), t(" y>")]);
  });
  test("bare URLs end before closing punctuation", () => {
    const url = (source: string) => parseInline(source).filter((run) => run.href).map((run) => run.href);
    expect(parseInline("see https://x.dev/a.")).toEqual([t("see "), a("https://x.dev/a", "https://x.dev/a"), t(".")]);
    expect(url("(see http://x.dev/a_b?c=d&e=f#g), ok")).toEqual(["http://x.dev/a_b?c=d&e=f#g"]);
    expect(url("https://en.wikipedia.org/wiki/A_(b) and (https://en.wikipedia.org/wiki/A_(b))")).toEqual([
      "https://en.wikipedia.org/wiki/A_(b)",
      "https://en.wikipedia.org/wiki/A_(b)",
    ]);
    expect(url("is it https://x.dev/a?! or https://y.dev/b;")).toEqual(["https://x.dev/a", "https://y.dev/b"]);
    expect(parseInline("**https://x.dev**")).toEqual([{ text: "https://x.dev", bold: true, href: "https://x.dev" }]);
    expect(parseInline("打开https://x.dev/a，然后")).toEqual([t("打开"), a("https://x.dev/a", "https://x.dev/a"), t("，然后")]);
    expect(parseInline("xhttps://x.dev http:// https://")).toEqual([t("xhttps://x.dev http:// https://")]);
    expect(parseInline("the http server, html, h")).toEqual([t("the http server, html, h")]);
  });
  test("backslash escapes", () => {
    expect(parseInline("\\*not\\* \\_it\\_ \\`c\\` \\[x\\](y) \\# \\\\ 2\\. \\<br>")).toEqual([t("*not* _it_ `c` [x](y) # \\ 2. <br>")]);
    expect(parseInline("C:\\dir\\name and a\\")).toEqual([t("C:\\dir\\name and a\\")]);
    expect(parseInline("\\*\\*not bold\\*\\* and **a\\*b**")).toEqual([t("**not bold** and "), b("a*b")]);
  });
  test("entities", () => {
    expect(text("&amp; &lt;b&gt; &quot;q&quot; &#39;s&#39; a&nbsp;b &#123; &#x1F; &#x4E2D; &#x1F600;")).toBe("& <b> \"q\" 's' a\u00a0b { \u001f 中 😀");
    expect(text("&unknown; &amp &; &#; &#x; &#xZZ; AT&T R&D;")).toBe("&unknown; &amp &; &#; &#x; &#xZZ; AT&T R&D;");
    expect(text("&#0; &#xD800; &#1114112;")).toBe("\ufffd \ufffd \ufffd");
    // an entity is text, not markup
    expect(parseInline("&#42;x&#42;")).toEqual([t("*x*")]);
  });
  test("HTML other than <br> is literal", () => {
    expect(parseInline("a <b>bold</b> <!-- c --> <img src=x> 1 < 2")).toEqual([t("a <b>bold</b> <!-- c --> <img src=x> 1 < 2")]);
  });
  test("whitespace around the text is dropped", () => {
    expect(parseInline("  a  ")).toEqual([t("a")]);
    expect(parseInline(" \n ")).toEqual([]);
    expect(parseInline("")).toEqual([]);
  });
});

describe("CJK", () => {
  test("emphasis beside CJK characters and punctuation, no spaces", () => {
    expect(parseInline("这是**重点**，然后")).toEqual([t("这是"), b("重点"), t("，然后")]);
    expect(parseInline("**注意：**后面")).toEqual([b("注意："), t("后面")]);
    expect(parseInline("请*务必*先运行`bun test`再提交。")).toEqual([t("请"), i("务必"), t("先运行"), c("bun test"), t("再提交。")]);
    expect(parseInline("（**原因**）和「*结果*」以及~~旧方案~~。")).toEqual([
      t("（"),
      b("原因"),
      t("）和「"),
      i("结果"),
      t("」以及"),
      { text: "旧方案", strike: true },
      t("。"),
    ]);
    expect(parseInline("**第一步：**安装依赖；**第二步：**运行测试。")).toEqual([b("第一步："), t("安装依赖；"), b("第二步："), t("运行测试。")]);
    expect(parseInline("详见[文档](https://x.dev/文档)。")).toEqual([t("详见"), a("文档", "https://x.dev/文档"), t("。")]);
    expect(parseInline("日本語の**強調**です。한국어 **강조**입니다.")).toEqual([t("日本語の"), b("強調"), t("です。한국어 "), b("강조"), t("입니다.")]);
  });
  test("a full-width space is a space", () => {
    expect(parseInline("a **\u3000b**")).toEqual([t("a **\u3000b**")]);
  });
});

const ANSWER = `# 修复方案

问题出在 \`wrapText\` 的**断行逻辑**：当一行以全角标点结尾时，
宽度计算少算了一个字符。**注意：**这只影响 CJK 文本。

## 改动

1. 在 \`tokenize\` 里把标点并入前一个 token：
   \`\`\`ts
   if (CLOSING.has(cp)) {
     last.end = at + 1; // 标点跟随前一个字
   }
   \`\`\`
2. 更新测试，覆盖以下情况：
   - 行尾是*句号*
   - 行尾是 emoji 😀
     - 以及代理对
3. ~~重写整个模块~~（没有必要）

> 提示：运行 \`bun test pocketui\` 之前先执行 \`bun install\`。
> 详见 [文档](https://example.com/docs/测试)。

| 设备 | 分辨率 | 耗时 |
|:-----|:------:|-----:|
| PSP | 480×272 | 12 ms |
| Thor | 1920×1080 | **3 ms** |

- [x] 修复断行
- [ ] 补充文档

---

完成后请查看 https://example.com/pr/42。
`;

describe("a realistic answer", () => {
  const blocks = md(ANSWER);
  test("block structure", () => {
    expect(blocks.map((block) => block.t)).toEqual(["h", "p", "h", "list", "quote", "table", "list", "hr", "p"]);
  });
  test("the paragraph joins its lines and styles its runs", () => {
    expect(blocks[1]).toEqual(
      p(t("问题出在 "), c("wrapText"), t(" 的"), b("断行逻辑"), t("：当一行以全角标点结尾时，宽度计算少算了一个字符。"), b("注意："), t("这只影响 CJK 文本。")),
    );
  });
  test("the ordered list holds code, a nested list and a struck item", () => {
    const list = blocks[3] as Extract<Block, { t: "list" }>;
    expect(list.ordered).toBe(true);
    expect(list.items.length).toBe(3);
    expect(list.items[0]!.blocks[1]).toEqual({ t: "code", lang: "ts", text: "if (CLOSING.has(cp)) {\n  last.end = at + 1; // 标点跟随前一个字\n}" });
    expect(list.items[1]!.blocks[1]).toEqual(bullets([p(t("行尾是"), i("句号"))], [p(t("行尾是 emoji 😀")), bullets([p(t("以及代理对"))])]));
    expect(list.items[2]!.blocks).toEqual([p({ text: "重写整个模块", strike: true }, t("（没有必要）"))]);
  });
  test("the quote, table, tasks and the closing link", () => {
    expect(blocks[4]).toEqual({
      t: "quote",
      blocks: [p(t("提示：运行 "), c("bun test pocketui"), t(" 之前先执行 "), c("bun install"), t("。详见 "), a("文档", "https://example.com/docs/测试"), t("。"))],
    });
    expect(blocks[5]).toEqual({
      t: "table",
      head: [[t("设备")], [t("分辨率")], [t("耗时")]],
      rows: [
        [[t("PSP")], [t("480×272")], [t("12 ms")]],
        [[t("Thor")], [t("1920×1080")], [b("3 ms")]],
      ],
      align: ["left", "center", "right"],
    });
    expect((blocks[6] as Extract<Block, { t: "list" }>).items.map((item) => item.checked)).toEqual([true, false]);
    expect(blocks[8]).toEqual(p(t("完成后请查看 "), a("https://example.com/pr/42", "https://example.com/pr/42"), t("。")));
  });
  test("as plain text", () => {
    expect(plainText(blocks)).toBe(`修复方案

问题出在 wrapText 的断行逻辑：当一行以全角标点结尾时，宽度计算少算了一个字符。注意：这只影响 CJK 文本。

改动

1. 在 tokenize 里把标点并入前一个 token：
   if (CLOSING.has(cp)) {
     last.end = at + 1; // 标点跟随前一个字
   }
2. 更新测试，覆盖以下情况：
   - 行尾是句号
   - 行尾是 emoji 😀
     - 以及代理对
3. 重写整个模块（没有必要）

> 提示：运行 bun test pocketui 之前先执行 bun install。详见 文档。

设备 | 分辨率 | 耗时
PSP | 480×272 | 12 ms
Thor | 1920×1080 | 3 ms

- [x] 修复断行
- [ ] 补充文档

---

完成后请查看 https://example.com/pr/42。`);
  });
});

describe("plain text", () => {
  test("runsText joins the runs", () => {
    expect(runsText([])).toBe("");
    expect(runsText(parseInline("a **b** `c` [d](e)"))).toBe("a b c d");
  });
  test("every block kind", () => {
    const source = "# Title\n\npara one  \nsecond line\n\n```js\nlet a;\n\nlet b;\n```\n\n> quote\n>\n> - in quote\n\n7. seven\n8. eight\n\n   loose\n\n- a\n  - b\n-\n\n| a | b |\n|---|---|\n| 1<br>2 | |\n\n***";
    expect(plainText(md(source))).toBe(
      "Title\n\npara one\nsecond line\n\nlet a;\n\nlet b;\n\n> quote\n>\n> - in quote\n\n7. seven\n8. eight\n   loose\n\n- a\n  - b\n-\n\na | b\n1 2 | \n\n---",
    );
    expect(plainText([])).toBe("");
  });
});

describe("streaming", () => {
  test("unmatched delimiters are text", () => {
    expect(parseInline("**bold")).toEqual([t("**bold")]);
    expect(parseInline("a *b and `c and ~~d and __e")).toEqual([t("a *b and `c and ~~d and __e")]);
    expect(parseInline("bold** and c` d")).toEqual([t("bold** and c` d")]);
    expect(parseInline("**a* b")).toEqual([t("*"), i("a"), t(" b")]);
    expect(parseInline("``a` b")).toEqual([t("``a` b")]);
  });
  test("a half-written link is text until its last character", () => {
    expect(parseInline("see [the docs")).toEqual([t("see [the docs")]);
    expect(parseInline("see [the docs](")).toEqual([t("see [the docs](")]);
    expect(parseInline("see [the docs](gui")).toEqual([t("see [the docs](gui")]);
    expect(parseInline('see [the docs](guide.md "ti')).toEqual([t('see [the docs](guide.md "ti')]);
    expect(parseInline("see ![alt")).toEqual([t("see ![alt")]);
    expect(parseInline("see <https://x.de")).toEqual([t("see <"), a("https://x.de", "https://x.de")]);
    expect(parseInline("a &am")).toEqual([t("a &am")]);
  });
  // The choices for input that stops mid-construct. Each shows what the
  // finished construct will show, as far as it is known, and never throws.
  test("a lone # is an empty heading, and is text under a paragraph", () => {
    expect(md("#")).toEqual([{ t: "h", level: 1, runs: [] }]);
    expect(md("## ")).toEqual([{ t: "h", level: 2, runs: [] }]);
    expect(md("text\n#")).toEqual([p(t("text #"))]);
  });
  test("a list marker with nothing after it is an empty item, and is text under a paragraph", () => {
    expect(md("-")).toEqual([bullets([])]);
    expect(md("1.")).toEqual([numbered(1, [])]);
    expect(md("- a\n- ")).toEqual([bullets([p(t("a"))], [])]);
    expect(md("- [ ]")).toEqual([{ t: "list", ordered: false, start: 1, items: [{ blocks: [], checked: false }] }]);
    expect(md("- [")).toEqual([bullets([p(t("["))])]);
    expect(md("text\n-")).toEqual([p(t("text -"))]);
    expect(md("text\n1.")).toEqual([p(t("text 1."))]);
  });
  test("an unterminated table row is padded; a table shows once its delimiter row is finished", () => {
    const head = [[t("a")], [t("b")]];
    expect(md("| a | b |")).toEqual([p(t("| a | b |"))]);
    expect(md("| a | b |\n|---|--")).toEqual([p(t("| a | b | |---|--"))]);
    expect(md("| a | b |\n|---|---|")).toEqual([p(t("| a | b | |---|---|"))]);
    expect(md("| a | b |\n|---|---|\n")).toEqual([{ t: "table", head, rows: [], align: ["left", "left"] }]);
    expect(md("| a | b |\n|---|---|\n|")).toEqual([{ t: "table", head, rows: [[[], []]], align: ["left", "left"] }]);
    expect(md("| a | b |\n|---|---|\n| 1")).toEqual([{ t: "table", head, rows: [[[t("1")], []]], align: ["left", "left"] }]);
    expect(md("| a | b |\n|---|---|\n| 1 | **2")).toEqual([{ t: "table", head, rows: [[[t("1")], [t("**2")]]], align: ["left", "left"] }]);
  });
  test("the last line, while it may grow, does not change the block before it", () => {
    // "---" may become "---|---" or "---x": it ends the paragraph once its newline arrives
    expect(md("text\n---")).toEqual([p(t("text ---"))]);
    expect(md("text\n---\n")).toEqual([p(t("text")), { t: "hr" }]);
    expect(md("text\n\n---")).toEqual([p(t("text")), { t: "hr" }]);
    // "2" may become "2." and the next item, so it stays in the list
    expect(md("1. a\n\n2")).toEqual([numbered(1, [p(t("a")), p(t("2"))])]);
    expect(md("1. a\n\n2.")).toEqual([numbered(1, [p(t("a"))], [])]);
    expect(md("1. a\n\n2\n")).toEqual([numbered(1, [p(t("a"))]), p(t("2"))]);
    expect(md("1. a\n\n20 minutes")).toEqual([numbered(1, [p(t("a"))]), p(t("20 minutes"))]);
    // "* * *" may become the item "* * * x", so it is an item until its newline
    expect(md("* a\n* * *")).toEqual([bullets([p(t("a"))], [bullets([bullets([])])])]);
    expect(md("* a\n* * *\n")).toEqual([bullets([p(t("a"))]), { t: "hr" }]);
    expect(md("text\n- - -")).toEqual([p(t("text")), { t: "hr" }]);
  });
  test("an empty quote and an unclosed fence in a container", () => {
    expect(md(">")).toEqual([{ t: "quote", blocks: [] }]);
    expect(md("> ```js\n> a")).toEqual([{ t: "quote", blocks: [{ t: "code", lang: "js", text: "a", open: true }] }]);
    expect(md("- ```js\n  a")).toEqual([bullets([{ t: "code", lang: "js", text: "a", open: true }])]);
  });

  const DOCUMENT = `# 流式渲染 Streaming

第一段：模型一边生成，界面一边**重新解析**整段文本，
所以每个前缀都必须能解析。See the [design notes](https://example.com/notes?id=1) for *why*.

## Steps

1. Install the toolchain:
   \`\`\`sh
   curl -fsSL https://bun.sh/install | bash
   bun --version   # 1.4.2
   \`\`\`
2. Run the tests with \`bun test\`.

3. Read the output:
   - a failing test prints a **diff**
   - a passing one prints nothing
     - unless \`--verbose\` is set
10. Ship it.

Some notes follow, with a hard break  
and a second line: 2 * 3 = 6, snake_case_name, <br> and &amp; and a \\* star.
- tight bullet after a paragraph
- [x] a finished task
- [ ] an open one

> **注意：**引用里也可以有列表：
> 1. 第一项
> 2. 第二项
>
> > nested quote with \`code\`

| Device | Screen | Time |
|:-------|:------:|-----:|
| PSP | 480×272 | 12 ms |
| Thor | 1920×1080 | **3 ms** |
| Duo \\| Lite | 1080p | ~~9~~ 4 ms |

\`\`\`ts
export function parse(source: string): Block[] {
  // \`\`\` inside a comment is not a fence close
  return [];
}
\`\`\`

***

### 表格之后 After the table

1) first with a paren

2) second, loose
   continued on the next line

   and a second paragraph with ***bold italic*** and __bold__

+ plus bullet
+ another, with an image ![logo](https://example.com/logo.png)

~~~python
def main():
    print("tilde fence")
~~~

中文段落在行尾直接换行，
下一行接着写，不应该多出空格；English lines
get one space. 版本号是
2. 这一行不是列表，\`code with **stars**\` 也不是强调。
* 星号列表紧跟段落
  1. 里面的有序列表
  2. 第二项

Setext-looking text
---

最后一行没有换行，以 https://example.com/a_(b) 结尾，还有 **未闭合的强调`;

  test("every prefix parses, and a block that has a later block after it no longer changes", () => {
    expect(DOCUMENT.length).toBeGreaterThan(1400);
    let before: Block[] = [];
    for (let end = 1; end <= DOCUMENT.length; end++) {
      const prefix = DOCUMENT.slice(0, end);
      const blocks = md(prefix);
      const settled = before.slice(0, -1);
      const now = blocks.slice(0, settled.length);
      if (JSON.stringify(now) !== JSON.stringify(settled)) {
        throw new Error(`a settled block changed at ${JSON.stringify(prefix.slice(-40))}:\n${JSON.stringify(settled)}\n${JSON.stringify(now)}`);
      }
      before = blocks;
    }
    expect(before.map((block) => block.t)).toEqual(["h", "p", "h", "list", "p", "list", "quote", "table", "code", "hr", "h", "list", "list", "code", "p", "list", "p", "hr", "p"]);
    expect(before[before.length - 1]).toEqual(
      p(t("最后一行没有换行，以 "), a("https://example.com/a_(b)", "https://example.com/a_(b)"), t(" 结尾，还有 **未闭合的强调")),
    );
  });
  test("the same over generated documents of block fragments", () => {
    const fragments = ["- ", "* ", "1. ", "2. ", "10. ", "1) ", "> ", "# ", "## ", "---", "***", "* * *", "- - -", "```", "~~~", "```js", "| a | b |", "|---|---|", "---|---", "a | b", "text", "more words", "2", "12", "#", "-", "*", "  ", "    ", "\n", "\n", "\n", "\n\n", "x", " ", "`", "**", "[ ] ", "[x] ", "|", ":-:", "中文", "="];
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let round = 0; round < 3000; round++) {
      let source = "";
      const count = 2 + Math.floor(random() * 16);
      for (let k = 0; k < count; k++) source += fragments[Math.floor(random() * fragments.length)];
      let before: Block[] = [];
      for (let end = 1; end <= source.length; end++) {
        const blocks = md(source.slice(0, end));
        const settled = JSON.stringify(before.slice(0, -1));
        if (JSON.stringify(blocks.slice(0, Math.max(0, before.length - 1))) !== settled) {
          throw new Error(`a settled block changed at ${JSON.stringify(source.slice(0, end))}`);
        }
        before = blocks;
      }
    }
  });
  test("every prefix of the realistic answer too, with \\r\\n line endings", () => {
    const source = ANSWER.replace(/\n/g, "\r\n");
    let before: Block[] = [];
    for (let end = 1; end <= source.length; end++) {
      const blocks = md(source.slice(0, end));
      expect(blocks.slice(0, Math.max(0, before.length - 1))).toEqual(before.slice(0, -1));
      before = blocks;
    }
    expect(before).toEqual(md(ANSWER));
  });
});

describe("pathological input", () => {
  const N = 10000;
  // No wall-clock budget: the suite's time limit per test (5 s) is what a
  // parser that backtracks over ten thousand delimiters would run into.
  const quick = (source: string) => md(source);
  test("ten thousand of one delimiter", () => {
    expect(quick("*".repeat(N))).toEqual([{ t: "hr" }]);
    expect(quick("a" + "*".repeat(N))).toEqual([p(t("a" + "*".repeat(N)))]);
    expect(quick("a" + "*".repeat(N) + "b" + "*".repeat(N))).toEqual([p(t("a"), b("b"))]);
    for (const ch of ["_", "~", "`", "[", "]", "(", ")", "!", "<", ">", "&", "\\", "#", "-", "+", "|", ">", " ", "\t", "\n", "h"]) {
      quick(ch.repeat(N));
      quick("x" + ch.repeat(N) + "y");
    }
  });
  test("ten thousand openers that never close, and closers that never opened", () => {
    for (const unit of ["*a ", "**a ", "_a ", "a* ", "a** ", "*a* *", "**a*b ", "a*b**c", "~~a ", "`a ", "``a` ", "[a ", "[a](b ", "[a](b", "![", "[a](<b ", '[a](b "c ', "](", "<a ", "<http://a ", "&a", "&#x", "http://", "https://a) ", "\\", "1. ", "- ", "> - ", "| a ", "x\n", "\n\n- [ ] ", "[]()\n"]) {
      quick(unit.repeat(N));
    }
  });
  test("ten thousand brackets", () => {
    expect(quick("[".repeat(N))).toEqual([p(t("[".repeat(N)))]);
    expect(quick("[".repeat(N) + "a" + "]".repeat(N))).toEqual([p(t("[".repeat(N) + "a" + "]".repeat(N)))]);
    expect(quick("[".repeat(N) + "a" + "](u)".repeat(N)).length).toBe(1);
    expect(quick("![".repeat(N) + "a" + "](u)".repeat(N))).toEqual([p(a("a", "u"))]);
    quick("[a](" + "(".repeat(N) + ")".repeat(N) + ")");
  });
  test("nesting deeper than the limit stays text and does not overflow the stack", () => {
    const quotes = quick(">".repeat(N) + " deep");
    let depth = 0;
    let block: Block = quotes[0]!;
    while (block.t === "quote") {
      depth++;
      block = block.blocks[0]!;
    }
    expect(depth).toBe(16);
    expect<Block>(block).toEqual(p(t(">".repeat(N - 16) + " deep")));
    expect(plainText(quotes)).toBe("> ".repeat(16) + ">".repeat(N - 16) + " deep");
    quick("> ".repeat(N) + "deep");
    quick("- ".repeat(N) + "deep");
    quick("1. ".repeat(N) + "deep");
    let stairs = "";
    for (let k = 0; k < 400; k++) stairs += ">".repeat(k + 1) + " line\n";
    quick(stairs);
    let steps = "";
    for (let k = 0; k < 400; k++) steps += " ".repeat(k * 2) + "- item\n";
    quick(steps);
  });
  test("rows, emphasis and code spans of every length", () => {
    quick("|".repeat(100) + "\n" + "|-".repeat(99) + "|\n" + ("|x".repeat(200) + "\n").repeat(200));
    let runs = "";
    for (let k = 1; k <= 300; k++) runs += "`".repeat(k) + " ";
    quick(runs);
    let stars = "";
    for (let k = 1; k <= 300; k++) stars += "*".repeat(k) + "a";
    quick(stars);
    quick("*a_b~~c".repeat(N) + "~~c_b*a".repeat(N));
  });
  test("never throws on noise", () => {
    const alphabet = ["*", "_", "`", "~", "[", "]", "(", ")", "!", "<", ">", "&", "#", "-", "+", "|", "\\", "\n", "\n", " ", " ", "  ", "\t", "a", "1", ".", "重", "，", "😀", ":", '"', "http://x", "br", ";", "x"];
    let seed = 12345;
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let round = 0; round < 400; round++) {
      let source = "";
      const length = 1 + Math.floor(random() * 120);
      for (let k = 0; k < length; k++) source += alphabet[Math.floor(random() * alphabet.length)];
      const blocks = md(source);
      expect(typeof plainText(blocks)).toBe("string");
    }
  });
});

describe("long input", () => {
  // The times are printed, not asserted: a test machine's load moves them.
  test("a 64 KB answer", () => {
    let source = "";
    while (source.length < 64 * 1024) source += ANSWER + "\n";
    expect(source.length).toBeLessThan(66 * 1024);
    let blocks: Block[] = [];
    for (let k = 0; k < 5; k++) parseMarkdown(source); // let the JIT see it first
    const ms = fastest(10, () => {
      blocks = parseMarkdown(source);
    });
    check(blocks);
    expect(blocks.length).toBeGreaterThan(500);
    console.log(`64 KB (${source.length} UTF-16 units, ${blocks.length} blocks): ${ms.toFixed(2)} ms`);
  });
  test("a message streamed to 64 KB in 1 KB steps", () => {
    let source = "";
    while (source.length < 64 * 1024) source += ANSWER + "\n";
    let last: Block[] = [];
    const ms = fastest(3, () => {
      for (let end = 1024; end <= 64 * 1024; end += 1024) last = parseMarkdown(source.slice(0, end));
    });
    expect(last).toEqual(parseMarkdown(source.slice(0, 64 * 1024)));
    console.log(`64 parses, 1 KB to 64 KB: ${ms.toFixed(2)} ms`);
  });
});
