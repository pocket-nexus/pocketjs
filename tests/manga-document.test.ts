import { expect, test } from "bun:test";
import { documentHead, encodeDocument, readDocument, utf8Length } from "../apps/manga/document.ts";
import { parseSeries, parseSummary } from "../apps/manga/model.ts";
import { slugify } from "../apps/manga/bake.ts";

test("large CJK and escaped metadata round-trips through bounded records", async () => {
  const value = { chapters: Array.from({ length: 200 }, (_, n) => ({ title: `第${n}章 \"雪\" \\`, page: n })) };
  const doc = encodeDocument(value, 900);
  expect(documentHead(doc.head)!.count).toBe(doc.chunks.length);
  expect(doc.chunks.length).toBeGreaterThan(1);
  for (const raw of [doc.head, ...doc.chunks]) {
    expect(utf8Length(raw)).toBeLessThanOrEqual(1800);
    expect(utf8Length(JSON.stringify({ id: 4294967295, payload: raw }))).toBeLessThan(4096);
  }
  const read = await readDocument(async entry => entry === 0 ? doc.head : doc.chunks[entry - 900]!);
  expect(JSON.parse(read)).toEqual(value);
  expect(await readDocument(async () => '{"v":3,"series":[]}')).toBe('{"v":3,"series":[]}');
});

test("metadata rejects invalid bounds and corrupt chunks", async () => {
  expect(() => documentHead('{"document":1,"start":65535,"count":2}')).toThrow();
  expect(() => encodeDocument("x".repeat(300000), 1)).toThrow();
  await expect(readDocument(async entry => entry === 0 ? '{"document":1,"start":1,"count":1}' : '{}')).rejects.toThrow();
});

test("quote-heavy metadata fits the extra JSON layer used by native cache writes", async () => {
  const value = { title: '\\"'.repeat(2000), summary: "雪".repeat(1000) };
  const doc = encodeDocument(value, 1);
  for (const record of [doc.head, ...doc.chunks]) {
    const payload = JSON.stringify(["p".repeat(48), 65535, record]);
    expect(payload.length).toBeLessThanOrEqual(2500);
    expect(utf8Length(JSON.stringify({ v: 1, id: 4294967295, method: "pack.cache-text", payload }))).toBeLessThanOrEqual(4096);
  }
  expect(JSON.parse(await readDocument(async entry => entry ? doc.chunks[entry - 1]! : doc.head))).toEqual(value);
});

test("pack addresses fit native bounds and CJK folder identities do not collide", () => {
  const summary = { slug: "ok", title: "Book", pages: 1, direction: "rtl" };
  expect(parseSummary({ ...summary, slug: "a".repeat(43) })).toBeUndefined();
  expect(parseSummary({ ...summary, pack: "../escape" })).toBeUndefined();
  expect(parseSummary({ ...summary, pack: "mg-abc123" })?.pack).toBe("mg-abc123");
  expect(slugify("雪国")).not.toBe(slugify("夏日"));
  expect(parseSeries({ ...summary, pages: 65536, pageW: 400, pageH: 600 })).toBeUndefined();
});
