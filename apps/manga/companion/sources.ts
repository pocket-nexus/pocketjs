import { createHash } from "node:crypto";
import { fetchJson, httpUrl, type NetworkOptions } from "./network.ts";

export interface Source { id: string; name: string; url: string; kind: "manifest" | "mangadex" }
export interface RemoteBook { id: string; title: string; direction: "rtl" | "ltr"; description?: string; chapters?: RemoteChapter[] }
export interface RemoteChapter { id: string; title: string; pages?: string[]; archive?: string }
export const identity = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (v: unknown, name: string, max = 240): string => {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw Error(`Invalid ${name}`);
  return v.trim();
};
function localized(value: Record<string, string> | undefined, lang: string): string {
  return value?.[lang] ?? value?.en ?? Object.values(value ?? {})[0] ?? "Untitled";
}
export function parseManifest(raw: any, url: string): { name: string; books: RemoteBook[] } {
  if (raw?.version !== 1 || !Array.isArray(raw.series) || raw.series.length > 2048) throw Error("Expected a Pocket Manga source manifest (version: 1, series: [...])");
  const used = new Set<string>();
  const books = raw.series.map((book: any): RemoteBook => {
    const id = text(book?.id, "series id", 120);
    if (used.has(id)) throw Error("Duplicate source series id"); used.add(id);
    if (!Array.isArray(book.chapters) || !book.chapters.length || book.chapters.length > 4096) throw Error("A series needs 1..4096 chapters");
    const chapters = new Set<string>();
    return { id, title: text(book.title, "series title"), direction: book.direction === "ltr" ? "ltr" : "rtl",
      description: typeof book.description === "string" ? book.description.slice(0, 4000) : undefined,
      chapters: book.chapters.map((chapter: any): RemoteChapter => {
        const id = text(chapter?.id, "chapter id", 120);
        if (chapters.has(id)) throw Error("Duplicate chapter id"); chapters.add(id);
        const title = text(chapter.title, "chapter title");
        if (typeof chapter.archive === "string") return { id, title, archive: httpUrl(chapter.archive, url) };
        if (!Array.isArray(chapter.pages) || !chapter.pages.length || chapter.pages.length > 2000) throw Error("A chapter needs page URLs or an archive URL");
        return { id, title, pages: chapter.pages.map((p: unknown) => httpUrl(text(p, "page URL", 4096), url)) };
      }),
    };
  });
  return { name: text(raw.name, "source name"), books };
}
export async function addSource(input: string, options: NetworkOptions): Promise<Source> {
  const url = httpUrl(input);
  const host = new URL(url).hostname;
  if (host === "mangadex.org" || host === "api.mangadex.org")
    return { id: identity("mangadex"), name: "MangaDex", url: "https://api.mangadex.org", kind: "mangadex" };
  const manifest = parseManifest(await fetchJson(url, options), url);
  return { id: identity(url), name: manifest.name, url, kind: "manifest" };
}
export async function listBooks(source: Source, query: string, offset: number, lang: string, options: NetworkOptions): Promise<{ books: RemoteBook[]; next?: number }> {
  if (source.kind === "manifest") {
    const manifest = parseManifest(await fetchJson(source.url, options), source.url);
    const books = manifest.books.filter(b => b.title.toLowerCase().includes(query.toLowerCase()));
    return { books: books.slice(offset, offset + 20).map(({ chapters, ...book }) => book), ...(offset + 20 < books.length ? { next: offset + 20 } : {}) };
  }
  const url = new URL("/manga", source.url);
  url.searchParams.set("limit", "20"); url.searchParams.set("offset", String(offset));
  if (query) url.searchParams.set("title", query);
  const result = await fetchJson(url.href, options);
  if (!Array.isArray(result.data)) throw Error("Invalid MangaDex catalog response");
  return { books: result.data.map((m: any) => ({ id: m.id, title: localized(m.attributes?.title, lang), direction: "rtl" as const })),
    ...(offset + result.data.length < result.total ? { next: offset + result.data.length } : {}) };
}
export async function getBook(source: Source, id: string, lang: string, options: NetworkOptions): Promise<RemoteBook> {
  if (source.kind === "manifest") {
    const book = parseManifest(await fetchJson(source.url, options), source.url).books.find(b => b.id === id);
    if (!book) throw Error("Series disappeared from source"); return book;
  }
  if (!UUID.test(id) || !/^[a-z]{2}(-[a-z]{2})?$/.test(lang)) throw Error("Invalid MangaDex series or language");
  const manga = (await fetchJson(`${source.url}/manga/${id}`, options)).data;
  if (!manga?.attributes) throw Error("Invalid MangaDex series");
  const chapters: RemoteChapter[] = [];
  const seen = new Set<string>();
  let offset = 0;
  while (true) {
    const url = new URL(`/manga/${id}/feed`, source.url);
    for (const [key, value] of Object.entries({ limit: "100", offset: String(offset), "translatedLanguage[]": lang, "order[volume]": "asc", "order[chapter]": "asc", includeExternalUrl: "0" })) url.searchParams.set(key, value);
    const feed = await fetchJson(url.href, options);
    if (!Array.isArray(feed.data)) throw Error("Invalid MangaDex chapter feed");
    for (const c of feed.data) {
      if (!UUID.test(c.id) || c.attributes?.externalUrl || !c.attributes?.pages || seen.has(c.id)) continue;
      seen.add(c.id);
      const a = c.attributes;
      chapters.push({ id: c.id, title: [a.volume ? `Vol. ${a.volume}` : "", a.chapter ? `Ch. ${a.chapter}` : "", a.title ?? ""].filter(Boolean).join(" · ") || "Chapter" });
    }
    offset += feed.data.length;
    if (!feed.data.length || offset >= feed.total) break;
    if (offset >= 10000) throw Error("Source has too many chapters; narrow the import");
    await Bun.sleep(250);
  }
  if (!chapters.length) throw Error(`No downloadable ${lang} chapters in this source`);
  return { id, title: localized(manga.attributes.title, lang), description: localized(manga.attributes.description, lang), direction: "rtl", chapters };
}
export async function chapterPages(source: Source, chapter: RemoteChapter, options: NetworkOptions): Promise<string[]> {
  if (chapter.pages) return chapter.pages;
  if (source.kind !== "mangadex" || !UUID.test(chapter.id)) throw Error("Chapter has no page list");
  const data = await fetchJson(`${source.url}/at-home/server/${chapter.id}`, options);
  if (!data?.chapter?.hash || !Array.isArray(data.chapter.data) || !data.chapter.data.length) throw Error("MangaDex chapter pages unavailable");
  const base = httpUrl(data.baseUrl);
  return data.chapter.data.map((name: string) => httpUrl(`/data/${encodeURIComponent(data.chapter.hash)}/${encodeURIComponent(name)}`, base));
}
