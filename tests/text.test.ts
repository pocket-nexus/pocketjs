import { describe, expect, test } from "bun:test";
import { createBakedFontCoverage } from "../framework/src/font-coverage.ts";
import { loadPack, resetPack } from "../framework/src/pak.ts";
import { pack, keyFont, PAK_DTYPE } from "../framework/compiler/pak.ts";
import { bakeAtlases } from "../framework/compiler/bake-font.ts";
import { existsSync } from "node:fs";
import { createTextResources } from "../framework/src/text.ts";
import { createOffloadClient } from "../framework/src/offload.ts";
import { createTextProvider } from "../tools/text-glyph-provider.ts";
import type { OffloadRequest } from "../contracts/spec/offload.ts";
const font = existsSync("/System/Library/Fonts/STHeiti Medium.ttc") ? "/System/Library/Fonts/STHeiti Medium.ttc" : "assets/fonts/Inter-Regular.ttf";

function fixture(maxGlyphs = 96) {
  const provider = createTextProvider(font), sent: OffloadRequest[] = [], replies: string[] = [], held: OffloadRequest[] = [];
  let session = 1, allow = true, next = 1, frame = 0;
  let failure: "load" | "upload" | undefined;
  const uploaded: number[] = [], freed: number[] = [];
  function answer(r: OffloadRequest) {
    if (r.method === "text.glyph" && failure === "load") { replies.push(JSON.stringify({ id: r.id, error: "unavailable" })); return; }
    replies.push(JSON.stringify({ id: r.id,
    payload: r.method === "text.font" ? provider["text.font"]() : provider["text.glyph"](r.payload) })); }
  const io = createOffloadClient({ session: () => session, take: () => replies.shift(), submit: raw => {
    const request = JSON.parse(raw) as OffloadRequest; sent.push(request);
    if (request.method === "text.font" || allow) answer(request); else held.push(request);
    return true;
  } });
  const resources = createTextResources({ io, maxGlyphs, measure: s => s.length * 8,
    upload() { uploaded.push(frame); return failure === "upload" ? undefined : next++; }, free: h => freed.push(h) });
  const layouts: ReturnType<typeof resources.createLayout>[] = [];
  function label() { const label = resources.createLayout({ width: 300, size: 20, density: 2, bold: true, fontSlot: 11 }); layouts.push(label); return label; }
  function step(n = 1) { for (let i = 0; i < n; i++) { frame++; io.step(); resources.step(); for (const l of layouts) l.snapshot(); } }
  return { resources, io, label, sent, uploaded, freed, step, connect: (s: number) => { session = s; },
    fail(mode?: "load" | "upload") { failure = mode; }, hold() { allow = false; }, resume() { allow = true; for (const request of held.splice(0)) answer(request); } };
}
describe("retained text resources", () => {
  test("a clipped glyph dependency still updates the full measured width", () => {
    const f = fixture(), visible = f.label();
    const clipped = f.resources.createLayout({ width: 6, size: 20, density: 2, bold: true, fontSlot: 11 });
    clipped.set("Aé"); const before = clipped.snapshot();
    expect(before.width).toBe(28);
    visible.set("é"); f.step(30);
    const after = clipped.snapshot();
    expect(after.width).toBe(8 + visible.snapshot().width);
    expect(after.width).not.toBe(before.width);
    expect(after.parts.map(p => p.text)).toEqual(["A"]);
    clipped.dispose(); f.resources.dispose();
  });
  test("loading another label's glyphs does not invalidate a resident layout", () => {
    const f = fixture(), row = f.label(), candidates = f.label();
    row.set("Tap to Edit 你好|"); f.step(30);
    const stable = row.snapshot();
    candidates.set("们中文候选");
    for (let frame = 0; frame < 40; frame++) {
      f.step(); expect(row.snapshot()).toBe(stable);
    }
    expect(candidates.snapshot().pending).toBe(false);
    f.resources.dispose();
  });
  test("deleting and reordering resident Han text preserves pixels without I/O, including offline", () => {
    const f = fixture(), label = f.label(); label.set("Tap to Edit 你好|"); f.step(30);
    const ready = label.snapshot(); expect(ready.pending).toBe(false);
    const glyph = ready.parts.find(p => p.text === "你")!;
    expect(glyph.kind).toBe("glyph");
    const before = f.sent.length;
    label.set("Tap to Edit 你|");
    expect(label.snapshot().pending).toBe(false);
    expect(label.snapshot().parts.find(p => p.text === "你")).toEqual(glyph);
    f.connect(0); f.step(); label.set("好你|");
    expect(label.snapshot().pending).toBe(false);
    f.step(5); expect(f.sent.length).toBe(before);
    expect(new Set(f.uploaded).size).toBe(f.uploaded.length);
    f.resources.dispose();
  });
  test("a missing glyph does not hide resident Latin or Han; labels share coverage", () => {
    const f = fixture(), a = f.label(), b = f.label();
    a.set("你好"); b.set("你好"); f.step(30);
    expect(f.sent.filter(r => r.method === "text.glyph")).toHaveLength(2);
    f.hold(); a.set("A你们B"); f.step(5);
    const parts = a.snapshot().parts;
    expect(parts.filter(p => p.kind === "local").map(p => p.text)).toEqual(["A", "B"]);
    expect(parts.find(p => p.text === "你" && p.kind === "glyph" && p.glyph)).toBeDefined();
    expect(parts.find(p => p.text === "们" && p.kind === "glyph" && !p.glyph)).toBeDefined();
    f.resume(); f.step(20); expect(a.snapshot().pending).toBe(false);
    f.resources.dispose();
  });
  test("font handshake on reconnect preserves immutable resident coverage and a bounded cache", () => {
    const f = fixture(2), a = f.label(), b = f.label(); a.set("你"); b.set("你"); f.step(20);
    const initial = f.sent.filter(r => r.method === "text.glyph").length;
    a.dispose(); f.connect(0); f.step(); f.connect(2); f.step(20);
    expect(b.snapshot().pending).toBe(false);
    expect(f.sent.filter(r => r.method === "text.glyph")).toHaveLength(initial);
    b.set("你好"); f.step(20); b.set("你们"); f.step(20);
    expect(b.snapshot().pending).toBe(false);
    expect(f.resources.stats().entries).toBeLessThanOrEqual(2);
    expect(f.freed.length).toBeGreaterThan(0);
    f.resources.dispose();
  });
});

for (const mode of ["load", "upload"] as const) for (const offline of [true, false])
  test(`same-font reconnect restores exhausted ${mode} retries (offline edge ${offline}) without reloading residents`, () => {
    const f = fixture(), resident = f.label(), missing = f.label(); resident.set("你"); f.step(30);
    const stable = resident.snapshot(); f.fail(mode); missing.set("好"); f.step(200);
    const reads = () => f.sent.filter(r => r.method === "text.glyph" && JSON.parse(r.payload).text === "好");
    expect(reads()).toHaveLength(3); expect(missing.snapshot().pending).toBe(true);
    f.fail(); f.step(200); expect(reads()).toHaveLength(3); // budget stays exhausted within the old session
    if (offline) { f.connect(0); f.step(2); }
    f.connect(2); f.step(200);
    expect(reads()).toHaveLength(4); expect(missing.snapshot().pending).toBe(false);
    expect(resident.snapshot()).toBe(stable); expect(f.freed).toEqual([]);
    expect(f.sent.filter(r => r.method === "text.glyph" && JSON.parse(r.payload).text === "你")).toHaveLength(1);
    f.resources.dispose();
  });


test("shipped baked coverage keeps non-ASCII symbols local before the first companion session", async () => {
  const [atlas] = await bakeAtlases({ slots: [11], codepoints: Array.from("AB£¥€•你").map(c => c.codePointAt(0)!) });
  loadPack(pack([{ key: keyFont(11), dtype: PAK_DTYPE.u8, data: atlas!.bytes }]).buffer as ArrayBuffer);
  try {
    let requests = 0;
    const local = createBakedFontCoverage();
    for (const c of "£¥€•") expect(local(c, 11)).toBe(true);
    expect(local("你", 11)).toBe(false); // the font has no glyph, despite being requested at bake
    expect(local("£", 4)).toBe(false); // coverage is per installed slot
    const resources = createTextResources({ io: { session: () => 0, request: () => { requests++; return 0; }, cancel() {} },
      measure: s => s.length * 8, local, upload() { throw new Error("local text must not upload"); }, free() {} });
    const label = resources.createLayout({ width: 300, size: 20, density: 2, bold: true, fontSlot: 11 });
    label.set("A£¥€•B");
    expect(label.snapshot().parts).toEqual([{ kind: "local", text: "A£¥€•B", x: 0, width: 48, start: 0, end: 6 }]);
    expect(label.snapshot().pending).toBe(false);
    for (let i = 0; i < 200; i++) resources.step();
    expect(requests).toBe(0);
    label.set("£你€");
    expect(label.snapshot().parts.map(p => [p.text, p.kind])).toEqual([["£", "local"], ["你", "glyph"], ["€", "local"]]);
    resources.dispose();
  } finally { resetPack(); }
});
