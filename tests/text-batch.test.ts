import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWasmUi } from "../hosts/web/wasm-ops.js";
import { bakeAtlases, PRINTABLE_ASCII } from "../framework/compiler/bake-font.ts";
import { bakeFontArchive } from "../framework/compiler/font-archive.ts";
import { createFontArchive } from "../framework/src/fonts.ts";
import { createOffloadClient } from "../framework/src/offload.ts";
import { runServicePumps } from "../framework/src/services.ts";
import { createFontArchiveProvider } from "../tools/font-archive-provider.ts";
import { createHash } from "node:crypto";
import { NODE_TYPE, PROP } from "../contracts/spec/spec.ts";

const bytes = await bakeFontArchive({ font: "assets/fonts/NotoSansCJK-Demo.otf", slots: [2],
  codepoints: Array.from("你好一二丁丂七丄丅丆万丈気迫", c => c.codePointAt(0)!) });
// The embedded atlas carries printable ASCII by explicit declaration, mirroring
// an app manifest with `"runtimeText": { "charset": "ascii" }`: metadata rows
// (digits, punctuation, spaces) render from baked cells while CJK scalars are
// served by the streamed PJFA archive.
const [baked] = await bakeAtlases({ slots: [2], codepoints: [65, 0xfffd], extraChars: PRINTABLE_ASCII });
async function harness(capacity: number, resident = "你好", maxBytes?: number,
  fixture = { bytes, slot: 2, baked: baked.bytes }) {
  const dir = mkdtempSync(join(tmpdir(), "pocket-font-"));
  const path = join(dir, "font.pjfa"); writeFileSync(path, fixture.bytes);
  const provider = createFontArchiveProvider({ "font.pjfa": path });
  const wasm = await createWasmUi(await Bun.file("hosts/web/pocketjs.wasm").arrayBuffer());
  wasm.ops.loadFontAtlas!(fixture.baked);
  const queue: any[] = [], replies: string[] = [], seen: any[] = [];
  let session = 1, fail = false, corrupt = false;
  const client = createOffloadClient({ session: () => session, take: () => replies.shift(),
    submit: raw => { queue.push(JSON.parse(raw)); return true; } });
  const archive = createFontArchive({ path: "font.pjfa", slots: [fixture.slot], capacity, maxBytes, resident: [{ slot: fixture.slot, text: resident }] }, wasm.ops, client);
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

// A downstream player pattern, using only the shared archive API and HostOps.
// Metadata arrives after baking; a live now-playing title shares the cache with
// a moving five-row library window. The archive is much larger than the cache.
test("1000 runtime titles survive eviction beside a pinned player title at five strikes", async () => {
  const slots = [0, 1, 2, 5, 7]; // regular 12/14/16/24 and bold 12
  const glyphs = "你好気迫Ａ１𠮷" + Array.from({ length: 256 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join("");
  const codepoints = Array.from(glyphs, c => c.codePointAt(0)!);
  const archiveBytes = await bakeFontArchive({ font: "assets/fonts/NotoSansCJK-Demo.otf", slots, codepoints });
  const embedded = await bakeAtlases({ slots, codepoints: [65, 0xfffd], extraChars: PRINTABLE_ASCII });
  const references = await bakeAtlases({ slots, codepoints, fallbackTtfs: ["assets/fonts/NotoSansCJK-Demo.otf"], extraChars: PRINTABLE_ASCII });
  const hash = (pixels: Uint8Array) => createHash("sha256").update(pixels).digest("hex");
  function surface(wasm: Awaited<ReturnType<typeof createWasmUi>>, slot: number) {
    wasm.resizeViewport(480, 240);
    const nodes = Array.from({ length: 6 }, () => {
      const node = wasm.ops.createNode(NODE_TYPE.text);
      wasm.ops.setProp(node, PROP.fontSlot, slot);
      wasm.ops.setProp(node, PROP.textColor, 0xffffffff);
      wasm.ops.setProp(node, PROP.height, 35);
      wasm.ops.insertBefore(1, node, 0);
      return node;
    });
    return (titles: string[]) => {
      nodes.forEach((node, i) => wasm.ops.setText(node, titles[i] ?? ""));
      wasm.tick(); return hash(wasm.render());
    };
  }
  for (const [strike, slot] of slots.entries()) {
    const h = await harness(32, "你好", undefined, { bytes: archiveBytes, slot, baked: embedded[strike].bytes });
    const reference = await createWasmUi(await Bun.file("hosts/web/pocketjs.wasm").arrayBuffer());
    const atlas = references[strike], quantized = atlas.bytes.slice();
    // Reference bypasses PJFA packing, its provider, the streamed cmap and LRU.
    const av = new DataView(quantized.buffer), cell = atlas.cellW * atlas.cellH;
    for (let e = 16; e < 16 + atlas.glyphCount * 8; e += 8) {
      const cp = av.getUint32(e, true);
      if (cp < 127 || cp === 0xfffd) continue; // embedded ASCII keeps its 8-bit coverage
      const start = 16 + atlas.glyphCount * 8 + av.getUint16(e + 4, true) * cell;
      for (let i = start; i < start + cell; i++) quantized[i] = Math.round(quantized[i] / 85) * 85;
    }
    reference.ops.loadFontAtlas!(quantized);
    const paint = surface(h.wasm, slot), expected = surface(reference, slot);
    try {
      const current = "気迫Ａ１𠮷";
      const playing = h.archive.prepareText(current, { slot });
      h.step(50); expect(playing.state().status).toBe("ready");
      // Encode/decode as a filesystem or metadata service would, after baking.
      const tracks = JSON.parse(new TextDecoder().decode(new TextEncoder().encode(JSON.stringify(
        Array.from({ length: 1000 }, (_, i) => `${i + 1} - ${String.fromCodePoint(0x4e00 + i % 256)}${String.fromCodePoint(0x4e00 + (i + 71) % 256)}.mp3`),
      )))) as string[];
      let first = "";
      for (let page = 0; page <= 200; page++) {
        const rows = tracks.slice((page % 200) * 5, (page % 200) * 5 + 5);
        const batch = h.archive.prepareText(rows.join("\n"), { slot });
        const before = paint([current]); // the ready title survives other demand
        for (let f = 0; batch.state().status === "pending" && f < 80; f++) {
          h.step();
          expect(playing.state().status).toBe("ready");
          expect(paint([current])).toBe(before);
        }
        expect(batch.state().status, `slot ${slot}, page ${page}`).toBe("ready");
        const image = paint([current, ...rows]);
        expect(image, `slot ${slot}, page ${page}`).toBe(expected([current, ...rows]));
        if (page === 0) first = image;
        if (page === 200) expect(image).toBe(first);
        expect(h.archive.stats().bytes).toBeLessThanOrEqual(32 * atlas.cellW * atlas.cellH);
        batch.dispose();
      }
      expect(h.archive.stats().evictions).toBeGreaterThan(900);
      const count = h.seen.length;
      const common = h.archive.prepareText("你好", { slot });
      expect(common.state().status).toBe("ready"); h.step(5);
      expect(h.seen.length).toBe(count);
      expect(h.seen.filter(q => q.method === "font.glyphs").flatMap(q => JSON.parse(q.payload).scalars)).toContain(0x20bb7);
      common.dispose(); playing.dispose();
    } finally { h.close(); }
  }
}, 60000);
