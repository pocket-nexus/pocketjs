// docs/RELAY.md prose gate. AGENTS.md bars adverbs that modify a verb or
// adjective in docs/ reference prose ("delete the adverb, or replace it
// with the fact it was standing in for"). Review 986 failed task 974 on
// "still", "instead" and "also" in this file; this test keeps the named
// empty adverbs out of the prose. Fenced code blocks and inline code spans
// are skipped: an identifier or error string may contain any word.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const DOC = new URL("../docs/RELAY.md", import.meta.url);

/** AGENTS.md's own examples plus the words review 986 flagged in this file. */
const BANNED_ADVERBS = [
  "simply", "just", "actually", "typically", "carefully", "silently", "properly",
  "still", "instead", "also", "already",
];

/** Prose lines only: fenced blocks dropped, inline code spans blanked. */
function proseLines(markdown: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let fenced = false;
  markdown.split("\n").forEach((raw, i) => {
    if (raw.startsWith("```")) { fenced = !fenced; return; }
    if (fenced) return;
    out.push({ line: i + 1, text: raw.replace(/`[^`]*`/g, "`code`") });
  });
  return out;
}

test("docs/RELAY.md prose carries none of the banned adverbs", () => {
  const pattern = new RegExp(`\\b(${BANNED_ADVERBS.join("|")})\\b`, "i");
  const hits = proseLines(readFileSync(DOC, "utf8"))
    .filter(({ text }) => pattern.test(text))
    .map(({ line, text }) => `docs/RELAY.md:${line}: ${text.trim()}`);
  expect(hits).toEqual([]);
});

test("the prose filter skips fenced blocks and inline code but not prose", () => {
  const sample = "prose still here\n```\nstill fenced\n```\nsee `still` code\nfine line";
  const lines = proseLines(sample);
  expect(lines.map((l) => l.line)).toEqual([1, 5, 6]);
  expect(lines[1].text).toBe("see `code` code");
  expect(lines.filter((l) => /\bstill\b/.test(l.text)).map((l) => l.line)).toEqual([1]);
});
