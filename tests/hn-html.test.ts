// tests/hn-html.test.ts — Hacker News text handling: comment HTML to plain
// text (apps/hn/html.ts) and the ASCII folding every runtime string passes
// before it reaches the 3DS's baked glyph atlases (apps/home/ui/text.ts).

import { describe, expect, test } from "bun:test";
import { ageLong, ageText, decodeEntities, domainOf, htmlToText } from "../apps/hn/html.ts";
import { toAscii } from "../apps/home/ui/text.ts";

describe("htmlToText", () => {
  test("paragraphs become blank-line breaks; <p> is never closed in HN bodies", () => {
    expect(htmlToText("First paragraph.<p>Second one.<p>Third.")).toBe("First paragraph.\n\nSecond one.\n\nThird.");
  });

  test("links read as their text, <i> and unknown tags vanish", () => {
    const html = 'See <a href="https:&#x2F;&#x2F;example.com&#x2F;a" rel="nofollow">https:&#x2F;&#x2F;example.com&#x2F;a</a> and <i>this</i> <b>too</b>.';
    expect(htmlToText(html)).toBe("See https://example.com/a and this too.");
  });

  test("entities decode: named, decimal and hex", () => {
    expect(decodeEntities("&quot;a&quot; &amp; &lt;b&gt; it&#x27;s &#39;c&#39; &#x2F; &nbsp;x")).toBe("\"a\" & <b> it's 'c' /  x");
    expect(decodeEntities("&mdash;&hellip;&rsquo;")).toBe("—…’");
    expect(decodeEntities("&unknown; &#0; &#xD800;")).toBe("&unknown;  ");
  });

  test("code blocks keep their line breaks and indentation", () => {
    const html = "Try:<p><pre><code>  let x = 1;\n  if (x &gt; 0) {}\n</code></pre>Then run it.";
    expect(htmlToText(html)).toBe("Try:\n\n  let x = 1;\n  if (x > 0) {}\n\nThen run it.");
  });

  test("whitespace collapses inside a paragraph; empty input stays empty", () => {
    expect(htmlToText("  lots   of\t\tspace  <p>  next  ")).toBe("lots of space\n\nnext");
    expect(htmlToText("")).toBe("");
    expect(htmlToText("<p><p>")).toBe("");
  });
});

describe("toAscii", () => {
  test("typographic punctuation folds to ASCII", () => {
    expect(toAscii("“Quoted” — it’s … – done")).toBe('"Quoted" - it\'s ... - done');
  });

  test("accented Latin loses its accents; ligatures spell out", () => {
    expect(toAscii("Café naïve Ångström Straße æsir")).toBe("Cafe naive Angstrom Strasse aesir");
  });

  test("anything else becomes ?; emoji variation selectors drop", () => {
    expect(toAscii("東京 ❤️")).toBe("?? ?");
    expect(toAscii("tab\there\nline")).toBe("tab here\nline");
  });
});

describe("story metadata", () => {
  test("domains drop www and paths", () => {
    expect(domainOf("https://www.Example.com/a/b?c")).toBe("example.com");
    expect(domainOf("http://sub.example.org:8080/")).toBe("sub.example.org");
    expect(domainOf(undefined)).toBe("");
  });

  test("ages", () => {
    const now = 1_000_000 * 1000;
    expect(ageText(1_000_000 - 30, now)).toBe("now");
    expect(ageText(1_000_000 - 5 * 60, now)).toBe("5m");
    expect(ageText(1_000_000 - 3 * 3600, now)).toBe("3h");
    expect(ageText(1_000_000 - 2 * 86400, now)).toBe("2d");
    expect(ageLong(1_000_000 - 3600, now)).toBe("1 hour ago");
    expect(ageLong(1_000_000 - 7200, now)).toBe("2 hours ago");
  });
});
