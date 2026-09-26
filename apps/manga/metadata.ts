// apps/manga/metadata.ts — pure parsers for the metadata a series may carry.
//
// Two conventions travel with downloaded manga: Mylar's `series.json` beside
// the series, and ComicRack's `ComicInfo.xml` inside the book. The baker reads
// both and folds them into one SeriesMeta; nothing here touches the filesystem,
// so the mapping is unit-tested without a fixture on disk.

export interface SeriesMetadata {
  title?: string;
  author?: string;
  artist?: string;
  publisher?: string;
  summary?: string;
  genres?: string[];
  status?: string;
  year?: number;
  language?: string;
  direction?: "rtl" | "ltr";
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    switch (body) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return '"';
      case "apos": return "'";
      default: return match;
    }
  });
}

/** First `<tag>…</tag>` value, whitespace-collapsed and entity-decoded. */
function tag(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  if (!match) return undefined;
  const value = decodeEntities(match[1]!)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return value || undefined;
}

function splitGenres(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const out = value
    .split(/[,;/]/)
    .map((g) => g.trim())
    .filter(Boolean);
  return out.length ? out : undefined;
}

function toYear(value: string | undefined): number | undefined {
  const year = value ? Number.parseInt(value, 10) : NaN;
  return Number.isInteger(year) && year > 0 ? year : undefined;
}

function direction(value: string | undefined): "rtl" | "ltr" | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  if (v.startsWith("yes")) return "rtl";
  if (v.startsWith("no")) return "ltr";
  return undefined;
}

/** The chapter's own name from a `ComicInfo.xml`: `Title`, else `Ch. <Number>`. */
export function comicInfoChapterLabel(xml: string): string | undefined {
  const title = tag(xml, "Title");
  if (title) return title;
  const number = tag(xml, "Number");
  return number ? `Ch. ${number}` : undefined;
}

/** ComicRack / Komga `ComicInfo.xml`. */
export function parseComicInfo(xml: string): SeriesMetadata {
  const meta: SeriesMetadata = {};
  const title = tag(xml, "Series");
  const author = tag(xml, "Writer");
  const artist = tag(xml, "Penciller");
  const publisher = tag(xml, "Publisher");
  const summary = tag(xml, "Summary");
  const genres = splitGenres(tag(xml, "Genre"));
  const year = toYear(tag(xml, "Year"));
  const language = tag(xml, "LanguageISO");
  const manga = direction(tag(xml, "Manga"));
  if (title) meta.title = title;
  if (author) meta.author = author;
  if (artist) meta.artist = artist;
  if (publisher) meta.publisher = publisher;
  if (summary) meta.summary = summary;
  if (genres) meta.genres = genres;
  if (year) meta.year = year;
  if (language) meta.language = language;
  if (manga) meta.direction = manga;
  return meta;
}

function stringList(value: unknown): string[] | undefined {
  const list = typeof value === "string" ? value.split(/[,;]/) : Array.isArray(value) ? value : undefined;
  if (!list) return undefined;
  const out = list
    .filter((v): v is string => typeof v === "string" && !!v.trim())
    .map((v) => v.trim());
  return out.length ? out : undefined;
}

/** Mylar `series.json`, either wrapped in `metadata` or at the root. */
export function parseSeriesJson(text: string): SeriesMetadata {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return {};
  }
  if (!root || typeof root !== "object") return {};
  const record = root as Record<string, unknown>;
  const source =
    record.metadata && typeof record.metadata === "object"
      ? (record.metadata as Record<string, unknown>)
      : record;
  const meta: SeriesMetadata = {};
  if (source.direction === "rtl" || source.direction === "ltr") meta.direction = source.direction;
  const title = typeof source.name === "string" && source.name.trim() ? source.name.trim() : undefined;
  const authors = stringList(source.authors) ?? stringList(source.writer);
  const publisher =
    typeof source.publisher === "string" && source.publisher.trim() ? source.publisher.trim() : undefined;
  const summary =
    typeof source.summary === "string" && source.summary.trim()
      ? source.summary.trim()
      : typeof source.description === "string" && source.description.trim()
        ? source.description.trim()
        : undefined;
  const genres = stringList(source.genres);
  const status = typeof source.status === "string" && source.status.trim() ? source.status.trim() : undefined;
  const year = toYear(typeof source.year === "number" || typeof source.year === "string" ? String(source.year) : undefined);
  const language =
    typeof source.language === "string" && source.language.trim()
      ? source.language.trim()
      : typeof source.lang === "string" && source.lang.trim()
        ? source.lang.trim()
        : undefined;
  if (title) meta.title = title;
  if (authors) meta.author = authors.join(", ");
  if (publisher) meta.publisher = publisher;
  if (summary) meta.summary = summary;
  if (genres) meta.genres = genres;
  if (status) meta.status = status;
  if (year) meta.year = year;
  if (language) meta.language = language;
  return meta;
}

/** Later layers win per field; undefined fields never overwrite a value. */
export function mergeMetadata(...layers: SeriesMetadata[]): SeriesMetadata {
  const out: SeriesMetadata = {};
  for (const layer of layers) {
    if (layer.title) out.title = layer.title;
    if (layer.author) out.author = layer.author;
    if (layer.artist) out.artist = layer.artist;
    if (layer.publisher) out.publisher = layer.publisher;
    if (layer.summary) out.summary = layer.summary;
    if (layer.genres) out.genres = layer.genres;
    if (layer.status) out.status = layer.status;
    if (layer.year) out.year = layer.year;
    if (layer.language) out.language = layer.language;
    if (layer.direction) out.direction = layer.direction;
  }
  return out;
}
