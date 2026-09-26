// apps/manga/model.ts — Pocket Manga's pure data model.
//
// Everything in this file is deterministic arithmetic over the PRP1 resource
// pack layout (docs/RESOURCE_PACKS.md) and nothing else: no Solid, no host
// calls, no IO. The baker (apps/manga/bake.ts) and the reader (apps/manga/
// app.tsx, apps/manga/viewer.ts) share it, so an entry address written here
// can only mean one thing on both sides. Unit-tested in tests/manga-pack.test.ts.

/** Fixed pack name of the library index (one per SD asset directory). */
export const INDEX_PACK = "manga-index";
/** The 256x256 prepared-image tile the asset pack worker hands back. */
export const TILE = 256;
/** Library cover rendition, small enough to draw 1:1 on the lower screen. */
export const COVER = 128;

/** One zoom level of a page's pyramid. `scale` is level pixels per document
 * pixel: a page's fit-width canvas is scale 1, and finer levels multiply it.
 * The grid is ceil(canvas / TILE) for canvas = round(page size * scale). */
export interface LevelMeta {
  scale: number;
  cols: number;
  rows: number;
}

/** The catalog entry: everything the library list needs, and nothing the
 * reader needs. Kept small so one index record can list many series. */
export interface SeriesSummary {
  slug: string;
  title: string;
  pages: number;
  direction: "rtl" | "ltr";
  /** Immutable rendition address. Omitted in legacy SD libraries. */
  pack?: string;
}

/** One book (chapter) inside a series. `page` is the first page's global
 * index; page addressing stays global across chapters. */
export interface ChapterMeta {
  title: string;
  page: number;
}

/** The full per-series record at index into its own pack (entry 0). Carries
 * the geometry the reader needs plus the optional catalog metadata. */
export interface SeriesMeta {
  slug: string;
  title: string;
  pages: number;
  /** Document (fit-width) page size in pixels. */
  pageW: number;
  pageH: number;
  direction: "rtl" | "ltr";
  pack?: string;
  /** Ascending by scale; levels[0] is the fit canvas used as the overview. */
  levels: LevelMeta[];
  /** Present when the series holds more than one chapter; starts at page 0. */
  chapters?: ChapterMeta[];
  author?: string;
  artist?: string;
  publisher?: string;
  summary?: string;
  genres?: string[];
  status?: string;
  year?: number;
  language?: string;
}

export interface LibraryIndex {
  v: 3;
  series: SeriesSummary[];
}

/** One prepared image in a series pack. */
export interface TileAddress {
  pack: string;
  entry: number;
}

export const SERIES_ENTRY_META = 0;
export const SERIES_ENTRY_COVER = 1;
export const SERIES_ENTRY_PAGE_BASE = 2;

export function seriesPackName(slug: string): string {
  return `manga-${slug}`;
}

export function packOf(series: Pick<SeriesSummary, "slug" | "pack">): string {
  return series.pack ?? seriesPackName(series.slug);
}

/** Tile grid for a canvas size, at most the PRP envelope count we expect. */
export function tileGrid(pageW: number, pageH: number): { cols: number; rows: number } {
  return { cols: Math.ceil(pageW / TILE), rows: Math.ceil(pageH / TILE) };
}

export function levelTiles(level: LevelMeta): number {
  return level.cols * level.rows;
}

/** Tiles across every level of one page. */
export function tilesPerPage(meta: SeriesMeta): number {
  let total = 0;
  for (const level of meta.levels) total += levelTiles(level);
  return total;
}

/** Entry index of `page`'s first tile (its coarsest level's first tile). */
export function pageTileBase(meta: SeriesMeta, page: number): number {
  return SERIES_ENTRY_PAGE_BASE + page * tilesPerPage(meta);
}

/** Entry index of one level's first tile within `page`. */
export function levelTileBase(meta: SeriesMeta, page: number, level: number): number {
  let base = pageTileBase(meta, page);
  for (let i = 0; i < level; i++) base += levelTiles(meta.levels[i]!);
  return base;
}

/** Entry index of one tile within one level of `page`. */
export function tileEntry(meta: SeriesMeta, page: number, level: number, tx: number, ty: number): number {
  return levelTileBase(meta, page, level) + ty * meta.levels[level]!.cols + tx;
}

export function pageTile(meta: SeriesMeta, page: number, level: number, tx: number, ty: number): TileAddress {
  return { pack: packOf(meta), entry: tileEntry(meta, page, level, tx, ty) };
}

/** Every tile of one page's level, row-major. */
export function pageTiles(meta: SeriesMeta, page: number, level: number): TileAddress[] {
  const lv = meta.levels[level]!;
  const out: TileAddress[] = [];
  for (let ty = 0; ty < lv.rows; ty++)
    for (let tx = 0; tx < lv.cols; tx++) out.push(pageTile(meta, page, level, tx, ty));
  return out;
}

/**
 * The level whose resolution is the smallest one still at or above the current
 * display scale: a level is downscaled into its tile, never upscaled, until the
 * display passes the finest baked level. `scale` is screen px per document px.
 */
export function pickLevel(meta: SeriesMeta, scale: number): number {
  let best = meta.levels.length - 1;
  for (let i = meta.levels.length - 1; i >= 0; i--) {
    if (meta.levels[i]!.scale >= scale) best = i;
  }
  return best;
}

export interface VisibleTile extends TileAddress {
  tx: number;
  ty: number;
  priority: number;
}

/**
 * Tiles of `level` intersecting the document rect (x, y, w, h), near-first.
 * The camera supplies the rect; the margin adds whole tiles the scheduler may
 * prefetch but the reader only draws once they enter view.
 */
export function windowTiles(
  meta: SeriesMeta,
  page: number,
  level: number,
  x: number,
  y: number,
  w: number,
  h: number,
  marginTiles = 1,
): VisibleTile[] {
  const lv = meta.levels[level]!;
  const s = lv.scale;
  const x0 = Math.max(0, Math.floor((x * s) / TILE) - marginTiles);
  const y0 = Math.max(0, Math.floor((y * s) / TILE) - marginTiles);
  const x1 = Math.min(lv.cols - 1, Math.floor(((x + w) * s) / TILE) + marginTiles);
  const y1 = Math.min(lv.rows - 1, Math.floor(((y + h) * s) / TILE) + marginTiles);
  const ccx = ((x + w / 2) * s) / TILE - 0.5;
  const ccy = ((y + h / 2) * s) / TILE - 0.5;
  const out: VisibleTile[] = [];
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++)
      out.push({
        ...pageTile(meta, page, level, tx, ty),
        tx,
        ty,
        priority: (tx - ccx) ** 2 + (ty - ccy) ** 2,
      });
  return out.sort((a, b) => a.priority - b.priority);
}

/** Direction-aware page step: RTL reads right to left, so "next" is left. */
export function pageStep(direction: "rtl" | "ltr"): number {
  return direction === "rtl" ? -1 : 1;
}

/** The chapter containing `page`, with its global page span. */
export interface ChapterSpan {
  index: number;
  title: string;
  start: number;
  end: number;
}

export function chapterAt(meta: SeriesMeta, page: number): ChapterSpan | undefined {
  const chapters = meta.chapters;
  if (!chapters || !chapters.length) return undefined;
  for (let i = chapters.length - 1; i >= 0; i--) {
    if (page >= chapters[i]!.page) {
      const next = chapters[i + 1];
      return {
        index: i,
        title: chapters[i]!.title,
        start: chapters[i]!.page,
        end: next ? next.page : meta.pages,
      };
    }
  }
  return undefined;
}

/**
 * Parse the index pack's kind-1 record into a lean catalog. v1/v2 records
 * (which also carry the full per-series meta) are accepted and reduced to a
 * summary, so an old pack still lists; the reader then reads the full record
 * from the series pack itself. Returns undefined for anything malformed; a
 * corrupt or missing index shows the empty state.
 */
export function parseIndex(raw: string): LibraryIndex | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as { v?: unknown; series?: unknown };
  if ((record.v !== 1 && record.v !== 2 && record.v !== 3) || !Array.isArray(record.series)) return undefined;
  const series: SeriesSummary[] = [];
  const slugs = new Set<string>();
  for (const item of record.series) {
    const summary = parseSummary(item);
    if (!summary || slugs.has(summary.slug)) return undefined;
    slugs.add(summary.slug);
    series.push(summary);
  }
  return { v: 3, series };
}

export function parseSummary(value: unknown): SeriesSummary | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as Record<string, unknown>;
  if (typeof r.slug !== "string" || !/^[a-z0-9-]{1,42}$/.test(r.slug)) return undefined;
  if (typeof r.title !== "string" || !r.title.length) return undefined;
  if (!positiveInt(r.pages)) return undefined;
  if (r.direction !== "rtl" && r.direction !== "ltr") return undefined;
  if (r.pack !== undefined && (typeof r.pack !== "string" || !/^[a-z0-9-]{1,48}$/.test(r.pack))) return undefined;
  return { slug: r.slug, title: r.title, pages: r.pages, direction: r.direction, ...(r.pack ? { pack: r.pack as string } : {}) };
}

function positiveInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalGenres(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .filter((g): g is string => typeof g === "string" && !!g.trim())
    .map((g) => g.trim());
  return out.length ? out : undefined;
}

export function parseSeries(value: unknown): SeriesMeta | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as Record<string, unknown>;
  const summaryRecord = parseSummary(value);
  if (!summaryRecord) return undefined;
  if (typeof r.title !== "string" || !r.title.length) return undefined;
  if (!positiveInt(r.pages) || !positiveInt(r.pageW) || !positiveInt(r.pageH)) return undefined;
  if (r.direction !== "rtl" && r.direction !== "ltr") return undefined;
  const levels = parseLevels(r.levels, r.pageW, r.pageH);
  if (!levels) return undefined;
  const chapters = parseChapters(r.chapters, r.pages);
  if (r.chapters !== undefined && !chapters) return undefined;
  const meta: SeriesMeta = {
    slug: summaryRecord.slug,
    title: r.title,
    pages: r.pages,
    pageW: r.pageW,
    pageH: r.pageH,
    direction: r.direction,
    levels,
  };
  if (chapters) meta.chapters = chapters;
  if (summaryRecord.pack) meta.pack = summaryRecord.pack;
  if (2 + meta.pages * tilesPerPage(meta) > 65536) return undefined;
  const author = optionalText(r.author);
  const artist = optionalText(r.artist);
  const publisher = optionalText(r.publisher);
  const summary = optionalText(r.summary);
  const genres = optionalGenres(r.genres);
  const status = optionalText(r.status);
  const language = optionalText(r.language);
  const year = positiveInt(r.year) ? r.year : undefined;
  if (author) meta.author = author;
  if (artist) meta.artist = artist;
  if (publisher) meta.publisher = publisher;
  if (summary) meta.summary = summary;
  if (genres) meta.genres = genres;
  if (status) meta.status = status;
  if (year) meta.year = year;
  if (language) meta.language = language;
  return meta;
}

/** Chapters when present: non-empty, ascending, first starts at page 0. */
function parseChapters(value: unknown, pages: number): ChapterMeta[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4096) return undefined;
  const out: ChapterMeta[] = [];
  let previous = -1;
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const c = item as Record<string, unknown>;
    if (typeof c.title !== "string" || !c.title.length) return undefined;
    if (!Number.isInteger(c.page) || (c.page as number) < 0 || (c.page as number) >= pages) return undefined;
    if ((c.page as number) <= previous) return undefined;
    out.push({ title: c.title, page: c.page as number });
    previous = c.page as number;
  }
  return out[0]!.page === 0 ? out : undefined;
}

/** v2 `levels`, or a single fit level synthesized for a v1 record. */
function parseLevels(value: unknown, pageW: number, pageH: number): LevelMeta[] | undefined {
  if (value === undefined) {
    const grid = tileGrid(pageW, pageH);
    return [{ scale: 1, cols: grid.cols, rows: grid.rows }];
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 9) return undefined;
  const levels: LevelMeta[] = [];
  let previous = 0;
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const l = item as Record<string, unknown>;
    if (typeof l.scale !== "number" || !Number.isFinite(l.scale) || l.scale <= previous) return undefined;
    if (!positiveInt(l.cols) || !positiveInt(l.rows)) return undefined;
    const grid = tileGrid(Math.round(pageW * l.scale), Math.round(pageH * l.scale));
    if (grid.cols !== l.cols || grid.rows !== l.rows) return undefined;
    levels.push({ scale: l.scale, cols: l.cols, rows: l.rows });
    previous = l.scale;
  }
  return levels;
}
