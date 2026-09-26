import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { encodePng } from "../apps/manga/png.ts";
import { parseManifest } from "../apps/manga/companion/sources.ts";
import { fetchBytes, httpUrl } from "../apps/manga/companion/network.ts";
import { serveManga } from "../apps/manga/companion/server.ts";
import { readPack } from "../apps/manga/companion/packs.ts";
import { mangaMethods } from "../apps/manga/companion/provider.ts";
import { exportLibrary } from "../apps/manga/companion.ts";
import { parseIndex, parseSeries, packOf } from "../apps/manga/model.ts";
import { readDocument } from "../apps/manga/document.ts";
import { dispatchOffload } from "../tools/offload-provider.ts";
import { MangaStore } from "../apps/manga/companion/store.ts";

const root = mkdtempSync(join(tmpdir(), "manga-relay-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const png = encodePng(400, 600, () => [250, 0, 0]);
let releaseSlow: (() => void) | undefined, slowRequested = false;
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === "/slow-source.json") return Response.json({ version: 1, name: "Slow", series: [{ id: "slow", title: "Slow", chapters: [{ id: "1", title: "One", pages: ["/slow.png"] }] }] });
  if (path === "/slow.png") { slowRequested = true; return new Promise<Response>(resolve => { releaseSlow = () => resolve(new Response(Buffer.from(png))); }); }
  if (path === "/source.json") return Response.json({ version: 1, name: "Test 源", series: [{ id: "test", title: "Test 雪", direction: "ltr", chapters: [{ id: "c1", title: "第一章", pages: ["/one.png", "/two.png"] }] }] });
  if (path === "/bad.json") return Response.json({ series: [] });
  if (path === "/redirect") return Response.redirect(new URL("/one.png", req.url).href);
  if (path.endsWith(".png")) return new Response(Buffer.from(png));
  return new Response("Not found", { status: 404 });
} });
afterAll(() => fixture.stop(true));

test("source manifests validate identities, relative URLs and chapter data", () => {
  expect(() => parseManifest({ version: 1, name: "X", series: [{ id: "x", title: "X", chapters: [] }] }, "https://example.com/source.json")).toThrow();
  const value = parseManifest({ version: 1, name: "X", series: [{ id: "x", title: "X", chapters: [{ id: "1", title: "One", pages: ["page.png"] }] }] }, "https://example.com/books/source.json");
  expect(value.books[0]?.chapters?.[0]?.pages).toEqual(["https://example.com/books/page.png"]);
  expect(() => httpUrl("file:///etc/passwd")).toThrow();
  expect(() => httpUrl("https://user:secret@example.com")).toThrow();
});

test("network rejects local addresses without opt-in and enforces body limits through redirects", async () => {
  await expect(fetchBytes(String(fixture.url), 100)).rejects.toThrow("Private");
  await expect(fetchBytes(new URL("/redirect", fixture.url).href, 2, { allowPrivate: true })).rejects.toThrow("size limit");
  expect(await fetchBytes(new URL("/redirect", fixture.url).href, 100000, { allowPrivate: true })).toEqual(png);
});

const decoder = Bun.which("ffmpeg") || Bun.which("magick");
test.skipIf(!decoder)("source URL -> worker import -> online tiles -> SD export -> restart", async () => {
  const relay = serveManga({ root, port: 0, allowPrivate: true });
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(new URL(path, relay.server.url), { method, headers: { "Content-Type": "application/json", "X-Manga-Request": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json(); expect(response.status).toBeLessThan(400); return data;
  };
  let slug = "", pack = "";
  try {
    expect((await fetch(new URL("/api/import", relay.server.url), { method: "POST", body: "{}" })).status).toBe(403);
    const source = await request("/api/sources", "POST", { url: new URL("/source.json", fixture.url).href });
    const catalog = await request(`/api/catalog?source=${source.id}`);
    expect(catalog.books[0].title).toBe("Test 雪");
    const job = await request("/api/import", "POST", { source: source.id, book: "test", language: "en" });
    const duplicate = await request("/api/import", "POST", { source: source.id, book: "test", language: "en" });
    expect(duplicate.id).toBe(job.id);
    const deadline = Date.now() + 15000;
    while (["queued", "running"].includes(relay.store.job(job.id)!.status) && Date.now() < deadline) await Bun.sleep(50);
    expect(relay.store.job(job.id)!.status).toBe("completed");
    const state = await request("/api/state");
    expect(state.library).toHaveLength(1);
    const book = state.library[0]; slug = book.slug; pack = packOf(book);
    expect(book.title).toBe("Test 雪"); expect(book.pages).toBe(2); expect(book.direction).toBe("ltr");
    const methods = mangaMethods(root);
    try {
      const pointer = JSON.parse(methods.methods["manga.read"]("manga-index/0"));
      const index = parseIndex(await readDocument(async n => methods.methods["manga.read"](`${pointer.catalog}/${n}`)));
      expect(index?.series[0]).toEqual(book);
      const meta = parseSeries(JSON.parse(await readDocument(async n => methods.methods["manga.read"](`${pack}/${n}`))));
      expect(meta?.pages).toBe(2);
      const image = methods.methods["manga.image"](`${pack}/2`);
      expect(image.width).toBe(256); expect(image.pixels[0]! | (image.pixels[1]! << 8)).toBe(31);
      const bad = await dispatchOffload(methods.methods, { v: 1, id: 1, method: "manga.read", payload: "../../etc/passwd/0" });
      expect(bad.error).toBeDefined();
      const p = { page: 1, updated: 2, bookmarks: [1], chapters: {} };
      methods.methods["manga.progress"](JSON.stringify({ device: "test", slug, progress: p }));
      methods.methods["manga.progress"](JSON.stringify({ device: "test", slug, progress: { ...p, page: 0, updated: 1 } }));
      const saved = relay.store.db.query("SELECT data FROM progress WHERE slug=?").get(slug) as { data: string };
      expect(JSON.parse(saved.data).page).toBe(1);
    } finally { methods.close(); }
    const page = await fetch(new URL(`/api/image/${pack}/2`, relay.server.url));
    expect(page.headers.get("content-type")).toBe("image/png");
    expect(exportLibrary(root, join(root, "sd"))).toBe(1);
    expect(readFileSync(join(root, "sd", pack + ".prp"))).toEqual(readFileSync(join(root, "packs", pack + ".prp")));
  } finally { relay.close(); }
  const reboot = serveManga({ root, port: 0 });
  try { expect(reboot.store.index().series[0]?.slug).toBe(slug); expect(readPack(root, pack, 0).kind).toBe(1); }
  finally { reboot.close(); }
}, 20000);

test("chunked progress survives provider restart, rejects old partial saves, and isolates devices", () => {
  const dir = mkdtempSync(join(tmpdir(), "manga-progress-")), store = new MangaStore(dir);
  let provider = mangaMethods(dir);
  try {
    const progress = { page: 1000, updated: 20, chapters: { "0": true }, bookmarks: Array.from({ length: 1200 }, (_, n) => n) };
    const raw = JSON.stringify(progress), total = Math.ceil(raw.length / 400);
    const send = (part: number, updated = progress.updated) => JSON.parse(provider.methods["manga.progress-part"](JSON.stringify({ device: "reader-a", slug: "book", updated, part, total, data: raw.slice(part * 400, (part + 1) * 400) })));
    expect(send(0)).toEqual({ accepted: 0 });
    expect(store.db.query("SELECT * FROM progress").all()).toHaveLength(0);
    expect(() => send(0, 19)).toThrow("superseded");
    provider.close(); provider = mangaMethods(dir);
    for (let part = total - 1; part >= 1; part--) send(part);
    const saved = store.db.query("SELECT data FROM progress WHERE device='reader-a'").get() as { data: string };
    expect(JSON.parse(saved.data)).toEqual(progress);
    expect(send(0, 19)).toEqual({ saved: 19 });
    expect(store.db.query("SELECT * FROM progress_parts").all()).toHaveLength(0);
    provider.methods["manga.progress"](JSON.stringify({ device: "reader-b", slug: "book", progress: { ...progress, page: 2, updated: 1 } }));
    expect(store.db.query("SELECT * FROM progress").all()).toHaveLength(2);
  } finally { provider.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a cancelled import cleans its workspace, and a second relay cannot take over the library", async () => {
  const dir = mkdtempSync(join(tmpdir(), "manga-cancel-")), relay = serveManga({ root: dir, port: 0, allowPrivate: true });
  try {
    expect(() => serveManga({ root: dir, port: 0 })).toThrow("already owns");
    const source = await (await fetch(new URL("/api/sources", relay.server.url), { method: "POST", headers: { "X-Manga-Request": "1", "Content-Type": "application/json" }, body: JSON.stringify({ url: new URL("/slow-source.json", fixture.url).href }) })).json();
    const job = relay.store.enqueue({ source: source.id, book: "slow", language: "en" });
    const deadline = Date.now() + 5000;
    while (!slowRequested && Date.now() < deadline) await Bun.sleep(20);
    expect(slowRequested).toBe(true);
    const result = await fetch(new URL(`/api/jobs/${job.id}/cancel`, relay.server.url), { method: "POST", headers: { "X-Manga-Request": "1" } });
    expect(result.status).toBe(200); expect(relay.store.job(job.id)?.status).toBe("cancelled");
    while (readdirSync(dir).some(s => s.startsWith("import-")) && Date.now() < deadline) await Bun.sleep(20);
    expect(readdirSync(dir).some(s => s.startsWith("import-"))).toBe(false);
    expect(relay.store.index().series).toHaveLength(0);
  } finally { releaseSlow?.(); relay.close(); rmSync(dir, { recursive: true, force: true }); }
}, 10000);

test("a failed catalog publication rolls back the book and preserves the existing pointer", () => {
  const dir = mkdtempSync(join(tmpdir(), "manga-catalog-")), store = new MangaStore(dir);
  try {
    store.publish(); const before = readFileSync(join(dir, "packs/manga-index.prp"));
    expect(() => store.publish({ slug: "huge", title: "x".repeat(300000), pages: 1, direction: "rtl" })).toThrow("256 KiB");
    expect(store.index().series).toHaveLength(0);
    expect(readFileSync(join(dir, "packs/manga-index.prp"))).toEqual(before);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
