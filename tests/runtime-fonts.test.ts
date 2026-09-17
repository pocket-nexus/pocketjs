import { expect, test } from "bun:test";
import { createRuntimeFont, textCaret, textHitTest, textMoveCaret, textSelection } from "../framework/src/runtime-fonts.ts";
import { createOffloadClient } from "../framework/src/offload.ts";
import { runServicePumps } from "../framework/src/services.ts";
import type { HostOps } from "../framework/src/host.ts";
import { RUNTIME_TEXT, type RuntimeTextLayout } from "../contracts/spec/runtime-text.ts";
import { layoutFromText, caretX, caretFromX, lineCaretX, backspaceSel, deleteSel } from "../apps/note/editor.ts";

function harness(options: { bitmapBytes?: number; gpuBytes?: number; rejectUploads?: boolean } = {}) {
  let session = 1, next = 1;
  const requests: any[] = [], replies: string[] = [], seen: any[] = [], packets: Uint8Array[] = [];
  const shapes = new Map<number, string>(), layouts = new Map<number, any>(), pins = new Set<number | string>();
  const client = createOffloadClient({ session: () => session, take: () => replies.shift(), submit(record) {
    expect(Buffer.byteLength(record)).toBeLessThanOrEqual(4096); requests.push(JSON.parse(record)); return true;
  } });
  const host = { fontStreamCommit(bytes: Uint8Array) {
    packets.push(bytes); const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(v.getUint32(0, true)).toBe(RUNTIME_TEXT.packetMagic);
    return options.rejectUploads && v.getUint32(4, true) === 2 ? 0 : 1;
  } } as HostOps;
  function reply(method: string, data: any): any {
    if (method === "runtime.font") return { font: 1, ascent: 12, descent: 4, lineHeight: 16 };
    if (method === "runtime.prepare") {
      for (const key of data.releases ?? []) pins.delete(key);
      const shape = reply("runtime.shape", data);
      if (shape.missing) throw Error("Font and explicit fallback have no glyph for this text");
      const layout = reply("runtime.layout", { ...data, shape: shape.shape });
      pins.add(data.leaseKey);
      return { ...layout, shape: shape.shape, units: shape.units, missing: 0, inline: layouts.get(layout.layout) };
    }
    if (method === "runtime.release") { pins.delete(data.key); return {}; }
    if (method === "runtime.shape") {
      const id = next++; shapes.set(id, data.text);
      return { shape: id, glyphs: data.text === "ffi" ? 1 : data.text.length, units: data.text.length, missing: data.text === "missing" ? 1 : 0 };
    }
    if (method === "runtime.layout") {
      const text = shapes.get(data.shape)!;
      const positions = text === "ffi" ? [[700, 0, 12, 13, 0, 3, 0]] :
        Array.from(text, (s, i) => [s.charCodeAt(0), i * 7, 12, 7, i, i + 1, 0]);
      const width = text === "ffi" ? 13 : text.length * 7;
      const carets = Array.from({ length: text.length + 1 }, (_, i) => [i, width * i / text.length || 0, 0, 0]);
      const id = next++; const layout = { glyphs: positions, rows: [[0, text.length, width, 12]], carets };
      layouts.set(id, layout);
      return { layout: id, width, height: 16, baseline: 12, truncated: false, glyphs: positions.length, rows: 1, carets: carets.length };
    }
    if (method === "runtime.layout.page") {
      const items = layouts.get(data.layout)[data.kind]; return { items, next: null, total: items.length };
    }
    if (method === "runtime.lease") {
      if (data.action === "pin") pins.add(data.layout); else pins.delete(data.layout);
      return {};
    }
    if (method === "runtime.glyph") return { glyph: data.glyph, width: 4, height: 4, left: -1, top: 12,
      offset: 0, next: null, total: 16, coverage: Buffer.alloc(16, data.glyph & 255).toString("base64") };
    if (method === "runtime.glyph.batch") return { items: data.glyphs.map((glyph: number) => reply("runtime.glyph", { glyph })), next: null, total: data.glyphs.length };
    throw Error(method);
  }
  const font = createRuntimeFont({ family: "Inter", fallback: [], size: 16, ...options }, host, client);
  return { font, seen, packets, pins, reconnect() { session++; },
    step(count = 1) {
      for (let i = 0; i < count; i++) {
        const r = requests.shift();
        if (r) {
          const data = JSON.parse(r.payload); seen.push({ method: r.method, ...data });
          try { replies.push(JSON.stringify({ id: r.id, payload: JSON.stringify(reply(r.method, data)) })); }
          catch (error) { replies.push(JSON.stringify({ id: r.id, error: String(error) })); }
        }
        client.step(); runServicePumps();
      }
    },
    close() { font.dispose(); this.step(40); client.dispose(); },
  };
}

test("runtime prepareText requests shaped glyph IDs and reveals a leased batch together", () => {
  const h = harness();
  try {
    const text = h.font.prepareText("ffi");
    expect(text.state().status).toBe("pending"); h.step(40);
    expect(text.state().status).toBe("ready");
    expect(h.seen.filter(r => r.method === "runtime.glyph.batch").flatMap(r => r.glyphs)).toEqual([700]);
    expect(h.font.stats()).toMatchObject({ glyphs: 1, bitmapBytes: 16, gpuBytes: 64, uploads: 1 });
    expect(h.pins.size).toBe(1);
    const state = text.state();
    if (state.status === "ready") expect(state.value.paint!(42)).toBe(true);
    const layout = text.layout(); text.dispose(); h.step(10);
    expect(text.layout()).toBe(layout); expect(h.pins.size).toBe(0);
    expect(h.font.stats()).toMatchObject({ bitmapBytes: 16, gpuBytes: 64 });
  } finally { h.close(); }
});

test("independent bitmap and GPU budgets reject the full union without publishing partial readiness", () => {
  for (const budget of [{ bitmapBytes: 16 }, { gpuBytes: 64 }, { rejectUploads: true }]) {
    const h = harness(budget);
    try {
      const text = h.font.prepareText("AB"); const states: string[] = [];
      text.subscribe(() => states.push(text.state().status)); h.step(60);
      expect(text.state().status).toBe("error"); expect(states).not.toContain("ready");
      expect(h.font.stats().gpuBytes).toBe(0); expect(h.pins.size).toBe(0);
      const before = h.seen.length; h.step(50); expect(h.seen.length).toBe(before);
    } finally { h.close(); }
  }
});

test("independent CPU and GPU eviction preserves copied geometry and pinned glyphs", () => {
  const h = harness({ bitmapBytes: 32, gpuBytes: 128 });
  try {
    const a = h.font.prepareText("A"); h.step(40);
    const shared = h.font.prepareText("A"); h.step(40);
    expect(h.font.stats().uploads).toBe(1); const geometry = a.layout();
    a.dispose(); expect(h.font.stats().gpuBytes).toBe(64);
    const b = h.font.prepareText("B"); h.step(40); b.dispose();
    const c = h.font.prepareText("C"); h.step(40);
    expect(c.state().status).toBe("ready"); expect(shared.state().status).toBe("ready");
    expect(a.layout()).toBe(geometry); expect(h.font.stats().evictions).toBe(2);
    expect(h.font.stats().bitmapBytes).toBeLessThanOrEqual(32);
    shared.dispose(); c.dispose(); expect(h.font.stats().gpuBytes).toBe(128);
  } finally { h.close(); }
});

test("missing explicit fallback, disposal and a new worker session cannot publish stale text", () => {
  const h = harness();
  try {
    const missing = h.font.prepareText("missing"); h.step(20);
    expect(missing.state().status).toBe("error");
    expect(h.seen.filter(r => r.method === "runtime.glyph")).toHaveLength(0);
    const cancelled = h.font.prepareText("A"); h.step(4); cancelled.dispose(); h.step(20);
    expect(cancelled.state().status).toBe("error");
    const live = h.font.prepareText("B"); h.step(40); const before = live.layout(), oldState = live.state();
    h.reconnect(); h.step(); expect(live.state().status).toBe("pending"); expect(live.layout()).toBeUndefined(); h.step(50);
    expect(live.state().status).toBe("ready"); expect(live.layout()).not.toBe(before);
    if (oldState.status === "ready") expect(oldState.value.paint!(42)).toBe(false);
    expect(() => h.font.prepareText("\ud800")).toThrow("surrogate");
    expect(() => h.font.prepareText("a".repeat(2049))).toThrow("2048");
  } finally { h.close(); }
});

test("carets, hit testing and selection use one proportional, kerned, ligature and combining layout", () => {
  // AV is kerned to 17 px; ffi has interior grapheme carets; e + acute has none.
  const layout: RuntimeTextLayout = {
    id: 1, text: "AVffi e\u0301", font: { font: 1, ascent: 12, descent: 4, lineHeight: 16 }, width: 42, height: 16, baseline: 12, truncated: false,
    glyphs: [[1, 0, 12, 8, 0, 1, 0], [2, 8, 12, 9, 1, 2, 0], [700, 17, 12, 13, 2, 5, 0], [3, 30, 12, 4, 5, 6, 0], [4, 34, 12, 8, 6, 8, 0]],
    rows: [[0, 8, 42, 12]], carets: [[0, 0, 0, 0], [1, 8, 0, 0], [2, 17, 0, 0], [3, 21, 0, 0], [4, 25, 0, 0], [5, 30, 0, 0], [6, 34, 0, 0], [8, 42, 0, 0]],
  };
  expect(textCaret(layout, 2)[1]).toBe(17); expect(textHitTest(layout, 24, 4)).toBe(4);
  expect(textMoveCaret(layout, 6, 1)).toBe(8); expect(textMoveCaret(layout, 8, -1)).toBe(6);
  expect(textSelection(layout, 2, 5)).toEqual([{ x: 17, y: 0, width: 13, height: 16, row: 0 }]);
  const lines = layoutFromText(layout), noMeasure = () => { throw Error("Editor must not remeasure shaped text"); };
  expect(caretX(layout.text, lines, 2, noMeasure)).toBe(17);
  expect(caretFromX(layout.text, lines, 0, 24, noMeasure)).toBe(4);
  expect(lineCaretX(layout.text, lines[0], 5, noMeasure)).toBe(30);
  expect(backspaceSel({ doc: layout.text, caret: 8, anchor: 8 }, lines).doc).toBe("AVffi ");
  expect(deleteSel({ doc: layout.text, caret: 6, anchor: 6 }, lines).doc).toBe("AVffi ");
});

test("warm text edits retain unpinned GPU glyphs and skip repeated raster and upload", () => {
  const h = harness();
  try {
    let text = h.font.prepareText("AB"); h.step(40); text.dispose();
    const uploads = h.font.stats().uploads;
    const raster = h.seen.filter(r => r.method === "runtime.glyph.batch").length;
    const before = h.seen.length;
    text = h.font.prepareText("BA", { width: 20 });
    let frames = 0;
    while (text.state().status === "pending" && frames < 40) { h.step(); frames++; }
    expect(text.state().status).toBe("ready");
    expect(frames).toBeLessThanOrEqual(4);
    expect(h.seen.slice(before).map(r => r.method)).toEqual(["runtime.prepare"]);
    expect(h.font.stats().uploads).toBe(uploads);
    expect(h.seen.filter(r => r.method === "runtime.glyph.batch")).toHaveLength(raster);
  } finally { h.close(); }
});

test("session-bound queued text mutations never enter a replacement worker", () => {
  let session = 1;
  const sent: string[] = [], errors: unknown[] = [];
  const client = createOffloadClient({ session: () => session, take: () => undefined, submit: record => { sent.push(record); return true; } });
  client.request("runtime.prepare", "{}", result => errors.push(result), { session: 1 });
  client.request("runtime.release", "{}", result => errors.push(result), { session: 1 });
  session = 2; client.step(); expect(sent).toHaveLength(0);
  client.step(); expect(sent).toHaveLength(0); expect(errors).toHaveLength(2);
  expect(errors).toEqual([{ ok: false, error: "Provider session changed" }, { ok: false, error: "Provider session changed" }]);
  client.dispose();
});
