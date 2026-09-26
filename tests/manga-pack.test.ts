// tests/manga-pack.test.ts — Pocket Manga's model math and PRP bake.
//
// The model tests are pure. The bake test needs ffmpeg or ImageMagick to
// decode its generated PNG (the same host-side codec the real baker uses) and
// is skipped when neither is installed; it then parses the written PRP1 file
// back with a mirror reader and verifies every entry (kind, dimensions, CRC).

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { crc32 } from "../apps/manga/pack-format.ts";
import { encodePng } from "../apps/manga/png.ts";
import {
  COVER,
  INDEX_PACK,
  SERIES_ENTRY_COVER,
  SERIES_ENTRY_META,
  SERIES_ENTRY_PAGE_BASE,
  TILE,
  chapterAt,
  levelTileBase,
  pageTile,
  pageTiles,
  pageTileBase,
  parseIndex,
  parseSeries,
  parseSummary,
  pickLevel,
  seriesPackName,
  tileEntry,
  tileGrid,
  tilesPerPage,
  windowTiles,
  type SeriesMeta,
} from "../apps/manga/model.ts";
import { bake, rgb24To565, makeTile, type Page } from "../apps/manga/bake.ts";
import { mergeMetadata, parseComicInfo, parseSeriesJson } from "../apps/manga/metadata.ts";
import { filterSeries, orderSeries } from "../apps/manga/library.ts";
import {
  emptyProgress,
  isBookmarked,
  isChapterRead,
  markChapterRead,
  parseProgress,
  resumePage,
  toggleBookmark,
  withPage,
} from "../apps/manga/progress.ts";

// ---------------------------------------------------------------------------
// PRP1 mirror reader (the asset_pack_format.h layout).
// ---------------------------------------------------------------------------

interface PrpEntry {
  offset: number; stored: number; raw: number; crc: number;
  kind: number; width: number; height: number;
}
function readPrp(path: string): { count: number; total: number; entries: PrpEntry[]; data(i: number): Uint8Array } {
  const buf = new Uint8Array(readFileSync(path));
  expect(new TextDecoder().decode(buf.subarray(0, 4))).toBe("PRP1");
  expect(buf[4]! | (buf[5]! << 8) | (buf[6]! << 16) | (buf[7]! << 24)).toBe(1);
  const count = buf[8]! | (buf[9]! << 8) | (buf[10]! << 16) | (buf[11]! << 24);
  const total = buf[12]! | (buf[13]! << 8) | (buf[14]! << 16) | (buf[15]! << 24);
  expect(total).toBe(buf.length);
  const entries: PrpEntry[] = [];
  for (let i = 0; i < count; i++) {
    const at = 64 + i * 24;
    const rd32 = (o: number) => buf[at + o]! | (buf[at + o + 1]! << 8) | (buf[at + o + 2]! << 16) | (buf[at + o + 3]! << 24);
    entries.push({
      offset: rd32(0), stored: rd32(4), raw: rd32(8), crc: rd32(12) >>> 0, kind: rd32(16),
      width: buf[at + 20]! | (buf[at + 21]! << 8),
      height: buf[at + 22]! | (buf[at + 23]! << 8),
    });
  }
  return {
    count,
    total,
    entries,
    data(i) {
      const e = entries[i]!;
      const raw = new Uint8Array(inflateSync(buf.subarray(e.offset, e.offset + e.stored)));
      expect(raw.length).toBe(e.raw);
      expect(crc32(raw)).toBe(e.crc);
      return raw;
    },
  };
}

// ---------------------------------------------------------------------------

const meta: SeriesMeta = {
  slug: "demo", title: "Demo", pages: 4,
  pageW: 400, pageH: 600, direction: "rtl",
  levels: [
    { scale: 1, cols: 2, rows: 3 },
    { scale: 2, cols: 4, rows: 5 },
  ],
};

describe("manga model", () => {
  test("tile grid and per-level entry addresses", () => {
    expect(tileGrid(400, 600)).toEqual({ cols: 2, rows: 3 });
    // Level 0 is 6 tiles, level 1 is 20, so a page spans 26 entries.
    expect(tilesPerPage(meta)).toBe(26);
    expect(pageTileBase(meta, 0)).toBe(SERIES_ENTRY_PAGE_BASE);
    expect(pageTileBase(meta, 1)).toBe(SERIES_ENTRY_PAGE_BASE + 26);
    expect(levelTileBase(meta, 0, 1)).toBe(SERIES_ENTRY_PAGE_BASE + 6);
    expect(levelTileBase(meta, 1, 1)).toBe(SERIES_ENTRY_PAGE_BASE + 26 + 6);
    expect(tileEntry(meta, 1, 1, 1, 2)).toBe(SERIES_ENTRY_PAGE_BASE + 26 + 6 + 2 * 4 + 1);
    expect(pageTile(meta, 0, 1, 1, 0)).toEqual({ pack: seriesPackName("demo"), entry: SERIES_ENTRY_PAGE_BASE + 6 + 1 });
    expect(pageTiles(meta, 0, 0)).toHaveLength(6);
    expect(pageTiles(meta, 0, 1)).toHaveLength(20);
  });

  test("pickLevel keeps the finest level that is downscaled", () => {
    expect(pickLevel(meta, 0.5)).toBe(0);
    expect(pickLevel(meta, 1)).toBe(0);
    expect(pickLevel(meta, 1.4)).toBe(1);
    expect(pickLevel(meta, 2)).toBe(1);
    expect(pickLevel(meta, 3)).toBe(1);
  });

  test("windowTiles returns the intersecting grid, near-first", () => {
    const tiles = windowTiles(meta, 0, 1, 0, 0, 400, 240, 1);
    // Level 1 scale 2: x 0..800 -> cols 0..3, y 0..480 -> rows 0..2, plus margin.
    expect(tiles).toHaveLength(12);
    expect(tiles[0]!.priority).toBeLessThanOrEqual(tiles[tiles.length - 1]!.priority);
    expect(tiles.every((t) => t.tx >= 0 && t.tx < 4 && t.ty >= 0 && t.ty < 5)).toBe(true);
  });

  test("parseIndex reduces any version to a lean catalog", () => {
    const v1 = parseIndex(JSON.stringify({
      v: 1,
      series: [{ slug: "demo", title: "Demo", pages: 4, pageW: 400, pageH: 600, direction: "rtl" }],
    }));
    expect(v1?.v).toBe(3);
    expect(v1?.series[0]).toEqual({ slug: "demo", title: "Demo", pages: 4, direction: "rtl" });

    const v2 = parseIndex(JSON.stringify({ v: 2, series: [meta] }));
    expect(v2?.series[0]).toEqual({ slug: "demo", title: "Demo", pages: 4, direction: "rtl" });

    expect(parseIndex("{")).toBeUndefined();
    expect(parseIndex(JSON.stringify({ v: 4, series: [] }))).toBeUndefined();
    expect(parseSummary({ ...meta, slug: "Bad Slug" })).toBeUndefined();
    expect(parseSummary({ ...meta, pages: 0 })).toBeUndefined();
  });

  test("parseSeries keeps optional metadata and ignores junk", () => {
    const full = parseSeries({
      ...meta,
      author: "A. Author",
      publisher: "Indie",
      year: 2020,
      genres: ["Action", " "],
      summary: "A demo.",
      language: "en",
    });
    expect(full?.author).toBe("A. Author");
    expect(full?.publisher).toBe("Indie");
    expect(full?.year).toBe(2020);
    expect(full?.genres).toEqual(["Action"]);
    expect(full?.summary).toBe("A demo.");

    const junk = parseSeries({ ...meta, year: "nope", genres: [1, 2] });
    expect(junk?.year).toBeUndefined();
    expect(junk?.genres).toBeUndefined();
  });

  test("parseSeries still rejects bad geometry", () => {
    expect(parseSeries({ ...meta, pageW: 0 })).toBeUndefined();
    // A level whose grid does not match its scale is rejected.
    expect(parseSeries({ ...meta, levels: [{ scale: 2, cols: 2, rows: 3 }] })).toBeUndefined();
  });

  test("chapterAt resolves the chapter span and chapters are validated", () => {
    const chaptered = parseSeries({
      ...meta,
      pages: 6,
      chapters: [
        { title: "One", page: 0 },
        { title: "Two", page: 2 },
        { title: "Three", page: 4 },
      ],
    })!;
    expect(chaptered.chapters).toHaveLength(3);
    expect(chapterAt(chaptered, 0)).toEqual({ index: 0, title: "One", start: 0, end: 2 });
    expect(chapterAt(chaptered, 3)).toEqual({ index: 1, title: "Two", start: 2, end: 4 });
    expect(chapterAt(chaptered, 5)).toEqual({ index: 2, title: "Three", start: 4, end: 6 });
    expect(chapterAt(meta, 0)).toBeUndefined();

    // Chapters must start at 0, ascend and stay in range.
    expect(parseSeries({ ...meta, chapters: [{ title: "A", page: 1 }] })).toBeUndefined();
    expect(parseSeries({ ...meta, chapters: [{ title: "A", page: 0 }, { title: "B", page: 0 }] })).toBeUndefined();
    expect(parseSeries({ ...meta, chapters: [{ title: "A", page: 0 }, { title: "B", page: 9 }] })).toBeUndefined();
  });
});

describe("manga metadata", () => {
  test("ComicInfo maps tags, direction and entities", () => {
    const m = parseComicInfo(
      `<ComicInfo><Series>Yotsuba&amp;!</Series><Writer>Kiyohiko</Writer>` +
      `<Penciller>Kiyohiko</Penciller><Publisher>ADV</Publisher>` +
      `<Genre>Comedy, Slice of Life</Genre><Year>2003</Year>` +
      `<Summary>A girl &amp; her town.</Summary><Manga>YesAndRightToLeft</Manga>` +
      `<LanguageISO>en</LanguageISO></ComicInfo>`,
    );
    expect(m.title).toBe("Yotsuba&!");
    expect(m.author).toBe("Kiyohiko");
    expect(m.artist).toBe("Kiyohiko");
    expect(m.publisher).toBe("ADV");
    expect(m.genres).toEqual(["Comedy", "Slice of Life"]);
    expect(m.year).toBe(2003);
    expect(m.summary).toBe("A girl & her town.");
    expect(m.language).toBe("en");
    expect(m.direction).toBe("rtl");
  });

  test("series.json reads Mylar metadata; merge prefers later layers", () => {
    const s = parseSeriesJson(JSON.stringify({
      metadata: {
        name: "X", publisher: "P", year: 1999, status: "Continuing",
        description: "Desc", authors: ["W", "A"], genres: ["Drama"], lang: "ja",
      },
    }));
    expect(s.title).toBe("X");
    expect(s.author).toBe("W, A");
    expect(s.summary).toBe("Desc");
    expect(s.status).toBe("Continuing");
    expect(s.year).toBe(1999);
    expect(s.language).toBe("ja");

    const merged = mergeMetadata(s, { title: "Y", direction: "ltr" });
    expect(merged.title).toBe("Y");
    expect(merged.publisher).toBe("P");
    expect(merged.direction).toBe("ltr");
  });
});

describe("manga progress", () => {
  test("parseProgress tolerates corrupt input and junk fields", () => {
    expect(parseProgress("{")).toEqual(emptyProgress());
    expect(parseProgress(JSON.stringify({ series: "no" }))).toEqual(emptyProgress());
    const parsed = parseProgress(JSON.stringify({
      v: 1,
      series: {
        good: { page: 3, updated: 5, chapters: { "0": true, "1": false }, bookmarks: [3, -1, 4] },
        "bad slug": { page: 1 },
        also: { page: 2, updated: 1, chapters: { x: true }, bookmarks: [] },
      },
    }));
    expect(parsed.series.good).toEqual({ page: 3, updated: 5, chapters: { "0": true }, bookmarks: [3, 4] });
    expect(parsed.series["bad slug"]).toBeUndefined();
    expect(parsed.series.also).toEqual({ page: 2, updated: 1, chapters: {}, bookmarks: [] });
  });

  test("reducers record pages, read chapters and bookmarks immutably", () => {
    const start = emptyProgress();
    const read = withPage(start, "demo", 4, 10);
    expect(start.series.demo).toBeUndefined();
    expect(read.series.demo).toEqual({ page: 4, updated: 10, chapters: {}, bookmarks: [] });

    const marked = markChapterRead(read, "demo", 1, 11);
    expect(isChapterRead(marked, "demo", 1)).toBe(true);
    expect(isChapterRead(marked, "demo", 0)).toBe(false);
    // Marking twice is a no-op (same object, no save).
    expect(markChapterRead(marked, "demo", 1, 12)).toBe(marked);

    const starred = toggleBookmark(marked, "demo", 4, 13);
    expect(isBookmarked(starred, "demo", 4)).toBe(true);
    expect(isBookmarked(toggleBookmark(starred, "demo", 4, 14), "demo", 4)).toBe(false);

    const chaptered: SeriesMeta = {
      ...meta,
      pages: 6,
      chapters: [{ title: "One", page: 0 }, { title: "Two", page: 3 }],
    };
    expect(resumePage(marked, chaptered)).toBe(4);
    expect(resumePage(emptyProgress(), chaptered)).toBe(0);
  });
});

describe("manga library ordering", () => {
  const list = [
    { slug: "b", title: "Beta", pages: 10, direction: "ltr" as const },
    { slug: "a", title: "Alpha", pages: 20, direction: "ltr" as const },
    { slug: "c", title: "gamma", pages: 30, direction: "ltr" as const },
  ];

  test("filterSeries matches titles case-insensitively", () => {
    expect(filterSeries(list, "").map((s) => s.slug)).toEqual(["b", "a", "c"]);
    expect(filterSeries(list, "a").map((s) => s.slug)).toEqual(["b", "a", "c"]);
    expect(filterSeries(list, "AL").map((s) => s.slug)).toEqual(["a"]);
    expect(filterSeries(list, "  gamma  ").map((s) => s.slug)).toEqual(["c"]);
    expect(filterSeries(list, "nope")).toEqual([]);
  });

  test("orderSeries sorts by recency, title, then unread-first", () => {
    let progress = emptyProgress();
    progress = withPage(progress, "a", 1, 100);
    progress = withPage(progress, "c", 0, 200);
    expect(orderSeries(list, "recent", progress).map((s) => s.slug)).toEqual(["c", "a", "b"]);
    expect(orderSeries(list, "title", progress).map((s) => s.slug)).toEqual(["a", "b", "c"]);
    expect(orderSeries(list, "unread", progress).map((s) => s.slug)).toEqual(["b", "a", "c"]);
    // The input array is never mutated.
    expect(list.map((s) => s.slug)).toEqual(["b", "a", "c"]);
  });
});

describe("manga baker", () => {
  test("rgb24 -> core RGB565 places red in the low bits", () => {
    const words = rgb24To565(new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255]), 3, 1);
    const read = (o: number) => words[o]! | (words[o + 1]! << 8);
    expect(read(0)).toBe(31);           // red5 = 31
    expect(read(2)).toBe(63 << 5);      // green6 = 63
    expect(read(4)).toBe(31 << 11);     // blue5 = 31
  });

  test("a tile pads past the page edge with white", () => {
    const pixels = new Uint8Array(300 * 20 * 2);
    for (let i = 0; i < pixels.length; i += 2) { pixels[i] = 0x34; pixels[i + 1] = 0x12; }
    const page: Page = { width: 300, height: 20, pixels };
    const tile = makeTile(page, 1, 0); // x 256..511: 44 real columns, rest padding
    const word = (x: number, y: number) => tile[(y * TILE + x) * 2]! | (tile[(y * TILE + x) * 2 + 1]! << 8);
    expect(word(43, 0)).toBe(0x1234);
    expect(word(44, 0)).toBe(0xffff);
    expect(word(255, 19)).toBe(0xffff);
    expect(tile).toHaveLength(TILE * TILE * 2);
  });

  const decoder = Bun.which("ffmpeg") || Bun.which("magick");
  const temp = decoder ? mkdtempSync(join(tmpdir(), "manga-bake-")) : "";
  afterAll(() => { if (temp) rmSync(temp, { recursive: true, force: true }); });

  test.skipIf(!decoder)("bake writes a v2 pyramid and parseable PRP1", () => {
    const library = join(temp, "library");
    const out = join(temp, "out");
    const seriesDir = join(library, "Demo Series");
    mkdirSync(seriesDir, { recursive: true });
    // Page 1 is 800 px wide, so the reading width of 400 yields levels 1 and 2
    // (a series no wider than the reading width gets the fit level alone).
    writeFileSync(join(seriesDir, "01.png"), encodePng(800, 600, () => [200, 30, 40]));
    writeFileSync(join(seriesDir, "02.png"), encodePng(128, 64, () => [10, 180, 60]));
    writeFileSync(join(seriesDir, "series.json"), JSON.stringify({
      metadata: { name: "Demo Series", status: "Completed", genres: ["Drama"] },
    }));
    writeFileSync(join(seriesDir, "ComicInfo.xml"),
      "<ComicInfo><Writer>A. Author</Writer><Publisher>Indie</Publisher>" +
      `<Year>2021</Year><Manga>Yes</Manga><Summary>A demo.</Summary></ComicInfo>`);

    bake({ library, out, width: 400, zoom: 3 });

    const index = readPrp(join(out, `${INDEX_PACK}.prp`));
    expect(index.count).toBe(1);
    expect(index.entries[0]!.kind).toBe(1);
    const parsed = parseIndex(new TextDecoder().decode(index.data(0)));
    expect(parsed?.v).toBe(3);
    expect(parsed?.series).toHaveLength(1);
    expect(parsed).toEqual({
      v: 3,
      series: [{ slug: "demo-series", title: "Demo Series", pages: 2, direction: "rtl" }],
    });

    const pack = readPrp(join(out, `${seriesPackName("demo-series")}.prp`));
    expect(pack.entries[SERIES_ENTRY_META]!.kind).toBe(1);
    const baked = parseSeries(JSON.parse(new TextDecoder().decode(pack.data(SERIES_ENTRY_META))))!;
    expect(baked.pages).toBe(2);
    expect(baked.pageW).toBe(400);
    expect(baked.pageH).toBe(300);
    expect(baked.levels).toEqual([
      { scale: 1, cols: 2, rows: 2 },
      { scale: 2, cols: 4, rows: 3 },
    ]);
    expect(baked.author).toBe("A. Author");
    expect(baked.publisher).toBe("Indie");
    expect(baked.year).toBe(2021);
    expect(baked.status).toBe("Completed");
    expect(baked.genres).toEqual(["Drama"]);
    expect(baked.summary).toBe("A demo.");

    expect(pack.count).toBe(2 + 2 * tilesPerPage(baked));
    expect(pack.entries[SERIES_ENTRY_COVER]!.kind).toBe(2);
    expect(pack.entries[SERIES_ENTRY_COVER]!.width).toBe(COVER);
    expect(pack.entries[SERIES_ENTRY_COVER]!.height).toBe(COVER);
    for (let i = 0; i < tilesPerPage(baked); i++) {
      const tile = pack.entries[SERIES_ENTRY_PAGE_BASE + i]!;
      expect(tile.kind).toBe(2);
      expect(tile.width).toBe(TILE);
      expect(tile.height).toBe(TILE);
      expect(tile.raw).toBe(TILE * TILE * 2);
    }
  });

  test.skipIf(!decoder)("bake groups chapter subdirectories", () => {
    const library = join(temp, "chaptered");
    const out = join(temp, "chaptered-out");
    const seriesDir = join(library, "Chaptered");
    mkdirSync(join(seriesDir, "Vol 1"), { recursive: true });
    mkdirSync(join(seriesDir, "Vol 2"), { recursive: true });
    writeFileSync(join(seriesDir, "Vol 1", "01.png"), encodePng(400, 600, () => [10, 10, 10]));
    writeFileSync(join(seriesDir, "Vol 1", "02.png"), encodePng(400, 600, () => [20, 20, 20]));
    writeFileSync(join(seriesDir, "Vol 2", "01.png"), encodePng(400, 600, () => [30, 30, 30]));

    bake({ library, out, width: 400, zoom: 1 });

    const pack = readPrp(join(out, `${seriesPackName("chaptered")}.prp`));
    const baked = parseSeries(JSON.parse(new TextDecoder().decode(pack.data(SERIES_ENTRY_META))))!;
    expect(baked.pages).toBe(3);
    expect(baked.chapters).toEqual([
      { title: "Vol 1", page: 0 },
      { title: "Vol 2", page: 2 },
    ]);
  });

  const zip = Bun.which("zip");
  test.skipIf(!decoder || !zip)("bake treats each CBZ as a chapter", () => {
    const library = join(temp, "boxed");
    const out = join(temp, "boxed-out");
    const seriesDir = join(library, "Boxed");
    const stage = join(temp, "boxed-stage");
    mkdirSync(seriesDir, { recursive: true });
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "a.png"), encodePng(400, 600, () => [1, 2, 3]));
    writeFileSync(join(stage, "b.png"), encodePng(400, 600, () => [4, 5, 6]));
    for (const [name, file] of [["Book A", "a.png"], ["Book B", "b.png"]] as const) {
      const proc = Bun.spawnSync(
        ["zip", "-q", "-j", join(seriesDir, `${name}.cbz`), join(stage, file)],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(proc.exitCode).toBe(0);
    }

    bake({ library, out, width: 400, zoom: 1 });

    const pack = readPrp(join(out, `${seriesPackName("boxed")}.prp`));
    const baked = parseSeries(JSON.parse(new TextDecoder().decode(pack.data(SERIES_ENTRY_META))))!;
    expect(baked.pages).toBe(2);
    expect(baked.chapters).toEqual([
      { title: "Book A", page: 0 },
      { title: "Book B", page: 1 },
    ]);
  });

  test.skipIf(!decoder || !zip)("bake ignores AppleDouble and __MACOSX junk in a CBZ", () => {
    const library = join(temp, "junk");
    const out = join(temp, "junk-out");
    const seriesDir = join(library, "Junk");
    const stage = join(temp, "junk-stage");
    mkdirSync(join(stage, "__MACOSX"), { recursive: true });
    mkdirSync(seriesDir, { recursive: true });
    writeFileSync(join(stage, "a.png"), encodePng(400, 600, () => [1, 2, 3]));
    writeFileSync(join(stage, "._a.png"), encodePng(400, 600, () => [9, 9, 9]));
    writeFileSync(join(stage, "__MACOSX", "._a.png"), encodePng(400, 600, () => [9, 9, 9]));
    const proc = Bun.spawnSync(["zip", "-q", "-r", join(seriesDir, "Junk.cbz"), "."], {
      cwd: stage,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);

    bake({ library, out, width: 400, zoom: 1 });

    const pack = readPrp(join(out, `${seriesPackName("junk")}.prp`));
    const baked = parseSeries(JSON.parse(new TextDecoder().decode(pack.data(SERIES_ENTRY_META))))!;
    expect(baked.pages).toBe(1);
  });
});
