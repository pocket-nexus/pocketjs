// The pack module's sim and browser hosts against contracts/spec/pack.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { createPackStore, packNameHash, type PackImage, type PackStore } from "../framework/src/game2d/packs.ts";
import { PackNames, PackWriter } from "../framework/src/game2d/pack-writer.ts";
import { createTexturePool } from "../framework/src/game2d/textures.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { encodeImageEntry } from "../framework/compiler/pak.ts";
import {
  PACK_MAX_DEPTH,
  PACK_MAX_HANDLES,
  PACK_MAX_IMG_BYTES,
  PACK_MAX_PATH_BYTES,
  PACK_MAX_SEGMENT_BYTES,
  PACK_OP,
  PACK_OPEN_MISSING,
  PACK_OPEN_PENDING,
  packValidPath,
} from "../contracts/spec/pack.ts";
import { POCKET_CAPABILITIES } from "../contracts/spec/platform-types.ts";
import { createPackHost } from "../platforms/web/pack.js";
import { createSimPackHost } from "../platforms/sim/pack.ts";

const dirs: string[] = [];
function tempRoot(files: Record<string, Uint8Array | string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pack-test-"));
  dirs.push(dir);
  for (const [name, bytes] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, bytes);
  }
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sequence = (length: number) => Uint8Array.from({ length }, (_, i) => i % 251);

describe("path grammar", () => {
  test("accepts relative paths and rejects escapes", () => {
    for (const ok of ["a.pcm", "ch01/music/a.pcm", "中文/曲.pcm"]) expect(packValidPath(ok)).toBe(true);
    for (const bad of [
      "", "/abs.pcm", "../up.pcm", "a/../b", "a/./b", "a//b", "a/", "ms0:/x", "c:\\x", "a\\b",
      "x".repeat(PACK_MAX_SEGMENT_BYTES + 1),
      Array(PACK_MAX_DEPTH + 1).fill("d").join("/"),
      Array(40).fill("seven77").join("/").slice(0, PACK_MAX_PATH_BYTES + 1),
    ]) {
      expect(packValidPath(bad)).toBe(false);
    }
  });

  test("the capability is registered and the ops are numbered", () => {
    expect(POCKET_CAPABILITIES).toContain("data.pack");
    expect(PACK_OP).toEqual({ open: 1, size: 2, read: 3, loadImg: 4, close: 5, stats: 6, mem: 7, gc: 8 });
  });

  test("the browser host pins the spec's constants", () => {
    const source = readFileSync(resolve(import.meta.dir, "../platforms/web/pack.js"), "utf8");
    const value = (name: string) => Number(new RegExp(`const ${name} = (-?\\d+)`).exec(source)?.[1]);
    expect(value("OPEN_MISSING")).toBe(PACK_OPEN_MISSING);
    expect(value("OPEN_PENDING")).toBe(PACK_OPEN_PENDING);
    expect(value("MAX_HANDLES")).toBe(PACK_MAX_HANDLES);
    expect(value("MAX_IMG_BYTES")).toBe(PACK_MAX_IMG_BYTES);
    expect(value("MAX_PATH_BYTES")).toBe(PACK_MAX_PATH_BYTES);
    expect(value("MAX_SEGMENT_BYTES")).toBe(PACK_MAX_SEGMENT_BYTES);
    expect(value("MAX_DEPTH")).toBe(PACK_MAX_DEPTH);
  });
});

describe("sim host", () => {
  test("reads to the end of the file and past it", () => {
    const host = createSimPackHost({ root: tempRoot({ "a/b.bin": sequence(1000) }) });
    const fh = host.ns.open("a/b.bin");
    expect(fh).toBeGreaterThanOrEqual(0);
    expect(host.ns.size(fh)).toBe(1000);
    const dst = new Uint8Array(300);
    expect(host.ns.read(fh, 900, dst)).toBe(100);
    expect([...dst.subarray(0, 100)]).toEqual([...sequence(1000).subarray(900)]);
    expect(host.ns.read(fh, 1000, dst)).toBe(0);
    expect(host.ns.read(fh, 5000, dst)).toBe(0);
    expect(host.ns.read(fh, 0, dst.subarray(10, 20))).toBe(10);
    expect(dst[10]).toBe(0);
    host.ns.close(fh);
    expect(host.ns.size(fh)).toBe(-1);
    expect(host.ns.read(fh, 0, dst)).toBe(-1);
    host.ns.close(fh); // stale close is a no-op
  });

  test("missing files, escaping paths and a directory are all PACK_OPEN_MISSING", () => {
    const root = tempRoot({ "dir/x.bin": sequence(4) });
    writeFileSync(join(root, "..", "outside.bin"), "x");
    dirs.push(join(root, "..", "outside.bin"));
    const host = createSimPackHost({ root });
    for (const path of ["nope.bin", "../outside.bin", "/etc/hosts", "dir"]) {
      expect(host.ns.open(path)).toBe(PACK_OPEN_MISSING);
    }
    expect(host.openCount()).toBe(0);
  });

  test("handles are capped", () => {
    const host = createSimPackHost({ root: tempRoot({ "x.bin": sequence(4) }) });
    const handles = Array.from({ length: PACK_MAX_HANDLES }, () => host.ns.open("x.bin"));
    expect(handles.every((h) => h >= 0)).toBe(true);
    expect(host.ns.open("x.bin")).toBe(PACK_OPEN_MISSING);
    host.ns.close(handles[3]!);
    expect(host.ns.open("x.bin")).toBeGreaterThanOrEqual(0);
    host.dispose();
    expect(host.openCount()).toBe(0);
  });

  test("pendingOpens reproduces the browser's retry shape", () => {
    const host = createSimPackHost({ root: tempRoot({ "x.bin": sequence(4) }), pendingOpens: 2 });
    expect(host.ns.open("x.bin")).toBe(PACK_OPEN_PENDING);
    expect(host.ns.open("x.bin")).toBe(PACK_OPEN_PENDING);
    expect(host.ns.open("x.bin")).toBeGreaterThanOrEqual(0);
  });

  test("loadImg hands the exact byte range to uploadImgEntry and checks bounds", () => {
    const img = encodeImageEntry({ width: 4, height: 4, rgba: new Uint8Array(4 * 4 * 4).fill(9) });
    const file = new Uint8Array(100 + img.length + 50);
    file.set(img, 100);
    const seen: Uint8Array[] = [];
    const host = createSimPackHost({
      root: tempRoot({ "t.pack": file }),
      ops: { uploadImgEntry: (blob) => (seen.push(blob), 7) },
    });
    const fh = host.ns.open("t.pack");
    expect(host.ns.loadImg(fh, 100, img.length)).toBe(7);
    expect([...seen[0]!]).toEqual([...img]);
    expect(host.ns.loadImg(fh, file.length - 4, 8)).toBe(-1);
    expect(host.ns.loadImg(fh, 0, 4)).toBe(-1);
    expect(host.ns.loadImg(fh, -1, 8)).toBe(-1);
    expect(host.ns.loadImg(99, 0, 8)).toBe(-1);
    expect(JSON.parse(host.ns.stats()).loadImgs).toBe(1);
    host.dispose();
  });

  test("loadImg without an uploader returns -1", () => {
    const host = createSimPackHost({ root: tempRoot({ "x.bin": sequence(64) }) });
    expect(host.ns.loadImg(host.ns.open("x.bin"), 0, 16)).toBe(-1);
    host.dispose();
  });
});

describe("browser host", () => {
  function browser(files: Record<string, Uint8Array>, ops?: { uploadImgEntry(b: Uint8Array): number }) {
    const urls: string[] = [];
    const fetchImpl = async (url: string) => {
      urls.push(url);
      const name = decodeURIComponent(url.slice("/root/".length));
      const bytes = files[name];
      return bytes ? new Response(new Uint8Array(bytes)) : new Response("no", { status: 404 });
    };
    const host = createPackHost({ baseUrl: "/root", ops, fetch: fetchImpl as unknown as typeof fetch });
    return { host, urls };
  }
  const settle = () => new Promise((done) => setTimeout(done, 5));

  test("open is pending until the fetch lands, then reads and closes", async () => {
    const { host, urls } = browser({ "ch 1/a.bin": sequence(500) });
    const ns = host.ns;
    expect(ns.open("ch 1/a.bin")).toBe(PACK_OPEN_PENDING);
    expect(ns.open("ch 1/a.bin")).toBe(PACK_OPEN_PENDING);
    await settle();
    expect(urls).toEqual(["/root/ch%201/a.bin"]);
    const fh = ns.open("ch 1/a.bin");
    expect(fh).toBeGreaterThanOrEqual(0);
    expect(ns.size(fh)).toBe(500);
    const dst = new Uint8Array(200);
    expect(ns.read(fh, 450, dst)).toBe(50);
    expect(dst[0]).toBe(450 % 251);
    expect(ns.read(fh, 500, dst)).toBe(0);
    ns.close(fh);
    expect(ns.size(fh)).toBe(-1);
    // The last close drops the bytes: the next open goes back to the network.
    expect(ns.open("ch 1/a.bin")).toBe(PACK_OPEN_PENDING);
  });

  test("a 404 answers missing once, then tries again; a bad path never fetches", async () => {
    const { host, urls } = browser({});
    expect(host.ns.open("gone.bin")).toBe(PACK_OPEN_PENDING);
    await settle();
    expect(host.ns.open("gone.bin")).toBe(PACK_OPEN_MISSING);
    expect(host.ns.open("gone.bin")).toBe(PACK_OPEN_PENDING);
    urls.length = 0;
    expect(host.ns.open("../x")).toBe(PACK_OPEN_MISSING);
    expect(urls).toEqual([]);
  });

  test("loadImg passes a view of the file to uploadImgEntry", async () => {
    const file = sequence(64);
    let seen: Uint8Array | null = null;
    const { host } = browser({ "t.pack": file }, { uploadImgEntry: (blob) => ((seen = blob), 11) });
    host.ns.open("t.pack");
    await settle();
    const fh = host.ns.open("t.pack");
    expect(host.ns.loadImg(fh, 8, 16)).toBe(11);
    expect([...seen!]).toEqual([...file.subarray(8, 24)]);
    expect(host.ns.loadImg(fh, 60, 16)).toBe(-1);
  });

  test("handles are capped and reset forgets everything", async () => {
    const { host } = browser({ "x.bin": sequence(4) });
    host.ns.open("x.bin");
    await settle();
    const handles = Array.from({ length: PACK_MAX_HANDLES }, () => host.ns.open("x.bin"));
    expect(handles.every((h) => h >= 0)).toBe(true);
    expect(host.ns.open("x.bin")).toBe(PACK_OPEN_MISSING);
    host.reset();
    expect(host.ns.size(handles[0])).toBe(-1);
    expect(host.ns.open("x.bin")).toBe(PACK_OPEN_PENDING);
  });
});

describe("pack store", () => {
  // A GPK2 file in memory: one row per name, in hash order, then data JSON.
  function fakePack(names: string[], data: unknown) {
    const json = JSON.stringify(data), sorted = names.map((n) => [packNameHash(n), n] as const).sort((a, b) => a[0] - b[0]), n = sorted.length;
    const out = new Uint8Array(12 + n * 52 + json.length), dv = new DataView(out.buffer);
    out.set([0x47, 0x50, 0x4b, 0x32]); dv.setUint32(4, n, true); dv.setUint32(8, json.length, true);
    sorted.forEach(([hash, name], i) => { const seed = names.indexOf(name); for (let k = 0; k < 12; k++) dv.setInt32(12 + i * 48 + k * 4, seed * 100 + k, true); dv.setUint32(12 + n * 48 + i * 4, hash, true); });
    out.set(new TextEncoder().encode(json), 12 + n * 52);
    return out;
  }
  function hostOf(files: Record<string, Uint8Array>) {
    const opened: Uint8Array[] = [];
    return {
      open(path: string) { const f = files[path]; if (!f) return -1; opened.push(f); return opened.length - 1; },
      size: (fh: number) => opened[fh].length,
      read(fh: number, off: number, dst: Uint8Array) { const part = opened[fh].subarray(off, off + dst.length); dst.set(part); return part.length; },
      loadImg: () => 7,
      close() {},
    };
  }
  const mounted = async () => {
    const store = createPackStore(hostOf({ "a.pack": fakePack(["hero.idle.0", "hero.idle.1", "shared"], { who: "a" }), "b.pack": fakePack(["stage.0", "shared"], { extra: 1 }) }));
    await store.mount("a", "a.pack", async () => {});
    await store.mount("b", "b.pack", async () => {});
    return store;
  };

  test("finds images across packs, with offsets past the data", async () => {
    const store = await mounted();
    const base = 12 + 3 * 52 + JSON.stringify({ who: "a" }).length;
    const img = store.image("hero.idle.1")!;
    expect(img).toMatchObject({ pack: "a", name: "hero.idle.1", off: 100 + base, len: 101, tw: 102, ay: 111, handle: -1 });
    expect(store.image("stage.0")?.pack).toBe("b");
    expect(store.image("shared")?.pack).toBe("a");
    expect(store.data("who")).toBe("a");
    expect(store.data("extra")).toBe(1);
  });

  test("a missing name is undefined, and the object is stable until trim", async () => {
    const store = await mounted();
    expect(store.image("nope")).toBeUndefined();
    expect(store.image("nope")).toBeUndefined();
    const a = store.image("stage.0")!, live = store.image("hero.idle.0")!;
    expect(store.image("stage.0")).toBe(a);
    live.handle = 3;
    store.trim();
    expect(store.image("hero.idle.0")).toBe(live); // owns a texture: must survive, the pool holds this object
    expect(store.image("stage.0")).not.toBe(a);
  });

  test("rejects a file of the wrong format", async () => {
    const store = createPackStore(hostOf({ "old.pack": new TextEncoder().encode("GPK1\0\0\0\0{}{}{}") }));
    expect(await store.mount("old", "old.pack", async () => {})).toBeNull();
  });
});

describe("texture pool out of memory", () => {
  const imgs = (n: number) => Array.from({ length: n }, (_, i) => ({ pack: "p", name: `i${i}`, off: 0, len: 8, tw: 64, th: 64, w: 64, h: 64, ox: 0, oy: 0, fw: 64, fh: 64, ax: 0, ay: 0, handle: -1, used: 0, fails: 0, retryAt: 0 }));

  test("a failed load evicts older images, keeps this frame's, and a later frame retries", () => {
    let failNext = false, next = 1;
    const store = { loadImage: () => { if (failNext) { failNext = false; return -1; } return next++; } } as any;
    const pool = createTexturePool(store, 1024 * 1024, () => {});
    const [old, current, big] = imgs(3);
    pool.beginFrame(); pool.get(old);
    pool.beginFrame(); pool.get(current);
    failNext = true;
    expect(pool.get(big)).toBe(-1);
    expect(old.handle).toBe(-1);
    expect(current.handle).toBeGreaterThan(0);
    pool.beginFrame();
    expect(pool.get(big)).toBeGreaterThan(0);
    expect(pool.stats().failures).toBe(1);
  });

  test("a corrupt image does not purge the pool every frame", () => {
    const store = { loadImage: (img: any) => (img.name === "i9" ? -1 : 1) } as any;
    const pool = createTexturePool(store, 1024 * 1024, () => {});
    const all = imgs(10), bad = all[9];
    pool.beginFrame(); pool.get(bad); // first failure spends the purge
    pool.beginFrame(); pool.get(all[0]);
    pool.beginFrame(); pool.get(bad);
    expect(all[0].handle).toBe(1);
  });
});

describe("game2d pack store: what a bad or late pack does", () => {
  const entry = new Uint8Array([1, 2, 3, 4]);
  const packWith = (names: string[], data: unknown = {}) => {
    const w = new PackWriter();
    for (const name of names) w.add(name, entry, { w: 8, h: 8, tw: 8, th: 8 });
    return w.encode(data);
  };
  function hostOf(files: Record<string, Uint8Array>) {
    const opened: (Uint8Array | null)[] = [];
    const ns = {
      closed: 0,
      open(path: string) { const f = files[path]; if (!f) return -1; opened.push(f); return opened.length - 1; },
      size: (fh: number) => opened[fh]?.length ?? -1,
      read(fh: number, off: number, dst: Uint8Array) { const part = opened[fh]!.subarray(off, off + dst.length); dst.set(part); return part.length; },
      loadImg: () => 7,
      close(fh: number) { opened[fh] = null; ns.closed++; },
    };
    return ns;
  }
  const wait = async () => {};

  test("a name missing before its pack mounts is found after", async () => {
    const store = createPackStore(hostOf({ "a.pack": packWith(["x"]), "b.pack": packWith(["y"]) }));
    await store.mount("a", "a.pack", wait);
    expect(store.image("y")).toBeUndefined();
    await store.mount("b", "b.pack", wait);
    expect(store.image("y")?.pack).toBe("b");
  });

  test("empty data is an empty object, and data() answers undefined", async () => {
    const bytes = packWith(["x"]);
    const empty = new Uint8Array(12 + 52);
    empty.set(bytes.subarray(0, 12 + 52));
    new DataView(empty.buffer).setUint32(8, 0, true);
    const store = createPackStore(hostOf({ "a.pack": empty }));
    expect(await store.mount("a", "a.pack", wait)).not.toBeNull();
    expect(store.data("anything")).toBeUndefined();
  });

  const damaged: [string, (b: Uint8Array) => Uint8Array][] = [
    ["corrupt JSON", (b) => { const c = b.slice(); c[12 + 52] = 0x7f; return c; }],
    ["an image count larger than the file", (b) => { const c = b.slice(); new DataView(c.buffer).setUint32(4, 0x7fffffff, true); return c; }],
    ["a data length larger than the file", (b) => { const c = b.slice(); new DataView(c.buffer).setUint32(8, 0xfffffff0, true); return c; }],
    ["a truncated file", (b) => b.subarray(0, 20)],
    ["JSON null for data", () => packWith([], null)],
    ["the old format", (b) => { const c = b.slice(); c[3] = 0x31; return c; }],
  ];
  for (const [what, damage] of damaged) {
    test(`${what} fails the mount and closes the handle`, async () => {
      const host = hostOf({ "a.pack": damage(packWith(["x"], { k: 1 })) });
      expect(await createPackStore(host).mount("a", "a.pack", wait)).toBeNull();
      expect(host.closed).toBe(1);
    });
  }
});

describe("game2d pack writer", () => {
  test("a store reads back what the writer wrote, shared bytes included", async () => {
    const w = new PackWriter();
    const where = w.add("hero", new Uint8Array([9, 8, 7]), { w: 10, h: 12, tw: 16, th: 16, ox: 1, oy: 2, fw: 20, fh: 24, ax: 3, ay: 4 });
    w.add("foe", new Uint8Array([6]), { w: 8, h: 8, tw: 8, th: 8 });
    w.share("hero.alias", where, { w: 10, h: 12, tw: 16, th: 16 });
    const file = w.encode({ who: "神雕" });
    const store = createPackStore({
      open: () => 0, size: () => file.length,
      read(_fh: number, off: number, dst: Uint8Array) { const part = file.subarray(off, off + dst.length); dst.set(part); return part.length; },
      loadImg: () => 1, close() {},
    });
    await store.mount("a", "a.pack", async () => {});
    expect(store.data("who")).toBe("神雕");
    const hero = store.image("hero")!, alias = store.image("hero.alias")!, foe = store.image("foe")!;
    expect([hero.w, hero.h, hero.tw, hero.th, hero.ox, hero.oy, hero.fw, hero.fh, hero.ax, hero.ay]).toEqual([10, 12, 16, 16, 1, 2, 20, 24, 3, 4]);
    expect([alias.off, alias.len]).toEqual([hero.off, hero.len]);
    expect(file.subarray(foe.off, foe.off + foe.len)).toEqual(new Uint8Array([6]));
    expect([foe.fw, foe.fh]).toEqual([8, 8]);
  });

  test("two names with one hash are refused, across every pack in a build", () => {
    // Two strings with the same FNV-1a value, found by search.
    const seen = new Map<number, string>();
    let pair: [string, string] | null = null;
    for (let i = 0; !pair; i++) {
      const name = `n${i}`, hash = packNameHash(name), had = seen.get(hash);
      if (had) pair = [had, name]; else seen.set(hash, name);
    }
    const names = new PackNames();
    new PackWriter(names).add(pair[0], new Uint8Array(1), { w: 8, h: 8, tw: 8, th: 8 });
    expect(() => new PackWriter(names).add(pair![1], new Uint8Array(1), { w: 8, h: 8, tw: 8, th: 8 })).toThrow("collision");
    // The same name in a second pack is not a collision: the oldest mount wins.
    new PackWriter(names).add(pair[0], new Uint8Array(1), { w: 8, h: 8, tw: 8, th: 8 });
  });
});

describe("game2d texture pool: images that fail to load", () => {
  const image = (name: string): PackImage => ({ pack: "a", name, off: 0, len: 1, tw: 8, th: 8, w: 8, h: 8, ox: 0, oy: 0, fw: 8, fh: 8, ax: 0, ay: 0, handle: -1, used: 0, fails: 0, retryAt: 0 });
  const storeWith = (load: (img: PackImage) => number) => ({ loadImage: load }) as unknown as PackStore;

  test("a bad image stops hitting storage every frame", () => {
    let reads = 0;
    const pool = createTexturePool(storeWith(() => { reads++; return -1; }), 1 << 20, () => {});
    const bad = image("bad");
    for (let f = 0; f < 600; f++) { pool.beginFrame(); pool.get(bad); }
    expect(reads).toBeLessThan(15);
    expect(reads).toBeGreaterThan(3);
  });

  test("a load that fails because memory is short succeeds soon after, and the wait resets", () => {
    let room = false;
    const pool = createTexturePool(storeWith(() => (room ? 5 : -1)), 1 << 20, () => {});
    const img = image("x");
    pool.beginFrame();
    expect(pool.get(img)).toBe(-1);
    room = true;
    pool.beginFrame();
    pool.beginFrame();
    expect(pool.get(img)).toBe(5);
    expect(img.fails).toBe(0);
  });
});
