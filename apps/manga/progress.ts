// apps/manga/progress.ts — Pocket Manga's reading progress model.
//
// Pure data: the shape saved to device state (apps/manga/state.ts) and the
// reducers the app applies on a page turn. Page numbers are the global indices
// model.ts uses, so a chapter's span stays computable with chapterAt(). No IO,
// no Solid; unit-tested in tests/manga-pack.test.ts.

import { type SeriesMeta } from "./model.ts";

export interface SeriesProgress {
  /** Last page read (global index). */
  page: number;
  /** Monotonic tick the app supplies; recentSeries orders by it. */
  updated: number;
  /** Chapter index (as a string key) -> read. */
  chapters: Record<string, boolean>;
  /** Bookmarked page numbers (global indices). */
  bookmarks: number[];
}

export interface Progress {
  v: 1;
  series: Record<string, SeriesProgress>;
}

export function emptyProgress(): Progress {
  return { v: 1, series: Object.create(null) };
}

/** Parse a saved blob; any malformed field degrades to a safe default so a
 *  corrupt file never blocks reading. */
export function parseProgress(raw: string): Progress {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return emptyProgress();
  }
  if (!value || typeof value !== "object") return emptyProgress();
  const source = (value as { series?: unknown }).series;
  if (!source || typeof source !== "object") return emptyProgress();
  const series: Record<string, SeriesProgress> = Object.create(null);
  for (const [slug, item] of Object.entries(source as Record<string, unknown>)) {
    if (!/^[a-z0-9-]{1,48}$/.test(slug) || !item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const page = Number.isInteger(record.page) && (record.page as number) >= 0 ? (record.page as number) : 0;
    const updated = Number.isSafeInteger(record.updated) && (record.updated as number) >= 0 ? record.updated as number : 0;
    const chapters: Record<string, boolean> = {};
    if (record.chapters && typeof record.chapters === "object") {
      for (const [key, flag] of Object.entries(record.chapters as Record<string, unknown>)) {
        if (/^\d+$/.test(key) && flag === true) chapters[key] = true;
      }
    }
    const bookmarks = Array.isArray(record.bookmarks)
      ? [...new Set(record.bookmarks.filter((n): n is number => Number.isInteger(n) && n >= 0 && n < 65536))].sort((a, b) => a - b)
      : [];
    series[slug] = { page, updated, chapters, bookmarks };
  }
  return { v: 1, series };
}

export function seriesProgress(progress: Progress, slug: string): SeriesProgress | undefined {
  return progress.series[slug];
}

function replace(progress: Progress, slug: string, next: SeriesProgress): Progress {
  return { ...progress, series: Object.assign(Object.create(null), progress.series, { [slug]: next }) };
}

/** Records the current page. There is no chapter argument: the chapter is
 *  derived when needed, so a page turn and its chapter stay consistent. */
export function withPage(progress: Progress, slug: string, page: number, updated: number): Progress {
  const previous = progress.series[slug];
  return replace(progress, slug, {
    page,
    updated,
    chapters: previous?.chapters ?? {},
    bookmarks: previous?.bookmarks ?? [],
  });
}

export function markChapterRead(progress: Progress, slug: string, chapter: number, updated: number): Progress {
  const previous = progress.series[slug];
  if (!previous || previous.chapters[String(chapter)]) return progress;
  return replace(progress, slug, {
    ...previous,
    chapters: { ...previous.chapters, [String(chapter)]: true },
    updated,
  });
}

export function isChapterRead(progress: Progress, slug: string, chapter: number): boolean {
  return progress.series[slug]?.chapters[String(chapter)] === true;
}

export function isBookmarked(progress: Progress, slug: string, page: number): boolean {
  return progress.series[slug]?.bookmarks.includes(page) ?? false;
}

export function toggleBookmark(progress: Progress, slug: string, page: number, updated: number): Progress {
  const previous = progress.series[slug];
  if (!previous) {
    return replace(progress, slug, { page, updated, chapters: {}, bookmarks: [page] });
  }
  const bookmarks = previous.bookmarks.includes(page)
    ? previous.bookmarks.filter((p) => p !== page)
    : [...previous.bookmarks, page].sort((a, b) => a - b);
  return replace(progress, slug, { ...previous, page, bookmarks, updated });
}

/** The page to resume at: the last read page, clamped into the series. */
export function resumePage(progress: Progress, meta: SeriesMeta): number {
  const entry = progress.series[meta.slug];
  if (!entry) return 0;
  return Math.max(0, Math.min(entry.page, meta.pages - 1));
}
