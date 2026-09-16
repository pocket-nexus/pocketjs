import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWasmUi } from "../hosts/web/wasm-ops.js";
import { bakeAtlases } from "../framework/compiler/bake-font.ts";
import { bakeFontArchive } from "../framework/compiler/font-archive.ts";
import { createFontArchive } from "../framework/src/fonts.ts";
import { createOffloadClient } from "../framework/src/offload.ts";
import { runServicePumps } from "../framework/src/services.ts";
import { createFontArchiveProvider } from "../tools/font-archive-provider.ts";

const bytes = await bakeFontArchive({ font: "assets/fonts/NotoSansCJK-Demo.otf", slots: [2],
  codepoints: Array.from("你好一二丁丂七丄丅丆万丈気迫", c => c.codePointAt(0)!) });
const [baked] = await bakeAtlases({ slots: [2], codepoints: [65, 0xfffd] });
async function harness(capacity: number, resident = "你好", maxBytes?: number) {
  const dir = mkdtempSync(join(tmpdir(), "pocket-font-"));
  const path = join(dir, "font.pjfa"); writeFileSync(path, bytes);
  const provider = createFontArchiveProvider({ "font.pjfa": path });
  const wasm = await createWasmUi(await Bun.file("hosts/web/pocketjs.wasm").arrayBuffer());
  wasm.ops.loadFontAtlas!(baked.bytes);
  const queue: any[] = [], replies: string[] = [], seen: any[] = [];
  let session = 1, fail = false, corrupt = false;
  const client = createOffloadClient({ session: () => session, take: () => replies.shift(),
    submit: raw => { queue.push(JSON.parse(raw)); return true; } });
  const archive = createFontArchive({ path: "font.pjfa", slots: [2], capacity, maxBytes, resident: [{ slot: 2, text: resident }] }, wasm.ops, client);
  return { archive, seen, wasm, reconnect: () => session++, fail: (v: boolean) => fail = v, corrupt: () => corrupt = true,
    step(count = 1) {
      for (let f = 0; f < count; f++) {
        const q = queue.shift();
        if (q) {
          seen.push(q);
          try {
            if (fail) throw Error("Injected disk failure");
            let payload = provider.methods[q.method](q.payload) as string;
            if (corrupt && q.method === "font.glyphs") payload = "00".repeat(20);
            replies.push(JSON.stringify({ id: q.id, payload }));
          } catch (e) { replies.push(JSON.stringify({ id: q.id, error: String(e) })); }
        }
        client.step(); runServicePumps(); wasm.tick();
      }
    },
    close() { archive.dispose(); client.dispose(); provider.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("batch prefetch before drawing shares pins, deduplicates scalars, and rejects an oversized union", async () => {
  for (const capacity of [4, 8]) {
    const h = await harness(capacity);
    try {
      const batch = h.archive.prepareText("AA一一二", { slot: 2 });
      expect(batch.state().status).toBe("pending");
      h.step(40);
      expect(batch.state()).toEqual({ status: "ready", value: { text: "AA一一二", slot: 2 } });
      expect(h.archive.stats().resident).toBe(4);
      expect(h.seen.filter(q => q.method === "font.glyphs").flatMap(q => JSON.parse(q.payload).scalars).sort()).toEqual(
        Array.from("你好一二", c => c.codePointAt(0)!).sort());
      const shared = h.archive.prepareText("一", { slot: 2 });
      expect(shared.state().status).toBe("ready");
      const excess = h.archive.prepareText(capacity === 4 ? "丁丂" : "丁丂七丄丅", { slot: 2 });
      expect(excess.state().status).toBe("error"); excess.dispose();
      const before = h.seen.length; h.step(80); expect(h.seen.length).toBe(before);
      batch.dispose();
      const next = h.archive.prepareText(capacity === 4 ? "丁" : "丁丂七丄丅", { slot: 2 });
      h.step(50);
      expect(next.state().status, JSON.stringify(next.state(), (_k, v) => v instanceof Error ? v.message : v)).toBe("ready"); expect(shared.state().status).toBe("ready");
      const common = h.archive.prepareText("你好", { slot: 2 });
      expect(common.state().status).toBe("ready");
      expect(h.archive.stats().bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    } finally { h.close(); }
  }
});

test("cancelled, reloaded and disconnected batches cannot reveal stale data", async () => {
  const h = await harness(8);
  try {
    h.step(20);
    const cancelled = h.archive.prepareText("気迫", { slot: 2 });
    h.step(1); cancelled.dispose(); h.step(20);
    expect(cancelled.state().status).toBe("error");
    expect(h.archive.stats().resident).toBe(2);
    const next = h.archive.prepareText("一二丁丂七丄", { slot: 2 });
    h.step(1); h.archive.reload();
    expect(next.state().status).toBe("pending"); h.step(60);
    expect(next.state().status, JSON.stringify(next.state(), (_k, v) => v instanceof Error ? v.message : v)).toBe("ready");
    h.reconnect(); h.step(1); expect(next.state().status).toBe("pending");
    h.step(60); expect(next.state().status, JSON.stringify(next.state(), (_k, v) => v instanceof Error ? v.message : v)).toBe("ready");
    next.dispose(); expect(next.state().status).toBe("error");
  } finally { h.close(); }
});

test("missing glyph, invalid replies and transport failure reach an error and stop retrying", async () => {
  for (const failure of ["missing", "transport", "corrupt"]) {
    const h = await harness(4);
    try {
      h.step(20);
      if (failure === "transport") h.fail(true);
      if (failure === "corrupt") h.corrupt();
      const batch = h.archive.prepareText(failure === "missing" ? String.fromCodePoint(0x10ffff) : "一二", { slot: 2 });
      h.step(240); expect(batch.state().status).toBe("error");
      const before = h.seen.length; h.step(200); expect(h.seen.length).toBe(before);
      expect(h.archive.stats().pending).toBe(0);
      if (failure === "transport") { h.fail(false); h.archive.reload(); h.step(60); expect(batch.state().status).toBe("ready"); }
    } finally { h.close(); }
  }
});

test("resident set failure propagates, supplementary scalars stay intact, and admission validates input", async () => {
  const h = await harness(4, String.fromCodePoint(0x10ffff));
  try {
    const batch = h.archive.prepareText("一", { slot: 2 });
    h.step(30); expect(batch.state().status).toBe("error");
    expect(h.archive.status().state).toBe("error");
    expect(h.seen.filter(q => q.method === "font.glyphs").flatMap(q => JSON.parse(q.payload).scalars)).toEqual([0x10ffff]);
    expect(() => h.archive.prepareText("\ud800", { slot: 2 })).toThrow("surrogate");
    expect(() => h.archive.prepareText("A".repeat(65537), { slot: 2 })).toThrow("65536");
    expect(() => h.archive.prepareText("A", { slot: 0 })).toThrow();
  } finally { h.close(); }
});

test("companion provider enforces grants, generation, reply budget and cell checksums", () => {
  const dir = mkdtempSync(join(tmpdir(), "pocket-font-provider-")), path = join(dir, "font.pjfa");
  writeFileSync(path, bytes);
  const p = createFontArchiveProvider({ "font.pjfa": path });
  try {
    expect(() => p.methods["font.open"]("../font.pjfa")).toThrow("granted");
    const face = JSON.parse(p.methods["font.open"]("font.pjfa") as string);
    const q = { generation: face.generation, slot: 2, scalars: [0x4f60] };
    expect((p.methods["font.glyphs"](JSON.stringify(q)) as string).length).toBeLessThanOrEqual(2500);
    expect(() => p.methods["font.glyphs"](JSON.stringify({ ...q, generation: 0 }))).toThrow();
    expect(() => p.methods["font.glyphs"](JSON.stringify({ ...q, scalars: [1, 2, 3, 4, 5] }))).toThrow();
    p.close();
    const damaged = Buffer.from(bytes), v = new DataView(damaged.buffer, damaged.byteOffset, damaged.byteLength);
    const index = v.getUint32(76, true), count = v.getUint32(72, true);
    for (let i = 0; i < count; i++) if (v.getUint32(index + i * 12, true) === 0x4f60) damaged[index + i * 12 + 8] ^= 1;
    writeFileSync(path, damaged);
    const next = JSON.parse(p.methods["font.open"]("font.pjfa") as string);
    expect(() => p.methods["font.glyphs"](JSON.stringify({ ...q, generation: next.generation }))).toThrow("checksum");
  } finally { p.close(); rmSync(dir, { recursive: true, force: true }); }
});


test("source byte budgets fail without retaining allocations and long chapters share a small glyph set", async () => {
  const small = await harness(8, "你好", 1);
  try {
    const text = small.archive.prepareText("一", { slot: 2 });
    small.step(20);
    expect(small.archive.status().state).toBe("error");
    expect(text.state().status).toBe("error");
    expect(small.archive.stats().bytes).toBe(0);
  } finally { small.close(); }
  const h = await harness(4);
  try {
    const chapter = h.archive.prepareText("你好一二".repeat(8000), { slot: 2 });
    h.step(50);
    expect(chapter.state().status).toBe("ready");
    expect(h.archive.stats().resident).toBe(4);
    const views = Array.from({ length: 30 }, () => h.archive.prepareText("你好", { slot: 2 }));
    expect(() => h.archive.prepareText("A", { slot: 2 })).toThrow("batch count");
    views[0].dispose();
    expect(h.archive.prepareText("A", { slot: 2 }).state().status).toBe("ready");
  } finally { h.close(); }
});
