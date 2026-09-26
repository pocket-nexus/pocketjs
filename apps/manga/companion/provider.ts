import { readPack, packImage, packSignature } from "./packs.ts";
import { identity } from "./sources.ts";
import { boundedCache } from "../cache.ts";
import { MangaStore } from "./store.ts";
import { parseProgress } from "../progress.ts";
import type { OffloadImage } from "../../../contracts/spec/offload.ts";

export interface MangaResource { revision: string; payload?: string; image?: OffloadImage; notModified?: boolean }
export function mangaMethods(root: string, budget = { maxEntries: 256, maxBytes: 8 * 1024 * 1024 }) {
  const store = new MangaStore(root);
  const cache = boundedCache<string, { signature: string; resource: MangaResource }>(budget.maxEntries, budget.maxBytes);
  let reads = 0, conversions = 0;
  const resource = (method: string, payload: string, ifRevision?: string): MangaResource => {
    const describe = method === "manga.describe", image = method === "manga.image";
    if (!describe && !image && method !== "manga.read") throw Error("Unknown manga resource");
    const [pack, entry, extra] = payload.split("/");
    if (!pack || (describe ? entry !== undefined : extra !== undefined || !/^(0|[1-9][0-9]{0,4})$/.test(entry ?? ""))) throw Error("Invalid pack address");
    const key = `${method}:${payload}`;
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
      cache.set(key, { signature: record.signature, resource: result },
        (result.image?.pixels.length ?? Buffer.byteLength(result.payload!)) + key.length * 2 + record.signature.length * 2 + 256);
    }
    // Cached records were validated before insertion; unchanged stat identity
    // permits revalidation without inflation, pixel conversion or image IPC.
    if (ifRevision === result.revision) return { revision: result.revision, notModified: true };
    return result.image ? { ...result, image: { ...result.image, pixels: result.image.pixels.slice() } } : { ...result };
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
  return { resource, cacheStats: () => ({ ...cache.stats(), reads, conversions }), close: () => { cache.clear(); store.close(); }, methods: {
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
