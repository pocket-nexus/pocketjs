import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bake } from "../bake.ts";
import type { SeriesSummary } from "../model.ts";
import { fetchBytes, httpUrl, type NetworkOptions } from "./network.ts";
import { addSource, chapterPages, getBook, identity, type RemoteBook, type Source } from "./sources.ts";
import type { ImportRequest } from "./store.ts";

export async function importBook(root: string, input: ImportRequest, source: Source | undefined, options: NetworkOptions,
  report: (message: string, done: number, total: number) => void, workspace?: string): Promise<SeriesSummary> {
  const stage = workspace ?? mkdtempSync(join(root, "import-"));
  try {
    let book: RemoteBook;
    if (input.url) {
      const url = httpUrl(input.url), parsed = new URL(url);
      const manga = /^\/title\/([a-f0-9-]{36})(?:\/|$)/i.exec(parsed.pathname);
      if (parsed.hostname === "mangadex.org" && manga) {
        source = await addSource(url, options); book = await getBook(source, manga[1]!, input.language, options);
      } else {
        if (!/\.(cbz|zip)$/i.test(parsed.pathname)) throw Error("Direct import supports CBZ/ZIP or a MangaDex title URL; add other catalogs under Sources");
        book = { id: url, title: input.title || decodeURIComponent(parsed.pathname.split("/").pop()!).replace(/\.(cbz|zip)$/i, ""), direction: "rtl", chapters: [{ id: url, title: "Chapter 1", archive: url }] };
      }
    } else {
      if (!source || !input.book) throw Error("Source series missing");
      book = await getBook(source, input.book, input.language, options);
    }
    const chapters = book.chapters!.slice((input.from ?? 1) - 1, input.to);
    if (!chapters.length) throw Error("No chapters in selected range");
    const slug = `s-${identity(`${source?.id ?? "url"}/${book.id}/${input.language}/${input.from ?? 1}:${input.to ?? "all"}`)}`;
    const library = join(stage, "library"), dir = join(library, slug);
    mkdirSync(dir, { recursive: true });
    const metadata = JSON.stringify({ name: input.title || book.title, direction: book.direction, summary: book.description });
    writeFileSync(join(dir, "series.json"), metadata);
    const hash = createHash("sha256").update("manga-rendition-v3/400/3/").update(slug).update(metadata);
    let totalBytes = 0, totalPages = 0;
    for (let n = 0; n < chapters.length; n++) {
      const c = chapters[n]!, name = `${String(n + 1).padStart(5, "0")} ${c.title.replace(/[^a-zA-Z0-9 ._-]/g, "_").slice(0, 80)}`;
      report(`Downloading ${n + 1}/${chapters.length}: ${c.title}`, n, chapters.length);
      hash.update(c.id).update(c.title);
      if (c.archive) {
        const bytes = await fetchBytes(c.archive, 512 * 1024 * 1024, options);
        totalBytes += bytes.length;
        if (totalBytes > 1024 * 1024 * 1024) throw Error("Import exceeds 1 GiB; select a smaller chapter range");
        hash.update(bytes); writeFileSync(join(dir, name + ".cbz"), bytes);
      } else {
        const chapterDir = join(dir, name); mkdirSync(chapterDir);
        const urls = await chapterPages(source!, c, options);
        totalPages += urls.length;
        if (totalPages > 10000) throw Error("Import exceeds 10000 pages; select a smaller range");
        for (let p = 0; p < urls.length; p++) {
          options.signal?.throwIfAborted();
          const bytes = await fetchBytes(urls[p]!, 32 * 1024 * 1024, options);
          totalBytes += bytes.length;
          if (totalBytes > 1024 * 1024 * 1024) throw Error("Import exceeds 1 GiB; select a smaller range");
          hash.update(bytes);
          // Image tools sniff file content. The extension is only for scanning.
          writeFileSync(join(chapterDir, `${String(p + 1).padStart(5, "0")}.png`), bytes);
          report(`Chapter ${n + 1}/${chapters.length} · page ${p + 1}/${urls.length}`, n, chapters.length);
          if (source?.kind === "mangadex") await Bun.sleep(250);
        }
      }
    }
    options.signal?.throwIfAborted();
    report("Preparing offline images", chapters.length, chapters.length);
    const pack = `mg-${hash.digest("hex").slice(0, 32)}`;
    const index = bake({ library, out: join(stage, "packs"), width: 400, zoom: 3, identity: { slug, pack }, chapterTitles: chapters.map(c => c.title) });
    renameSync(join(stage, "packs", pack + ".prp"), join(root, "packs", pack + ".prp"));
    return index.series[0]!;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
