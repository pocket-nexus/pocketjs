import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createTextResources } from "../framework/src/text.ts";
import { createOffloadClient } from "../framework/src/offload.ts";
import { createTextProvider } from "../tools/text-glyph-provider.ts";
import type { OffloadRequest } from "../contracts/spec/offload.ts";
const font = existsSync("/System/Library/Fonts/STHeiti Medium.ttc") ? "/System/Library/Fonts/STHeiti Medium.ttc" : "assets/fonts/Inter-Regular.ttf";

function fixture(maxGlyphs = 96) {
  const provider = createTextProvider(font), sent: OffloadRequest[] = [], replies: string[] = [], held: OffloadRequest[] = [];
  let session = 1, allow = true, next = 1, frame = 0;
  const uploaded: number[] = [], freed: number[] = [];
  function answer(r: OffloadRequest) { replies.push(JSON.stringify({ id: r.id,
    payload: r.method === "text.font" ? provider["text.font"]() : provider["text.glyph"](r.payload) })); }
  const io = createOffloadClient({ session: () => session, take: () => replies.shift(), submit: raw => {
    const request = JSON.parse(raw) as OffloadRequest; sent.push(request);
    if (request.method === "text.font" || allow) answer(request); else held.push(request);
    return true;
  } });
  const resources = createTextResources({ io, maxGlyphs, measure: s => s.length * 8,
    upload() { uploaded.push(frame); return next++; }, free: h => freed.push(h) });
  const layouts: ReturnType<typeof resources.createLayout>[] = [];
  function label() { const label = resources.createLayout({ width: 300, size: 20, density: 2, bold: true, fontSlot: 11 }); layouts.push(label); return label; }
  function step(n = 1) { for (let i = 0; i < n; i++) { frame++; io.step(); resources.step(); for (const l of layouts) l.snapshot(); } }
  return { resources, io, label, sent, uploaded, freed, step, connect: (s: number) => { session = s; },
    hold() { allow = false; }, resume() { allow = true; for (const request of held.splice(0)) answer(request); } };
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
