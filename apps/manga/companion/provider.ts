import { readPack, packImage, packSignature } from "./packs.ts";
import { identity } from "./sources.ts";
import { boundedCache } from "../cache.ts";
import { MangaStore } from "./store.ts";
import { parseProgress } from "../progress.ts";
import type { OffloadImage } from "../../../contracts/spec/offload.ts";
import { deflateSync } from "node:zlib";
import { documentHead } from "../document.ts";
import { levelTiles, pageTile, pageTileBase, pageTiles, parseSeries, pickLevel, tilesPerPage, windowTiles, type SeriesMeta } from "../model.ts";

export interface MangaResource { revision: string; payload?: string; image?: OffloadImage;
  compressed?: { pixels: Uint8Array; width: number; height: number }; notModified?: boolean }
export function mangaMethods(root: string, budget = { maxEntries: 1536, maxBytes: 128 * 1024 * 1024 }) {
  const store = new MangaStore(root);
  const cache = boundedCache<string, { signature: string; resource: MangaResource }>(budget.maxEntries, budget.maxBytes);
  let reads = 0, conversions = 0;
  const metas = new Map<string, { signature: string; meta: SeriesMeta }>();
  const warmQueue: string[] = [], warmKeys = new Set<string>();
  let warmTimer: ReturnType<typeof setTimeout> | undefined, closed = false, warming = false;
  let warmed = 0, warmFailures = 0;
  function metaFor(pack: string): SeriesMeta | undefined {
    try {
      const signature = packSignature(root, pack), held = metas.get(pack);
      if (held?.signature === signature) return held.meta;
      if (held) {
        metas.delete(pack);
        warmQueue.splice(0, warmQueue.length, ...warmQueue.filter(key => !key.startsWith(`${pack}/`)));
        for (const key of warmKeys) if (key.startsWith(`${pack}/`)) warmKeys.delete(key);
      }
      const first = readPack(root, pack, 0).bytes.toString("utf8"), head = documentHead(first);
      const raw = head ? Array.from({ length: head.count }, (_, n) =>
        JSON.parse(readPack(root, pack, head.start + n).bytes.toString("utf8")) as string).join("") : first;
      const meta = parseSeries(JSON.parse(raw));
      if (meta) metas.set(pack, { signature, meta });
      return meta;
    } catch { return undefined; }
  }
  function warmNext() {
    warmTimer = undefined;
    if (closed) return;
    const payload = warmQueue.shift();
    if (payload) {
      warming = true;
      try { resource("manga.image-z", payload); warmed++; }
      catch { warmFailures++; }
      finally { warmKeys.delete(payload); warming = false; }
    }
    if (warmQueue.length) warmTimer = setTimeout(warmNext, 15);
  }
  function warmPages(pack: string, firstPage: number, focusEntry?: number) {
    const meta = metaFor(pack);
    if (!meta) return;
    const fitHeight = 240 * meta.pageW / 400;
    const desired: string[] = [], seen = new Set<string>();
    const add = (tile: { pack: string; entry: number }) => {
      const payload = `${tile.pack}/${tile.entry}`;
      if (seen.has(payload)) return;
      seen.add(payload);
      const cached = cache.get(`manga.image:${payload}`);
      if (cached?.signature !== metas.get(pack)?.signature) desired.push(payload);
    };
    const queue = (page: number, level: number, full = false) => {
      const visible = windowTiles(meta, page, level, 0, 0, meta.pageW, fitHeight, 0);
      const tiles = full ? [...visible, ...pageTiles(meta, page, level)] : visible;
      for (const tile of tiles) add(tile);
    };
    const detail = pickLevel(meta, 400 / meta.pageW);
    if (focusEntry !== undefined) {
      let offset = focusEntry - pageTileBase(meta, firstPage);
      for (let level = 0; level < meta.levels.length; level++) {
        const lv = meta.levels[level]!, count = levelTiles(lv);
        if (offset < count) {
          if (level > 0 && count > 1) {
            const x = offset % lv.cols, y = Math.floor(offset / lv.cols);
            for (let radius = 0; radius <= 1; radius++)
              for (let dy = -radius; dy <= radius; dy++)
                for (let dx = -radius; dx <= radius; dx++)
                  if (Math.max(Math.abs(dx), Math.abs(dy)) === radius && x + dx >= 0 && x + dx < lv.cols && y + dy >= 0 && y + dy < lv.rows)
                    add(pageTile(meta, firstPage, level, x + dx, y + dy));
          }
          break;
        }
        offset -= count;
      }
    }
    // Finish the first screen before scanning the full page. A page turn
    // promotes its working set ahead of stale background preparations.
    queue(firstPage, 0);
    if (detail > 0) queue(firstPage, detail);
    if (firstPage + 1 < meta.pages) queue(firstPage + 1, 0);
    for (let page = firstPage; page < Math.min(meta.pages, firstPage + 3); page++) {
      queue(page, 0, true);
      if (detail > 0) queue(page, detail, true);
    }
    for (let page = firstPage + 3; page < Math.min(meta.pages, firstPage + 6); page++) queue(page, 0, true);
    const reordered = [...desired, ...warmQueue.filter(payload => !seen.has(payload))].slice(0, 128);
    warmQueue.splice(0, warmQueue.length, ...reordered);
    warmKeys.clear(); for (const payload of warmQueue) warmKeys.add(payload);
    if (warmQueue.length && !warmTimer) warmTimer = setTimeout(warmNext, 15);
  }
  const resource = (method: string, payload: string, ifRevision?: string): MangaResource => {
    const describe = method === "manga.describe", compressed = method === "manga.image-z", image = compressed || method === "manga.image";
    if (!describe && !image && method !== "manga.read") throw Error("Unknown manga resource");
    const [pack, entry, extra] = payload.split("/");
    if (!pack || (describe ? entry !== undefined : extra !== undefined || !/^(0|[1-9][0-9]{0,4})$/.test(entry ?? ""))) throw Error("Invalid pack address");
    const key = `${image ? "manga.image" : method}:${payload}`;
    let current: string;
    try { current = packSignature(root, pack); }
    catch (error) { cache.delete(key); throw error; }
    const held = cache.get(key);
    let result = held?.signature === current ? held.resource : undefined;
    if (!result) {
      cache.delete(key);
      const record = readPack(root, pack, describe ? 0 : Number(entry)); reads++;
      if (!image && !describe && record.kind !== 1) throw Error("Not a metadata record");
      const revision = `file-${identity(record.signature)}`;
      if (image) { result = { revision, image: packImage(record) }; conversions++; }
      else result = { revision, payload: describe ? JSON.stringify({ count: record.count }) : record.bytes.toString("utf8") };
    }
    if (compressed && result.image && !result.compressed) {
      const { pixels, width, height } = result.image;
      const packed = deflateSync(pixels, { level: 6 });
      if (packed.length < pixels.length) result.compressed = { pixels: packed, width, height };
    }
    cache.set(key, { signature: current, resource: result },
      (result.image?.pixels.length ?? Buffer.byteLength(result.payload!)) + (result.compressed?.pixels.length ?? 0) + key.length * 2 + current.length * 2 + 256);
    if (!warming && pack !== "manga-index") {
      if (method === "manga.read" && entry === "0") warmPages(pack, 0);
      else if (image) {
        const meta = metaFor(pack), index = Number(entry);
        if (meta && index >= 2) {
          const page = Math.floor((index - 2) / tilesPerPage(meta));
          if (page < meta.pages) warmPages(pack, page, index);
        }
      }
    }
    // Cached records were validated before insertion; unchanged stat identity
    // permits revalidation without inflation, pixel conversion or image IPC.
    if (ifRevision === result.revision) return { revision: result.revision, notModified: true };
    if (compressed && result.compressed) return { revision: result.revision,
      compressed: { ...result.compressed, pixels: result.compressed.pixels.slice() } };
    return result.image ? { revision: result.revision, image: { ...result.image, pixels: result.image.pixels.slice() } }
      : { revision: result.revision, payload: result.payload };
  };
  const writeProgress = (value: any): string => {
    if (typeof value.device !== "string" || !/^[a-z0-9-]{1,64}$/.test(value.device) ||
        typeof value.slug !== "string" || !/^[a-z0-9-]{1,42}$/.test(value.slug)) throw Error("Invalid progress identity");
    const progress = parseProgress(JSON.stringify({ series: { [value.slug]: value.progress } })).series[value.slug];
    if (!progress) throw Error("Invalid reading progress");
    const row = store.db.query("SELECT data FROM progress WHERE device=? AND slug=?").get(value.device, value.slug) as { data: string } | null;
    const previous = row ? JSON.parse(row.data) : undefined;
    // Replayed saves from one terminal cannot roll back a later save. Keep
    // devices separate: wall clocks on old consoles need not agree.
    if (!previous || progress.updated >= previous.updated)
      store.db.query("INSERT OR REPLACE INTO progress VALUES(?,?,?)").run(value.device, value.slug, JSON.stringify(progress));
    return JSON.stringify({ saved: progress.updated });
  };
  return { resource, cacheStats: () => ({ ...cache.stats(), reads, conversions, warmed, warmFailures, warmPending: warmQueue.length }),
    close: () => { closed = true; if (warmTimer) clearTimeout(warmTimer); warmQueue.length = 0; cache.clear(); store.close(); }, methods: {
    "manga.read": (payload: string): string => resource("manga.read", payload).payload!,
    "manga.image": (payload: string): OffloadImage => resource("manga.image", payload).image!,
    "manga.describe": (payload: string): string => resource("manga.describe", payload).payload!,
    "manga.progress": (payload: string): string => writeProgress(JSON.parse(payload)),
    "manga.progress-part": (payload: string): string => {
      const v = JSON.parse(payload);
      if (typeof v.device !== "string" || !/^[a-z0-9-]{1,64}$/.test(v.device) ||
          typeof v.slug !== "string" || !/^[a-z0-9-]{1,42}$/.test(v.slug) ||
          !Number.isSafeInteger(v.updated) || v.updated < 0 || !Number.isInteger(v.total) || v.total < 1 || v.total > 164 ||
          !Number.isInteger(v.part) || v.part < 0 || v.part >= v.total || typeof v.data !== "string" || v.data.length > 400) throw Error("Invalid progress chunk");
      return store.db.transaction(() => {
        const prior = store.db.query("SELECT data FROM progress WHERE device=? AND slug=?").get(v.device, v.slug) as { data: string } | null;
        if (prior && JSON.parse(prior.data).updated >= v.updated) return JSON.stringify({ saved: v.updated });
        const pending = store.db.query("SELECT MAX(updated) AS updated FROM progress_parts WHERE device=? AND slug=?").get(v.device, v.slug) as { updated: number | null };
        if (pending.updated !== null && pending.updated > v.updated) throw Error("Progress revision was superseded");
        store.db.query("DELETE FROM progress_parts WHERE device=? AND slug=? AND updated<>?").run(v.device, v.slug, v.updated);
        store.db.query("INSERT OR REPLACE INTO progress_parts VALUES(?,?,?,?,?,?)").run(v.device, v.slug, v.updated, v.part, v.total, v.data);
        const chunks = store.db.query("SELECT total,data FROM progress_parts WHERE device=? AND slug=? AND updated=? ORDER BY part").all(v.device, v.slug, v.updated) as { total: number; data: string }[];
        if (chunks.some(c => c.total !== v.total)) throw Error("Progress chunk count changed");
        if (chunks.length !== v.total) return JSON.stringify({ accepted: v.part });
        const raw = chunks.map(c => c.data).join("");
        if (Buffer.byteLength(raw) > 65536) throw Error("Progress exceeds state budget");
        const progress = JSON.parse(raw);
        if (progress.updated !== v.updated) throw Error("Progress revision mismatch");
        const reply = writeProgress({ device: v.device, slug: v.slug, progress });
        store.db.query("DELETE FROM progress_parts WHERE device=? AND slug=?").run(v.device, v.slug);
        return reply;
      })();
    },
  } };
}
