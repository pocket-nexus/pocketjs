// Build-time Markdown rendering for the docs pages and the homepage code tabs.
// Headings get GitHub-style anchors like site/build.ts, so in-page links in the
// shared docs resolve on both sites. Links to docs pages this site does not
// render point back to pocketjs.pocket.nexus.
import { Marked, type Tokens } from "marked";
import { createHighlighter, type Highlighter } from "shiki";
import { LOCAL_DOCS, POCKETJS_SITE } from "../src/docs/catalog.ts";

export interface TocEntry {
  depth: number;
  id: string;
  text: string;
}

const LANG_ALIAS: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  sh: "bash",
  shell: "bash",
  console: "bash",
  jsonc: "json",
  rs: "rust",
  txt: "text",
};

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function rewriteHref(href: string): { href: string; external: boolean } {
  const m = href.match(/^\/docs\/([a-z0-9-]+)\/?(#.*)?$/);
  if (m) {
    const [, slug, hash = ""] = m;
    if (LOCAL_DOCS.has(slug)) return { href: `/docs/${slug}${hash}`, external: false };
    return { href: `${POCKETJS_SITE}/docs/${slug}/${hash}`, external: true };
  }
  if (href.startsWith("/")) return { href: POCKETJS_SITE + href, external: true };
  return { href, external: /^https?:/.test(href) };
}

let highlighterPromise: Promise<Highlighter> | undefined;
export function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({
    themes: ["one-dark-pro"],
    langs: ["tsx", "typescript", "javascript", "json", "bash", "rust", "toml", "html", "vue", "css", "diff"],
  });
  return highlighterPromise;
}

export function highlight(hl: Highlighter, code: string, rawLang: string): string {
  const raw = (rawLang || "").trim().split(/\s+/)[0].toLowerCase();
  const lang = LANG_ALIAS[raw] ?? raw;
  const use = hl.getLoadedLanguages().includes(lang) ? lang : "text";
  return hl.codeToHtml(code.replace(/\n$/, ""), { theme: "one-dark-pro", lang: use });
}

export async function renderMarkdown(source: string): Promise<{ html: string; title: string; toc: TocEntry[] }> {
  const hl = await getHighlighter();
  const toc: TocEntry[] = [];
  let title = "";
  const marked = new Marked({
    renderer: {
      code({ text, lang }: Tokens.Code) {
        const label = (lang || "").split(/\s+/)[0];
        const body = highlight(hl, text, label);
        const tag = label && label !== "text" ? `<span class="code-lang">${escapeAttr(label)}</span>` : "";
        return `<div class="code-block">${tag}${body}</div>\n`;
      },
      heading({ tokens, depth, text }: Tokens.Heading) {
        const html = this.parser.parseInline(tokens);
        if (depth === 1) {
          title = text.replace(/[`*_]/g, "");
          return "";
        }
        const id = slugify(text);
        const plain = html.replace(/<[^>]+>/g, "");
        if (depth <= 3) toc.push({ depth, id, text: plain });
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${html}</h${depth}>\n`;
      },
      link({ href, title: linkTitle, tokens }: Tokens.Link) {
        const inner = this.parser.parseInline(tokens);
        const r = rewriteHref(href);
        const t = linkTitle ? ` title="${escapeAttr(linkTitle)}"` : "";
        const ext = r.external ? ' target="_blank" rel="noopener"' : ' data-internal=""';
        return `<a href="${escapeAttr(r.href)}"${t}${ext}>${inner}</a>`;
      },
      table(token: Tokens.Table) {
        const cell = (c: Tokens.TableCell) => {
          const align = c.align ? ` style="text-align:${c.align}"` : "";
          const tag = c.header ? "th" : "td";
          return `<${tag}${align}>${this.parser.parseInline(c.tokens)}</${tag}>`;
        };
        const head = `<tr>${token.header.map(cell).join("")}</tr>`;
        const rows = token.rows.map((r) => `<tr>${r.map(cell).join("")}</tr>`).join("");
        return `<div class="table-wrap"><table><thead>${head}</thead><tbody>${rows}</tbody></table></div>\n`;
      },
    },
  });
  const html = await marked.parse(source);
  return { html, title, toc };
}

/** `foo.md?tabs`: the first code block under each `## Title` becomes one tab. */
export async function renderTabs(source: string): Promise<{ title: string; lang: string; code: string; html: string }[]> {
  const hl = await getHighlighter();
  const tabs: { title: string; lang: string; code: string; html: string }[] = [];
  const re = /^## (.+)\n+```(\w*)\n([\s\S]*?)\n```/gm;
  for (const m of source.matchAll(re)) {
    const [, title, lang, code] = m;
    tabs.push({ title: title!.trim(), lang: lang!, code: code!, html: highlight(hl, code!, lang!) });
  }
  return tabs;
}
