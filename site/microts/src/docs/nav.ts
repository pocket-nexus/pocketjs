// Docs sidebar. Titles come from site/nav.ts (via catalog.ts); this file only
// regroups the pages in MicroTS reading order and adds a one-line blurb per
// page. A MicroTS page added to site/nav.ts and missing here lands at the end
// of "Guides".
import { DOCS, type DocPage } from "microts:docs";
import { MICROTS_DOCS } from "./catalog";

export interface DocItem {
  slug: string;
  title: string;
  blurb: string;
}
export interface DocSection {
  title: string;
  items: DocItem[];
}

const GROUPS: { title: string; items: [slug: string, blurb: string][] }[] = [
  {
    title: "Start",
    items: [["microts", "How a Vue template becomes Rust, then a counter from source to native frame loop."]],
  },
  {
    title: "Guides",
    items: [
      ["microts-components", "Props, events, instance state, v-model, keyed lists, slots and context."],
      ["microts-solid", "The Solid front end: TSX views over the same View IR."],
      ["microts-model", "Compiled mode: state, reactions, cached values and tasks."],
      ["microts-boundaries", "What runs in TypeScript, in generated Rust and in the host."],
    ],
  },
  {
    title: "Reference",
    items: [
      ["microts-reference", "Template syntax, host elements, input handlers, CLI flags and diagnostics."],
      ["typescript-support", "Execution modes, types, numbers, expressions and current limits."],
    ],
  },
];

const titleOf = new Map(MICROTS_DOCS.map((d) => [d.slug, d.title]));

export const DOC_NAV: DocSection[] = GROUPS.map((g) => ({
  title: g.title,
  items: g.items.filter(([slug]) => titleOf.has(slug)).map(([slug, blurb]) => ({ slug, title: titleOf.get(slug)!, blurb })),
}));
const grouped = new Set(GROUPS.flatMap((g) => g.items.map(([slug]) => slug)));
DOC_NAV.find((s) => s.title === "Guides")!.items.push(
  ...MICROTS_DOCS.filter((d) => !grouped.has(d.slug)).map((d) => ({ slug: d.slug, title: d.title, blurb: "" })),
);

export const DOC_ITEMS: DocItem[] = DOC_NAV.flatMap((s) => s.items);

export function loadDoc(slug: string): Promise<DocPage> | undefined {
  return DOCS[slug]?.().then((m) => m.default);
}
