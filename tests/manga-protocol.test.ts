import { expect, test } from "bun:test";
import { once } from "node:events";
import { createConnection } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MangaStore } from "../apps/manga/companion/store.ts";
import { serveMangaRelay } from "../apps/manga/companion/relay.ts";
import { dispatchManga } from "../apps/manga/companion/backend.ts";
import { mangaMethods } from "../apps/manga/companion/provider.ts";
import { createRelayMangaClient, frameScheduler } from "../apps/manga/relay-client.ts";
import { mangaRef, MANGA_RELAY, mangaRelayLimits } from "../apps/manga/relay-profile.ts";
import { createMangaConnection, type MangaTransport, type MangaCache } from "../apps/manga/client.ts";
import { createResourcePack, prepareTiledRGB565 } from "../apps/manga/pack-format.ts";
import { relaySocketChannel, attachRelayChannel } from "../tools/relay-wire.ts";
import type { OffloadResult } from "../framework/src/offload.ts";

const key = "31".repeat(32);
const summary = { slug: "book", title: "漫画 😀", pages: 1, direction: "rtl" as const, pack: "mg-test" };
const meta = { ...summary, pageW: 256, pageH: 256, levels: [{ scale: 0.5, cols: 1, rows: 1 }] };
function library() {
  const root = mkdtempSync(join(tmpdir(), "manga-protocol-")), store = new MangaStore(root);
  const pixels = Uint8Array.from({ length: 256 * 256 * 2 }, (_, n) => (n * 131 + 17) & 255);
  const pack = createResourcePack(join(root, "packs", "mg-test.prp"), 3);
  pack.add(Buffer.from(JSON.stringify(meta)));
  pack.add(prepareTiledRGB565(pixels.slice(0, 128 * 128 * 2), 128, 128), { width: 128, height: 128 });
  pack.add(prepareTiledRGB565(pixels, 256, 256), { width: 256, height: 256 }); pack.finish(); store.publish(summary);
  return { root, store, pixels, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
async function until(predicate: () => boolean, tick: () => void = () => {}) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) { tick(); await Bun.sleep(2); }
  expect(predicate()).toBe(true);
}
async function attach(port: number) {
  const socket = createConnection({ host: "127.0.0.1", port }); await once(socket, "connect");
  const channel = relaySocketChannel(socket, { id: "companion", grants: [MANGA_RELAY.app] });
  const client = createRelayMangaClient({ rxLimits: mangaRelayLimits(true),
    transport: { peer: channel.peer, trySend: bytes => channel.closed ? "offline" : channel.send(bytes) ? "accepted" : "busy" }, upload: () => 123 });
  const binding = attachRelayChannel({ handleRecord: client.handleRecord, handleDisconnect: client.disconnect, close: client.close, flush: client.step }, channel, { maxWireBytes: mangaRelayLimits(true).maxWireBytes });
  // A split authentication prefix followed by HELLO exercises the L0 handoff.
  socket.write(key.slice(0, 11)); socket.write(key.slice(11)); client.connect();
  await until(client.connected, client.step);
  return { client, close: () => binding.close() };
}
async function request(client: ReturnType<typeof createRelayMangaClient>, method: string, payload: string, image = false) {
  let result: OffloadResult | undefined, id = 0;
  await until(() => !!result, () => {
    client.step();
    if (!id) id = (image ? client.requestImage : client.request)(method, payload, r => { result = r; });
  });
  if (!result!.ok) throw Error(result!.error);
  return result!.value;
}

test("paired TCP Relay reads chunks through the worker, revalidates metadata and pushes catalog updates", async () => {
  const f = library(), server = await serveMangaRelay({ root: f.root, key, port: 0, pollMs: 60000, log: console.error });
  const link = await attach(server.port), client = link.client;
  try {
    const pointer = JSON.parse(await request(client, "manga.read", "manga-index/0"));
    expect(pointer.catalog).toMatch(/^mc-/);
    expect(JSON.parse(await request(client, "manga.read", "mg-test/0"))).toEqual(meta);
    expect(JSON.parse(await request(client, "manga.read", "mg-test/0"))).toEqual(meta);
    expect(server.authority.stats.notModified).toBe(1);
    const ticket = await request(client, "manga.image", "mg-test/2", true);
    expect(client.pixels(ticket).pixels).toEqual(f.pixels);
    expect(client.uploadImage(ticket)).toEqual({ handle: 123, width: 256, height: 256 });
    client.releaseImage(ticket); expect(client.staged()).toBe(0);
    await expect(request(client, "manga.progress-part", "{}")).rejects.toThrow("INVALID");
    expect(JSON.parse(await request(client, "manga.describe", "mg-test"))).toEqual({ count: 3 });
    const before = client.session(); f.store.publish({ ...summary, title: "New title" }); await server.authority.refresh();
    await until(() => client.session() > before, client.step);
    expect(server.authority.stats.pushes).toBe(1);
    expect(JSON.parse(await request(client, "manga.read", "manga-index/0")).catalog).not.toBe(pointer.catalog);
    await expect(request(client, "manga.read", "missing/0")).rejects.toThrow();
    expect(client.endpoint.protocolErrors).toBe(0);
  } finally { link.close(); await server.close(); f.close(); }
}, 15000);

test("Relay download and progress leave a complete library readable with only the terminal", async () => {
  const f = library(), server = await serveMangaRelay({ root: f.root, key, port: 0, pollMs: 60000, log: console.error });
  const link = await attach(server.port), values = new Map<string, string | Uint8Array>(), replies: (() => void)[] = [];
  let next = 1;
  const local: MangaTransport = {
    connected: () => true, session: () => 1, cancel() {}, uploadImage: () => ({ handle: 1, width: 256, height: 256 }), releaseImage() {},
    request(_method, payload, callback) {
      replies.push(() => { const v = values.get(payload); callback(typeof v === "string" ? { ok: true, value: v } : { ok: false, error: "Not saved" }); }); return next++;
    },
    requestImage(_method, payload, callback) {
      replies.push(() => callback(values.get(payload) instanceof Uint8Array ? { ok: true, value: "saved-image" } : { ok: false, error: "Not saved" })); return next++;
    },
  };
  const save = (address: string, value: string | Uint8Array, callback: (result: OffloadResult) => void) => {
    replies.push(() => { values.set(address, value); callback({ ok: true, value: "saved" }); }); return next++;
  };
  const cache: MangaCache = {
    text: (pack, entry, raw, cb) => save(`${pack}/${entry}`, raw, cb),
    image: (pack, entry, ticket, cb) => save(`${pack}/${entry}`, link.client.pixels(ticket).pixels.slice(), cb),
  };
  let connection = createMangaConnection({ local, remote: link.client, cache });
  async function drive<T>(promise: Promise<T>): Promise<T> {
    let done = false, value!: T, error: unknown;
    void promise.then(v => { value = v; done = true; }, e => { error = e; done = true; });
    await until(() => done, () => { connection.step(); link.client.step(); replies.shift()?.(); });
    if (error) throw error; return value;
  }
  try {
    expect((await drive(connection.index("remote"))).series).toEqual([summary]);
    await drive(connection.download(summary, () => {}));
    expect(values.get("mg-test/2")).toEqual(f.pixels); expect(link.client.staged()).toBe(0);
    const progress = { page: 0, bookmarks: [0], chapters: {}, updated: 20 };
    await drive(connection.syncProgress("reader-a", "book", progress));
    const saved = f.store.db.query("SELECT data FROM progress WHERE device=? AND slug=?").get("reader-a", "book") as { data: string };
    expect(JSON.parse(saved.data)).toEqual(progress);
    connection.dispose(); link.close();
    connection = createMangaConnection({ local });
    expect((await drive(connection.index("local"))).series).toEqual([summary]);
    expect(await drive(connection.meta(summary))).toEqual(meta);
    expect(await drive(connection.downloaded(summary))).toBe(true);
    expect(connection.connected()).toBe(false);
  } finally { connection.dispose(); link.close(); await server.close(); f.close(); }
}, 15000);

test("withdrawn Relay images send CANCEL and cannot allocate staging after the worker finishes", async () => {
  const f = library(), methods = mangaMethods(f.root);
  let release: (() => void) | undefined;
  const server = await serveMangaRelay({ root: f.root, key, port: 0, pollMs: 60000, backend: {
    async call(method, payload) {
      if (method === "manga.image") await new Promise<void>(resolve => { release = resolve; });
      return dispatchManga(methods, method, payload);
    }, close: () => methods.close(),
  } });
  const link = await attach(server.port), connection = createMangaConnection({ remote: link.client });
  let delivered = false;
  try {
    const id = connection.imageClient!.requestImage("manga.image", "mg-test/2", () => { delivered = true; });
    await until(() => !!release, () => { connection.step(); link.client.step(); });
    connection.imageClient!.cancel(id);
    // Allow CANCEL to reach the provider before completing its queued work.
    await Bun.sleep(20); release!();
    await until(() => server.authority.stats.cancellations === 1, link.client.step);
    expect(delivered).toBe(false); expect(link.client.staged()).toBe(0);
    expect(await request(link.client, "manga.describe", "mg-test")).toBe('{"count":3}');
  } finally { release?.(); connection.dispose(); link.close(); await server.close(); f.close(); }
}, 10000);

test("Relay refuses an unpaired connection and shuts down pending authentication", async () => {
  const f = library(), server = await serveMangaRelay({ root: f.root, key, port: 0 });
  try {
    const bad = createConnection({ host: "127.0.0.1", port: server.port });
    bad.on("error", () => {});
    await once(bad, "connect"); bad.write("00".repeat(32)); await new Promise<void>(resolve => bad.once("close", () => resolve()));
    const pending = createConnection({ host: "127.0.0.1", port: server.port });
    await once(pending, "connect"); pending.write("31");
    pending.on("error", () => {});
    const closed = new Promise<void>(resolve => pending.once("close", () => resolve())); await server.close(); await closed;
  } finally { await server.close(); f.close(); }
});

test("guest Relay timers wait for frame time instead of scheduling microtask loops", () => {
  let now = 0, calls = 0;
  const clock = frameScheduler(() => now);
  const repeat = () => { calls++; clock.scheduler.setTimeout(repeat, 100); };
  clock.scheduler.setTimeout(repeat, 100);
  for (let n = 0; n < 30; n++) clock.step();
  expect(calls).toBe(0); now = 100; clock.step(); expect(calls).toBe(1);
  now = 10000; clock.step(); expect(calls).toBe(2);
  expect(() => mangaRef("manga.read", "../../keys/0")).toThrow();
});
