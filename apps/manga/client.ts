/** Terminal-side coordinator. Remote work and local storage use bounded
 * asynchronous transports; no HTTP, files, codecs or source adapters here. */
import type { OffloadResult } from "@pocketjs/framework/offload";
import { boundedCache } from "./cache.ts";
import { createMangaImages, type Withdrawal } from "./image-cache.ts";
import { documentHead, encodeDocument, readDocument } from "./document.ts";
import { INDEX_PACK, packOf, parseIndex, parseSeries, tilesPerPage, type LibraryIndex, type SeriesMeta, type SeriesSummary } from "./model.ts";

export interface MangaTransport {
  connected(): boolean;
  session(): number;
  request(method: string, payload: string, callback: (result: OffloadResult) => void): number;
  requestImage(method: string, payload: string, callback: (result: OffloadResult) => void): number;
  cancel(id: number): void;
  uploadImage(ticket: string): { handle: number; width: number; height: number };
  releaseImage(ticket: string): void;
}
export interface MangaCache {
  remove?(pack: string, cb: (result: OffloadResult) => void): number;
  text(pack: string, entry: number, value: string, cb: (result: OffloadResult) => void): number;
  image(pack: string, entry: number, ticket: string, cb: (result: OffloadResult) => void): number;
}
interface Task { start(): number; cancel(id: number): void; fail(error: Error): void; id: number; age: number; done: boolean }
export function createMangaConnection(options: { local?: MangaTransport; remote?: MangaTransport; cache?: MangaCache; onCacheError?: (error: string) => void }) {
  const { local, remote, cache } = options;
  const tasks = new Set<Task>();
  // Only acknowledged disk records enter this cache. RAM-only remote replies
  // cannot satisfy a strict offline save or publish a new offline catalog.
  const durableText = boundedCache<string, string>(32, 64 * 1024);
  interface TextRecord { raw: string; durable: boolean; error?: unknown }
  const readingText = new Map<string, Promise<TextRecord>>();
  const writing = new Map<string, Set<Promise<void>>>(), removing = new Set<string>();
  let cacheGeneration = 0;
  let activeDownload: { stop: Withdrawal; done: Promise<void> } | undefined;
  let cacheSession = local?.session();
  function checkCacheSession() {
    if (cacheSession !== local?.session()) { durableText.clear(); cacheSession = local?.session(); }
  }
  function rememberText(address: string, raw: string) {
    checkCacheSession();
    if (!disposed) durableText.set(address, raw, (address.length + raw.length) * 2 + 64);
  }
  let disposed = false, downloadGeneration = 0;
  function run(start: (cb: (r: OffloadResult) => void) => number, cancel: (id: number) => void, withdrawal?: Withdrawal): Promise<string> {
    return new Promise((resolve, reject) => {
      if (disposed || withdrawal?.cancelled) { reject(Error("Manga request cancelled")); return; }
      if (tasks.size >= 24) { reject(Error("Manga request queue unavailable")); return; }
      const finish = () => {
        if (task.done) return false;
        task.done = true; tasks.delete(task); if (withdrawal) withdrawal.cancel = undefined; return true;
      };
      const task: Task = { id: 0, age: 0, done: false, cancel,
        fail(error) { if (finish()) { if (task.id) cancel(task.id); reject(error); } },
        start: () => start(result => { if (finish()) result.ok ? resolve(result.value) : reject(Error(result.error)); }) };
      tasks.add(task);
      if (withdrawal) withdrawal.cancel = () => task.fail(Error("Manga request cancelled"));
    });
  }
  function call(client: MangaTransport | undefined, method: string, payload: string, image = false, withdrawal?: Withdrawal): Promise<string> {
    if (!client?.connected()) return Promise.reject(Error("Companion offline or cache unavailable"));
    return run(cb => {
      if (!client.connected()) throw Error("Companion disconnected");
      return image ? client.requestImage(method, payload, cb) : client.request(method, payload, cb);
    }, id => client.cancel(id), withdrawal);
  }
  async function save(pack: string, entry: number, value: string, image = false, withdrawal?: Withdrawal): Promise<void> {
    if (!cache || !local) throw Error("This host cannot save offline records; use SD export");
    checkCacheSession();
    if (disposed || withdrawal?.cancelled || removing.has(pack)) throw Error("Manga request cancelled");
    if (!image && durableText.get(`${pack}/${entry}`) === value) return;
    // An admitted native write owns a pixel copy and cannot be withdrawn by
    // cancelling its JS callback. Keep its acknowledgement for removal drains.
    const pending = run(cb => image ? cache.image(pack, entry, value, cb) : cache.text(pack, entry, value, cb), id => local.cancel(id))
      .then(() => { if (!image) rememberText(`${pack}/${entry}`, value); });
    const writes = writing.get(pack) ?? new Set<Promise<void>>();
    writing.set(pack, writes); writes.add(pending);
    try { await pending; }
    finally { writes.delete(pending); if (!writes.size) writing.delete(pack); }
  }
  function readText(pack: string, entry: number, origin: "auto" | "local" | "remote"): Promise<TextRecord> {
    checkCacheSession();
    const address = `${pack}/${entry}`, generation = cacheGeneration, key = `${generation}:${origin}:${address}`;
    if (disposed) return Promise.reject(Error("Reader closed"));
    if (removing.has(pack)) return Promise.reject(Error("Cache removal in progress"));
    // Completeness markers share the rendition prefix but are mutable state.
    if (origin !== "remote" && local?.connected() && /^(mc-|mg-|saved-)/.test(pack) && !pack.endsWith("-ok")) {
      const raw = durableText.get(address);
      if (raw !== undefined) return Promise.resolve({ raw, durable: true });
    }
    const pending = readingText.get(key);
    if (pending) return pending;
    if (readingText.size >= 24) return Promise.reject(Error("Manga metadata queue unavailable"));
    const reading = (async (): Promise<TextRecord> => {
      if (origin !== "remote" && local?.connected()) {
        try {
          const raw = await call(local, "pack.read", address);
          if (generation !== cacheGeneration || removing.has(pack)) throw Error("Manga cache changed during the request");
          rememberText(address, raw); return { raw, durable: true };
        } catch (error) { durableText.delete(address); if (origin === "local") throw error; }
      }
      if (origin === "local") throw Error("Offline metadata is not saved");
      const raw = await call(remote, "manga.read", address);
      if (cache) try {
        if (generation !== cacheGeneration) throw Error("Manga cache changed during the request");
        await save(pack, entry, raw); return { raw, durable: true };
      }
      catch (error) { options.onCacheError?.(String(error)); return { raw, durable: false, error }; }
      return { raw, durable: false };
    })().finally(() => { readingText.delete(key); });
    readingText.set(key, reading); return reading;
  }
  async function text(pack: string, entry: number, origin: "auto" | "local" | "remote" = "auto", strictCache = false): Promise<string> {
    const result = await readText(pack, entry, origin);
    if (strictCache && cache && !result.durable) throw result.error ?? Error("Metadata was not saved");
    return result.raw;
  }
  async function baseIndex(origin: "local" | "remote"): Promise<LibraryIndex> {
    // The mutable root is committed last. Its referenced records are immutable,
    // so an interrupted refresh leaves the previous offline catalog readable.
    const root = await call(origin === "local" ? local : remote, origin === "local" ? "pack.read" : "manga.read", `${INDEX_PACK}/0`);
    if (origin === "local") rememberText(`${INDEX_PACK}/0`, root);
    const pointer = JSON.parse(root);
    let raw: string;
    let cached = true;
    if (typeof pointer?.catalog === "string" && /^[a-z0-9-]{1,48}$/.test(pointer.catalog)) {
      raw = await readDocument(async n => {
        if (origin === "local") return text(pointer.catalog, n, "local");
        const record = await readText(pointer.catalog, n, "auto");
        if (!record.durable) cached = false;
        return record.raw;
      });
    } else raw = await readDocument(async n => n === 0 ? root : text(INDEX_PACK, n, origin));
    const parsed = parseIndex(raw);
    if (!parsed) throw Error("Invalid manga catalog");
    if (origin === "remote" && cache && cached && pointer.catalog) try {
      // A cold boot can reuse an unchanged SD pointer without rewriting it.
      if (durableText.get(`${INDEX_PACK}/0`) === undefined) try { await text(INDEX_PACK, 0, "local"); } catch { /* First sync. */ }
      await save(INDEX_PACK, 0, root);
    }
    catch (error) { options.onCacheError?.(String(error)); }
    return parsed;
  }
  async function savedIndex(): Promise<LibraryIndex> {
    try {
      const pointer = JSON.parse(await text("manga-saved", 0, "local"));
      if (typeof pointer.catalog !== "string" || !/^[a-z0-9-]{1,48}$/.test(pointer.catalog)) throw Error("Invalid saved catalog");
      return parseIndex(await readDocument(n => text(pointer.catalog, n, "local"))) ?? { v: 3, series: [] };
    } catch { return { v: 3, series: [] }; }
  }
  async function pin(summary: SeriesSummary, remove = false) {
    const saved = await savedIndex();
    const next: LibraryIndex = { v: 3, series: [...saved.series.filter(s => s.slug !== summary.slug || remove && packOf(s) !== packOf(summary)), ...(remove ? [] : [summary])] };
    const name = `saved-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;
    const doc = encodeDocument(next, 1);
    for (let n = 0; n < doc.chunks.length; n++) await save(name, n + 1, doc.chunks[n]!);
    await save(name, 0, doc.head);
    await save("manga-saved", 0, JSON.stringify({ catalog: name }));
  }
  async function index(origin: "local" | "remote"): Promise<LibraryIndex> {
    const saved = await savedIndex();
    let base: LibraryIndex;
    try { base = await baseIndex(origin); }
    catch (error) { if (saved.series.length && origin === "local") return saved; throw error; }
    // Offline favors the last complete rendition. A companion update cannot erase
    // the version the reader took on a trip. Online includes removed-but-saved books.
    const all = new Map<string, SeriesSummary>();
    for (const s of (origin === "local" ? base.series : saved.series)) all.set(s.slug, s);
    for (const s of (origin === "local" ? saved.series : base.series)) all.set(s.slug, s);
    return { v: 3, series: [...all.values()] };
  }
  const marker = (pack: string) => pack.slice(0, 45) + "-ok";
  async function meta(summary: SeriesSummary): Promise<SeriesMeta> {
    const parsed = parseSeries(JSON.parse(await readDocument(n => text(packOf(summary), n))));
    if (!parsed || parsed.slug !== summary.slug || packOf(parsed) !== packOf(summary)) throw Error("Series metadata does not match its rendition");
    return parsed;
  }
  const imageClient = remote ? createMangaImages({ remote,
    fetch: (payload, stop) => call(remote, "manga.image", payload, true, stop),
    save: cache ? (payload, ticket, stop) => { const [pack, entry] = payload.split("/"); return save(pack!, Number(entry), ticket, true, stop); } : undefined,
    onCacheError: options.onCacheError,
  }) : undefined;
  function cancelDownload() {
    downloadGeneration++;
    if (activeDownload) { activeDownload.stop.cancelled = true; activeDownload.stop.cancel?.(); }
  }
  async function download(summary: SeriesSummary, progress: (done: number, total: number) => void, stop: Withdrawal) {
    if (!cache) throw Error("Offline saving needs a writable resource cache; use SD export on this host");
    const generation = downloadGeneration, pack = packOf(summary);
    const check = () => { if (disposed || stop.cancelled || generation !== downloadGeneration) throw Error("Offline download cancelled"); };
    const raw = await text(pack, 0, "auto", true), head = documentHead(raw);
    check();
    const parsed = await meta(summary);
    check();
    const total = 2 + parsed.pages * tilesPerPage(parsed) + (head?.count ?? 0);
    const described = JSON.parse(await call(remote, "manga.describe", pack, false, stop));
    if (described.count !== total) throw Error("Rendition entry count mismatch");
    for (let n = 0; n < total; n++) {
      check(); progress(n, total);
      const image = n >= 1 && n < 2 + parsed.pages * tilesPerPage(parsed);
      let localHit = false;
      if (local?.connected()) try {
        const value = await call(local, "pack.read", `${pack}/${n}`, image, stop);
        if (image) local.releaseImage(value);
        localHit = true;
      } catch { /* Missing entries are the resumable download cursor. */ }
      check();
      if (localHit) continue;
      if (image) {
        if (!imageClient) throw Error("Companion offline");
        const ticket = await run(cb => imageClient.requestImage("manga.image", `${pack}/${n}`, cb), id => imageClient.cancel(id), stop);
        try { await imageClient.persist(ticket); }
        finally { imageClient.releaseImage(ticket); }
      } else {
        const value = await call(remote, "manga.read", `${pack}/${n}`, false, stop);
        await save(pack, n, value, false, stop);
      }
    }
    check(); await pin(summary); check();
    await save(marker(pack), 0, JSON.stringify({ complete: true, pack }), false, stop);
    check(); progress(total, total);
  }
  return {
    text, index, meta, imageClient,
    connected: () => remote?.connected() ?? false,
    session: () => remote?.session() ?? 0,
    canCache: () => !!cache,
    step() {
      for (const task of tasks) {
        if (task.done) { tasks.delete(task); continue; }
        if (++task.age > 1200 || disposed) { task.fail(Error("Manga request timed out")); continue; }
        if (!task.id) try { task.id = task.start(); }
        catch (error) { task.fail(error instanceof Error ? error : Error(String(error))); }
      }
    },
    async downloaded(summary: SeriesSummary): Promise<boolean> {
      try { const flag = JSON.parse(await text(marker(packOf(summary)), 0, "local")); return flag.complete === true && flag.pack === packOf(summary); }
      catch { return false; }
    },
    download(summary: SeriesSummary, progress: (done: number, total: number) => void) {
      const previous = activeDownload?.done.catch(() => {});
      cancelDownload();
      const stop: Withdrawal = { cancelled: false };
      const done = (async () => {
        await previous;
        if (stop.cancelled || disposed) throw Error("Offline download cancelled");
        await download(summary, progress, stop);
      })().finally(() => { if (activeDownload?.stop === stop) activeDownload = undefined; });
      activeDownload = { stop, done }; return done;
    },
    cancelDownload,
    async removeDownload(summary: SeriesSummary) {
      if (!cache?.remove || !local) throw Error("This host cannot remove cached records");
      const pack = packOf(summary);
      if (removing.has(pack)) throw Error("Cache removal already in progress");
      removing.add(pack); removing.add(marker(pack)); cacheGeneration++;
      cancelDownload();
      const downloading = activeDownload?.done.catch(() => {});
      try {
        await imageClient?.block(pack); await downloading;
        await Promise.all([...(writing.get(pack) ?? []), ...(writing.get(marker(pack)) ?? [])].map(p => p.catch(() => {})));
        // Remove the completeness claim before changing any page records.
        await run(cb => cache.remove!(marker(pack), cb), id => local.cancel(id));
        await pin(summary, true);
        await run(cb => cache.remove!(pack, cb), id => local.cancel(id));
      } finally {
        durableText.deleteWhere(key => key.startsWith(pack + "/") || key.startsWith(marker(pack) + "/"));
        removing.delete(pack); removing.delete(marker(pack)); imageClient?.unblock(pack);
      }
    },
    async syncProgress(device: string, slug: string, progress: { updated: number }) {
      const raw = JSON.stringify(progress);
      if (raw.length > 65536) throw Error("Progress exceeds state budget");
      const total = Math.ceil(raw.length / 400);
      for (let part = 0; part < total; part++) {
        const reply = await call(remote, "manga.progress-part", JSON.stringify({ device, slug, updated: progress.updated, part, total, data: raw.slice(part * 400, (part + 1) * 400) }));
        if (JSON.parse(reply).saved === progress.updated) return;
      }
      throw Error("Companion did not commit reading progress");
    },
    dispose() {
      disposed = true; cacheGeneration++; cancelDownload(); imageClient?.dispose();
      for (const task of tasks) task.fail(Error("Reader closed"));
      tasks.clear();
      durableText.clear();
    },
  };
}
