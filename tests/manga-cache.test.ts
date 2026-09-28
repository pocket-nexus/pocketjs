import { expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mangaMethods } from "../apps/manga/companion/provider.ts";
import { serveManga } from "../apps/manga/companion/server.ts";
import { createResourcePack, prepareTiledRGB565 } from "../apps/manga/pack-format.ts";

function fixture(budget?: { maxEntries: number; maxBytes: number }) {
  const root = mkdtempSync(join(tmpdir(), "manga-read-cache-")), service = mangaMethods(root, budget);
  const path = join(root, "packs", "legacy.prp");
  const publish = (seed: number) => {
    const pack = createResourcePack(path, 4);
    pack.add(Buffer.from(JSON.stringify({ title: `Book ${seed}` })));
    for (let n = 1; n < 4; n++) pack.add(prepareTiledRGB565(new Uint8Array(512).fill(seed + n), 16, 16), { width: 16, height: 16 });
    pack.finish();
  };
  publish(1);
  return { service, root, path, publish, close() { service.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("companion caches converted pixels and revalidates without decoding or transferring them again", () => {
  const f = fixture();
  try {
    const first = f.service.resource("manga.image", "legacy/1");
    first.image!.pixels.fill(255);
    const next = f.service.resource("manga.image", "legacy/1");
    expect(next.image!.pixels[0]).toBe(2);
    expect(f.service.resource("manga.image", "legacy/1", next.revision)).toEqual({ revision: next.revision, notModified: true });
    expect(f.service.cacheStats().reads).toBe(1);
    expect(f.service.cacheStats().conversions).toBe(1);
    f.publish(2);
    const changed = f.service.resource("manga.image", "legacy/1", next.revision);
    expect(changed.notModified).toBeUndefined(); expect(changed.revision).not.toBe(next.revision);
    expect(changed.image!.pixels[0]).toBe(3); expect(f.service.cacheStats().reads).toBe(2);
    rmSync(f.path);
    expect(() => f.service.resource("manga.image", "legacy/1", changed.revision)).toThrow();
  } finally { f.close(); }
});

test("companion evicts least recently read resources within both memory and entry budgets", () => {
  const f = fixture({ maxEntries: 2, maxBytes: 4000 });
  try {
    const read = (entry: number) => f.service.methods["manga.image"](`legacy/${entry}`);
    read(1); read(2); read(1); read(3);
    expect(f.service.cacheStats().reads).toBe(3);
    read(1); expect(f.service.cacheStats().reads).toBe(3);
    read(2); expect(f.service.cacheStats().reads).toBe(4);
    expect(f.service.cacheStats().entries).toBeLessThanOrEqual(2);
    expect(f.service.cacheStats().bytes).toBeLessThanOrEqual(4000);
    expect(f.service.cacheStats().evictions).toBe(2);
    expect(() => f.service.methods["manga.read"]("legacy/0/ignored")).toThrow();
  } finally { f.close(); }
  expect(f.service.cacheStats().bytes).toBe(0);
});

test("oversized companion records are served without displacing retained small metadata", () => {
  const f = fixture({ maxEntries: 4, maxBytes: 850 });
  try {
    f.service.methods["manga.read"]("legacy/0");
    f.service.methods["manga.image"]("legacy/1");
    const before = f.service.cacheStats().reads;
    f.service.methods["manga.read"]("legacy/0");
    expect(f.service.cacheStats().reads).toBe(before);
    expect(f.service.cacheStats().bytes).toBeLessThanOrEqual(850);
  } finally { f.close(); }
});

test("browser image revalidation skips unchanged bodies and refreshes replaced legacy packs", async () => {
  const f = fixture(), server = serveManga({ root: f.root, port: 0 });
  try {
    const url = new URL("/api/image/legacy/1", server.server.url);
    const first = await fetch(url), etag = first.headers.get("etag")!;
    expect(first.status).toBe(200); expect(etag).toMatch(/^"[a-f0-9]+"$/);
    expect(first.headers.get("cache-control")).toContain("must-revalidate");
    const before = await first.bytes();
    const unchanged = await fetch(url, { headers: { "If-None-Match": etag } });
    expect(unchanged.status).toBe(304); expect(await unchanged.text()).toBe("");
    f.publish(2);
    const changed = await fetch(url, { headers: { "If-None-Match": etag } });
    expect(changed.status).toBe(200); expect(changed.headers.get("etag")).not.toBe(etag);
    expect(await changed.bytes()).not.toEqual(before);
    const immutable = `mg-${"a".repeat(32)}`;
    copyFileSync(f.path, join(f.root, "packs", `${immutable}.prp`));
    const versioned = await fetch(new URL(`/api/image/${immutable}/1`, server.server.url));
    expect(versioned.headers.get("cache-control")).toContain("immutable"); await versioned.arrayBuffer();
    const missing = await fetch(new URL("/api/image/legacy/99", server.server.url), { headers: { "If-None-Match": "*" } });
    expect(missing.status).toBe(400); await missing.arrayBuffer();
  } finally { server.close(); f.close(); }
});
