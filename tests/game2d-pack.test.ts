// The pack module's sim and browser hosts against contracts/spec/pack.ts.
import { afterEach, describe, expect, test } from "bun:test";
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
    expect(PACK_OP).toEqual({ open: 1, size: 2, read: 3, loadImg: 4, close: 5, stats: 6 });
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
      return bytes ? new Response(bytes) : new Response("no", { status: 404 });
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
