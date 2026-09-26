import { expect, test } from "bun:test";
import { createMangaConnection, type MangaCache, type MangaTransport } from "../apps/manga/client.ts";
import { encodeDocument } from "../apps/manga/document.ts";
import type { OffloadResult } from "../framework/src/offload.ts";

const summary = { slug: "book", title: "Book", pages: 2, direction: "rtl" as const, pack: "mg-original" };
const meta = { ...summary, pageW: 16, pageH: 16, levels: [{ scale: 1, cols: 1, rows: 1 }] };
function rig() {
  let online = true, epoch = 1, sequence = 0, failWrites = false, holdWrites = false;
  const local = new Map<string, string>(), remote = new Map<string, string>([
    ["manga-index/0", '{"catalog":"mc-one"}'], ["mc-one/0", JSON.stringify({ v: 3, series: [summary] })],
    ["mg-original/0", JSON.stringify(meta)], ["mg-original/1", "image"], ["mg-original/2", "image"], ["mg-original/3", "image"],
  ]);
  const tickets = new Set<string>(), writes: string[] = [], errors: string[] = [];
  const reads: string[] = [];
  const heldWrites: (() => void)[] = [], removals: string[] = [];
  const progressPayloads: string[] = [];
  const pending = new Map<number, boolean>();
  function transport(records: Map<string, string>, isRemote: boolean): MangaTransport {
    function request(method: string, payload: string, cb: (r: OffloadResult) => void, image = false) {
      const id = ++sequence; pending.set(id, true);
      reads.push(`${isRemote ? "remote" : "local"}:${method}:${payload}`);
      queueMicrotask(() => {
        if (!pending.delete(id)) return;
        if (isRemote && !online) { cb({ ok: false, error: "Disconnected" }); return; }
        if (method === "manga.describe") { cb({ ok: true, value: '{"count":4}' }); return; }
        if (method === "manga.progress-part") {
          progressPayloads.push(payload); const part = JSON.parse(payload);
          cb({ ok: true, value: JSON.stringify(part.part === part.total - 1 ? { saved: part.updated } : { accepted: part.part }) }); return;
        }
        const record = records.get(payload);
        if (record === undefined) cb({ ok: false, error: "Resource pack not installed" });
        else if (image && record === "image") {
          const ticket = JSON.stringify({ token: id, width: 16, height: 16, address: payload }); tickets.add(ticket); cb({ ok: true, value: ticket });
        } else if (!image && record !== "image") cb({ ok: true, value: record });
        else cb({ ok: false, error: "Wrong response kind" });
      });
      return id;
    }
    return {
      connected: () => !isRemote || online, session: () => !isRemote ? 1 : online ? epoch : 0,
      request, requestImage: (m, p, cb) => request(m, p, cb, true), cancel(id) { pending.delete(id); },
      uploadImage: () => ({ handle: 1, width: 16, height: 16 }), releaseImage(ticket) { expect(tickets.delete(ticket)).toBe(true); },
    };
  }
  const cache: MangaCache = {
    remove(pack, cb) { const id = ++sequence; queueMicrotask(() => { removals.push(pack); for (const key of local.keys()) if (key.startsWith(pack + "/")) local.delete(key); cb({ ok: true, value: "{}" }); }); return id; },
    text(pack, entry, value, cb) {
      const id = ++sequence; queueMicrotask(() => { if (failWrites) cb({ ok: false, error: "Disk full" }); else { local.set(`${pack}/${entry}`, value); writes.push(`${pack}/${entry}`); cb({ ok: true, value: "{}" }); } }); return id;
    },
    image(pack, entry, ticket, cb) {
      expect(tickets.has(ticket)).toBe(true);
      const id = ++sequence;
      const finish = () => { if (failWrites) cb({ ok: false, error: "Disk full" }); else { local.set(`${pack}/${entry}`, "image"); writes.push(`${pack}/${entry}`); cb({ ok: true, value: "{}" }); } };
      if (holdWrites) heldWrites.push(finish); else queueMicrotask(finish);
      return id;
    },
  };
  const options = { local: transport(local, false), remote: transport(remote, true), cache, onCacheError: (e: string) => errors.push(e) };
  let connection = createMangaConnection(options);
  async function drive<T>(promise: Promise<T>): Promise<T> {
    let done = false, result: T | undefined, error: unknown;
    promise.then(v => { result = v; done = true; }, e => { error = e; done = true; });
    for (let n = 0; n < 1300 && !done; n++) { connection.step(); await Promise.resolve(); }
    if (!done) throw Error("Test client did not settle");
    if (error) throw error; return result as T;
  }
  return { get connection() { return connection; }, drive, local, remote, tickets, writes, reads, removals, errors, progressPayloads,
    async tick(count = 30) { for (let n = 0; n < count; n++) { connection.step(); await Promise.resolve(); } },
    holdWrites() { holdWrites = true; },
    flushWrites() { holdWrites = false; for (const finish of heldWrites.splice(0)) finish(); },
    disconnect() { online = false; }, reconnect() { online = true; epoch++; }, diskFull(value: boolean) { failWrites = value; },
    reboot() { connection.dispose(); connection = createMangaConnection(options); },
  };
}

test("online reading caches records, full download survives disconnect and reboot", async () => {
  const r = rig();
  expect((await r.drive(r.connection.index("remote"))).series).toEqual([summary]);
  expect(await r.drive(r.connection.meta(summary))).toEqual(meta);
  await r.drive(r.connection.download(summary, () => {}));
  expect(r.tickets.size).toBe(0);
  r.disconnect(); r.reboot();
  expect((await r.drive(r.connection.index("local"))).series).toEqual([summary]);
  expect(await r.drive(r.connection.meta(summary))).toEqual(meta);
  expect(await r.drive(r.connection.downloaded(summary))).toBe(true);
  expect(r.local.get("mg-original/3")).toBe("image");
  r.connection.dispose();
});

function requestImage(r: ReturnType<typeof rig>, entry = 2) {
  return new Promise<string>((resolve, reject) => {
    const id = r.connection.imageClient!.requestImage("manga.image", `mg-original/${entry}`, reply => reply.ok ? resolve(reply.value) : reject(Error(reply.error)));
    if (!id) reject(Error("Image queue full"));
  });
}

test("image readers share one fetch and display before SD acknowledges, retaining pixels for the writer", async () => {
  const r = rig(); r.holdWrites();
  const images = r.connection.imageClient!;
  const [first, second] = await r.drive(Promise.all([requestImage(r), requestImage(r)]));
  expect(first).not.toBe(second);
  expect(r.reads.filter(v => v === "remote:manga.image:mg-original/2")).toHaveLength(1);
  expect(images.uploadImage(first).width).toBe(16); expect(images.uploadImage(second).height).toBe(16);
  expect(r.writes).toEqual([]); expect(r.tickets.size).toBe(1);
  let persisted = false;
  const saving = images.persist(first).then(() => { persisted = true; });
  images.releaseImage(first); images.releaseImage(second);
  await r.tick(); expect(persisted).toBe(false); expect(r.tickets.size).toBe(1);
  r.flushWrites(); await r.drive(saving);
  expect(r.tickets.size).toBe(0); expect(r.writes).toEqual(["mg-original/2"]);
  r.connection.dispose();
});

test("cancelling one image reader preserves the shared request for the other", async () => {
  const r = rig(); let cancelledCallback = false;
  const images = r.connection.imageClient!;
  const cancelled = images.requestImage("manga.image", "mg-original/2", () => { cancelledCallback = true; });
  const surviving = requestImage(r); images.cancel(cancelled);
  const ticket = await r.drive(surviving); await r.drive(images.persist(ticket)); images.releaseImage(ticket);
  expect(cancelledCallback).toBe(false); expect(r.tickets.size).toBe(0);
  expect(r.reads.filter(v => v === "remote:manga.image:mg-original/2")).toHaveLength(1);
  r.connection.dispose();
});

test("pending SD writes retain the four-image budget even after their readers release", async () => {
  const r = rig(); r.holdWrites(); r.remote.set("mg-original/4", "image");
  const images = r.connection.imageClient!;
  const tickets = await r.drive(Promise.all([1, 2, 3, 4].map(n => requestImage(r, n))));
  for (const ticket of tickets) images.releaseImage(ticket);
  expect(r.tickets.size).toBe(4);
  expect(images.requestImage("manga.image", "mg-other/1", () => {})).toBe(0);
  r.flushWrites(); await r.tick(); expect(r.tickets.size).toBe(0);
  const next = await r.drive(requestImage(r)); await r.drive(images.persist(next)); images.releaseImage(next);
  expect(r.tickets.size).toBe(0); r.connection.dispose();
});

test("a failed image write still renders online but cannot satisfy an offline save", async () => {
  const r = rig(); r.diskFull(true);
  const images = r.connection.imageClient!, ticket = await r.drive(requestImage(r));
  expect(images.uploadImage(ticket).handle).toBe(1);
  await expect(r.drive(images.persist(ticket))).rejects.toThrow("Disk full"); images.releaseImage(ticket);
  expect(r.errors).toHaveLength(1); expect(r.tickets.size).toBe(0); expect(r.local.size).toBe(0);
  r.connection.dispose();
});

test("removal waits for admitted SD writes so a late write cannot recreate the pack", async () => {
  const r = rig(); r.holdWrites();
  const images = r.connection.imageClient!, ticket = await r.drive(requestImage(r)); images.releaseImage(ticket);
  const removal = r.connection.removeDownload(summary);
  await r.tick(); expect(r.removals).toEqual([]); expect(r.tickets.size).toBe(1);
  r.flushWrites(); await r.drive(removal); await r.tick();
  expect(r.removals).toEqual(["mg-original-ok", "mg-original"]);
  expect(r.local.has("mg-original/2")).toBe(false); expect(r.tickets.size).toBe(0);
  r.connection.dispose();
});

test("offline downloads join a reader's pending image write and mark completeness after its acknowledgement", async () => {
  const r = rig(); r.holdWrites();
  const images = r.connection.imageClient!, ticket = await r.drive(requestImage(r, 1));
  const download = r.connection.download(summary, () => {});
  await r.tick(100);
  expect(r.reads.filter(v => v === "remote:manga.image:mg-original/1")).toHaveLength(1);
  expect(r.local.has("mg-original-ok/0")).toBe(false);
  r.flushWrites(); await r.drive(download); images.releaseImage(ticket);
  expect(await r.drive(r.connection.downloaded(summary))).toBe(true);
  expect(r.tickets.size).toBe(0); r.connection.dispose();
});

test("closing during an SD write releases all leases and leaves no native image tickets", async () => {
  const r = rig(); r.holdWrites();
  await r.drive(requestImage(r)); r.connection.dispose(); await r.tick();
  expect(r.tickets.size).toBe(0);
  r.flushWrites(); await r.tick(); expect(r.tickets.size).toBe(0);
});

test("image consumer leases remain bounded even when all consumers request the same image", async () => {
  const r = rig(), images = r.connection.imageClient!;
  const tickets = await r.drive(Promise.all(Array.from({ length: 24 }, () => requestImage(r))));
  expect(images.requestImage("manga.image", "mg-original/2", () => {})).toBe(0);
  expect(r.reads.filter(v => v === "remote:manga.image:mg-original/2")).toHaveLength(1);
  for (const ticket of tickets) images.releaseImage(ticket);
  await r.tick(); expect(r.tickets.size).toBe(0); r.connection.dispose();
});

test("removal settles pending readers and drains an interrupted offline download before deleting", async () => {
  const r = rig();
  const reading = requestImage(r).catch(error => String(error));
  const result = await r.drive(Promise.all([reading, r.connection.removeDownload(summary)]));
  expect(result[0]).toContain("cancel");
  r.holdWrites();
  const download = r.connection.download(summary, () => {}).catch(error => String(error));
  await r.tick(100); expect(r.tickets.size).toBe(1);
  r.removals.length = 0;
  const removal = r.connection.removeDownload(summary);
  await r.tick(); expect(r.removals).toEqual([]);
  r.flushWrites(); await r.drive(removal);
  expect(await r.drive(download)).toContain("cancelled");
  expect(r.local.has("mg-original/1")).toBe(false); expect(r.local.has("mg-original-ok/0")).toBe(false);
  expect(r.tickets.size).toBe(0);
  await r.drive(r.connection.download(summary, () => {}));
  expect(await r.drive(r.connection.downloaded(summary))).toBe(true);
  r.connection.dispose();
});

test("unchanged catalogs reuse durable records and do not rewrite SD, including after reboot", async () => {
  const r = rig(); await r.drive(r.connection.index("remote"));
  const writes = [...r.writes]; r.reads.length = 0;
  expect((await r.drive(r.connection.index("remote"))).series).toEqual([summary]);
  expect(r.writes).toEqual(writes);
  expect(r.reads.filter(v => v.startsWith("remote:"))).toEqual(["remote:manga.read:manga-index/0"]);
  expect(r.reads.some(v => v.endsWith("mc-one/0"))).toBe(false);
  r.reboot(); r.reads.length = 0;
  expect((await r.drive(r.connection.index("remote"))).series).toEqual([summary]);
  expect(r.writes).toEqual(writes);
  expect(r.reads.filter(v => v.startsWith("remote:"))).toEqual(["remote:manga.read:manga-index/0"]);
  r.connection.dispose();
});

test("concurrent metadata readers share disk and network work, and removal invalidates RAM", async () => {
  const r = rig();
  expect(await r.drive(Promise.all([r.connection.meta(summary), r.connection.meta(summary)]))).toEqual([meta, meta]);
  expect(r.reads.filter(v => v.endsWith("mg-original/0"))).toHaveLength(2); // One disk miss, one remote read.
  expect(r.writes.filter(v => v === "mg-original/0")).toHaveLength(1);
  r.reads.length = 0;
  expect(await r.drive(r.connection.meta(summary))).toEqual(meta);
  expect(r.reads).toEqual([]);
  r.disconnect(); await r.drive(r.connection.removeDownload(summary));
  await expect(r.drive(r.connection.meta(summary))).rejects.toThrow("offline");
  r.connection.dispose();
});

test("offline completeness probes SD even when its former marker is retained in RAM", async () => {
  const r = rig(); await r.drive(r.connection.download(summary, () => {}));
  expect(await r.drive(r.connection.downloaded(summary))).toBe(true);
  r.local.delete("mg-original-ok/0");
  expect(await r.drive(r.connection.downloaded(summary))).toBe(false);
  r.connection.dispose();
});

test("failed catalog writes leave the offline pointer intact and retry on the next refresh", async () => {
  const r = rig(); await r.drive(r.connection.index("remote"));
  const newer = { ...summary, title: "Updated" };
  r.remote.set("manga-index/0", '{"catalog":"mc-two"}'); r.remote.set("mc-two/0", JSON.stringify({ v: 3, series: [newer] }));
  r.diskFull(true);
  expect((await r.drive(r.connection.index("remote"))).series).toEqual([newer]);
  expect(r.local.get("manga-index/0")).toBe('{"catalog":"mc-one"}');
  expect(r.local.has("mc-two/0")).toBe(false);
  r.diskFull(false); await r.drive(r.connection.index("remote"));
  expect(r.local.get("manga-index/0")).toBe('{"catalog":"mc-two"}');
  r.disconnect(); r.reboot();
  expect((await r.drive(r.connection.index("local"))).series).toEqual([newer]);
  r.connection.dispose();
});

test("a relay update cannot hide the complete rendition saved for offline", async () => {
  const r = rig();
  await r.drive(r.connection.index("remote")); await r.drive(r.connection.download(summary, () => {}));
  const newer = { ...summary, pages: 3, pack: "mg-newer" };
  r.remote.set("manga-index/0", '{"catalog":"mc-two"}'); r.remote.set("mc-two/0", JSON.stringify({ v: 3, series: [newer] }));
  expect((await r.drive(r.connection.index("remote"))).series).toEqual([newer]);
  r.disconnect(); r.reboot();
  expect((await r.drive(r.connection.index("local"))).series).toEqual([summary]);
  r.connection.dispose();
});

test("interrupted catalog refresh preserves the old offline pointer", async () => {
  const r = rig(); await r.drive(r.connection.index("remote"));
  const doc = encodeDocument({ v: 3, series: Array.from({ length: 60 }, (_, n) => ({ ...summary, slug: `book-${n}`, title: "雪".repeat(15) })) }, 1);
  r.remote.set("manga-index/0", '{"catalog":"mc-two"}'); r.remote.set("mc-two/0", doc.head);
  r.remote.set("mc-two/1", doc.chunks[0]!);
  await expect(r.drive(r.connection.index("remote"))).rejects.toThrow();
  expect(r.local.get("manga-index/0")).toBe('{"catalog":"mc-one"}');
  r.connection.dispose();
});

test("disk-full downloads do not claim offline completeness and can retry", async () => {
  const r = rig(); await r.drive(r.connection.index("remote"));
  r.diskFull(true);
  await expect(r.drive(r.connection.download(summary, () => {}))).rejects.toThrow("Disk full");
  expect(r.local.has("mg-original-ok/0")).toBe(false); expect(r.tickets.size).toBe(0);
  r.diskFull(false); await r.drive(r.connection.download(summary, () => {}));
  expect(await r.drive(r.connection.downloaded(summary))).toBe(true); expect(r.tickets.size).toBe(0);
  r.connection.dispose();
});

test("cancelled fallback consumers release tickets after the cache write", async () => {
  const r = rig(); let delivered = false;
  const image = r.connection.imageClient!;
  const id = image.requestImage("manga.image", "mg-original/2", () => { delivered = true; });
  r.connection.step(); await Promise.resolve(); image.cancel(id);
  for (let n = 0; n < 10; n++) { r.connection.step(); await Promise.resolve(); }
  expect(delivered).toBe(false); expect(r.tickets.size).toBe(0); r.connection.dispose();
});


test("offline removal drops completeness and cached pages without contacting relay", async () => {
  const r = rig(); await r.drive(r.connection.index("remote"));
  await r.drive(r.connection.download(summary, () => {}));
  r.disconnect(); await r.drive(r.connection.removeDownload(summary));
  expect(await r.drive(r.connection.downloaded(summary))).toBe(false);
  expect(r.local.has("mg-original/2")).toBe(false);
  expect(r.local.has("mc-one/0")).toBe(true);
  r.connection.dispose();
});

test("removing an unsaved new rendition preserves the older offline version", async () => {
  const r = rig(); await r.drive(r.connection.index("remote"));
  await r.drive(r.connection.download(summary, () => {}));
  const newer = { ...summary, pages: 3, pack: "mg-newer" };
  r.remote.set("manga-index/0", '{"catalog":"mc-two"}'); r.remote.set("mc-two/0", JSON.stringify({ v: 3, series: [newer] }));
  await r.drive(r.connection.index("remote"));
  await r.drive(r.connection.removeDownload(newer));
  r.disconnect(); r.reboot();
  expect((await r.drive(r.connection.index("local"))).series).toEqual([summary]);
  expect(await r.drive(r.connection.downloaded(summary))).toBe(true);
  r.connection.dispose();
});

test("large bookmark sets sync within offload request limits", async () => {
  const r = rig(), progress = { page: 500, updated: 99, chapters: { "0": true }, bookmarks: Array.from({ length: 1200 }, (_, n) => n) };
  await r.drive(r.connection.syncProgress("reader-a", summary.slug, progress));
  expect(r.progressPayloads.length).toBeGreaterThan(1);
  expect(JSON.parse(r.progressPayloads.map(p => JSON.parse(p).data).join(""))).toEqual(progress);
  for (const payload of r.progressPayloads) {
    expect(payload.length).toBeLessThanOrEqual(2500);
    expect(Buffer.byteLength(JSON.stringify({ v: 1, id: 4294967295, method: "manga.progress-part", payload }))).toBeLessThanOrEqual(4096);
  }
  r.connection.dispose();
});
