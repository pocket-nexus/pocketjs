// site/candy.ts — candy pixel headlines, split per letter at build time.
//
// site/assets/arcade.css draws each headline letter as its own sticker: a
// candy fill cycling through five hues, a plum outline and a stepped drop.
// That needs one element per letter. Splitting in the browser would paint the
// plain headline first and then swap it, so every page's HTML is rewritten
// here before it is written to site/dist/.
//
// A split headline keeps its whole text once for assistive technology:
//   <h2 class="verb … ar-candy">
//     <span class="ar-sr">Familiar tools</span>
//     <span class="ar-vis" aria-hidden="true">
//       <span class="ar-w"><span class="ar-ch ar-c" style="--i:0">F</span>…</span> …
//     </span>
//   </h2>

const HUES = ["p", "y", "c", "l", "o"] as const;

interface Target {
  selector: string;
  /** Hue of the first letter; omitted targets take turns from a shared counter. */
  start?: number;
  /** Small marks (the wordmark) get the short outline instead of the full extrusion. */
  small?: boolean;
}

const TARGETS: Target[] = [
  { selector: ".hero h1 .spectrum", start: 0 },
  { selector: ".nav .mark .nm", start: 0, small: true },
  { selector: ".foot .mark .nm", start: 0, small: true },
  // section heads and showcase dialog titles, each starting two hues on
  { selector: ".vwrap .verb" },
  { selector: ".sc-dialog h2" },
  { selector: ".doc-content > h1:first-child", start: 1 },
  { selector: "main > section > h1:first-child", start: 3 },
];

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (raw: string) =>
  raw.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return ENTITIES[name.toLowerCase()] ?? all;
  });
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The letter markup for one headline; "\n" in `text` marks a <br>. */
function letters(text: string, start: number): string {
  let hue = start;
  let index = 0;
  const lines = text.split("\n").map((line) =>
    line.replace(/\s+/g, " ").split(/( )/).map((part) => {
      if (!part) return "";
      if (part === " ") return " ";
      const chars = [...part].map((ch) =>
        `<span class="ar-ch ar-${HUES[hue++ % HUES.length]}" style="--i:${index++}">${escape(ch)}</span>`);
      return `<span class="ar-w">${chars.join("")}</span>`;
    }).join(""));
  const readable = text.replace(/\s+/g, " ").trim();
  return `<span class="ar-sr">${escape(readable)}</span><span class="ar-vis" aria-hidden="true">${lines.join("<br>")}</span>`;
}

/** Rewrite every candy headline in a page. Other markup passes through unchanged. */
export function candyHeadings(html: string): string {
  let turn = 0;
  let text: string[] | null = null;
  const rewriter = new HTMLRewriter();
  for (const target of TARGETS) {
    rewriter.on(target.selector, {
      element(el) {
        const start = target.start ?? (turn++ * 2) % HUES.length;
        const parts: string[] = [];
        text = parts;
        const classes = [el.getAttribute("class") ?? "", "ar-candy", target.small ? "ar-sm" : ""];
        el.setAttribute("class", classes.filter(Boolean).join(" "));
        el.onEndTag((end) => {
          end.before(letters(decode(parts.join("")), start), { html: true });
          text = null;
        });
      },
      text(chunk) {
        text?.push(chunk.text);
        chunk.remove();
      },
    });
    // a <br> becomes a line break between letter runs; any other child element
    // gives up its tags and keeps its text
    rewriter.on(`${target.selector} *`, {
      element(el) {
        if (el.tagName === "br") {
          text?.push("\n");
          el.remove();
        } else {
          el.removeAndKeepContent();
        }
      },
    });
  }
  return rewriter.transform(html);
}
