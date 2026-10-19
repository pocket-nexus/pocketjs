// apps/hn/html.ts — Hacker News comment HTML to plain text.
//
// The API returns comment and Ask HN bodies as a small HTML subset: <p>
// between paragraphs (never closed), <a href> links whose text is the URL,
// <i>, <pre><code> blocks, and entities (&#x27; &quot; &gt; &#x2F; …). The
// 3DS draws text runs only, so this keeps the words and the paragraph breaks
// and drops the markup. Pure: tests/hn-html.test.ts runs it under Bun.

// Code points, not literals: every string literal in the bundle is baked into
// every glyph atlas, and these characters are folded to ASCII before drawing.
const NAMED: Record<string, number> = {
  amp: 0x26, lt: 0x3c, gt: 0x3e, quot: 0x22, apos: 0x27, nbsp: 0xa0,
  mdash: 0x2014, ndash: 0x2013, hellip: 0x2026, lsquo: 0x2018, rsquo: 0x2019,
  ldquo: 0x201c, rdquo: 0x201d, bull: 0x2022, middot: 0xb7, times: 0xd7, copy: 0xa9, eacute: 0xe9,
};

/** Decode HTML character references; unknown names stay as written. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "";
      return String.fromCodePoint(code);
    }
    const code = NAMED[body];
    return code === undefined ? whole : String.fromCodePoint(code);
  });
}

/** Comment HTML to text: paragraphs separated by one blank line, code blocks
 *  keep their line breaks, links read as their text, other tags vanish. */
export function htmlToText(html: string): string {
  if (!html) return "";
  const blocks: string[] = [];
  // Code blocks first, so their newlines survive the whitespace collapse.
  let source = html.replace(/<pre>\s*<code>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_, code: string) => {
    blocks.push(decodeEntities(code.replace(/<[^>]*>/g, "")).replace(/\s+$/, ""));
    return `\n\n\u0000${blocks.length - 1}\u0000\n\n`;
  });
  source = source
    .replace(/<a\s[^>]*>([\s\S]*?)<\/a>/gi, "$1")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?p\s*\/?>/gi, "\n\n")
    .replace(/<[^>]*>/g, "");
  const paragraphs = source
    .split(/\n{2,}/)
    .map((paragraph) =>
      decodeEntities(paragraph.replace(/[ \t\r]+/g, " ").replace(/ ?\n ?/g, "\n").trim()),
    )
    .filter((paragraph) => paragraph !== "");
  return paragraphs
    .join("\n\n")
    .replace(/\u0000(\d+)\u0000/g, (_, index: string) => blocks[Number(index)] ?? "")
    .trim();
}

/** "example.com" from a story URL ("www." dropped); "" without one. */
export function domainOf(url: string | undefined): string {
  if (!url) return "";
  const match = /^[a-z]+:\/\/([^/?#:]+)/i.exec(url);
  return match ? match[1]!.replace(/^www\./i, "").toLowerCase() : "";
}

/** "now", "5m", "3h", "2d", "4mo", "3y" — HN's ages, compact. */
export function ageText(unixSeconds: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor(nowMs / 1000) - unixSeconds);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)}d`;
  if (seconds < 86400 * 365) return `${Math.floor(seconds / (86400 * 30))}mo`;
  return `${Math.floor(seconds / (86400 * 365))}y`;
}

/** "3 hours ago" — the reading pane's long form. */
export function ageLong(unixSeconds: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor(nowMs / 1000) - unixSeconds);
  const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? "" : "s"} ago`;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return unit(Math.floor(seconds / 60), "minute");
  if (seconds < 86400) return unit(Math.floor(seconds / 3600), "hour");
  if (seconds < 86400 * 30) return unit(Math.floor(seconds / 86400), "day");
  if (seconds < 86400 * 365) return unit(Math.floor(seconds / (86400 * 30)), "month");
  return unit(Math.floor(seconds / (86400 * 365)), "year");
}
