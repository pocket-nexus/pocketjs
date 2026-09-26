// apps/manga/bake.ts — Pocket Manga's offline baker.
//
//   bun apps/manga/bake.ts --library <dir> [--out dist/manga] [--width 400]
//
// Scans <dir>/<series>/ (images, or one level of chapter subdirectories),
// decodes and scales each page on the desktop, quantizes to the core's
// RGB565, tiles it into 256x256 PRP entries and writes:
//
//   <out>/manga-index.prp     one kind-1 record: the lean series catalog
//   <out>/manga-<slug>.prp    entry 0 full metadata, entry 1 cover, page tiles
//
// Entry 0 folds in `series.json` (Mylar) and `ComicInfo.xml` (ComicRack) when
// present; the index carries only the summary, so it stays inside its budget.
//
// Copy both files to sdmc:/pocketjs/assets/<runtime-slot>/ on the 3DS.
// JPEG/PNG decoding is host-side: the console only inflates a bounded record
// (docs/RESOURCE_PACKS.md). The 3DS never runs an image codec.

import { extractCbz } from "./archive.ts";
import { encodeDocument } from "./document.ts";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { createResourcePack, prepareTiledRGB565 } from "./pack-format.ts";
import {
  COVER,
  INDEX_PACK,
  TILE,
  seriesPackName,
  tileGrid,
  tilesPerPage,
  type ChapterMeta,
  type LevelMeta,
  type LibraryIndex,
  type SeriesMeta,
  type SeriesSummary,
} from "./model.ts";
import { comicInfoChapterLabel, mergeMetadata, parseComicInfo, parseSeriesJson } from "./metadata.ts";

/** Keep descriptions compact in terminal metadata. */
const SUMMARY_LIMIT = 900;

const APP_ID = "dev.pocket-stack.manga";
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff"]);

/** Hidden entries and archive junk (AppleDouble forks, `__MACOSX`) to ignore. */
function isJunkName(name: string): boolean {
  return name.startsWith(".") || name === "__MACOSX" || name.startsWith("._");
}
const NATURAL = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export interface Args {
  library: string;
  out: string;
  width: number;
  /** Native zoom cap: the highest level scale baked per page. */
  zoom: number;
  only?: string;
  /** Relay-owned stable identity and immutable rendition name. */
  identity?: { slug: string; pack: string };
  chapterTitles?: string[];
}

function parseArgs(argv: string[]): Args {
  let library = "";
  let out = "dist/manga";
  let width = 400;
  let zoom = 3;
  let only: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const next = argv[++i];
      if (!next) throw new Error(`${a} needs a value`);
      return next;
    };
    if (a === "--library") library = value();
    else if (a === "--out") out = value();
    else if (a === "--width") width = Number(value());
    else if (a === "--zoom") zoom = Number(value());
    else if (a === "--series") only = value();
    else if (a === "--help" || a === "-h") {
      console.log("usage: bun apps/manga/bake.ts --library <dir> [--out dist/manga] [--width 400] [--zoom 3] [--series <slug>]");
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!library) throw new Error("--library is required");
  if (!Number.isInteger(width) || width < 64 || width > 1000) throw new Error("--width must be 64..1000");
  if (!Number.isInteger(zoom) || zoom < 1 || zoom > 8) throw new Error("--zoom must be 1..8");
  return { library, out, width, zoom, only };
}

/** One decoded page: tightly packed little-endian core RGB565 words. */
interface Page {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/** Decode fit+pad into a fixed WxH canvas (white bars on the short side). */
function decode(path: string, width: number, height: number): Uint8Array {
  const attempts: string[][] = [
    ["ffmpeg", "-v", "error", "-i", path, "-vf",
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=white,format=rgb24`,
      "-frames:v", "1", "-f", "rawvideo", "-"],
    ["magick", path + "[0]", "-background", "white", "-alpha", "remove", "-alpha", "off",
      "-resize", `${width}x${height}`, "-gravity", "center", "-extent", `${width}x${height}`,
      "-depth", "8", "rgb:-"],
  ];
  let lastError = "";
  for (const [bin, ...args] of attempts) {
    if (!Bun.which(bin)) continue;
    const proc = Bun.spawnSync([bin!, ...args], { stdout: "pipe", stderr: "pipe", timeout: 30000 });
    if (proc.exitCode === 0 && proc.stdout.length > 0) return new Uint8Array(proc.stdout);
    lastError = proc.stderr.toString().trim() || `${bin} exited ${proc.exitCode}`;
  }
  throw new Error(`could not decode ${path}: ${lastError || "install ffmpeg or ImageMagick"}`);
}

/** RGB24 -> core RGB565 (red in the low five bits; see prepareTiledRGB565). */
function rgb24To565(rgb: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 2);
  for (let i = 0, o = 0; i < width * height; i++, o += 2) {
    const r = rgb[i * 3]!, g = rgb[i * 3 + 1]!, b = rgb[i * 3 + 2]!;
    const v = (r >> 3) | ((g >> 2) << 5) | ((b >> 3) << 11);
    out[o] = v & 0xff;
    out[o + 1] = v >> 8;
  }
  return out;
}

/** Image dimensions without a full decode (ffprobe, else magick identify). */
function probe(path: string): { width: number; height: number } {
  const attempts: string[][] = [
    ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", path],
    ["magick", "identify", "-format", "%w,%h", path + "[0]"],
  ];
  let lastError = "";
  for (const [bin, ...args] of attempts) {
    if (!Bun.which(bin)) continue;
    const proc = Bun.spawnSync([bin!, ...args], { stdout: "pipe", stderr: "pipe", timeout: 30000 });
    if (proc.exitCode === 0) {
      const [w, h] = proc.stdout.toString().trim().split(/[,\s]+/).map(Number);
      if (Number.isInteger(w) && Number.isInteger(h) && w! > 0 && h! > 0) {
        if (w! > 32768 || h! > 32768 || w! * h! > 64 * 1024 * 1024) throw Error("Source image dimensions exceed decode budget");
        return { width: w!, height: h! };
      }
    }
    lastError = proc.stderr.toString().trim() || `${bin} exited ${proc.exitCode}`;
  }
  throw new Error(`could not read image size of ${path}: ${lastError || "install ffmpeg or ImageMagick"}`);
}

/** Decode a page into the series canvas: fit inside, centered, white bars. */
function decodeInto(path: string, width: number, height: number): Page {
  const rgb = decode(path, width, height);
  if (rgb.length !== width * height * 3) {
    throw new Error(`decoded ${path} is ${rgb.length / 3} pixels; expected ${width}x${height}`);
  }
  return { width, height, pixels: rgb24To565(rgb, width, height) };
}

/** Box-downscale a page into a white-padded `size`x`size` cover. */
function makeCover(page: Page, size: number): Uint8Array {
  const out = new Uint8Array(size * size * 2).fill(0xff);
  const scale = Math.min(size / page.width, size / page.height);
  const dw = Math.max(1, Math.round(page.width * scale));
  const dh = Math.max(1, Math.round(page.height * scale));
  const ox = (size - dw) >> 1;
  const oy = (size - dh) >> 1;
  for (let dy = 0; dy < dh; dy++) {
    const sy0 = Math.floor((dy * page.height) / dh);
    const sy1 = Math.max(sy0 + 1, Math.floor(((dy + 1) * page.height) / dh));
    for (let dx = 0; dx < dw; dx++) {
      const sx0 = Math.floor((dx * page.width) / dw);
      const sx1 = Math.max(sx0 + 1, Math.floor(((dx + 1) * page.width) / dw));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++)
        for (let sx = sx0; sx < sx1; sx++) {
          const o = (sy * page.width + sx) * 2;
          const v = page.pixels[o]! | (page.pixels[o + 1]! << 8);
          r += v & 31; g += (v >> 5) & 63; b += (v >> 11) & 31; n++;
        }
      const rr = Math.round(r / n), gg = Math.round(g / n), bb = Math.round(b / n);
      const v = rr | (gg << 5) | (bb << 11);
      const at = ((dy + oy) * size + dx + ox) * 2;
      out[at] = v & 0xff; out[at + 1] = v >> 8;
    }
  }
  return out;
}

/** One 256x256 tile of a page, whitespace padded past the page edge. */
function makeTile(page: Page, tx: number, ty: number): Uint8Array {
  const out = new Uint8Array(TILE * TILE * 2).fill(0xff);
  const x0 = tx * TILE, y0 = ty * TILE;
  const w = Math.min(TILE, page.width - x0);
  const h = Math.min(TILE, page.height - y0);
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * page.width + x0) * 2;
    const dst = (y * TILE) * 2;
    out.set(page.pixels.subarray(src, src + w * 2), dst);
  }
  return out;
}

function collectImages(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string) => {
    const entries = readdirSync(current, { withFileTypes: true })
      .filter((e) => !isJunkName(e.name))
      .sort((a, b) => NATURAL.compare(a.name, b.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && IMAGE_EXT.has(extname(entry.name).toLowerCase())) files.push(path);
    }
  };
  walk(dir);
  return files;
}

/** First ComicInfo.xml at the top level, else the shallowest under `dir`. */
function findComicInfo(dir: string): string | undefined {
  const queue = [dir];
  while (queue.length) {
    const current = queue.shift()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase() === "comicinfo.xml") {
        return join(current, entry.name);
      }
      if (entry.isDirectory() && !isJunkName(entry.name)) queue.push(join(current, entry.name));
    }
  }
  return undefined;
}

/** One planned chapter: its images and where its ComicInfo.xml lives. */
interface Chapter {
  title: string;
  files: string[];
  source: string;
  xml?: string;
}

function extractArchive(path: string): string {
  const dir = mkdtempSync(join(tmpdir(), "manga-cbz-"));
  try { extractCbz(path, dir); return dir; }
  catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
}

/**
 * Split a series directory into chapters. Each CBZ/ZIP file and each
 * subdirectory is a chapter; consecutive loose images group into one. Chapter
 * titles come from a `ComicInfo.xml` when present, else the file/directory
 * name. Returned temp directories are cleaned up by the caller.
 */
function collectChapters(dir: string): { chapters: Chapter[]; temps: string[] } {
  const temps: string[] = [];
  const chapters: Chapter[] = [];
  let loose: string[] = [];
  const flushLoose = () => {
    if (loose.length) {
      chapters.push({ title: "", files: loose, source: dir });
      loose = [];
    }
  };
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((e) => !isJunkName(e.name))
    .sort((a, b) => NATURAL.compare(a.name, b.name));
  try {
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      flushLoose();
      const files = collectImages(path);
      if (files.length) chapters.push({ title: entry.name, files, source: path });
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (ext === ".cbz" || ext === ".zip") {
        flushLoose();
        const temp = extractArchive(path);
        if (!temp) throw new Error(`could not extract ${entry.name}: install unzip or bsdtar`);
        temps.push(temp);
        const files = collectImages(temp);
        if (files.length) chapters.push({ title: entry.name.replace(/\.(cbz|zip)$/i, ""), files, source: temp });
      } else if (IMAGE_EXT.has(ext)) {
        loose.push(path);
      }
    }
  }
  flushLoose();
  for (const chapter of chapters) {
    const info = findComicInfo(chapter.source);
    if (!info) continue;
    chapter.xml = readFileSync(info, "utf8");
    const label = comicInfoChapterLabel(chapter.xml);
    if (label) chapter.title = label;
  }
  return { chapters, temps };
  } catch (error) {
    for (const temp of temps) rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || `series-${createHash("sha256").update(name).digest("hex").slice(0, 12)}`;
}

function runtimeSlot(appId: string): string {
  return createHash("sha256").update(appId, "utf8").digest("hex").slice(0, 16);
}

export function bake(args: Args) {
  if (!Number.isInteger(args.width) || args.width < 64 || args.width > 1000 ||
      !Number.isInteger(args.zoom) || args.zoom < 1 || args.zoom > 8) throw Error("Invalid bake dimensions");
  if (!existsSync(args.library)) throw new Error(`library not found: ${args.library}`);
  mkdirSync(args.out, { recursive: true });
  const library = resolve(args.library);

  const candidates = readdirSync(library, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .filter((name) => !args.only || slugify(name) === args.only)
    .sort((a, b) => NATURAL.compare(a, b));
  if (candidates.length === 0) throw new Error(`no series directories under ${library}`);

  const names = new Set<string>();
  for (const name of candidates) {
    const slug = slugify(name);
    if (names.has(slug)) throw Error(`Series names collide at ${slug}; rename one directory`);
    names.add(slug);
  }
  if (args.identity && candidates.length !== 1) throw Error("A rendition must contain one series");
  const index: LibraryIndex = { v: 3, series: [] };
  const temps: string[] = [];
  try {
  for (const name of candidates) {
    const dir = join(library, name);
    const { chapters, temps: chapterTemps } = collectChapters(dir);
    temps.push(...chapterTemps);
    const images = chapters.flatMap((chapter) => chapter.files);
    if (images.length === 0) {
      console.log(`  skip ${name}: no images`);
      continue;
    }
    const slug = args.identity?.slug ?? slugify(name);
    // The document canvas is as tall as the tallest page at the reading width,
    // so a wide title banner pads instead of shrinking every page.
    const sizes = images.map((file) => probe(file));
    const heights = sizes.map((size) => Math.max(1, Math.round((args.width * size.height) / size.width)));
    const pageH = heights.reduce((a, b) => Math.max(a, b), 1);
    if (pageH > 16384) throw Error(`${name}: page canvas exceeds 16384 pixels; split long strips`);
    // Bake enough levels to reach the source resolution at the reading width,
    // never past the configured cap. A series only as wide as the reading
    // width gets its fit level alone.
    const sourceW = sizes.reduce((max, size) => Math.max(max, size.width), 1);
    const nativeScale = Math.min(args.zoom, Math.max(1, Math.floor(sourceW / args.width)));
    const levels: LevelMeta[] = [];
    const overviewScale = Math.min(1, 768 / pageH, 768 / args.width);
    if (overviewScale < 1) {
      const grid = tileGrid(Math.round(args.width * overviewScale), Math.round(pageH * overviewScale));
      levels.push({ scale: overviewScale, cols: grid.cols, rows: grid.rows });
    }
    for (let scale = 1; scale <= nativeScale; scale++) {
      if (args.width * pageH * scale * scale > 16 * 1024 * 1024) break;
      const grid = tileGrid(Math.round(args.width * scale), Math.round(pageH * scale));
      levels.push({ scale, cols: grid.cols, rows: grid.rows });
    }
    const firstXml = chapters.find((chapter) => chapter.xml)?.xml;
    const catalog = mergeMetadata(
      existsSync(join(dir, "series.json"))
        ? parseSeriesJson(readFileSync(join(dir, "series.json"), "utf8"))
        : {},
      firstXml ? parseComicInfo(firstXml) : {},
    );
    const meta: SeriesMeta = {
      slug,
      title: catalog.title ?? name,
      pages: images.length,
      pageW: args.width,
      pageH,
      direction: catalog.direction ?? "rtl",
      levels,
      ...(args.identity ? { pack: args.identity.pack } : {}),
    };
    if (chapters.length > 1) {
      let page = 0;
      const list: ChapterMeta[] = chapters.map((chapter, chapterIndex) => {
        const entry = { title: args.chapterTitles?.[chapterIndex] || chapter.title || name, page };
        page += chapter.files.length;
        return entry;
      });
      meta.chapters = list;
    }
    if (catalog.author) meta.author = catalog.author;
    if (catalog.artist) meta.artist = catalog.artist;
    if (catalog.publisher) meta.publisher = catalog.publisher;
    if (catalog.genres) meta.genres = catalog.genres;
    if (catalog.status) meta.status = catalog.status;
    if (catalog.year) meta.year = catalog.year;
    if (catalog.language) meta.language = catalog.language;
    if (catalog.summary) {
      meta.summary = catalog.summary.length > SUMMARY_LIMIT
        ? `${catalog.summary.slice(0, SUMMARY_LIMIT - 1).trimEnd()}\u2026`
        : catalog.summary;
    }
    const tileEnd = 2 + images.length * tilesPerPage(meta);
    const document = encodeDocument(meta, tileEnd);
    const total = tileEnd + document.chunks.length;
    if (total > 65536) throw new Error(`${name}: ${total} entries exceeds the PRP entry limit`);
    const packPath = join(args.out, `${args.identity?.pack ?? seriesPackName(slug)}.prp`);
    const pack = createResourcePack(packPath, total);
    try {
    pack.add(new TextEncoder().encode(document.head));
    pack.add(prepareTiledRGB565(makeCover(decodeInto(images[0]!, args.width, pageH), COVER), COVER, COVER), { width: COVER, height: COVER });
    for (let page = 0; page < images.length; page++) {
      for (const level of levels) {
        // Each page is fit into the document canvas, then scaled to this
        // level: different aspect ratios pad rather than fail the bake.
        const decoded = decodeInto(
          images[page]!,
          Math.round(args.width * level.scale),
          Math.round(pageH * level.scale),
        );
        for (let ty = 0; ty < level.rows; ty++)
          for (let tx = 0; tx < level.cols; tx++)
            pack.add(prepareTiledRGB565(makeTile(decoded, tx, ty), TILE, TILE), { width: TILE, height: TILE });
      }
    }
    for (const chunk of document.chunks) pack.add(new TextEncoder().encode(chunk));
    const { entries, bytes } = pack.finish();
    const summary: SeriesSummary = {
      slug,
      title: meta.title,
      pages: meta.pages,
      direction: meta.direction,
      ...(meta.pack ? { pack: meta.pack } : {}),
    };
    index.series.push(summary);
    console.log(`  ${slug}: ${images.length} pages, ${levels.length} level(s), ${tilesPerPage(meta)} tiles/page, ${entries} entries, ${(bytes / 1048576).toFixed(1)} MiB`);
    } catch (error) { pack.abort(); throw error; }
  }
  } finally {
    for (const temp of temps) rmSync(temp, { recursive: true, force: true });
  }

  if (index.series.length === 0) throw new Error("no series with images were baked");
  const document = encodeDocument(index, 1);
  const indexPack = createResourcePack(join(args.out, `${INDEX_PACK}.prp`), 1 + document.chunks.length);
  try {
    indexPack.add(new TextEncoder().encode(document.head));
    for (const chunk of document.chunks) indexPack.add(new TextEncoder().encode(chunk));
    indexPack.finish();
  } catch (error) { indexPack.abort(); throw error; }

  const slot = runtimeSlot(APP_ID);
  console.log(`\nbaked ${index.series.length} series to ${args.out}`);
  console.log(`install: copy ${args.out}/${INDEX_PACK}.prp and ${args.out}/manga-*.prp to`);
  console.log(`         sdmc:/pocketjs/assets/${slot}/ (${APP_ID})`);
  return index;
}

// Guarded so tests can import the helpers without running the CLI.
if (import.meta.main) {
  try {
    bake(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`bake: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

export { decodeInto, makeTile, makeCover, rgb24To565, slugify, collectImages, type Page };
