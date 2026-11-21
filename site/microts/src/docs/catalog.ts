// The pocketjs docs pages this site renders: every page in the MicroTS section
// of site/nav.ts plus the TypeScript support reference. The Markdown source is
// site/content/docs/<slug>.md, the same file pocketjs.dev renders, so both
// sites change in the same commit.
import { DOC_NAV, type DocItem } from "../../../nav.ts";

export const POCKETJS_SITE = "https://pocketjs.pocket.nexus";

const SECTION = "MicroTS";
const EXTRA = ["typescript-support"];

const all = DOC_NAV.flatMap((s) => s.items);
const section = DOC_NAV.find((s) => s.title === SECTION)?.items ?? [];

export const MICROTS_DOCS: DocItem[] = [
  ...section,
  ...EXTRA.map((slug) => {
    const item = all.find((i) => i.slug === slug);
    if (!item) throw new Error(`site/nav.ts has no docs page "${slug}"`);
    return item;
  }),
];

export const LOCAL_DOCS = new Set(MICROTS_DOCS.map((d) => d.slug));
